'use strict';
// guardian: checks.js dagi sof yordamchi funksiyalar testlari (tarmoqqa chiqmaydi).
// Ishga tushirish: npm test   yoki   node guardian/test/checks.test.js
const { uptimeContactsItem, lineTime, within, keyStatus, dmy } = require('../checks')._internal;

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}

// ── UptimeRobot kontaktlari ──
// 11.09.2026: dashboard'da E-mail va Push YOQILGAN, v2 API esa ikkalasiga status=1 qaytardi.
// Eski tekshiruv faqat status=2 ni faol hisoblab, har kuni yolg'on "pauzada" ogohlantirishi berardi.
{
  const cases = [
    ['haqiqiy holat: email+push, API status=1 -> ok', [{ id: 1, type: 2, status: 1 }, { id: 2, type: 12, status: 1 }], 'ok', '2 ta kontakt (email, push)'],
    ['status=2 -> ok', [{ type: 2, status: 2 }], 'ok', '1 ta kontakt (email)'],
    ["kontakt umuman yo'q -> warn", [], 'warn', "yo'q"],
    ['hammasi faollashtirilmagan (status 0) -> warn', [{ type: 2, status: 0 }, { type: 12, status: '0' }], 'warn', 'faollashtirilmagan'],
    ['biri 0, biri 1 -> ok (faqat ishlaydigani sanaladi)', [{ type: 2, status: 0 }, { type: 12, status: 1 }], 'ok', '1 ta kontakt (push)'],
    ['undefined kelsa qulamaydi -> warn', undefined, 'warn', "yo'q"],
  ];
  for (const [name, input, level, needle] of cases) {
    const r = uptimeContactsItem(input);
    t('UptimeRobot: ' + name, r.id === 'ur:contacts' && r.level === level && r.msg.includes(needle), JSON.stringify(r));
  }
}

// ── PM2 log vaqti (time: true prefiksi UTC) ──
{
  t('lineTime: PM2 prefiksi UTC deb o‘qiladi', lineTime('2026-09-11T04:00:36: attCheckIn saqlash xato') === Date.parse('2026-09-11T04:00:36Z'));
  t("lineTime: prefiksi yo'q qator -> null", lineTime('    at Object.invoke (/opt/x.js:1:1)') === null);
  const now = Date.parse('2026-09-11T12:00:00Z');
  const lines = [
    '2026-09-10T11:00:00: 25 soat oldin',
    '2026-09-11T11:30:00: 30 daqiqa oldin',
    '2026-09-11T12:02:00: 2 daqiqa keyin (soat farqi — qabul qilinadi)',
    '2026-09-11T13:00:00: 1 soat keyin (qabul qilinmaydi)',
    '    at stack qatori',
  ];
  const got = within(lines, 3600 * 1000, now).map((l) => l.slice(21));
  t("within: faqat oyna ichidagilar, uzoq kelajak va prefikssizlar tashlanadi", JSON.stringify(got) === JSON.stringify(['30 daqiqa oldin', "2 daqiqa keyin (soat farqi — qabul qilinadi)"]), JSON.stringify(got));
}

// ── AI kalit javoblarini baholash ──
{
  const k = (res) => keyStatus('ai:x', 'X', res).level;
  t('keyStatus: 200 -> ok', k({ status: 200 }) === 'ok');
  t('keyStatus: 401 va 403 -> crit (kalit rad etildi)', k({ status: 401 }) === 'crit' && k({ status: 403 }) === 'crit');
  t("keyStatus: 400 'API key not valid' (Gemini) -> crit", k({ status: 400, text: '{"error":{"message":"API key not valid. Please pass a valid API key."}}' }) === 'crit');
  t('keyStatus: boshqa 400 -> warn', k({ status: 400, text: 'bad request' }) === 'warn');
  t('keyStatus: 402 -> crit (balans tugagan)', k({ status: 402 }) === 'crit');
  t('keyStatus: 429 va 500 -> warn (vaqtinchalik)', k({ status: 429 }) === 'warn' && k({ status: 500 }) === 'warn');
  const net = keyStatus('ai:x', 'X', { status: 0, error: 'javob kelmadi (timeout)' });
  t('keyStatus: tarmoq xatosi -> warn va sababi matnda', net.level === 'warn' && net.msg.includes('timeout'), JSON.stringify(net));
}

// ── sana Toshkent vaqti bilan ──
{
  t("dmy: UTC 20:30 Toshkentda ertasi kun (UTC+5)", dmy(Date.parse('2026-11-10T20:30:00Z')) === '11.11.2026', dmy(Date.parse('2026-11-10T20:30:00Z')));
  t('dmy: kun.oy.yil formati', dmy(Date.parse('2026-12-06T13:14:17Z')) === '06.12.2026');
}

console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
process.exit(fail ? 1 : 0);
