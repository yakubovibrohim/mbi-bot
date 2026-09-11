'use strict';
// ads-watch.js (18:30 reklama holati bo'limi) testlari — soxta Windsor javoblari bilan, tarmoqqa chiqmaydi.
// Ishga tushirish: npm test   yoki   node test/ads-watch.test.js
const { adsDailySection } = require('../ads-watch');

const NOW = new Date('2026-09-10T13:30:00Z');           // Toshkent 18:30
const TODAY = '2026-09-10', YDAY = '2026-09-09';

// URL dagi preset va fields bo'yicha javob tanlaydigan soxta getJson
function stub(map) {
  return async (url) => {
    const u = new URL(url);
    const key = u.searchParams.get('date_preset') + '|' + u.searchParams.get('fields');
    for (const [k, v] of Object.entries(map)) {
      if (key.startsWith(k)) return typeof v === 'function' ? v() : v;
    }
    return { data: [] };
  };
}
const D = 'last_7dT|date,campaign,spend,impressions';
const S = 'last_30dT|campaign,campaign_effective_status';
const A = 'last_30dT|account_status';
const L = 'last_90d|date';

const cases = [
  { name: 'ishlayapti', map: { [D]: { data: [{ date: TODAY, campaign: 'MBI – Xabarlar – Toshkent', spend: 1.2, impressions: 293 }] } },
    expect: ['✅ ishlayapti', '$1.20', '293'] },

  { name: "bugun to'xtagan, kecha ishlagan, PAUSED", map: {
      [D]: { data: [{ date: YDAY, spend: 5.4, impressions: 2100 }] },
      [S]: { data: [{ campaign: 'X', campaign_effective_status: 'PAUSED', adset_effective_status: 'CAMPAIGN_PAUSED', effective_status: 'CAMPAIGN_PAUSED' }] },
      [A]: { data: [{ account_status: 'ACTIVE', spend_cap: 0, amount_spent: 36078 }] } },
    expect: ["TO'XTAGAN", 'Kecha ishlagan edi ($5.40)', '09.09.2026', '1 kun oldin', 'pauza qilingan', 'kampaniya pauzada'] },

  { name: "2 oy to'xtagan (14.07–09.09 dagi haqiqiy holat kabi), holat noma'lum", map: {
      [D]: { data: [] }, [S]: { data: [] }, [A]: { data: [] },
      [L]: { data: [{ date: '2026-07-12', spend: 5.64, impressions: 2908 }, { date: '2026-07-13', spend: 2.08, impressions: 928 }] } },
    expect: ["TO'XTAGAN", 'Kecha ham', '13.07.2026', '$2.08', '59 kun oldin', "Sababni aniqlab bo'lmadi"] },

  { name: "to'lov muammosi, kampaniya ACTIVE", map: {
      [D]: { data: [{ date: '2026-09-08', spend: 4, impressions: 1500 }] },
      [S]: { data: [{ campaign_effective_status: 'ACTIVE', adset_effective_status: 'ACTIVE', effective_status: 'ACTIVE' }] },
      [A]: { data: [{ account_status: 'UNSETTLED', spend_cap: 0, amount_spent: 100 }] } },
    expect: ["TO'XTAGAN", "to'lov o'tmagan", '08.09.2026', '2 kun oldin'] },

  { name: 'sarf limiti tugagan', map: {
      [D]: { data: [{ date: YDAY, spend: 3, impressions: 900 }] },
      [S]: { data: [{ campaign_effective_status: 'ACTIVE', effective_status: 'ACTIVE' }] },
      [A]: { data: [{ account_status: 'ACTIVE', spend_cap: 50000, amount_spent: 50000 }] } },
    expect: ['sarf limiti tugagan'] },

  { name: "holat ACTIVE lekin ko'rsatuv yo'q", map: {
      [D]: { data: [{ date: YDAY, spend: 3, impressions: 900 }] },
      [S]: { data: [{ campaign_effective_status: 'ACTIVE', adset_effective_status: 'ACTIVE', effective_status: 'ACTIVE' }] },
      [A]: { data: [{ account_status: 'ACTIVE', spend_cap: 0, amount_spent: 1 }] } },
    expect: ["holat faol ko'rinadi", 'byudjet'] },

  { name: "noma'lum xom holat — pastki chiziq tozalanadi", map: {
      [D]: { data: [{ date: YDAY, spend: 3, impressions: 900 }] },
      [S]: { data: [{ effective_status: 'SOME_NEW_STATUS' }] }, [A]: { data: [] } },
    expect: ['some new status'] },

  { name: 'Windsor xato qaytardi (pastki chiziqli matn)', map: {
      [D]: { error: 'Invalid date_preset. Allowed: last_Xd', code: 'user_error' } },
    expect: ["tekshirib bo'lmadi", 'Invalid date preset'] },

  { name: 'tarmoq xatosi (null)', map: { [D]: null }, expect: ["tekshirib bo'lmadi"] },

  { name: 'osilib qolish — timeout', map: { [D]: () => new Promise(() => {}) }, timeoutMs: 300,
    expect: ["tekshirib bo'lmadi"] },

  { name: 'getJson throw qiladi', getJson: async () => { throw new Error('boom_x'); }, expect: ["tekshirib bo'lmadi"] },

  { name: "kelajak sanali qator e'tiborsiz (Windsor sana chegarasi)", map: {
      [D]: { data: [{ date: '2026-09-11', spend: 1, impressions: 10 }, { date: '2026-09-08', spend: 4, impressions: 1500 }] },
      [S]: { data: [] }, [A]: { data: [] } },
    expect: ["TO'XTAGAN", '08.09.2026', '2 kun oldin'] },

  { name: "faqat kelajak sanali qator — bugun ishlayapti deb o'qilmasin", map: {
      [D]: { data: [{ date: '2026-09-11', spend: 1, impressions: 10 }] },
      [S]: { data: [] }, [A]: { data: [] }, [L]: { data: [] } },
    expect: ["TO'XTAGAN", '90 kunda birorta ham'] },

  { name: "kalit yo'q", key: '', expect: ['kaliti sozlanmagan'] },
];

(async () => {
  let fail = 0;
  for (const c of cases) {
    const t0 = Date.now();
    let out;
    try {
      out = await adsDailySection({
        windsorKey: c.key === undefined ? 'TESTKEY' : c.key,
        getJson: c.getJson || stub(c.map || {}),
        now: NOW,
        timeoutMs: c.timeoutMs || 2000,
      });
    } catch (e) { out = 'THROW: ' + e.message; }
    const ms = Date.now() - t0;

    const problems = [];
    if (typeof out !== 'string') problems.push('string emas');
    for (const e of c.expect) if (!String(out).includes(e)) problems.push("yo'q: " + e);
    // Telegram Markdown xavfsizligi: _ ` [ ] bo'lmasin, * juft bo'lsin
    if (/[_`\[\]]/.test(out)) problems.push('Markdown buzuvchi belgi bor');
    if (((String(out).match(/\*/g) || []).length) % 2) problems.push('* toq sonli');
    if (ms > 3000) problems.push('sekin: ' + ms + 'ms');
    if (/-[0-9]+ kun/.test(out)) problems.push('manfiy kun soni');

    if (problems.length) { fail++; console.log('✗ ' + c.name + '\n   ' + problems.join(' | ') + '\n   ---\n   ' + String(out).replace(/\n/g, '\n   ')); }
    else console.log('✓ ' + c.name + ' (' + ms + 'ms)');
  }
  console.log('\n' + (cases.length - fail) + '/' + cases.length + " o'tdi");
  process.exit(fail ? 1 : 0);
})();
