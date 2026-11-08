/* 合并后项目的一键测试入口： node test/run-all.js */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const tests = ['merge-core-test.js'];
let pass = 0, fail = 0;

for (const name of tests) {
  console.log('\n' + '━'.repeat(60));
  console.log('▶  ' + name);
  console.log('━'.repeat(60));
  const r = spawnSync(process.execPath, [path.join(__dirname, name)], { stdio: 'inherit' });
  if (r.status === 0) pass++; else fail++;
}

console.log('\n' + '━'.repeat(60));
console.log('  浏览器端到端探针（需先启动后端 python server.py）：');
console.log('    node test/browser-probe.js');
console.log('    然后用无头浏览器打开 http://127.0.0.1:5000/_probe_merge.html');
console.log('    （本地后端需加 --no-proxy-server，否则系统代理会返回 502）');
console.log('    读取 <body data-probe="..."> 的 JSON 断言');
console.log('');
console.log('  麦克风「识别当前声音」探针（纯本地，file:// 即可）：');
console.log('    node test/mic-probe.js → 打开 _probe_mic.html');
console.log('    断言：真实 PCM 命中已训练模板、静音时只弹诊断不伪造命中');
console.log('  麦克风模式截图： node test/shot-mic.js "设备名" idle|hit|unknown');
console.log('━'.repeat(60));
console.log(`  ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
