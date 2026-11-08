# -*- coding: utf-8 -*-
"""
声音的形状 · 本机后端服务（纯 Python 标准库，零 pip 依赖）

启动：  python server.py            # 默认 http://127.0.0.1:5000
       python server.py --port 8080
       HOST=0.0.0.0 python server.py   # 允许局域网投屏访问

能力：
  GET  /                     托管 dashboard.html（同源，麦克风权限最稳）
  GET  /api/health           健康检查 / 当前分析引擎 / 连接数
  GET  /api/config           当前 aigent 配置
  GET  /api/templates        声纹模板库（SQLite）
  GET  /api/history          识别历史 + 累计次数
  GET  /api/demo.wav         合成测试音频（无麦克风也能跑通全链路）
  POST /api/train            接收 WAV/PCM 样本，提取特征取平均，写入模板库
  POST /api/analyze          接收 WAV/PCM，后端分析并匹配，写历史并广播
  POST /api/recognize        仅传 7 维特征时的轻量比对
  POST /api/templates/delete 删除模板
  POST /api/reset            重置模板与历史
  GET  /ws                   WebSocket 推送 recognition / template_updated
  GET  /api/events           SSE 推送（WebSocket 不可用时的降级通道）

所有接口均带 CORS，前端以 file:// 打开也能跨域调用。
"""

import argparse
import base64
import hashlib
import io
import json
import os
import queue
import struct
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import voice_engine as engine

ROOT = os.path.dirname(os.path.abspath(__file__))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
VERSION = "1.0.0"

_WS_CLIENTS = set()      # (socket, rfile)
_SSE_CLIENTS = set()     # queue.Queue
_LOCK = threading.RLock()

# 硬件链路状态：任何一条 /api/device/event 都会刷新它
_DEVICE = {"last": 0.0, "ev": "", "tpl": 0, "count": 0}


# ------------------------------------------------------------------ 广播
def _ws_frame(text, opcode=0x81):
    data = text.encode("utf-8")
    n = len(data)
    if n < 126:
        head = bytes([opcode, n])
    elif n < 65536:
        head = bytes([opcode, 126]) + struct.pack("!H", n)
    else:
        head = bytes([opcode, 127]) + struct.pack("!Q", n)
    return head + data


def _ws_read(rfile):
    head = rfile.read(2)
    if len(head) < 2:
        return None
    b1, b2 = head[0], head[1]
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", rfile.read(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", rfile.read(8))[0]
    mask = rfile.read(4) if masked else None
    data = rfile.read(n) if n else b""
    if mask:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return opcode, data


def broadcast(obj):
    """识别结果 / 模板变更 → 推给所有 WebSocket 与 SSE 客户端。"""
    payload = json.dumps(obj, ensure_ascii=False)
    frame = _ws_frame(payload)
    sse_msg = "event: %s\ndata: %s\n\n" % (obj.get("type", "message"), payload)
    with _LOCK:
        ws = list(_WS_CLIENTS)
        sse = list(_SSE_CLIENTS)
    dead = []
    for sock, _ in ws:
        try:
            sock.sendall(frame)
        except Exception:
            dead.append(sock)
    for sock in dead:
        with _LOCK:
            for item in list(_WS_CLIENTS):
                if item[0] is sock:
                    _WS_CLIENTS.discard(item)
    for q in sse:
        try:
            q.put_nowait(sse_msg)
        except Exception:
            pass


def make_wav(pcm, sr=16000):
    vals = [max(-32768, min(32767, int(float(v) * 32767))) for v in pcm]
    raw = struct.pack("<%dh" % len(vals), *vals)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(raw)
    return buf.getvalue()


