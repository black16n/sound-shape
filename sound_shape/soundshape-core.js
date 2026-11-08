/* =====================================================================
 * soundshape-core.js · 声音的形状「识别引擎 + 训练库」可复用核心
 * ---------------------------------------------------------------------
 * 来源：sound-shape/app.js（规则分类 / 帧特征 / 模板匹配 / 合成音 / WAV）
 * 改造：UMD、无 DOM 依赖，既可被 dashboard.html 直接 <script src> 引入，
 *       也可被 Node 测试 require。
 *
 * 导出：
 *   SOUNDS / SOUND_MAP / LIVE_KEYS / COLORS / REGIONS / REGION_NAME
 *   SSAnalyzer          帧级 13 特征（能量/噪声底/谱质心/谱平坦度/过零率/
 *                       峰值频率/频段占比/分散度/谱通量/基频/稳态性…）
 *   scoreAll / classifySS   13 类规则识别
 *   vecOf / matchVecs       11 维多样本最近邻训练库匹配
 *   antiAlias / encodeWav16k 抗混叠降采样 + 16k/16bit WAV 编码
 *   createSynth(ctx)        15 个内置声音的合成音试听
 * ===================================================================== */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SoundShapeCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------------------------------------------------------- 工具 */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function near(v, lo, hi, soft) {
  if (v >= lo && v <= hi) return 1;
  var d = v < lo ? lo - v : v - hi;
  return clamp01(1 - d / soft);
}
function wavg(items) {
  var s = 0, w = 0;
  for (var i = 0; i < items.length; i++) { s += items[i][0] * items[i][1]; w += items[i][0]; }
  return w ? s / w : 0;
}
function nextPow2(n) { var p = 1; while (p < n) p <<= 1; return p; }

/* ---------------------------------------------------------- 常量 */
var COLORS = { voice: '#7FE9FF', env: '#FFB15C', nature: '#7BE495', danger: '#FF5A5A' };
var CAT_NAME = { voice: '人声', env: '环境声', nature: '自然声' };
var REGIONS = { door: [0, 15], kitchen: [16, 31], room: [32, 47], window: [48, 63], all: [0, 63] };
var REGION_NAME = { door: '门口', kitchen: '厨房', room: '室内', window: '窗外', all: '全屋' };
var SEGMENTS = 64;

/* 15 个内置声音：颜色=类别，位置=声源，节奏=是哪一个声音，文字=确认 */
var SOUNDS = [
  { key:'speech',   name:'说话',  cat:'voice',  icon:'🗣️', region:'all',     mode:'sustain', desc:'连续、带音节起伏的谐波声，能量在中频' },
  { key:'shout',    name:'喊叫',  cat:'voice',  icon:'📢', region:'all',     mode:'sustain', desc:'突发、高能量、起始很快的人声' },
  { key:'laugh',    name:'笑声',  cat:'voice',  icon:'😄', region:'all',     mode:'pulse', rhythm:[0,140,280,420], desc:'一串短促爆发，约每秒 4–6 次' },
  { key:'cry',      name:'哭声',  cat:'voice',  icon:'😢', region:'all',     mode:'sustain', desc:'高基频、长持续、带颤音' },

  { key:'doorbell', name:'门铃',  cat:'env',    icon:'🔔', region:'door',    mode:'pulse', rhythm:[0,430], desc:'两个稳定音高，"叮—咚"，音高几乎不抖' },
  { key:'knock',    name:'敲门',  cat:'env',    icon:'✊', region:'door',    mode:'pulse', rhythm:[0,160,320], desc:'二到五下低频冲击，间隔 150–400ms' },
  { key:'boiling',  name:'水开',  cat:'env',    icon:'💧', region:'kitchen', mode:'sustain', desc:'宽带嘶声，谱平坦度高，持续数十秒' },
  { key:'phone',    name:'电话',  cat:'env',    icon:'📞', region:'room',    mode:'pulse', rhythm:[0,600,1200], desc:'稳定双音、规律重复的铃声' },
  { key:'alarm',    name:'警报',  cat:'env',    icon:'🚨', region:'all',     mode:'pulse', rhythm:[0,180,360,540], danger:true, desc:'约 3kHz 的严格周期脉冲，绝不可漏' },

  { key:'wind',     name:'风声',  cat:'nature', icon:'🍃', region:'window',  mode:'sustain', desc:'能量集中在低频，缓慢起伏，几乎没有起始' },
  { key:'rain',     name:'雨声',  cat:'nature', icon:'🌧️', region:'window',  mode:'sustain', desc:'宽带、高频丰富、细密连续的沙沙声' },
  { key:'thunder',  name:'雷声',  cat:'nature', icon:'⚡', region:'window',  mode:'pulse', rhythm:[0], danger:true, desc:'极强低频冲击，衰减很长' },
  { key:'bird',     name:'鸟鸣',  cat:'nature', icon:'🐦', region:'window',  mode:'pulse', rhythm:[0,120,240], desc:'高频、快速扫频的短促音节' },
  { key:'horn',     name:'车笛',  cat:'nature', icon:'🚗', region:'window',  mode:'pulse', rhythm:[0], desc:'350–600Hz 稳定音高，0.2–1.5 秒' },
  { key:'traffic',  name:'车流',  cat:'nature', icon:'🛣️', region:'window',  mode:'sustain', desc:'低频为主、缓慢变化的持续噪声' }
];
var SOUND_MAP = {};
SOUNDS.forEach(function (s) { SOUND_MAP[s.key] = s; });
/* 实时参与规则识别的 13 类（笑声 / 哭声留给声音库展示） */
var LIVE_KEYS = ['speech','shout','doorbell','knock','boiling','phone','alarm',
                 'wind','rain','thunder','bird','horn','traffic'];

