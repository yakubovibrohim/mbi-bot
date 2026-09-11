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

// ── Webhook, Caddy va avtomatik tuzatish holati ──
{
  const { webhookItem, caddyItem, autofixItem } = require('../checks')._internal;
  const EXP = 'https://65.21.147.238.nip.io/webhook';
  const now = Date.parse('2026-09-11T12:00:00Z');
  let r = webhookItem({ url: '', pending_update_count: 0 }, EXP, now);
  t("webhook bo'sh -> crit, avto-tuzatish belgisi bilan", r.level === 'crit' && r.msg.includes("bo'sh") && r.meta.fixable === 'webhook' && r.meta.expected === EXP && r.meta.current === '', JSON.stringify(r));
  r = webhookItem({ url: 'https://mbi-bot-yw9q.onrender.com/webhook', pending_update_count: 0 }, EXP, now);
  t("webhook boshqa manzilda -> crit, hozirgi manzil meta'da", r.level === 'crit' && r.meta.current.includes('onrender'));
  r = webhookItem({ url: EXP, pending_update_count: 2 }, EXP, now);
  t("webhook joyida -> ok, tuzatish belgisi yo'q", r.level === 'ok' && r.msg.includes('navbatda 2') && !r.meta);
  r = webhookItem({ url: EXP, pending_update_count: 0, last_error_date: now / 1000 - 600, last_error_message: 'Wrong response from the webhook: 502 Bad Gateway' }, EXP, now);
  t('10 daqiqa oldingi yetkazish xatosi -> warn (webhook tuzatilmaydi)', r.level === 'warn' && r.msg.includes('502') && !r.meta);
  r = webhookItem({ url: EXP, pending_update_count: 0, last_error_date: now / 1000 - 7200, last_error_message: 'x' }, EXP, now);
  t('2 soat oldingi xato -> ok', r.level === 'ok');
  r = webhookItem({ url: EXP, pending_update_count: 150 }, EXP, now);
  t('150 ta xabar navbatda -> warn', r.level === 'warn' && r.msg.includes('150'));

  t('Caddy active -> ok', caddyItem('active').level === 'ok');
  t('Caddy failed / inactive -> crit, holati matnda', caddyItem('failed').level === 'crit' && caddyItem('inactive').msg.includes('inactive'));
  t("Caddy holati o'qilmadi -> warn", caddyItem(null).level === 'warn');

  t("autofix.off yo'q -> ok (yoqilgan)", autofixItem(null, now).level === 'ok');
  const off = autofixItem(now - 5 * 3600 * 1000, now);
  t("autofix.off 5 soatdan beri -> warn (18:30 da ko'rinadi, unutilmasin)", off.level === 'warn' && off.msg.includes('5 soatdan'), JSON.stringify(off));
}

console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
process.exit(fail ? 1 : 0);
