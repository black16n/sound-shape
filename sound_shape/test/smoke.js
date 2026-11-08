/* 冒烟测试：加载 dashboard.html，捕获初始化期运行时错误与未处理异常。 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

const CATCH = `<script>window.__err=[];window.addEventListener('error',function(e){window.__err.push('ERR:'+e.message+(e.filename?(' @'+e.lineno+':'+e.colno):''));});window.addEventListener('unhandledrejection',function(e){window.__err.push('REJ:'+((e.reason&&e.reason.message)||e.reason));});</script>`;
const REPORT = `<script>
(function(){try{
  var f=document.getElementById('fireBtn'), st=document.getElementById('stage');
  var ok = f && st;
  var d=document.createElement('div'); d.id='__smoke';
  d.setAttribute('data-probe', JSON.stringify({err:window.__err, ui:!!ok, fire: f?f.textContent.trim():null, stage: st?st.className:null}));
  document.body.appendChild(d);
}catch(e){var d=document.createElement('div');d.id='__smoke';d.setAttribute('data-probe',JSON.stringify({err:['REP:'+e.message]}));document.body.appendChild(d);} })();
</script>`;

const out = html
  .replace('<head>', '<head>' + CATCH)
  .replace('</body>', REPORT + '</body>');
fs.writeFileSync(path.join(ROOT, '_smoke.html'), out);
console.log('已生成 _smoke.html');
