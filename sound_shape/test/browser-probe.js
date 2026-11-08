/* 生成合并后的浏览器端到端探针页面。
 * 用法： node test/browser-probe.js   → 写出 _probe_merge.html
 *       再用无头 Chrome/Edge --dump-dom 打开并读取 <body data-probe="...">
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = '// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史\nBackend.init();';

const PROBE = [
'// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史',
'Backend.connect=function(){}; Backend.init();',
'window.__o={errs:[]};addEventListener("error",e=>window.__o.errs.push(e.message));',
'setTimeout(async ()=>{',
' const o=window.__o;',
' try{',
'  o.ssc=!!SSC; o.sounds=SSC?SSC.SOUNDS.length:0; o.live=SSC?SSC.LIVE_KEYS.length:0;',
'  o.serverSounds=Backend.soundCount||0; o.backend=Backend.online;',
'  openSoundModal();',
'  o.cards=document.querySelectorAll("#soundGrid .sound-card").length;',
'  document.querySelector(\'#soundGrid .sound-card[data-key="doorbell"]\').click();',
'  o.strip=!!SS.strip; o.stripName=SS.strip&&SS.strip.sound?SS.strip.sound.name:null;',
'  closeSoundModal();',
'  const sr=48000,N=2048;',
'  SS.analyzer=null; SS.sf=SSC.newSmooth();',
'  const sig=new Float32Array(sr);',
'  for(let i=0;i<sig.length;i++) sig[i]=0.2*Math.sin(2*Math.PI*3100*i/sr);',
'  for(let off=0;off+N<=sig.length;off+=480) SS.feed(sig.subarray(off,off+N),sr,10);',
'  const r=SSC.classifySS(SS.f);',
'  o.ruleKey=r.key; o.ruleConf=+r.conf.toFixed(3); o.sc=Math.round(SS.f.SC);',
'  openTrain();',
'  const pcm=new Float32Array(sr/2);',
'  for(let i=0;i<pcm.length;i++) pcm[i]=Math.sin(2*Math.PI*900*i/sr)*.4;',
'  const info=featuresFromPCM(pcm,sr), pack=wavFromPCM(pcm,sr);',
'  o.wavRate=pack.sampleRate;',
'  const vec=ssVecFromPCM(pcm,sr);',
'  addSample({name:"t1",feat:info.feat,envelope:info.envelope,wav:pack.wav,sampleRate:pack.sampleRate,vec,blob:null,duration:.5});',
'  addSample({name:"t2",feat:info.feat,envelope:info.envelope,wav:pack.wav,sampleRate:pack.sampleRate,vec,blob:null,duration:.5});',
'  document.getElementById("trainTarget").value="__new";',
'  document.getElementById("trainName").value="合并测试";',
'  saveTemplate();',
'  const tt=TEMPLATES.filter(t=>t.name==="合并测试").pop();',
'  o.vecs=tt&&tt.vecs?tt.vecs.length:0; o.vecDim=tt&&tt.vecs&&tt.vecs[0]?tt.vecs[0].length:0;',
'  o.cat=tt&&tt.cat; o.region=tt&&tt.region;',
'  SS.analyzer=null; SS.sf=SSC.newSmooth();',
'  const sig2=new Float32Array(sr/2);',
'  for(let i=0;i<sig2.length;i++) sig2[i]=Math.sin(2*Math.PI*900*i/sr)*.4;',
'  for(let off=0;off+N<=sig2.length;off+=480) SS.feed(sig2.subarray(off,off+N),sr,10);',
'  const c=matchCustomTemplates();',
'  o.customHit=c?c.t.name:null; o.customConf=c?+c.conf.toFixed(1):null;',
'  o.lightBarW=document.getElementById("lightBar").width;',
'  o.hisRate=document.getElementById("hisRate").textContent;',
' }catch(e){o.fatal=String(e);}',
' document.body.setAttribute("data-probe",JSON.stringify(o));',
'},900);'
].join('\n');

const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
if (!html.includes(MARK)) throw new Error('dashboard.html 中找不到启动标记');
const out = html.replace(MARK, MARK + '\n' + PROBE);
fs.writeFileSync(path.join(ROOT, '_probe_merge.html'), out);
console.log('已生成 _probe_merge.html');