/* ---------------------------------------------------------- FFT（原地基 2） */
function fft(re, im) {
  var n = re.length, j = 0, i, k, bit;
  for (i = 1; i < n; i++) {
    bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j |= bit;
    if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (var size = 2; size <= n; size <<= 1) {
    var half = size >> 1, ang = -2 * Math.PI / size;
    var wl_r = Math.cos(ang), wl_i = Math.sin(ang);
    for (i = 0; i < n; i += size) {
      var wr = 1, wi = 0;
      for (k = 0; k < half; k++) {
        var a = i + k, b = a + half;
        var vr = re[b] * wr - im[b] * wi, vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        var nwr = wr * wl_r - wi * wl_i;
        wi = wr * wl_i + wi * wl_r; wr = nwr;
      }
    }
  }
}

/* ---------------------------------------------------------- 帧特征分析器 */
function SSAnalyzer(sr, N) {
  this.sr = sr || 48000;
  this.N = N || nextPow2(Math.round(this.sr * 0.032));
  this.binHz = this.sr / this.N;
  var half = this.N >> 1;
  this.win = new Float32Array(this.N);
  for (var i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.N - 1));
  this.kLo = Math.max(1, Math.floor(80 / this.binHz));
  this.kHi = Math.min(half - 2, Math.ceil(8000 / this.binHz));
  this.prevMag = null;
  this.floor = -70;
  this.env = [];
  this.modLo = 0; this.modHi = 0; this.steady = true;
  this.frameCount = 0;
  this.pitch = 0; this.pitchConf = 0;
  this.lastMag = new Float32Array(half);
}

