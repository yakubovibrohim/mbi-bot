'use strict';
// guardian: alerting.js (qachon xabar yuborish) va section.js (18:30 "🛡 Tizim" qatori) testlari.
// Ishga tushirish: npm test   yoki   node guardian/test/alerting-section.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planAlerts, expiryStep } = require('../alerting');
const { guardianDailySection } = require('../section');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}
const H = 3600 * 1000;
const crit = (id) => ({ id, name: 'N-' + id, level: 'crit', msg: 'yomon' });
const ok = (id) => ({ id, name: 'N-' + id, level: 'ok', msg: 'yaxshi' });
const warn = (id) => ({ id, name: 'N-' + id, level: 'warn', msg: 'ogoh' });
const exp = (id, days, level = 'ok') => ({ id, name: 'N-' + id, level, msg: days + ' kun', meta: { expiry: true, days } });

// ── alerting ──
{
  let r = planAlerts({}, [warn('a')], 0);
  t('warn darhol xabar bermaydi', r.messages.length === 0);

  r = planAlerts({}, [crit('a')], 0);
  t("crit 1-marta: xabar yo'q (tasdiq kutiladi)", r.messages.length === 0 && r.state.issues.a.streak === 1);
  r = planAlerts(r.state, [crit('a')], 15 * 60000);
  t('crit 2-marta: xabar keladi', r.messages.length === 1 && r.messages[0].kind === 'problem' && !r.messages[0].repeat);
  t('firstSeen = birinchi aniqlangan vaqt', r.messages[0] && r.messages[0].firstSeen === 0);
  r = planAlerts(r.state, [crit('a')], 30 * 60000);
  t("crit 3-marta: takror xabar yo'q", r.messages.length === 0);
  r = planAlerts(r.state, [crit('a')], 15 * 60000 + 12 * H);
  t('12 soatdan keyin eslatma (repeat)', r.messages.length === 1 && r.messages[0].repeat === true);
  r = planAlerts(r.state, [ok('a')], 13 * H);
  t('tiklanganda ✅ xabar', r.messages.length === 1 && r.messages[0].kind === 'recovered' && !r.state.issues.a);
  r = planAlerts(r.state, [ok('a')], 14 * H);
  t('tiklangandan keyin jim', r.messages.length === 0);

  r = planAlerts({}, [crit('b')], 0);
  r = planAlerts(r.state, [ok('b')], 15 * 60000);
  t("bir marta crit bo'lib tiklansa — hech qanday xabar yo'q", r.messages.length === 0 && !r.state.issues.b);

  let st = {}; const got = [];
  for (const d of [20, 14, 13, 8, 7, 6, 4, 3, 2, 1, 0, -1]) {
    const rr = planAlerts(st, [exp('ig', d)], d);
    st = rr.state;
    if (rr.messages.length) got.push(d);
  }
  t('muddat: faqat 14, 7, 3, 1 kunda bir martadan', JSON.stringify(got) === JSON.stringify([14, 7, 3, 1]), 'olindi: ' + JSON.stringify(got));
  let rr = planAlerts(st, [exp('ig', 60)], 100);
  t('muddat yangilansa bosqichlar tozalanadi', rr.messages.length === 0 && rr.state.expiry.ig == null);
  rr = planAlerts(rr.state, [exp('ig', 13)], 200);
  t('yangilangandan keyin 14 kun bosqichi yana ishlaydi', rr.messages.length === 1 && rr.messages[0].kind === 'expiry');
  rr = planAlerts({}, [exp('x', 5, 'warn')], 0);
  t('birinchi ishga tushishda 5 kun qolgan — 7 bosqichi, bitta xabar', rr.messages.length === 1 && rr.state.expiry.x === 7);
  rr = planAlerts({}, [exp('c', 2, 'crit')], 0);
  t("muddat bo'yicha crit alohida 'muammo' xabari bermaydi", rr.messages.length === 1 && rr.messages[0].kind === 'expiry');

  let dt = planAlerts({}, [crit('ig')], 0);
  dt = planAlerts(dt.state, [crit('ig')], 15 * 60000);
  dt = planAlerts(dt.state, [exp('ig', 59)], 30 * 60000);
  t("o'lik token yangilanganda ✅ tiklandi xabari", dt.messages.some((m) => m.kind === 'recovered') && !dt.state.issues.ig);

  const gone = planAlerts({ issues: { old: { streak: 3, alertedAt: 1 } }, expiry: { oldx: 7 } }, [ok('a')], 0);
  t('olib tashlangan tekshiruv izi tozalanadi', !gone.state.issues.old && gone.state.expiry.oldx == null);
  t('expiryStep chegaralari', expiryStep(15) === null && expiryStep(14) === 14 && expiryStep(8) === 14 && expiryStep(7) === 7 && expiryStep(1) === 1 && expiryStep(-5) === 1);

  const before = { issues: { z: { streak: 1, firstSeen: 5, alertedAt: null } } };
  const snap = JSON.stringify(before);
  planAlerts(before, [crit('z')], 10);
  t("planAlerts kiruvchi holatni o'zgartirmaydi (yuborilmasa qaytarish uchun kerak)", JSON.stringify(before) === snap);
}

