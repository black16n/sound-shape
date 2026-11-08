// 验证「训练指纹 vs 实时指纹」一致性：同一声音应高置信匹配，不同声音应不匹配。
// 直接复用 soundshape-core.js 的真实特征提取，模拟新版 ssVecFromPCM（只取响帧）。
const path = require('path');
const SSC = require(path.join(__dirname, '..', 'soundshape-core.js'));

const SR = 48000, N = 2048, HOP = 1024;

// 合成一段音频：在静音背景中嵌入若干「事件」窗口
function synth(events, durSec){
  const n = Math.floor(SR*durSec);
  const pcm = new Float32Array(n);
  for(const ev of events){
    const start = Math.floor(ev.t*SR);
    for(let i=0;i<ev.len && start+i<n;i++){
      let v=0;
      for(const tone of (ev.tones||[{f:440,a:1}])) v += tone.a*Math.sin(2*Math.PI*tone.f*(start+i)/SR);
      // 包络：起音快、衰减慢
      const e = Math.exp(-i/(ev.decay||4000));
      pcm[start+i] += v*e*0.5;
    }
  }
  // 加一点底噪
  for(let i=0;i<n;i++) pcm[i] += (Math.random()*2-1)*0.002;
  return pcm;
}

// 与 dashboard 中新版 ssVecFromPCM 同逻辑：只取较响帧
function vecFromPCM(pcm){
  const rms=[];
  for(let off=0; off+N<=pcm.length; off+=HOP){
    const w=pcm.subarray(off,off+N);
    let s=0; for(let i=0;i<N;i++) s+=w[i]*w[i];
    rms.push(Math.sqrt(s/N));
  }
  if(!rms.length) return null;
  const cut=Math.max(1e-4, Math.max.apply(null,rms)*0.3);
  const idx=rms.map((v,i)=>v>=cut?i:-1).filter(i=>i>=0);
  const use=idx.length?idx:rms.map((_,i)=>i);
  const an=new SSC.SSAnalyzer(SR,N), sf=SSC.newSmooth();
  use.forEach(i=>{ const off=i*HOP; SSC.smooth(sf, an.process(pcm.subarray(off,off+N)), 20); });
  return SSC.vecOfStable(sf);
}

// 训练用：knock（低频、短促、衰减快）
const trainKnock = synth([{t:0.2,len:6000,tones:[{f:180,a:1},{f:90,a:0.6}],decay:2500},
                          {t:0.7,len:6000,tones:[{f:180,a:1},{f:90,a:0.6}],decay:2500}], 1.5);
// 实时用：同一 knock，但换了个起始时间 + 更多底噪（模拟不同设备/房间）
const liveKnock = synth([{t:0.35,len:6000,tones:[{f:185,a:1},{f:88,a:0.6}],decay:2400}], 1.2);
liveKnock.forEach((_,i)=>{}); for(let i=0;i<liveKnock.length;i++) liveKnock[i]+=(Math.random()*2-1)*0.01;

// 不同声音：doorbell（高频、持续）
const liveDoorbell = synth([{t:0.3,len:20000,tones:[{f:880,a:1},{f:1320,a:0.5}],decay:9000}], 1.2);

const vTrain = vecFromPCM(trainKnock);
const vKnock = vecFromPCM(liveKnock);
const vBell  = vecFromPCM(liveDoorbell);

// 与 dashboard 中 matchCustomTemplates 相同的匹配维度屏蔽（pitchConf=7, flux=9）
const MATCH_MASK = [1,1,1,1,1,1,1,0,1,0,1];
const mask = v => (v||[]).map((x,i)=>x*(MATCH_MASK[i]||0));

const templates=[{key:'knock',name:'敲门',vecs:[mask(vTrain)]}];
const hitKnock = SSC.matchVecs(mask(vKnock), templates, 0.30);
const hitBell  = SSC.matchVecs(mask(vBell),  templates, 0.30);

console.log('训练指纹 :', vTrain.map(x=>x.toFixed(2)).join(','));
console.log('实时敲门 :', vKnock.map(x=>x.toFixed(2)).join(','));
console.log('实时门铃 :', vBell.map(x=>x.toFixed(2)).join(','));
console.log('---');
console.log('同声音(敲门)匹配 :', hitKnock ? ('命中 '+hitKnock.name+' 置信 '+(hitKnock.conf*100).toFixed(1)+'%  距离 '+hitKnock.dist.toFixed(3)) : '未匹配 (应匹配!)');
console.log('异声音(门铃)匹配 :', hitBell ? ('命中 '+hitBell.name+' 置信 '+(hitBell.conf*100).toFixed(1)+'%') : '未匹配 (正确)');

const ok = hitKnock && hitKnock.conf>0.6 && !hitBell;
console.log('---');
console.log(ok ? 'PASS: 同源指纹可匹配、异源指纹不匹配' : 'FAIL: 一致性不符合预期');
process.exit(ok?0:1);