SSAnalyzer.prototype.pitchOf = function (frame) {
  var dec = 2, srd = this.sr / dec, n = Math.floor(frame.length / dec);
  if (n < 64) return [0, 0];
  var x = new Float32Array(n), mean = 0, i;
  for (i = 0; i < frame.length; i++) mean += frame[i];
  mean /= frame.length;
  for (i = 0; i < n; i++) x[i] = 0.5 * ((frame[2*i] - mean) + (frame[2*i+1] - mean));
  var minLag = Math.max(2, Math.floor(srd / 800));
  var maxLag = Math.min(n - 2, Math.floor(srd / 70));
  if (maxLag <= minLag + 2) return [0, 0];
  var best = 0, bestLag = 0, corr = new Float32Array(maxLag + 2);
  for (var lag = minLag; lag <= maxLag; lag++) {
    var s = 0, e1 = 0, e2 = 0, lim = n - lag;
    for (i = 0; i < lim; i++) { var a = x[i], b = x[i + lag]; s += a*b; e1 += a*a; e2 += b*b; }
    var c = s / (Math.sqrt(e1 * e2) + 1e-12);
    corr[lag] = c;
    if (c > best) { best = c; bestLag = lag; }
  }
  if (bestLag <= 0) return [0, 0];
  /* 取「不低于最高峰 85% 的最早局部峰」，避免纯音掉到低八度 */
  var chosen = 0, thresh = best * 0.85;
  for (var l = minLag + 1; l < maxLag; l++) {
    if (corr[l] >= thresh && corr[l] >= corr[l-1] && corr[l] >= corr[l+1]) { chosen = l; break; }
  }
  if (!chosen) chosen = bestLag;
  var outLag = chosen;
  var pa = corr[chosen-1] || 0, pb = corr[chosen], pc = corr[chosen+1] || 0;
  var den = pa - 2*pb + pc;
  if (Math.abs(den) > 1e-9) outLag = chosen + 0.5 * (pa - pc) / den;
  return [srd / outLag, clamp01(best)];
};

SSAnalyzer.prototype.updateMod = function () {
  var n = this.env.length;
  if (n < 80) return;
  var use = Math.min(128, n), buf = new Float32Array(128), mean = 0, start = n - use, i;
  for (i = 0; i < use; i++) { buf[i] = this.env[start + i]; mean += buf[i]; }
  mean /= use;
  for (i = 0; i < use; i++) buf[i] = (buf[i] - mean) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (use - 1)));
  var re = Float32Array.from(buf), im = new Float32Array(128);
  fft(re, im);
  var lo = 0, hi = 0, k;
  for (k = 0; k <= 2; k++) lo += Math.hypot(re[k], im[k]);
  for (k = 4; k <= 10; k++) hi += Math.hypot(re[k], im[k]);
  this.modLo = lo; this.modHi = hi;
  this.steady = (lo + hi) < 1e-3;   // 完全平稳 = 极稳态，不是「不稳态」
};