// ── section (18:30 qatori) ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbi-guardian-section-'));
  const f = path.join(dir, 'status.json');
  const NOW = Date.parse('2026-09-11T13:30:00Z');
  const md = (out) => !/[_`\[\]]/.test(out) && ((out.match(/\*/g) || []).length % 2 === 0);
  try {
    let out = guardianDailySection({ file: f, now: NOW });
    t("fayl yo'q — ochiq ogohlantirish", out.includes('topilmadi') && md(out), out);

    fs.writeFileSync(f, '{buzuq json');
    out = guardianDailySection({ file: f, now: NOW });
    t('buzuq JSON — ochiq ogohlantirish', out.includes('topilmadi') && md(out), out);

    fs.writeFileSync(f, JSON.stringify({ checkedAt: new Date(NOW - 2 * H).toISOString(), items: [] }));
    out = guardianDailySection({ file: f, now: NOW });
    t("eski holat (120 daq) — guardian to'xtagan bo'lishi mumkin", out.includes('120 daqiqadan beri') && md(out), out);

    fs.writeFileSync(f, JSON.stringify({ checkedAt: 'sana-emas', items: [] }));
    out = guardianDailySection({ file: f, now: NOW });
    t('checkedAt buzuq — ochiq ogohlantirish', out.includes('buzilgan') && md(out), out);

    fs.writeFileSync(f, JSON.stringify({ checkedAt: new Date(NOW - 5 * 60000).toISOString(), items: [
      { id: 'a', name: 'A', level: 'ok', msg: 'x' }, { id: 'b', name: 'B', level: 'info', msg: 'y' },
    ] }));
    out = guardianDailySection({ file: f, now: NOW });
    t('hammasi joyida (info muammo hisoblanmaydi)', out.includes('✅ 2 ta tekshiruv') && md(out), out);

    fs.writeFileSync(f, JSON.stringify({ checkedAt: new Date(NOW - 5 * 60000).toISOString(), items: [
      { id: 'u', name: 'UptimeRobot ogohlantirishlari', level: 'warn', msg: 'kontakt yo‘q' },
      { id: 'i', name: 'Instagram tokeni (IG_TOKEN)', level: 'crit', msg: 'ishlaydi (@mbi_mebel), [test] `x` *y*' },
      { id: 'o', name: 'OK', level: 'ok', msg: 'z' },
    ] }));
    out = guardianDailySection({ file: f, now: NOW });
    const lines = out.split('\n');
    t('muammolar: sarlavha, keyin crit, keyin warn', lines.length === 3 && lines[1].startsWith('❌') && lines[2].startsWith('⚠️'), out);
    t('Markdown xavfsiz (_ ` [ ] tozalangan, * juft)', md(out), out);

    const many = Array.from({ length: 12 }, (_, k) => ({ id: 'w' + k, name: 'W' + k, level: 'warn', msg: 'm' }));
    fs.writeFileSync(f, JSON.stringify({ checkedAt: new Date(NOW).toISOString(), items: many }));
    out = guardianDailySection({ file: f, now: NOW });
    t("12 ta muammo — sarlavha + 8 qator + 'yana 4 ta'", out.split('\n').length === 10 && out.includes('yana 4 ta'), out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
process.exit(fail ? 1 : 0);
