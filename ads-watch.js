'use strict';
// ─── Reklama yetkazilishi nazorati (Windsor.ai → Meta Ads) ───
// 18:30 kunlik xulosaga qo'shiladigan bo'lim.
//
// Qoidalar:
//  • HECH QACHON throw qilmaydi — kunlik xulosani buzmasin.
//  • Ma'lumot olinmasa buni OCHIQ aytadi. Jimlik "hammasi joyida" deb o'qilmasin:
//    eski 12:00 tekshiruvi reklama 2 oy to'xtab turganda shu sababdan jim qolgan.
//  • Telegram Markdown'ni buzadigan belgilar (_ * ` [ ]) tashqi matndan tozalanadi —
//    aks holda butun kunlik xulosa jimgina yuborilmay qoladi.
//
// Cheklov: Windsor ko'rsatuv bo'lmagan davr uchun holat (PAUSED va h.k.) qaytarmaydi.
// Shuning uchun sabab faqat so'nggi 30 kunda ko'rsatuv bo'lgan bo'lsa aniqlanadi.
// Akkaunt vaqt zonasi Asia/Aqtobe (UTC+5) — Toshkent bilan bir xil, sanalar mos.

const TZ = 'Asia/Tashkent';

const STATUS_UZ = {
  PAUSED: 'pauza qilingan',
  CAMPAIGN_PAUSED: 'kampaniya pauzada',
  ADSET_PAUSED: "reklama to'plami pauzada",
  DELETED: "o'chirilgan",
  ARCHIVED: 'arxivlangan',
  DISAPPROVED: 'Meta rad etgan',
  PENDING_REVIEW: 'Meta tekshiruvida',
  IN_PROCESS: 'qayta ishlanmoqda',
  WITH_ISSUES: 'Meta muammo belgilagan',
  PENDING_BILLING_INFO: "to'lov ma'lumoti kutilmoqda",
};
const ACCOUNT_UZ = {
  DISABLED: 'akkaunt bloklangan',
  UNSETTLED: "to'lov o'tmagan (qarzdorlik)",
  PENDING_RISK_REVIEW: 'akkaunt xavfsizlik tekshiruvida',
  PENDING_SETTLEMENT: "to'lov kutilmoqda",
  IN_GRACE_PERIOD: "to'lov muddati o'tgan",
  PENDING_CLOSURE: 'akkaunt yopilish arafasida',
  CLOSED: 'akkaunt yopilgan',
};

