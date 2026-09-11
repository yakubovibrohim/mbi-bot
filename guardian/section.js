'use strict';
// ─── 18:30 kunlik xulosa uchun "🛡 Tizim" bo'limi ───
// mbi-bot ichida chaqiriladi; mbi-guardian yozgan status.json ni o'qiydi.
// Fayl yo'q yoki eski bo'lsa buni OCHIQ aytadi — guardian o'lganini jimlik yashirmasin.
// Telegram Markdown'ni buzadigan belgilar (_ * ` [ ]) tozalanadi.

const fs = require('fs');

const clean = (s) => String(s == null ? '' : s).replace(/[_*`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const HEAD = '🛡 *Tizim:*';
const MAX_LINES = 8;

function guardianDailySection({ file, now = Date.now(), maxAgeMin = 60 } = {}) {
  let st;
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return `${HEAD} ⚠️ guardian holati topilmadi — mbi-guardian ishlamayotgan bo'lishi mumkin.`; }

  const age = Math.round((now - Date.parse(st && st.checkedAt)) / 60000);
  if (!Number.isFinite(age)) return `${HEAD} ⚠️ guardian holati buzilgan — mbi-guardian ni tekshiring.`;
  if (age > maxAgeMin) return `${HEAD} ⚠️ guardian ${age} daqiqadan beri tekshirmagan — mbi-guardian to'xtagan bo'lishi mumkin.`;

  const items = Array.isArray(st.items) ? st.items : [];
  const crit = items.filter((i) => i.level === 'crit');
  const warn = items.filter((i) => i.level === 'warn');
  if (!crit.length && !warn.length) return `${HEAD} ✅ ${items.length} ta tekshiruv — hammasi joyida.`;

  const problems = [...crit, ...warn];
  const lines = [`${HEAD} ${crit.length ? '❌' : '⚠️'} ${problems.length} ta muammo (${items.length} ta tekshiruvdan):`];
  for (const i of problems.slice(0, MAX_LINES)) lines.push(`${i.level === 'crit' ? '❌' : '⚠️'} ${clean(i.name)}: ${clean(i.msg)}`);
  if (problems.length > MAX_LINES) lines.push(`… yana ${problems.length - MAX_LINES} ta`);
  return lines.join('\n');
}

module.exports = { guardianDailySection };