# ------------------------------------------------------------------ HTTP Handler
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SonoraBackend/" + VERSION

    def log_message(self, fmt, *args):
        if os.environ.get("VERBOSE"):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---- 基础响应 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _bytes(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        raw = self.rfile.read(n)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ---- GET ----
    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)
        try:
            if p == "/ws":
                return self.handle_ws()
            if p == "/api/events":
                return self.handle_sse()
            if p in ("/", "/index.html", "/dashboard.html"):
                return self.serve_static("dashboard.html")
            if p.startswith("/preview-") and p.endswith(".png"):
                return self.serve_static(p.lstrip("/"), "image/png")
            if p.endswith(".html") and "/" not in p.strip("/"):
                return self.serve_static(p.lstrip("/"))
            if "/" not in p.strip("/") and p.endswith((".js", ".css", ".json")):
                ctype = {".js": "application/javascript; charset=utf-8",
                         ".css": "text/css; charset=utf-8",
                         ".json": "application/json; charset=utf-8"}[p[p.rfind("."):]]
                return self.serve_static(p.lstrip("/"), ctype)
            if p == "/api/health":
                cfg = engine.load_config()["aigent"]
                age = (time.time() - _DEVICE["last"]) if _DEVICE["last"] else None
                return self._json({
                    "ok": True, "version": VERSION,
                    "engine": "aigent" if cfg.get("url") else "local-fft-mfcc",
                    "featureDim": engine.FEATURE_DIM,
                    "threshold": engine.MATCH_THRESHOLD,
                    "templates": engine.STORE.count_templates(),
                    "total": engine.STORE.list_history(1)["total"],
                    "wsClients": len(_WS_CLIENTS), "sseClients": len(_SSE_CLIENTS),
                    # 硬件链路状态：最近一次上报的时间与事件类型
                    "device": {
                        "online": bool(age is not None and age < 45),
                        "lastSeenSeconds": (round(age, 1) if age is not None else None),
                        "lastEvent": _DEVICE["ev"] or None,
                        "tplCount": _DEVICE["tpl"],
                        "events": _DEVICE["count"],
                    },
                })
            if p == "/api/config":
                cfg = engine.load_config()["aigent"]
                return self._json({"aigent": {
                    "url": cfg.get("url", ""), "mode": cfg.get("mode", "feature"),
                    "timeout": cfg.get("timeout", 3), "enabled": bool(cfg.get("url")),
                }})
            if p == "/api/templates":
                return self._json({"templates": engine.STORE.list_templates()})
            if p == "/api/device/templates":
                return self._json({"templates": list_device_templates()})
            if p == "/api/sounds":
                # 与 soundshape-core.js 共享同一份内置声音库元数据
                with open(os.path.join(ROOT, "sounds.json"), "r", encoding="utf-8") as f:
                    return self._json(json.load(f))
            if p == "/api/history":
                return self._json(engine.STORE.list_history(int(q.get("limit", [12])[0])))
            if p == "/api/demo.wav":
                hz = float(q.get("hz", [1000])[0])
                kind = q.get("kind", ["tone"])[0]
                dur = min(2.0, float(q.get("dur", [0.6])[0]))
                sr = 16000
                pcm = engine.synthesize(hz, kind, sr, dur)
                return self._bytes(make_wav(pcm, sr), "audio/wav")
            return self._json({"error": "not found", "path": p}, 404)
        except Exception as exc:
            traceback.print_exc()
            return self._json({"error": str(exc)}, 500)

    def serve_static(self, name, ctype="text/html; charset=utf-8"):
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path) or not os.path.abspath(path).startswith(ROOT):
            return self._json({"error": "file not found"}, 404)
        with open(path, "rb") as f:
            return self._bytes(f.read(), ctype)

    # ---- POST ----
    def do_POST(self):
        p = urlparse(self.path).path
        data = self._body()
        try:
            if p == "/api/train":
                res = engine.train(data.get("name"), data.get("samples"))
                broadcast({"type": "template_updated", "template": res["template"],
                           "samples": res["samples"], "feature7": res["feature7"],
                           "updatedAt": res["updatedAt"]})
                return self._json(res)

            if p == "/api/analyze":
                pcm, sr = engine.decode_sample(data)
                dry = bool(data.get("dryRun"))          # 自检/试跑：不写历史、不广播
                src = data.get("source", "mic")
                res = engine.analyze(pcm, sr, source=src, record=not dry)
                res["dryRun"] = dry
                if not dry:
                    broadcast({"type": "recognition", "eventId": res["eventId"],
                               "name": res["match"] or "未知声音",
                               "confidence": res["confidence"], "unknown": res["unknown"],
                               "engine": res["engine"], "source": src,
                               "time": res["event"]["time"], "total": res["total"]})
                return self._json(res)

            if p == "/api/device/event":
                # 硬件（ESP32）通过串口桥上报的事件
                return self._json(handle_device_event(data))

            if p == "/api/recognize":
                res = engine.recognize(data.get("feature"))
                broadcast({"type": "recognition", "eventId": res["eventId"],
                           "name": res["match"] or "未知声音",
                           "confidence": res["confidence"], "unknown": res["unknown"],
                           "engine": res["engine"], "source": "feature",
                           "time": time.time(),
                           "total": res["total"]})
                return self._json(res)

            if p == "/api/templates/delete":
                name = str(data.get("name", ""))
                engine.STORE.delete_template(name)
                broadcast({"type": "template_updated", "deleted": name})
                return self._json({"status": "ok", "deleted": name})

            if p == "/api/reset":
                engine.STORE.reset()
                broadcast({"type": "reset", "templates": [t["name"] for t in engine.STORE.list_templates()]})
                return self._json({"status": "ok", "templates": engine.STORE.count_templates()})

            return self._json({"error": "not found", "path": p}, 404)
        except ValueError as exc:
            return self._json({"error": str(exc)}, 400)
        except Exception as exc:
            traceback.print_exc()
            return self._json({"error": str(exc)}, 500)

    def do_DELETE(self):
        u = urlparse(self.path)
        if u.path == "/api/templates":
            name = parse_qs(u.query).get("name", [""])[0]
            engine.STORE.delete_template(name)
            broadcast({"type": "template_updated", "deleted": name})
            return self._json({"status": "ok", "deleted": name})
        return self._json({"error": "not found"}, 404)

    # ---- WebSocket ----
    def handle_ws(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            return self._json({"error": "expected websocket upgrade"}, 400)
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            pass

        sock = self.connection
        entry = (sock, self.rfile)
        with _LOCK:
            _WS_CLIENTS.add(entry)
        try:
            sock.sendall(_ws_frame(json.dumps({"type": "hello", "version": VERSION,
                                               "templates": engine.STORE.count_templates()})))
        except Exception:
            pass
        try:
            sock.settimeout(25)
            while True:
                try:
                    frame = _ws_read(self.rfile)
                except (TimeoutError, OSError):
                    try:
                        sock.sendall(b"\x89\x00")     # ping 保活
                        continue
                    except Exception:
                        break
                if frame is None:
                    break
                opcode, payload = frame
                if opcode == 8:
                    break
                if opcode == 9:
                    sock.sendall(_ws_frame(payload.decode("utf-8", "ignore"), 0x8A))
                elif opcode == 1:
                    try:
                        msg = json.loads(payload.decode("utf-8"))
                        if msg.get("type") == "ping":
                            sock.sendall(_ws_frame('{"type":"pong"}'))
                    except Exception:
                        pass
        except Exception:
            pass
        finally:
            with _LOCK:
                _WS_CLIENTS.discard(entry)
            self.close_connection = True

    # ---- SSE ----
    def handle_sse(self):
        q = queue.Queue()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self._cors()
        self.end_headers()
        with _LOCK:
            _SSE_CLIENTS.add(q)
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = ": ping\n\n"
                self.wfile.write(msg.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _LOCK:
                _SSE_CLIENTS.discard(q)
            self.close_connection = True


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _ensure_device_table():
    with engine.STORE.lock, engine.STORE.db:
        engine.STORE.db.execute(
            """CREATE TABLE IF NOT EXISTS device_templates(
                   name TEXT PRIMARY KEY,
                   bands TEXT NOT NULL,
                   updated_at TEXT NOT NULL)""")


def handle_device_event(data):
    """硬件上报：hello / hit / miss / learned / deleted

    硬件自己做识别（以硬件为主），后端只负责存档、广播、给大屏显示。
    """
    _ensure_device_table()

    ev = str(data.get("ev", "")).strip()
    label = str(data.get("label", "")).strip() or "未知声音"
    try:
        conf = float(data.get("conf") or 0.0)
    except (TypeError, ValueError):
        conf = 0.0
    bands = data.get("bands")

    # 不管什么事件，先记下"硬件还活着"
    _DEVICE["last"] = time.time()
    _DEVICE["ev"] = ev
    _DEVICE["count"] += 1
    if ev == "hello":
        _DEVICE["tpl"] = int(data.get("tpl") or 0)

    if ev == "hello":
        broadcast({"type": "device", "device": "online",
                   "templates": int(data.get("tpl") or 0)})
        return {"status": "ok", "templates": engine.STORE.count_templates()}

    if ev == "learned" and isinstance(bands, list) and len(bands) >= 4:
        vals = [round(float(x), 6) for x in bands]
        with engine.STORE.lock, engine.STORE.db:
            engine.STORE.db.execute(
                "INSERT INTO device_templates(name, bands, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(name) DO UPDATE SET bands=excluded.bands, updated_at=excluded.updated_at",
                (label, json.dumps(vals), time.strftime("%Y-%m-%d %H:%M:%S")))
        broadcast({"type": "device_learned", "name": label, "bands": vals})
        return {"status": "ok", "learned": label, "bands": len(vals)}

    if ev == "deleted":
        with engine.STORE.lock, engine.STORE.db:
            engine.STORE.db.execute("DELETE FROM device_templates WHERE name=?", (label,))
        broadcast({"type": "device_deleted", "name": label})
        return {"status": "ok", "deleted": label}

    if ev in ("hit", "miss"):
        unknown = (ev == "miss")
        rec = engine.STORE.add_history(label, conf, "device", unknown)
        broadcast({"type": "recognition", "eventId": rec["id"],
                   "name": label, "confidence": conf, "unknown": unknown,
                   "engine": "device", "source": "device",
                   "time": rec["time"], "total": rec["total"]})
        return {"status": "ok", "unknown": unknown, "total": rec["total"]}

    return {"status": "ignored", "ev": ev}


def list_device_templates():
    _ensure_device_table()
    with engine.STORE.lock:
        rows = engine.STORE.db.execute(
            "SELECT name, bands, updated_at FROM device_templates ORDER BY updated_at DESC").fetchall()
    return [{"name": r["name"], "bands": json.loads(r["bands"]),
             "updatedAt": r["updated_at"]} for r in rows]


def main():
    ap = argparse.ArgumentParser(description="声音的形状 · 本机声纹后端")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    ap.add_argument("--open", action="store_true",
                    help="启动后用默认浏览器打开独立窗口（本地化运行，避开预览面板 iframe）")
    args = ap.parse_args()
    cfg = engine.load_config()["aigent"]
    print("=" * 62)
    print("  声音的形状 · 声纹可视化平台后端  v" + VERSION)
    print("=" * 62)
    print("  页面地址   : http://%s:%d/" % (args.host, args.port))
    print("  健康检查   : http://%s:%d/api/health" % (args.host, args.port))
    print("  分析引擎   : %s" % ("aigent → " + cfg["url"] if cfg.get("url") else "本地 FFT + MFCC（零依赖）"))
    print("  模板库     : %d 个模板  |  数据库: %s" % (engine.STORE.count_templates(), engine.DB_PATH))
    print("  推送通道   : WebSocket /ws  ·  SSE /api/events")
    print("  独立窗口   : %s" % ("启动后自动打开浏览器 ✓" if args.open else "加 --open 可自动打开"))
    print("  停止服务   : Ctrl+C")
    print("=" * 62)
    sys.stdout.flush()
    if args.open:
        import webbrowser
        browser_host = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
        url = "http://%s:%d/" % (browser_host, args.port)
        # 延迟一点，等监听建立后再打开，避免首次连接失败
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        Server((args.host, args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
