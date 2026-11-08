/* 合并后核心的回归测试：从 sound-shape 原工程 dsp-test / alias-test / wav-test 移植
 * 运行： node test/merge-core-test.js
 */
'use strict';
const C = require('../soundshape-core.js');

const SR = 48000;
let ok = true;
const check = (cond, msg) => {
  if (!cond) { ok = false; console.error('  FAIL ' + msg); }
  else console.log('  OK   ' + msg);
};
const p = (n, w) => String(n).padStart(w || 6);

/* 按 32ms 窗 / 10ms 跳喂信号，与原工程一致 */
function feed(gen, seconds, analyzer, sf) {
  const total = Math.floor(SR * seconds);
  const N = analyzer.N, hop = Math.round(SR * 0.010);
  const signal = new Float32Array(total);
  for (let i = 0; i < total; i++) signal[i] = gen(i);
  let last = null;
  for (let off = 0; off + N <= total; off += hop) {
    const frame = signal.subarray(off, off + N);
    last = C.smooth(sf, analyzer.process(frame), 10);
  }
  return last;
}
function fresh() { return { a: new C.SSAnalyzer(SR), sf: C.newSmooth() }; }
function report(label, sf) {
  console.log('  ' + label.padEnd(12),
    'SC=' + p(Math.round(sf.SC), 5), 'SF=' + sf.SF.toFixed(3),
    'ton=' + sf.tonality.toFixed(2), 'f0=' + p(Math.round(sf.pitch), 5),
    'snr=' + sf.snr.toFixed(1));
  return sf;
}

console.log('=== 声音库 / 常量 ===');
check(C.SOUNDS.length === 15, '内置声音库 15 个');
check(C.LIVE_KEYS.length === 13, '实时规则识别 13 类');
check(C.SOUNDS.every(s => s.key && s.name && s.cat && s.region), '每个声音都有 key/name/cat/region');
check(C.REGIONS.all[1] === 63 && C.SEGMENTS === 64, '灯带 64 段 / 4 个分区');

console.log('\n=== 帧特征 + 规则分类 ===');
{
  const { a, sf } = fresh();
  const s = report('1kHz 正弦', feed(n => 0.3 * Math.sin(2*Math.PI*1000*n/SR), 2, a, sf));
  check(s.SC > 850 && s.SC < 1200, '谱质心约 1000Hz（实际 ' + Math.round(s.SC) + '）');
  check(s.SF < 0.05, '谱平坦度低（纯音，实际 ' + s.SF.toFixed(3) + '）');
}
{
  const { a, sf } = fresh();
  const s = report('白噪声', feed(() => 0.2 * (Math.random()*2-1), 2, a, sf));
  check(s.SF > 0.25, '谱平坦度高（噪声性，实际 ' + s.SF.toFixed(3) + '）');
}
{
  const { a, sf } = fresh();
  const s = report('120Hz 低频', feed(n => 0.3 * Math.sin(2*Math.PI*120*n/SR), 2, a, sf));
  check(s.low > 0.6, '低频占比高（实际 ' + s.low.toFixed(2) + '）');
}
{
  const { a, sf } = fresh();
  const s = report('659Hz 稳态', feed(n => 0.35 * Math.sin(2*Math.PI*659.25*n/SR), 3, a, sf));
  check(Math.abs(s.pitch - 659) < 40, '基频约 659Hz（实际 ' + Math.round(s.pitch) + '）');
  check(s.tonality > 1.0, '稳态性高（实际 ' + s.tonality.toFixed(2) + '）');
  const r = C.classifySS(s);
  check(r.key === 'doorbell' || r.key === 'phone', '判为门铃/电话（实际 ' + r.key + '）');
}
{
  const { a, sf } = fresh();
  const s = report('3100Hz 稳态', feed(n => 0.2 * Math.sin(2*Math.PI*3100*n/SR), 2, a, sf));
  check(s.SC > 2000, '谱质心高（实际 ' + Math.round(s.SC) + '）');
  check(C.classifySS(s).key === 'alarm', '判为警报（实际 ' + C.classifySS(s).key + '）');
}
{
  const { a, sf } = fresh();
  const s = report('4Hz 调幅噪声', feed(n => {
    const am = 0.5 + 0.5 * Math.sin(2*Math.PI*4*n/SR);
    return 0.25 * am * (Math.random()*2-1);
  }, 3, a, sf));
  check(s.tonality < 2.5, '稳态性偏低（实际 ' + s.tonality.toFixed(2) + '）');
}