const clean = (s) => String(s == null ? '' : s).replace(/[_*`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const ymdIn = (d) => d.toLocaleDateString('en-CA', { timeZone: TZ });           // 2026-09-10
const dmy = (ymd) => { const [y, m, d] = ymd.split('-'); return `${d}.${m}.${y}`; };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const money = (n) => '$' + (Number(n) || 0).toFixed(2);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function aggregateByDay(rows) {
  const byDay = {};
  for (const r of rows) {
    if (!r || !r.date) continue;
    const d = (byDay[r.date] = byDay[r.date] || { spend: 0, imp: 0 });
    d.spend += Number(r.spend) || 0;
    d.imp += Number(r.impressions) || 0;
  }
  return byDay;
}

const HEAD = '📣 *Reklama:*';

async function adsDailySection(opts) {
  try {
    const { windsorKey, getJson, now = new Date(), timeoutMs = 25000 } = opts || {};
    if (!windsorKey) return `${HEAD} ⚠️ tekshirib bo'lmadi — Windsor kaliti sozlanmagan.`;
    if (typeof getJson !== 'function') return `${HEAD} ⚠️ tekshirib bo'lmadi — ichki xato (getJson yo'q).`;

    const base = 'https://connectors.windsor.ai/facebook?api_key=' + encodeURIComponent(windsorKey);
    const get = (preset, fields) => withTimeout(getJson(`${base}&date_preset=${preset}&fields=${fields}`), timeoutMs);
    const ok = (j) => !!(j && Array.isArray(j.data));

    const today = ymdIn(now);
    const yesterday = ymdIn(new Date(now.getTime() - 86400000));

    const delivery = await get('last_7dT', 'date,campaign,spend,impressions');
    if (!ok(delivery)) {
      const why = delivery && delivery.error ? ` (${clean(delivery.error).slice(0, 80)})` : '';
      return `${HEAD} ⚠️ holatni tekshirib bo'lmadi — Windsor javob bermadi${why}.\nReklama ishlayotganini Ads Manager'da qo'lda tekshiring.`;
    }

    const byDay = aggregateByDay(delivery.data);
    const t = byDay[today] || { spend: 0, imp: 0 };
    if (t.imp > 0) {
      return `${HEAD} ✅ ishlayapti — bugun ${money(t.spend)}, ${Math.round(t.imp)} ko'rsatuv.`;
    }

    // ── Bugun ko'rsatuv yo'q: oxirgi ishlagan kun va sababni izlaymiz ──
    const y = byDay[yesterday] || { spend: 0, imp: 0 };
    // Bugundan keyingi sanalar e'tiborsiz: Windsor davri o'z sana chegarasi bo'yicha olinadi
    // va yarim tun atrofida biznikidan oldinda bo'lishi mumkin (aks holda "-1 kun oldin" chiqadi).
    let lastDay = Object.keys(byDay).filter((d) => d <= today && byDay[d].imp > 0).sort().pop() || null;
    let lastSpend = lastDay ? byDay[lastDay].spend : 0;

    const [statusJ, accountJ, longJ] = await Promise.all([
      get('last_30dT', 'campaign,campaign_effective_status,adset_effective_status,effective_status'),
      get('last_30dT', 'account_status,spend_cap,amount_spent'),
      lastDay ? Promise.resolve(null) : get('last_90d', 'date,spend,impressions'),
    ]);

    if (!lastDay && ok(longJ)) {
      const longBy = aggregateByDay(longJ.data);
      lastDay = Object.keys(longBy).filter((d) => d <= today && longBy[d].imp > 0).sort().pop() || null;
      lastSpend = lastDay ? longBy[lastDay].spend : 0;
    }

    const reasons = new Set();
    let statusKnown = false;
    if (ok(accountJ)) {
      for (const r of accountJ.data) {
        const s = String(r.account_status || '').toUpperCase();
        if (s) statusKnown = true;
        if (s && s !== 'ACTIVE' && s !== 'ANY_ACTIVE') reasons.add(ACCOUNT_UZ[s] || 'akkaunt holati: ' + clean(s));
        const cap = Number(r.spend_cap) || 0;
        const spent = Number(r.amount_spent) || 0;
        if (cap > 0 && spent >= cap) reasons.add('akkaunt sarf limiti tugagan');
      }
    }
    if (ok(statusJ)) {
      for (const r of statusJ.data) {
        for (const k of ['campaign_effective_status', 'adset_effective_status', 'effective_status']) {
          const s = String(r[k] || '').toUpperCase();
          if (s) statusKnown = true;
          if (s && s !== 'ACTIVE') reasons.add(STATUS_UZ[s] || clean(s).toLowerCase());
        }
      }
    }

    const lines = [`🔴 *Reklama TO'XTAGAN* — bugun hozirgacha 0 ko'rsatuv.`];
    if (y.imp > 0) lines.push(`• Kecha ishlagan edi (${money(y.spend)}) — demak bugun to'xtagan.`);
    else lines.push('• Kecha ham ko\'rsatuv bo\'lmagan.');

    if (lastDay) {
      const ago = Math.max(0, daysBetween(lastDay, today));
      lines.push(`• Oxirgi ishlagan kun: ${dmy(lastDay)} (${money(lastSpend)}) — ${ago} kun oldin.`);
    } else if (ok(longJ)) {
      lines.push("• So'nggi 90 kunda birorta ham ko'rsatuv yo'q.");
    } else {
      lines.push("• Oxirgi ishlagan kunni aniqlab bo'lmadi.");
    }

    if (reasons.size) lines.push('• Sabab: ' + [...reasons].join('; ') + '.');
    else if (statusKnown) lines.push("• Meta'da holat faol ko'rinadi, lekin ko'rsatuv yo'q — byudjet, to'lov yoki jadvalni tekshiring.");
    else lines.push("• Sababni aniqlab bo'lmadi: so'nggi 30 kunda ko'rsatuv bo'lmagani uchun Windsor holat bermaydi.");

    lines.push("👉 Ads Manager'ni tekshiring.");
    return lines.join('\n');
  } catch (e) {
    return `${HEAD} ⚠️ tekshirishda ichki xato: ${clean(e && e.message).slice(0, 80)}.`;
  }
}

module.exports = { adsDailySection, _internal: { clean, ymdIn, dmy, daysBetween, withTimeout } };
