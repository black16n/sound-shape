/* 生成「麦克风模式」截图用页面：伪造一路已连接的麦克风信号，仅用于视觉验收。
 * node test/shot-mic.js → _shot_mic.html，再用无头浏览器 --screenshot 截图。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = '// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史\nBackend.init();';
const DEVICE = process.argv[2] || '阵列麦克风 (AMD Audio Device)';
const STATE  = process.argv[3] || 'idle';          // idle | hit | unknown

const PROBE = [
'Backend.connect=function(){}; Backend.online=false; Backend.enabled=false; Backend.init();',
'setTimeout(()=>{',
'  const sr=48000, N=2048;',
'  const buf=new Float32Array(N);',
'  for(let i=0;i<N;i++){',
'    const t=i/sr;',
'    buf[i]=0.16*Math.sin(2*Math.PI*210*t)+0.09*Math.sin(2*Math.PI*430*t+1.1)+0.05*Math.sin(2*Math.PI*790*t+.4);',
'  }',
'  state.mode="mic"; MIC.active=true; MIC.actx={sampleRate:sr}; MIC.time=buf;',
'  MIC.freq=new Uint8Array(1024); MIC.rms=.052; MIC.deviceLabel=' + JSON.stringify(DEVICE) + ';',
'  MIC.feat=extractFeatures(buf,sr); MIC.noise=.006; MIC.calibUntil=0;',
'  document.getElementById("stage").classList.add("mic-on");',
'  document.getElementById("autoWrap").classList.add("disabled");',
'  document.getElementById("autoToggle").checked=false;',
'  const trained=TEMPLATES.filter(t=>t.trained).length;',
'  document.getElementById("micNote").innerHTML = esc(MIC.deviceLabel.slice(0,22)) + " · "',
'    + \'<b id="micLevel" class="num">-26 dBFS</b> · \'',
'    + (trained?trained+" 个已训练模板":"内置样例原型")',
'    + \' <button class="link-btn" id="diagInlineBtn">设备诊断</button>\';',
'  document.getElementById("liveText").textContent="本机麦克风 · 实时采集";',
'  updateModeUI();',
'  const s=' + JSON.stringify(STATE) + ';',
'  if(s==="hit"){ setStatus("hit","门铃",96.4); energy=1.1; }',
'  else if(s==="unknown"){ setStatus("unknown","未知",43.2); energy=.7; }',
'  else setStatus("idle");',
'  document.getElementById("syncLabel").textContent="MIC LIVE · 48.0kHz · -26 dBFS";',
'},400);'
].join('\n');

const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
if (!html.includes(MARK)) throw new Error('dashboard.html 中找不到启动标记');
fs.writeFileSync(path.join(ROOT, '_shot_mic.html'), html.replace(MARK, MARK + '\n' + PROBE));
console.log('已生成 _shot_mic.html（' + STATE + '）');