console.log('\n=== 11 维训练库多样本最近邻 ===');
{
  const f = C.newSmooth();
  Object.assign(f, { SC: 1200, SF: 0.1, ZCR: 0.05, low: 0.2, mid: 0.7, high: 0.1,
                     pitch: 660, pitchConf: 0.8, tonality: 3, flux: 0.05, snr: 18 });
  const v = C.vecOf(f);
  check(v.length === 11, 'vecOf 输出 11 维');
  const fs = C.vecOfStable(f);
  check(fs.length === 11 && fs[0] === v[1], 'vecOfStable 11 维且去掉噪声底（首维=谱质心）');
  const tpl = [{ key:'mine', name:'我家门铃', cat:'env', enabled:true,
                 vecs:[v.slice(), v.map(x => x * 0.98)] }];
  const hit = C.matchVecs(v, tpl);
  check(!!hit && hit.name === '我家门铃' && hit.conf > 0.99, '同向量命中自定义模板 conf=' + (hit && hit.conf.toFixed(3)));
  const far = v.map(x => 1 - x);
  check(C.matchVecs(far, tpl) === null, '差异大的向量不误命中');
  // 原工程策略：规则不自信(<0.72)时自定义模板优先；规则高自信时规则优先
  const weak = C.newSmooth();
  Object.assign(weak, { snr:12, SC:1500, SF:0.55, ZCR:0.2, peakF:1500, low:0.3, mid:0.4,
                        high:0.3, spread:0.6, flux:0.05, pitch:0, pitchConf:0, tonality:0.2, dur:200 });
  const custom = { key:'mine', conf:0.9, cat:'env' };
  check(C.classifySS(weak, custom).key === 'mine', '规则不自信时自定义模板优先');
  const strong = C.newSmooth();
  Object.assign(strong, { snr:40, SC:3100, SF:0.0, ZCR:0.1, peakF:3100, low:0, mid:0,
                          high:1, spread:0.1, flux:0, pitch:0, pitchConf:0, tonality:6, dur:800 });
  check(C.classifySS(strong, custom).key === 'alarm', '规则高自信时规则分类优先');
}

console.log('\n=== 抗混叠降采样 + WAV 编码 ===');
function decodeWav(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rate = dv.getUint32(24, true), bits = dv.getUint16(34, true);
  const n = dv.getUint32(40, true) / 2, pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(44 + i*2, true) / 32768;
  return { rate, bits, pcm,
    riff: String.fromCharCode(bytes[0],bytes[1],bytes[2],bytes[3]),
    wave: String.fromCharCode(bytes[8],bytes[9],bytes[10],bytes[11]) };
}
function toneAmp(pcm, freq, rate) {
  let re = 0, im = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = 2*Math.PI*freq*i/rate;
    re += pcm[i]*Math.cos(a); im += pcm[i]*Math.sin(a);
  }
  return 2*Math.hypot(re,im)/pcm.length;
}
{
  const src = new Float32Array(SR*2);
  for (let i=0;i<src.length;i++) src[i] = 0.5*Math.sin(2*Math.PI*1000*i/SR);
  const w = decodeWav(C.encodeWav16k(src, SR, 16000));
  check(w.riff === 'RIFF' && w.wave === 'WAVE', 'WAV 头 RIFF / WAVE');
  check(w.rate === 16000 && w.bits === 16, '16kHz / 16bit（实际 ' + w.rate + 'Hz / ' + w.bits + 'bit）');
  check(w.pcm.length === 32000, '2 秒 → 32000 采样（实际 ' + w.pcm.length + '）');
  const a1k = toneAmp(w.pcm, 1000, w.rate);
  check(Math.abs(a1k - 0.5) < 0.08, '1kHz 幅度基本不变（实际 ' + a1k.toFixed(3) + '）');
}
{
  const src = new Float32Array(SR*2);
  for (let i=0;i<src.length;i++) src[i] = 0.5*Math.sin(2*Math.PI*12000*i/SR);
  const w = decodeWav(C.encodeWav16k(src, SR, 16000));
  const a4k = toneAmp(w.pcm, 4000, w.rate);
  const rms = Math.sqrt(w.pcm.reduce((s,v)=>s+v*v,0)/w.pcm.length);
  check(a4k < 0.08, '12kHz 没折回 4kHz（实际 ' + a4k.toFixed(3) + '）');
  check(rms < 0.08, '超奈奎斯特成分已滤除（RMS ' + rms.toFixed(3) + '）');
}

console.log(ok ? '\n全部通过。' : '\n有断言失败。');
process.exit(ok ? 0 : 1);
