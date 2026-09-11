'use strict';
// Barcha testlarni ishga tushiradi:  npm test
// Tashqi paket kerak emas. Har test fayli alohida jarayonda ishlaydi va o'z natijasini chiqaradi.
// Test fayllari: test/*.test.js va guardian/test/*.test.js — haqiqiy API, token yoki .mbi.env ga tegmaydi.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dirs = [path.join(root, 'test'), path.join(root, 'guardian', 'test')];
const files = dirs.flatMap((d) => (fs.existsSync(d)
  ? fs.readdirSync(d).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(d, f))
  : []));

const results = [];
for (const f of files) {
  const rel = path.relative(root, f);
  console.log('\n━━ ' + rel + ' ━━');
  const r = spawnSync(process.execPath, [f], { stdio: 'inherit', cwd: root });
  results.push([rel, r.status === 0]);
}

console.log('\n━━ Natija ━━');
for (const [rel, ok] of results) console.log((ok ? '✅ ' : '❌ ') + rel);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} ta test fayli muvaffaqiyatsiz` : `\n${results.length} ta test fayli — hammasi o'tdi`);
process.exit(failed || !results.length ? 1 : 0);
