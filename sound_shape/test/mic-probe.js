/* 生成「麦克风手动识别」端到端探针。
 * 用法： node test/mic-probe.js      → 写出 _probe_mic.html
 *       再用无头浏览器 --dump-dom 打开，读取 <body data-probe="..."> 的 JSON
 * 验证点：mic 模式下点按钮走的是「采样最近 PCM → 真实识别」，而不是伪造命中；
 *        静音时给出 dBFS 诊断而不是假装命中。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = '// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史\nBackend.init();';

const PROBE = [
'// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史',
'Backend.connect=function(){}; Backend.online=false; Backend.enabled=false; Backend.init();',
'window.__o={errs:[]};addEventListener("error",e=>window.__o.errs.push(e.message));',
'const SR=48000;',
'function tone(sec,freq,amp){',
'  const n=Math.round(SR*sec), a=new Float32Array(n);',
'  for(let i=0;i<n;i++) a[i]=Math.sin(2*Math.PI*freq*i/SR)*(amp||.4);',
'  return a;',
'}',
'function ringOf(pcm){',
'  const B=4096, out=[];',
'  for(let off=0; off< pcm.length; off+=B) out.push(pcm.slice(off, Math.min(pcm.length, off+B)));',
'  return out;',
'}',
'setTimeout(async ()=>{',
' const o=window.__o;',
' try{',
'  // 1) 先训练一个「900Hz 自定义模板」，模拟用户已录入的声纹',
'  openTrain();',
'  const pcm=tone(.8,900,.4);',
'  const info=featuresFromPCM(pcm,SR), pack=wavFromPCM(pcm,SR), vec=ssVecFromPCM(pcm,SR);',
'  for(let i=0;i<2;i++) addSample({name:"s"+i,feat:info.feat,envelope:info.envelope,wav:pack.wav,sampleRate:pack.sampleRate,vec,blob:null,duration:.8});',
'  document.getElementById("trainTarget").value="__new";',
'  document.getElementById("trainName").value="麦克风测试";',
'  saveTemplate();',
'  closeTrain();',
'  const tt=TEMPLATES.filter(t=>t.name==="麦克风测试").pop();',
'  o.trained=!!tt; o.vecs=tt&&tt.vecs?tt.vecs.length:0;',
'',
'  // 2) 伪造一个已连接的麦克风（不真的开设备），塞入 1.2s 的 900Hz 真实 PCM',
'  state.mode="mic"; MIC.active=true; MIC.actx={sampleRate:SR}; MIC.deviceLabel="测试麦克风";',
'  MIC.noise=.004; MIC.calibUntil=0; MIC.feat=extractFeatures(pcm.subarray(0,2048),SR);',
'  MIC.ring=ringOf(tone(1.2,900,.4));',
'  o.ringBlocks=MIC.ring.length;',
'  o.ringRms=+pcmStats(collectRecentPCM(1.2)).rms.toFixed(4);',
'',
'  // 3) 按钮 = trigger()，在 mic 模式下必须走真实识别',
'  const before=state.logs.length;',
'  o.frames=framesFromPCM(collectRecentPCM(1.2),SR).length;',
'  trigger();',
'  o.busyAfterClick=state.busy;',
'  o.statusAfterClick=document.getElementById("stage").className;',
'',
'  await new Promise(r=>setTimeout(r,1400));',
'  o.topLogName=state.logs[0]?state.logs[0].name:null;',
'  o.topLogSource=state.logs[0]?state.logs[0].source:null;',
'  o.logsAdded=state.logs.length-before;',
'  o.busySettled=state.busy;',
'',
'  // 4) 静音场景：不应伪造命中，应给出 dBFS 诊断',
'  state.busy=false;',
'  const n0=state.logs.length;',
'  MIC.ring=ringOf(new Float32Array(SR));',
'  trigger();',
'  await new Promise(r=>setTimeout(r,500));',
'  o.silentLogsAdded=state.logs.length-n0;',
'  o.diagVisible=!document.getElementById("micDiag").hidden;',
'  o.diagTitle=document.getElementById("diagTitle").textContent;',
'  o.silentBusy=state.busy;',
'  o.silentDbfs=+pcmStats(collectRecentPCM(1.2)).dbfs.toFixed(0);',
'',
'  MIC.active=false; state.mode="sim";',
' }catch(e){o.fatal=String(e&&e.stack||e);}',
' document.body.setAttribute("data-probe",JSON.stringify(o));',
'},800);'
].join('\n');

const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
if (!html.includes(MARK)) throw new Error('dashboard.html 中找不到启动标记');
fs.writeFileSync(path.join(ROOT, '_probe_mic.html'), html.replace(MARK, MARK + '\n' + PROBE));
console.log('已生成 _probe_mic.html');
