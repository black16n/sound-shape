# -*- coding: utf-8 -*-
"""
声音的形状 · 声纹分析引擎（纯 Python 标准库，零第三方依赖）

职责：
  1. WAV / 裸 PCM 解码
  2. FFT + Mel 滤波器组 + DCT → 7 维基础声学特征 + 13 阶 MFCC
  3. 余弦相似度 + 加权距离 的模板匹配
  4. SQLite 持久化：声纹模板、识别历史、累计计数
  5. 可插拔 aigent 适配器：配置外部 AI 端点后自动接管分析，失败回退本地

特征契约（与 dashboard.html 保持一致）：
  feature[0:7]  = [过零率, 谱心(8kHz归一), 低频占比, 中频占比, 高频占比, 峰值因子, 响度]
  feature[7:20] = 13 阶 MFCC（tanh 压缩到 [-1,1]）
  FEATURE_DIM   = 20
"""

import base64
import io
import json
import math
import os
import sqlite3
import struct
import threading
import time
import urllib.error
import urllib.request
import wave

FEATURE_DIM = 20
BASIC_W = [1.35, 1.30, 1.00, 1.05, 1.10, 0.70, 0.35]
W_SUM = sum(BASIC_W)
MATCH_THRESHOLD = 0.70
BASE_TOTAL = 1284
N_FFT = 2048
N_MELS = 26
N_MFCC = 13

_ROOT = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("VOICEPRINT_DB", os.path.join(_ROOT, "voiceprint.db"))
CONFIG_PATH = os.environ.get("VOICEPRINT_CONFIG", os.path.join(_ROOT, "config.json"))