SSAnalyzer.prototype.process = function (frame) {
  var N = this.N, binHz = this.binHz, half = N >> 1, i, k;
  var mean = 0;
  for (i = 0; i < N; i++) mean += frame[i];
  mean /= N;
  var re = new Float32Array(N), im = new Float32Array(N);
  for (i = 0; i < N; i++) { re[i] = (frame[i] - mean) * this.win[i]; im[i] = 0; }
  fft(re, im);
  var mag = new Float32Array(half);
  for (k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
  this.lastMag = mag;

  var kLo = this.kLo, kHi = this.kHi, span = kHi - kLo + 1;
  var sumP = 0, sumF = 0, sumLog = 0, peakK = kLo, peakM = -1;
  for (k = kLo; k <= kHi; k++) {
    if (mag[k] > peakM) { peakM = mag[k]; peakK = k; }
    var p = mag[k] * mag[k] + 1e-12;
    sumP += p; sumF += k * binHz * p; sumLog += Math.log(p);
  }
  var SC = sumF / (sumP + 1e-12);
  var SF = Math.exp(sumLog / span) / (sumP / span + 1e-12);
  var peakF = peakK * binHz;

  var e = 0;
  for (i = 0; i < N; i++) e += frame[i] * frame[i];
  var EdB = 10 * Math.log10(e / N + 1e-12);
  if (EdB < this.floor) this.floor = this.floor * 0.8 + EdB * 0.2;
  else this.floor = this.floor * 0.9993 + EdB * 0.0007;
  this.floor = clamp(this.floor, -95, -10);

  var flux = 0;
  if (this.prevMag) {
    var num = 0, den = 1e-9;
    for (k = 0; k < half; k++) { var d = mag[k] - this.prevMag[k]; if (d > 0) num += d; den += this.prevMag[k]; }
    flux = num / den;
  }
  this.prevMag = mag;

  var low = 0, mid = 0, high = 0;
  for (k = 0; k < half; k++) {
    var f = k * binHz, pp = mag[k] * mag[k];
    if (f >= 80 && f < 500) low += pp;
    else if (f >= 500 && f < 2000) mid += pp;
    else if (f >= 2000 && f < 6000) high += pp;
  }
  var tot = low + mid + high + 1e-12;
  var zc = 0;
  for (i = 1; i < N; i++) if ((frame[i-1] < 0) !== (frame[i] < 0)) zc++;
  var ZCR = zc / N;

  this.frameCount++;
  if (this.frameCount % 5 === 0) {
    var pc = this.pitchOf(frame);
    this.pitch = pc[0]; this.pitchConf = pc[1];
  }
  this.env.push(EdB);
  if (this.env.length > 320) this.env.shift();
  if (this.frameCount % 10 === 0) this.updateMod();
  var tonality = this.steady ? 6 : this.modLo / (this.modHi + 1e-9);
  var lowR = low / tot, midR = mid / tot, highR = high / tot;
  return {
    E: EdB, floor: this.floor, snr: EdB - this.floor,
    SC: SC, SF: SF, ZCR: ZCR, peakF: peakF,
    low: lowR, mid: midR, high: highR,
    spread: 1 - Math.max(lowR, midR, highR),
    flux: flux, pitch: this.pitch, pitchConf: this.pitchConf,
    tonality: clamp(tonality, 0, 8), mag: mag
  };
};

/* 平滑状态（指数平滑 + 持续时长），供规则分类使用 */
function newSmooth() {
  return { E:-90, snr:0, SC:400, SF:0.2, ZCR:0.1, peakF:500,
           low:0.3, mid:0.4, high:0.3, spread:0.3,
           flux:0, pitch:0, pitchConf:0, tonality:1, dur:0 };
}
function smooth(sf, f, dtMs) {
  var a = 0.22, keys = ['E','snr','SC','SF','ZCR','peakF','low','mid','high','spread','flux','pitchConf','tonality'];
  for (var i = 0; i < keys.length; i++) { var k = keys[i]; sf[k] = sf[k] * (1 - a) + f[k] * a; }
  sf.pitch = f.pitch || sf.pitch;
  sf.dur = sf.snr > 5 ? sf.dur + dtMs : 0;
  return sf;
}

/* ---------------------------------------------------------- 13 类规则识别 */
function scoreAll(f) {
  var s = {};
  s.speech = wavg([[1.2,1-clamp01((f.SF-0.10)/0.22)],[1.0,near(f.SC,350,2600,700)],
    [1.0,clamp01((f.pitchConf-0.15)/0.45)],[0.8,near(f.pitch,80,380,130)],
    [1.0,clamp01((f.snr-4)/12)],[1.3,1-clamp01((f.tonality-1.0)/2.0)],[1.0,clamp01(f.spread/0.35)]]);
  s.shout = wavg([[1.6,clamp01((f.snr-14)/14)],[1.0,1-clamp01((f.SF-0.10)/0.20)],
    [0.8,near(f.SC,500,3200,900)],[0.8,clamp01((f.pitchConf-0.2)/0.5)],
    [0.7,1-clamp01((f.tonality-1.0)/2.0)],[0.9,clamp01(f.spread/0.35)]]);
  s.doorbell = wavg([[1.7,clamp01((f.tonality-1.2)/2.2)],[1.0,clamp01((f.pitchConf-0.45)/0.45)],
    [1.2,near(f.pitch,450,1700,380)],[1.4,near(f.peakF,450,2200,600)],
    [1.0,near(f.SC,700,3200,900)],[0.8,1-clamp01((f.SF-0.10)/0.18)],[0.8,clamp01((f.snr-6)/14)]]);
  s.knock = wavg([[1.4,near(f.SC,100,950,520)],[1.3,clamp01((f.low-0.20)/0.40)],
    [1.0,1-clamp01((f.SF-0.12)/0.28)],[1.5,clamp01((f.flux-0.12)/0.45)],[0.8,clamp01((f.snr-8)/14)]]);
  s.boiling = wavg([[1.9,clamp01((f.SF-0.22)/0.30)],[1.2,clamp01((f.SC-1900)/2600)],
    [1.0,clamp01((f.dur-600)/2400)],[1.0,1-clamp01((f.flux-0.10)/0.25)],[0.6,clamp01((f.snr-4)/12)]]);
  s.phone = wavg([[1.4,clamp01((f.tonality-1.0)/2.0)],[1.0,clamp01((f.pitchConf-0.40)/0.40)],
    [1.0,near(f.pitch,330,1200,300)],[1.0,near(f.peakF,400,1200,350)],
    [1.0,near(f.SC,500,2600,800)],[0.7,clamp01((f.snr-6)/14)]]);
  s.alarm = wavg([[1.8,clamp01((f.tonality-1.5)/2.5)],[2.0,near(f.peakF,2600,3800,600)],
    [1.2,clamp01((f.SC-1800)/1200)],[1.0,clamp01((f.snr-10)/18)],[0.9,1-clamp01((f.SF-0.10)/0.25)]]);
  s.wind = wavg([[1.7,clamp01((f.low-0.35)/0.35)],[1.3,clamp01((f.SF-0.25)/0.35)],
    [1.2,clamp01((f.dur-1200)/2500)],[1.0,1-clamp01((f.flux-0.08)/0.25)],[0.8,1-clamp01((f.pitchConf-0.2)/0.4)]]);
  s.rain = wavg([[1.7,clamp01((f.SF-0.32)/0.30)],[1.5,clamp01((f.SC-2600)/2500)],
    [1.0,clamp01((f.dur-1200)/2500)],[1.0,1-clamp01((f.pitchConf-0.2)/0.4)]]);
  s.thunder = wavg([[1.7,clamp01((f.snr-16)/16)],[1.4,clamp01((f.low-0.30)/0.40)],
    [2.0,clamp01((f.flux-0.30)/0.50)],[0.8,1-clamp01((f.SF-0.15)/0.30)]]);
  s.bird = wavg([[1.8,clamp01((f.SC-2400)/2600)],[1.5,clamp01((f.high-0.35)/0.40)],
    [1.0,clamp01((f.tonality-0.6)/1.5)],[0.8,1-clamp01((f.dur-1500)/2500)]]);
  s.horn = wavg([[1.7,clamp01((f.pitchConf-0.50)/0.40)],[1.3,near(f.pitch,280,700,160)],
    [1.2,near(f.peakF,300,750,220)],[1.0,clamp01((f.tonality-0.8)/1.8)],
    [0.8,near(f.dur,150,2200,900)],[0.8,clamp01((f.snr-8)/14)]]);
  s.traffic = wavg([[1.4,clamp01((f.low-0.25)/0.35)],[1.2,near(f.SF,0.12,0.50,0.30)],
    [1.2,clamp01((f.dur-1500)/2500)],[1.0,1-clamp01((f.flux-0.10)/0.30)]]);
  return s;
}

/* 规则分类 + 可选自定义模板（自定义优先，与原工程策略一致） */
function classifySS(f, custom) {
  var scores = scoreAll(f), bestKey = null, bestVal = 0;
  var cat = { voice: 0, env: 0, nature: 0 };
  for (var i = 0; i < LIVE_KEYS.length; i++) {
    var k = LIVE_KEYS[i], v = scores[k] || 0, c = SOUND_MAP[k].cat;
    if (v > cat[c]) cat[c] = v;
    if (v > bestVal) { bestVal = v; bestKey = k; }
  }
  if (custom && (!bestKey || bestVal < 0.72)) {
    bestKey = custom.key; bestVal = Math.max(bestVal, custom.conf);
    cat[custom.cat || 'env'] = Math.max(cat[custom.cat || 'env'] || 0, custom.conf);
  }
  if (f.snr < 5 || bestVal < 0.52) return { key:null, conf:bestVal, cat:cat, scores:scores };
  return { key:bestKey, conf:bestVal, cat:cat, scores:scores };
}

/* ---------------------------------------------------------- 11 维训练库模板 */
function vecOf(f) {
  return [ clamp01(f.snr/30), clamp01(f.SC/3000), clamp01(f.SF), clamp01(f.ZCR*5),
           clamp01(f.low), clamp01(f.mid), clamp01(f.high), clamp01(f.pitch/800),
           clamp01(f.pitchConf), clamp01(f.tonality/3), clamp01(f.flux) ];
}
/* 稳定 11 维：去掉随房间噪声底漂移的 snr，换成频带分散度。
   训练时用离线录音、匹配时用实时会话，只有去掉噪声底才可移植。 */
function vecOfStable(f) {
  return [ clamp01(f.SC/3000), clamp01(f.SF), clamp01(f.ZCR*5),
           clamp01(f.low), clamp01(f.mid), clamp01(f.high),
           clamp01(f.pitch/800), clamp01(f.pitchConf),
           clamp01(f.tonality/3), clamp01(f.flux), clamp01(f.spread) ];
}
/* templates: [{ key, name, cat, vecs:[[11],...], enabled }]，取最像的一个样本 */
function matchVecs(v, templates, threshold) {
  if (!templates || !templates.length) return null;
  var limit = threshold || 0.26, best = null, bd = Infinity;
  for (var i = 0; i < templates.length; i++) {
    var t = templates[i];
    if (t.enabled === false) continue;
    var vs = t.vecs || (t.vec ? [t.vec] : []);
    for (var j = 0; j < vs.length; j++) {
      var tv = vs[j], d = 0;
      for (var k = 0; k < v.length; k++) { var x = v[k] - (tv[k] || 0); d += x * x; }
      d = Math.sqrt(d / v.length);
      if (d < bd) { bd = d; best = t; }
    }
  }
  if (!best || bd > limit) return null;
  return { key: best.key, name: best.name, cat: best.cat || 'env',
           conf: clamp01(1 - bd / limit), dist: bd, template: best };
}

/* ---------------------------------------------------------- 抗混叠 WAV */
function biquadLowpass(input, fs, fc, Q) {
  var w0 = 2 * Math.PI * fc / fs, cosw = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
  var b0 = (1 - cosw) / 2, b1 = 1 - cosw, b2 = (1 - cosw) / 2;
  var a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  var nb0 = b0/a0, nb1 = b1/a0, nb2 = b2/a0, na1 = a1/a0, na2 = a2/a0;
  var out = new Float32Array(input.length), x1=0, x2=0, y1=0, y2=0;
  for (var i = 0; i < input.length; i++) {
    var x0 = input[i];
    var y0 = nb0*x0 + nb1*x1 + nb2*x2 - na1*y1 - na2*y2;
    x2=x1; x1=x0; y2=y1; y1=y0; out[i]=y0;
  }
  return out;
}
function antiAlias(x, fs, cutoff) {
  var QS = [0.5176, 0.7071, 1.9319], y = x;   // 6 阶 Butterworth
  for (var i = 0; i < QS.length; i++) y = biquadLowpass(y, fs, cutoff, QS[i]);
  return y;
}
/* Float32 PCM → 16kHz / 16bit / 单声道 WAV 的 Uint8Array */
function encodeWav16k(samples, srcRate, targetRate) {
  targetRate = targetRate || 16000;
  var ratio = srcRate / targetRate, work = samples;
  if (srcRate > targetRate * 1.05) work = antiAlias(samples, srcRate, targetRate * 0.45);
  var n = Math.floor(work.length / ratio);
  if (n < 32) return null;
  var buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  var str = function (off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0,'RIFF'); dv.setUint32(4, 36 + n*2, true); str(8,'WAVE'); str(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,targetRate,true); dv.setUint32(28,targetRate*2,true);
  dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  str(36,'data'); dv.setUint32(40,n*2,true);
  for (var i = 0; i < n; i++) {
    var pos = i*ratio, i0 = Math.floor(pos), i1 = Math.min(work.length-1, i0+1), frac = pos-i0;
    var v = work[i0]*(1-frac) + work[i1]*frac;
    v = v < -1 ? -1 : v > 1 ? 1 : v;
    dv.setInt16(44 + i*2, v < 0 ? v*0x8000 : v*0x7FFF, true);
  }
  return new Uint8Array(buf);
}

/* ---------------------------------------------------------- 合成音试听 */
function createSynth(ctx) {
  var bus = ctx.createGain(); bus.gain.value = 0.8; bus.connect(ctx.destination);
  var noiseCache = null;
  function getNoise(sec) {
    var len = Math.floor(ctx.sampleRate * sec);
    var b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function noiseSource(sec) { var s = ctx.createBufferSource(); s.buffer = getNoise(sec); return s; }
  function env(node, t0, attack, hold, decay, peak) {
    var g = node.gain;
    g.cancelScheduledValues(t0);
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setValueAtTime(peak, t0 + attack + hold);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + decay);
  }
  function tone(freq, t0, dur, type, peak) {
    var o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    o.connect(g); g.connect(bus);
    env(g, t0, 0.008, Math.max(0.01, dur * 0.3), dur * 0.7, peak);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  var S = {
    doorbell: function () { var t=ctx.currentTime; tone(659.25,t,0.7,'sine',0.45); tone(523.25,t+0.42,0.9,'sine',0.45); },
    knock: function () {
      var t=ctx.currentTime;
      [0,0.17,0.34].forEach(function (dt) {
        var s=noiseSource(0.2), f=ctx.createBiquadFilter(), g=ctx.createGain();
        f.type='lowpass'; f.frequency.value=420; f.Q.value=1.1;
        s.connect(f); f.connect(g); g.connect(bus);
        env(g,t+dt,0.004,0.02,0.10,0.9); s.start(t+dt); s.stop(t+dt+0.2);
      });
    },
    boiling: function () {
      var t=ctx.currentTime, dur=3, s=noiseSource(dur), hp=ctx.createBiquadFilter(), bp=ctx.createBiquadFilter(), g=ctx.createGain();
      hp.type='highpass'; hp.frequency.value=1800; bp.type='bandpass'; bp.frequency.value=4200; bp.Q.value=0.7; g.gain.value=0.16;
      s.connect(hp); hp.connect(bp); bp.connect(g); g.connect(bus); s.start(t); s.stop(t+dur);
    },
    phone: function () { var t=ctx.currentTime; for(var r=0;r<2;r++){ var b=t+r*1.15; tone(440,b,0.9,'sine',0.22); tone(480,b,0.9,'sine',0.22);} },
    alarm: function () { var t=ctx.currentTime; for(var i=0;i<4;i++) tone(3100,t+i*0.18,0.11,'square',0.16); },
    wind: function () { var t=ctx.currentTime,dur=3,s=noiseSource(dur),lp=ctx.createBiquadFilter(),g=ctx.createGain(); lp.type='lowpass';lp.frequency.value=520;lp.Q.value=0.6;g.gain.value=0.16; s.connect(lp);lp.connect(g);g.connect(bus);s.start(t);s.stop(t+dur); },
    rain: function () { var t=ctx.currentTime,dur=3,s=noiseSource(dur),hp=ctx.createBiquadFilter(),g=ctx.createGain(); hp.type='highpass';hp.frequency.value=2200;g.gain.value=0.13; s.connect(hp);hp.connect(g);g.connect(bus);s.start(t);s.stop(t+dur); },
    thunder: function () { var t=ctx.currentTime,dur=2.6,s=noiseSource(dur),lp=ctx.createBiquadFilter(),g=ctx.createGain(); lp.type='lowpass';lp.frequency.value=180;lp.Q.value=0.9; s.connect(lp);lp.connect(g);g.connect(bus); env(g,t,0.02,0.35,2.0,0.9);s.start(t);s.stop(t+dur); },
    bird: function () {
      var t=ctx.currentTime;
      for(var i=0;i<5;i++){
        var o=ctx.createOscillator(),g=ctx.createGain(),st=t+i*0.13;
        o.type='sine'; o.frequency.setValueAtTime(2600+Math.random()*800,st);
        o.frequency.exponentialRampToValueAtTime(4200+Math.random()*1200,st+0.08);
        o.connect(g);g.connect(bus); env(g,st,0.005,0.02,0.06,0.12); o.start(st);o.stop(st+0.12);
      }
    },
    horn: function () { var t=ctx.currentTime; [400,500].forEach(function(f){tone(f,t,0.8,'square',0.10);}); },
    traffic: function () { var t=ctx.currentTime,dur=3,s=noiseSource(dur),lp=ctx.createBiquadFilter(),g=ctx.createGain(); lp.type='lowpass';lp.frequency.value=700;lp.Q.value=0.5;g.gain.value=0.14; s.connect(lp);lp.connect(g);g.connect(bus);s.start(t);s.stop(t+dur); },
    speech: function () {
      var t=ctx.currentTime,dur=2.2,o=ctx.createOscillator(),b1=ctx.createBiquadFilter(),b2=ctx.createBiquadFilter(),g=ctx.createGain();
      o.type='sawtooth';o.frequency.value=128; b1.type='bandpass';b1.frequency.value=620;b1.Q.value=5; b2.type='bandpass';b2.frequency.value=1450;b2.Q.value=6;
      g.gain.setValueAtTime(0.05,t); o.connect(b1);b1.connect(g);o.connect(b2);b2.connect(g);g.connect(bus); o.start(t);o.stop(t+dur);
    },
    shout: function () { var t=ctx.currentTime,o=ctx.createOscillator(),bp=ctx.createBiquadFilter(),g=ctx.createGain(); o.type='sawtooth';o.frequency.value=210;bp.type='bandpass';bp.frequency.value=900;bp.Q.value=3; o.connect(bp);bp.connect(g);g.connect(bus); env(g,t,0.02,0.4,0.7,0.28);o.start(t);o.stop(t+1.2); },
    laugh: function () {
      var t=ctx.currentTime;
      for(var i=0;i<5;i++){ var o=ctx.createOscillator(),g=ctx.createGain(),bp=ctx.createBiquadFilter(),st=t+i*0.14;
        o.type='sawtooth';o.frequency.value=200+Math.random()*30;bp.type='bandpass';bp.frequency.value=800;bp.Q.value=4;
        o.connect(bp);bp.connect(g);g.connect(bus);env(g,st,0.01,0.03,0.08,0.18);o.start(st);o.stop(st+0.16); }
    },
    cry: function () {
      var t=ctx.currentTime,o=ctx.createOscillator(),vib=ctx.createOscillator(),vg=ctx.createGain(),bp=ctx.createBiquadFilter(),g=ctx.createGain();
      o.type='sawtooth';o.frequency.setValueAtTime(420,t);vib.type='sine';vib.frequency.value=5;vg.gain.value=22;vib.connect(vg);vg.connect(o.frequency);
      bp.type='bandpass';bp.frequency.value=1100;bp.Q.value=4;o.connect(bp);bp.connect(g);g.connect(bus);
      env(g,t,0.08,1.6,0.8,0.20);o.start(t);vib.start(t);o.stop(t+2.6);vib.stop(t+2.6);
    }
  };
  return {
    play: function (key) { if (S[key]) { try { S[key](); return true; } catch (e) { return false; } } return false; },
    bus: bus
  };
}

return {
  SOUNDS: SOUNDS, SOUND_MAP: SOUND_MAP, LIVE_KEYS: LIVE_KEYS,
  COLORS: COLORS, CAT_NAME: CAT_NAME, REGIONS: REGIONS, REGION_NAME: REGION_NAME,
  SEGMENTS: SEGMENTS,
  SSAnalyzer: SSAnalyzer, newSmooth: newSmooth, smooth: smooth,
  scoreAll: scoreAll, classifySS: classifySS,
  vecOf: vecOf, vecOfStable: vecOfStable, matchVecs: matchVecs,
  antiAlias: antiAlias, encodeWav16k: encodeWav16k,
  createSynth: createSynth,
  clamp01: clamp01, clamp: clamp
};
});
