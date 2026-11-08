/* 端到端识别验证：在浏览器内构造合成「敲门」声与对应训练指纹，
 * 直接调用真实的 recognizeFrames，确认状态变为「命中」；
 * 再用「门铃」声验证不会误匹配（显示 未知/其它）。 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const MARK = '// 探测本机后端：在线则建立 WebSocket/SSE、同步模板库与识别历史\nBackend.init();';

const PROBE = `
Backend.connect=function(){}; Backend.online=false; Backend.enabled=false;
setTimeout(function(){
  try{
    var SR=48000, N=2048, HOP=1024;
    function synth(events, dur){
      var n=Math.floor(SR*dur), pcm=new Float32Array(n);
      events.forEach(function(ev){
        var s=Math.floor(ev.t*SR);
        for(var i=0;i<ev.len && s+i<n;i++){
          var v=0; (ev.tones||[{f:440,a:1}]).forEach(function(tn){ v+=tn.a*Math.sin(2*Math.PI*tn.f*(s+i)/SR); });
          pcm[s+i]+=v*Math.exp(-i/(ev.decay||4000))*0.5;
        }
      });
      for(var i=0;i<n;i++) pcm[i]+=(Math.random()*2-1)*0.002;
      return pcm;
    }
    function mask(v){ var M=[1,1,1,1,1,1,1,0,1,0,1]; return (v||[]).map(function(x,i){return x*(M[i]||0);}); }
    var knock = synth([{t:0.2,len:6000,tones:[{f:180,a:1},{f:90,a:0.6}],decay:2500}], 1.5);
    var door  = synth([{t:0.3,len:20000,tones:[{f:880,a:1},{f:1320,a:0.5}],decay:9000}], 1.5);
    var vKnock = ssVecFromPCM(knock, SR);
    TEMPLATES.push({id:'probe_knock', name:'敲门(探针)', cat:'env', vecs:[mask(vKnock)], enabled:true,
                    prototype:new Array(7).fill(0), count:0, hitCount:0, bars:[8,16,12,20,10], icon:'⭐'});
    MIC.feat = extractFeatures(knock.subarray(0,2048), SR);   // 避免空 frames 触发提前返回
    MIC.actx = { sampleRate: SR };                            // 真实应用里麦克风激活必带该字段
    function run(label, pcm){
      state.busy=false; setStatus('idle');
      var liveVec = ssVecFromPCM(pcm, SR);
      var custom = matchCustomTemplates(liveVec);
      var st = ssStateFromPCM(pcm, SR) || SS.f;
      var rule = SSC && st ? SSC.classifySS(st, custom?{key:custom.key,conf:custom.conf/100,cat:custom.cat}:null) : null;
      recognizeFrames([], pcm, 'mic', null);
      return { label:label, char:document.getElementById('statusChar').textContent,
               custom: custom?{name:custom.t.name, conf:+custom.conf.toFixed(1)}:null,
               rule: rule?{key:rule.key, conf:+rule.conf.toFixed(2)}:null,
               cls:document.getElementById('stage').className, busy:state.busy };
    }
    var r1 = run('同声音(应命中敲门)', knock);
    var r2 = run('异声音(不应命中敲门)', door);
    var d=document.createElement('div'); d.id='__recog';
    d.setAttribute('data-probe', JSON.stringify({ vKnock: vKnock, r1:r1, r2:r2 }));
    document.body.appendChild(d);
  }catch(e){
    var d=document.createElement('div'); d.id='__recog';
    d.setAttribute('data-probe', JSON.stringify({err:e.message})); document.body.appendChild(d);
  }
}, 500);
`;

const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
if (!html.includes(MARK)) throw new Error('找不到启动标记');
fs.writeFileSync(path.join(ROOT, '_recog.html'), html.replace(MARK, MARK + '\n' + PROBE));
console.log('已生成 _recog.html');