# ---------------------------------------------------------------- FFT / MFCC
def fft_magnitude(frame):
    """原地基 2 Cooley-Tukey FFT，返回 N/2 幅度谱。frame 为实数序列。"""
    n = len(frame)
    re = list(frame)
    im = [0.0] * n

    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            re[i], re[j] = re[j], re[i]

    size = 2
    while size <= n:
        half = size >> 1
        ang = -2.0 * math.pi / size
        wr_len, wi_len = math.cos(ang), math.sin(ang)
        for start in range(0, n, size):
            wr, wi = 1.0, 0.0
            for k in range(half):
                a, b = start + k, start + k + half
                vr = re[b] * wr - im[b] * wi
                vi = re[b] * wi + im[b] * wr
                re[b], im[b] = re[a] - vr, im[a] - vi
                re[a], im[a] = re[a] + vr, im[a] + vi
                nwr = wr * wr_len - wi * wi_len
                wi = wr * wi_len + wi * wr_len
                wr = nwr
        size <<= 1
    return [math.hypot(re[i], im[i]) for i in range(n // 2)]


def _hz2mel(hz):
    return 2595.0 * math.log10(1.0 + hz / 700.0)


def _mel2hz(mel):
    return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)


def _mel_filterbank(sr, n_fft=N_FFT, n_mels=N_MELS):
    fmax = sr / 2.0
    pts = [_mel2hz(_hz2mel(0) + (_hz2mel(fmax) - _hz2mel(0)) * i / (n_mels + 2))
           for i in range(n_mels + 2)]
    bins = [min(n_fft // 2, int(math.floor(p * n_fft / sr))) for p in pts]
    bank = []
    for m in range(1, n_mels + 1):
        left, center, right = bins[m - 1], bins[m], bins[m + 1]
        row = [0.0] * (n_fft // 2)
        for k in range(left, min(center, n_fft // 2)):
            if center > left:
                row[k] = (k - left) / (center - left)
        for k in range(center, min(right, n_fft // 2)):
            if right > center:
                row[k] = (right - k) / (right - center)
        bank.append(row)
    return bank


def _dct(values, n_out=N_MFCC):
    n = len(values)
    out = []
    for k in range(n_out):
        s = 0.0
        for i, v in enumerate(values):
            s += v * math.cos(math.pi * k * (i + 0.5) / n)
        out.append(math.tanh(s / (n * 8.0)))   # 压缩到 [-1,1]，便于余弦比对
    return out


def _frame_features(frame, sr, bank):
    n = len(frame)
    energy = 0.0
    peak = 0.0
    cross = 0
    windowed = [0.0] * n
    for i, v in enumerate(frame):
        energy += v * v
        peak = max(peak, abs(v))
        if i and (v >= 0) != (frame[i - 1] >= 0):
            cross += 1
        windowed[i] = v * (0.54 - 0.46 * math.cos(2.0 * math.pi * i / (n - 1)))
    rms = math.sqrt(energy / n)

    mag = fft_magnitude(windowed)
    power = [m * m for m in mag]
    total = sum(power[1:]) or 1e-12
    wsum = sum(i * (sr / n) * power[i] for i in range(1, len(power)))
    low = sum(power[i] for i in range(1, len(power)) if i * sr / n < 350)
    mid = sum(power[i] for i in range(1, len(power)) if 350 <= i * sr / n < 2000)
    high = sum(power[i] for i in range(1, len(power)) if 2000 <= i * sr / n < 12000)
    centroid = wsum / (total * 8000.0)

    basic = [
        min(1.0, cross / n * 4.0),
        min(1.0, max(0.0, centroid)),
        low / total, mid / total, high / total,
        min(1.0, peak / (rms + 1e-6) / 10.0),
        min(1.0, rms * 12.0),
    ]
    mel = [math.log(sum(power[k] * row[k] for k in range(len(power))) + 1e-10)
           for row in bank]
    mfcc = _dct(mel)
    return basic, mfcc, rms


def analyze_pcm(pcm, sr):
    """整段 PCM(float) → 20 维特征。取能量较高的 70% 帧做加权平均。"""
    sr = int(sr or 16000)
    pcm = [float(v) for v in pcm]
    if not pcm:
        return {"feature": [0.0] * FEATURE_DIM, "feature7": [0.0] * 7,
                "duration": 0.0, "frames": 0}
    bank = _mel_filterbank(sr)
    n, hop, max_frames = N_FFT, 1024, 64
    stride = max(hop, (len(pcm) - n) // max_frames) if len(pcm) > n + max_frames * hop else hop
    frames = []
    for off in range(0, len(pcm) - n + 1, stride):
        basic, mfcc, rms = _frame_features(pcm[off:off + n], sr, bank)
        if rms < 0.002:
            continue
        frames.append((basic + mfcc, rms))
        if len(frames) >= max_frames:
            break
    if not frames:
        return {"feature": [0.0] * FEATURE_DIM, "feature7": [0.0] * 7,
                "duration": len(pcm) / sr, "frames": 0}
    frames.sort(key=lambda x: -x[1])
    keep = frames[:max(1, math.ceil(len(frames) * 0.7))]
    feat = [sum(f[0][i] for f in keep) / len(keep) for i in range(FEATURE_DIM)]
    return {"feature": feat, "feature7": feat[:7],
            "duration": len(pcm) / sr, "frames": len(frames)}


# ---------------------------------------------------------------- WAV / PCM 解码
def decode_wav(data):
    with wave.open(io.BytesIO(data)) as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        vals = struct.unpack("<%dh" % (len(raw) // 2), raw)
        pcm = [v / 32768.0 for v in vals]
    elif sw == 4:
        vals = struct.unpack("<%df" % (len(raw) // 4), raw)
        pcm = list(vals)
    elif sw == 1:
        pcm = [(b - 128) / 128.0 for b in raw]
    else:
        raise ValueError("不支持的采样位宽: %d" % sw)
    if ch > 1:
        pcm = pcm[::ch]
    return pcm, sr


def decode_sample(sample):
    """接受 {wav:<base64>} / {pcm:[...], sampleRate} / {pcmBase64, sampleRate}。"""
    if not isinstance(sample, dict):
        raise ValueError("样本格式错误")
    if sample.get("wav"):
        return decode_wav(base64.b64decode(sample["wav"]))
    if sample.get("pcmBase64"):
        raw = base64.b64decode(sample["pcmBase64"])
        vals = struct.unpack("<%dh" % (len(raw) // 2), raw)
        return [v / 32768.0 for v in vals], int(sample.get("sampleRate", 16000))
    pcm = sample.get("pcm")
    if isinstance(pcm, list):
        return pcm, int(sample.get("sampleRate", 16000))
    raise ValueError("样本缺少 wav / pcm / pcmBase64")


# ---------------------------------------------------------------- 相似度
def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-8
    nb = math.sqrt(sum(y * y for y in b)) or 1e-8
    return max(0.0, min(1.0, dot / (na * nb)))


def weighted_distance(a, b):
    return sum(w * abs(x - y) for w, x, y in zip(BASIC_W, a[:7], b[:7])) / W_SUM


def match_score(feature, template_feature):
    cos = cosine(feature, template_feature)
    d7 = weighted_distance(feature, template_feature)
    local = max(0.0, min(1.0, 1.0 - d7 / 0.30))
    return 0.55 * cos + 0.45 * local


# ---------------------------------------------------------------- SQLite 存储
class Store:
    def __init__(self, path=DB_PATH):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._init()

    def _init(self):
        with self.lock, self.db:
            self.db.execute("""CREATE TABLE IF NOT EXISTS templates(
                name TEXT PRIMARY KEY, feature TEXT NOT NULL, feature7 TEXT NOT NULL,
                samples INTEGER NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'local')""")
            self.db.execute("""CREATE TABLE IF NOT EXISTS history(
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                confidence REAL NOT NULL, source TEXT NOT NULL,
                ts REAL NOT NULL, unknown INTEGER NOT NULL DEFAULT 0)""")
            self.db.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            self.db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('total','%d')" % BASE_TOTAL)
        if self.count_templates() == 0:
            self.seed()
        if self._history_count() == 0:
            self.seed_history()

    def _history_count(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM history").fetchone()[0]

    def seed_history(self):
        """种子历史：让平台首屏就有「持续运行」的时间线数据。"""
        now = time.time()
        rows = [
            ("门铃", 0.972, 120), ("敲门", 0.948, 660), ("门铃", 0.981, 1440),
            ("婴儿哭", 0.936, 2460), ("门铃", 0.964, 3480), ("玻璃碎裂", 0.919, 4560),
            ("敲门", 0.953, 5640), ("门铃", 0.978, 6720),
        ]
        with self.lock, self.db:
            for name, conf, ago in rows:
                self.db.execute(
                    "INSERT INTO history(name,confidence,source,ts,unknown) VALUES(?,?,?,?,0)",
                    (name, conf, "demo", now - ago))

    def seed(self):
        """用合成信号为 4 个内置样例生成真实 20 维原型，免去手工调参。"""
        sr = 16000
        specs = [
            ("门铃", 1000, "tone", False),
            ("敲门", 150, "impulse", False),
            ("婴儿哭", 700, "sweep", False),
            ("玻璃碎裂", 4500, "noise", True),
        ]
        for name, hz, kind, custom in specs:
            pcm = synthesize(hz, kind, sr, 0.6)
            feat = analyze_pcm(pcm, sr)["feature"]
            self.put_template(name, feat, samples=5, source="seed")

    # ---- templates
    def count_templates(self):
        with self.lock:
            return self.db.execute("SELECT COUNT(*) FROM templates").fetchone()[0]

    def list_templates(self):
        with self.lock:
            rows = self.db.execute("SELECT * FROM templates ORDER BY created_at").fetchall()
        return [{
            "name": r["name"], "feature": json.loads(r["feature"]),
            "feature7": json.loads(r["feature7"]), "samples": r["samples"],
            "createdAt": r["created_at"], "updatedAt": r["updated_at"],
            "source": r["source"],
        } for r in rows]

    def get_template(self, name):
        for t in self.list_templates():
            if t["name"] == name:
                return t
        return None

    def put_template(self, name, feature, samples=1, source="local"):
        now_iso = time.strftime("%Y-%m-%d %H:%M:%S")
        with self.lock, self.db:
            self.db.execute("""INSERT INTO templates(name,feature,feature7,samples,created_at,updated_at,source)
                VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(name) DO UPDATE SET feature=excluded.feature,
                    feature7=excluded.feature7, samples=excluded.samples,
                    updated_at=excluded.updated_at, source=excluded.source""",
                (name, json.dumps(feature), json.dumps(feature[:7]), samples, now_iso, now_iso, source))
        return self.get_template(name)

    def delete_template(self, name):
        with self.lock, self.db:
            self.db.execute("DELETE FROM templates WHERE name=?", (name,))

    # ---- history
    def add_history(self, name, confidence, source, unknown=False):
        ts = time.time()
        with self.lock, self.db:
            self.db.execute("INSERT INTO history(name,confidence,source,ts,unknown) VALUES(?,?,?,?,?)",
                            (name, float(confidence), source, ts, 1 if unknown else 0))
            self.db.execute("UPDATE meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='total'")
            total = int(self.db.execute("SELECT value FROM meta WHERE key='total'").fetchone()[0])
        return {"id": ts, "name": name, "confidence": round(float(confidence), 4),
                "source": source, "time": ts, "unknown": bool(unknown), "total": total}

    def list_history(self, limit=12):
        with self.lock:
            rows = self.db.execute("SELECT * FROM history ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
            total = int(self.db.execute("SELECT value FROM meta WHERE key='total'").fetchone()[0])
        return {"logs": [{
            "name": r["name"], "confidence": r["confidence"], "source": r["source"],
            "time": r["ts"], "unknown": bool(r["unknown"]),
        } for r in rows], "total": total}

    def reset(self):
        with self.lock, self.db:
            self.db.execute("DELETE FROM history")
            self.db.execute("DELETE FROM templates")
            self.db.execute("UPDATE meta SET value=? WHERE key='total'", (str(BASE_TOTAL),))
        self.seed()
        self.seed_history()


def synthesize(hz, kind, sr=16000, dur=0.6):
    """合成测试/种子信号：纯音、扫频、脉冲串、宽带噪声。"""
    n = int(sr * dur)
    out = []
    phase = 0.0
    for i in range(n):
        t = i / sr
        if kind == "impulse":
            v = math.sin(2 * math.pi * hz * t) * (0.9 if i % (sr // 8) < sr // 60 else 0.02)
        elif kind == "sweep":
            f = hz * (0.7 + 0.6 * t / dur)
            phase += 2 * math.pi * f / sr
            v = 0.6 * math.sin(phase) + 0.15 * math.sin(2 * math.pi * f * 2.1 * t)
        elif kind == "noise":
            v = 0.35 * math.sin(2 * math.pi * hz * t) + 0.25 * (((i * 1103515245 + 12345) & 0xffff) / 32768.0 - 1)
        else:
            v = 0.5 * math.sin(2 * math.pi * hz * t) + 0.2 * math.sin(2 * math.pi * hz * 2 * t)
        out.append(v)
    return out


# ---------------------------------------------------------------- aigent 适配器
def load_config():
    cfg = {"aigent": {"url": "", "token": "", "mode": "feature", "timeout": 3}}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            user = json.load(f)
        cfg["aigent"].update(user.get("aigent", {}))
    except (OSError, ValueError, TypeError):
        pass
    env_url = os.environ.get("AIGENT_URL")
    if env_url:
        cfg["aigent"]["url"] = env_url
    if os.environ.get("AIGENT_TOKEN"):
        cfg["aigent"]["token"] = os.environ["AIGENT_TOKEN"]
    return cfg


def agent_recognize(feature, feature7, pcm=None, sr=None):
    """把特征（或原始 PCM）POST 给外部 aigent；返回标准化结果或 None。"""
    a = load_config()["aigent"]
    url = a.get("url")
    if not url:
        return None
    body = {"feature": feature, "feature7": feature7, "sampleRate": sr,
            "templates": [t["name"] for t in STORE.list_templates()]}
    if a.get("mode") == "pcm" and pcm:
        raw = struct.pack("<%dh" % len(pcm), *[max(-32768, min(32767, int(v * 32767))) for v in pcm[:sr or 16000]])
        body["pcmBase64"] = base64.b64encode(raw).decode()
    headers = {"Content-Type": "application/json"}
    if a.get("token"):
        headers["Authorization"] = "Bearer " + a["token"]
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=float(a.get("timeout", 3))) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError, TimeoutError):
        return None
    if not isinstance(data, dict):
        return None
    name = data.get("match") or data.get("label") or data.get("name")
    conf = data.get("confidence", data.get("score"))
    if conf is None:
        return None
    try:
        conf = float(conf)
    except (TypeError, ValueError):
        return None
    if conf > 1.0:
        conf /= 100.0
    return {"match": name if conf >= MATCH_THRESHOLD else None,
            "confidence": max(0.0, min(1.0, conf)), "engine": "aigent"}


# ---------------------------------------------------------------- 对外主流程
STORE = Store()


def train(name, samples):
    """训练：多段样本 → 各自 20 维特征 → 取平均 → 写入 SQLite。"""
    name = str(name or "").strip()[:24]
    if not name:
        raise ValueError("模板名不能为空")
    if not isinstance(samples, list) or not samples:
        raise ValueError("至少提供 1 段样本")
    feats = []
    for s in samples:
        # 支持三种样本：① 特征数组（用户示例 / 前端已提取）② {feature|feature7} ③ WAV / PCM
        if isinstance(s, list):
            f = [float(v) for v in s]
        elif isinstance(s, dict) and (s.get("feature") or s.get("feature7")):
            f = [float(v) for v in (s.get("feature") or s.get("feature7"))]
        else:
            pcm, sr = decode_sample(s)
            feats.append(analyze_pcm(pcm, sr)["feature"])
            continue
        f = (f + [0.0] * FEATURE_DIM)[:FEATURE_DIM]
        feats.append(f)
    avg = [sum(f[i] for f in feats) / len(feats) for i in range(FEATURE_DIM)]
    spread = sum(weighted_distance(f, avg) for f in feats) / len(feats)
    tpl = STORE.put_template(name, avg, samples=len(feats), source="trained")
    return {"status": "ok", "template": name, "feature": avg,
            "feature7": avg[:7], "samples": len(feats),
            "consistency": round(max(0.0, 1.0 - spread * 4.0), 4),
            "updatedAt": tpl["updatedAt"]}


def analyze(pcm, sr, source="mic", record=True):
    """实时识别：WAV/PCM → 特征 → aigent 或本地模板匹配 → 写历史，返回结果。
    record=False 用于自检 / 试跑：只返回匹配结果，不污染识别历史与计数。"""
    info = analyze_pcm(pcm, sr)
    feat = info["feature"]
    result = None
    engine = "local"
    try:
        result = agent_recognize(feat, info["feature7"], pcm=pcm, sr=sr)
    except Exception:
        result = None
    if result is None:
        engine = "aigent-fallback" if load_config()["aigent"].get("url") else "local"
        best_name, best_score = None, 0.0
        for tpl in STORE.list_templates():
            score = match_score(feat, tpl["feature"])
            if score > best_score:
                best_name, best_score = tpl["name"], score
        result = {"match": best_name if best_score >= MATCH_THRESHOLD else None,
                  "confidence": best_score, "engine": engine}
    hit = result["match"]
    conf = float(result["confidence"])
    if record:
        event = STORE.add_history(hit or "未知声音", conf if hit else min(conf, 0.69),
                                  source, unknown=not bool(hit))
    else:
        event = {"id": time.time(), "name": hit or "未知声音", "confidence": conf,
                 "source": source, "time": time.time(), "unknown": not bool(hit),
                 "total": STORE.list_history(1)["total"]}
    return {
        "match": hit, "confidence": round(conf, 4), "unknown": not bool(hit),
        "engine": result.get("engine", engine), "feature": feat,
        "feature7": info["feature7"], "duration": round(info["duration"], 3),
        "frames": info["frames"], "eventId": event["id"], "total": event["total"],
        "event": event,
    }


def recognize(feature):
    """仅传特征（前端已提好 7 维）时的轻量比对，用于 /api/recognize。"""
    if not isinstance(feature, list) or len(feature) < 7:
        raise ValueError("feature 至少需要 7 维")
    f = [float(v) for v in feature]
    if len(f) < FEATURE_DIM:
        f += [0.0] * (FEATURE_DIM - len(f))
    best_name, best_score = None, 0.0
    for tpl in STORE.list_templates():
        score = match_score(f, tpl["feature"])
        if score > best_score:
            best_name, best_score = tpl["name"], score
    hit = best_name if best_score >= MATCH_THRESHOLD else None
    event = STORE.add_history(hit or "未知声音", best_score if hit else min(best_score, 0.69),
                              "feature", unknown=not bool(hit))
    return {"match": hit, "confidence": round(best_score, 4),
            "unknown": not bool(hit), "engine": "local",
            "eventId": event["id"], "total": event["total"], "event": event}
