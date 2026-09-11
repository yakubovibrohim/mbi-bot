'use strict';
// ─── MBI Guardian: avtomatik tuzatish qarorlari (sof funksiya — test qilinadi) ───
// Faqat shu uch holat o'zi tuzatiladi; qolgan hamma narsa faqat xabar qilinadi:
//   • restart — mbi-bot / mbi-tannarx-bot PM2 da yo'q, to'xtagan yoki xatolikda (errored),
//               yoki online bo'lsa ham ichki porti javob bermayapti (qotib qolgan).
//               2 marta ketma-ket tasdiqlansa (≥15 daqiqa). PM2 o'zi qayta ishga tushirayotgan
//               bo'lsa (qulash sikli — warn) aralashmaydi.
//   • caddy   — Caddy (HTTPS) systemd'da faol emas (unit'da Restart=no); 2 marta tasdiqlansa.
//   • webhook — @mbi_mebel_bot webhook manzili bo'sh yoki boshqa joyga o'zgargan. Darhol, chunki
//               qayta o'rnatish zararsiz (kutilayotgan xabarlar o'chirilmaydi). Faqat BIZNING
//               manzilga: WEBHOOK_BASE aynan shu server bo'lmasa tegilmaydi.
// Cheklovlar (qulash siklida cheksiz aylanmasin, boshqa server bilan "tortishuv" bo'lmasin):
//   • bir nishonga urinishlar orasida kamida 25 daqiqa;
//   • 6 soatda jarayon/Caddy uchun 3, webhook uchun 2 urinish — keyin to'xtaydi va bir marta
//     🚨 xabar yuboriladi (urinishlar 6 soatdan eskirgach yana urinadi);
//   • autofix.off fayli bo'lsa (texnik ish paytida) — hech narsa tuzatilmaydi.
// Urinish bajarilishidan OLDIN yoziladi — muvaffaqiyatsiz urinishlar ham limitga kiradi.

const MIN = 60000, H = 3600000;
const DEFAULTS = { confirmRuns: 2, minGapMs: 25 * MIN, windowMs: 6 * H, maxRestarts: 3, maxWebhookFixes: 2 };

// Tuzatishdan keyin qaysi tekshiruvlar qayta ishga tushiriladi (checks.js funksiya nomlari)
const RECHECKS = {
  restart: ['checkProcesses', 'checkLocal', 'checkPublic'],
  caddy: ['checkCaddy', 'checkPublic'],
  webhook: ['checkTelegram'],
};

const hintFor = (c) => (c.type === 'caddy' ? 'journalctl -u caddy' : `pm2 logs ${c.target}`);
const whatFor = (c) => (c.type === 'caddy' ? 'Caddy (HTTPS)' : c.target);
const RENDER_NOTE = " ⚠️ Eski manzil Render'niki — Render yana yoqilgan bo'lishi mumkin. Ikkalasi bir vaqtda ishlasa GitHub JSON'larga takroriy yozuv bo'ladi: Render dashboard'ni tekshiring.";

function blockedText(c, n, rc) {
  const h = Math.round(rc.windowMs / H);
  if (c.type === 'webhook') {
    return `🚨 @mbi_mebel_bot webhook oxirgi ${h} soatda ${n} marta qayta o'rnatildi, lekin yana o'zgartirildi (hozir: "${c.current || "bo'sh"}"). `
      + "Uni boshqa joy o'zgartiryapti — Render yoki boshqa server yoqilgan bo'lishi mumkin. Avtomatik tuzatish to'xtatildi, tekshiring.";
  }
  return `🚨 ${whatFor(c)}: oxirgi ${h} soatda ${n} marta avtomatik qayta ishga tushirildi, lekin yana ishlamayapti (${c.reason}). `
    + `Avtomatik tiklash to'xtatildi — qo'lda tekshiring: ${hintFor(c)}`;
}

// issues: alerting holatidagi state.issues (oldingi tekshiruvlardagi ketma-ket crit soni)
// remedyState: state.remedy ({ attempts: {key: [ts]}, blockedAt: {key: ts} })
function planRemedies({ issues = {}, remedyState, results, now, cfg, paused = false }) {
  const rc = { ...DEFAULTS, ...(cfg.remedy || {}) };
  const st = JSON.parse(JSON.stringify(remedyState || {}));
  st.attempts = st.attempts || {};
  st.blockedAt = st.blockedAt || {};
  const actions = [], blocked = [];

  for (const k of Object.keys(st.attempts)) {
    st.attempts[k] = st.attempts[k].filter((ts) => now - ts < rc.windowMs);
    if (!st.attempts[k].length) delete st.attempts[k];
  }
  if (paused) return { actions, blocked, state: st, paused: true };

  const byId = new Map(results.map((r) => [r.id, r]));
  const confirmed = (r) => !!r && r.level === 'crit' && ((issues[r.id] && issues[r.id].streak) || 0) + 1 >= rc.confirmRuns;

  const candidates = [];
  for (const name of cfg.processes || []) {
    const p = byId.get('proc:' + name);
    const ep = (cfg.localEndpoints || []).find((e) => e[4] === name);
    const local = ep && byId.get(ep[0]);
    const base = { type: 'restart', key: 'restart:' + name, target: name, max: rc.maxRestarts };
    if (confirmed(p)) candidates.push({ ...base, reason: p.msg });
    else if (p && p.level === 'ok' && confirmed(local)) candidates.push({ ...base, reason: 'online, lekin ichki porti javob bermayapti (qotib qolgan)' });
  }
  const caddy = byId.get('sys:caddy');
  if (confirmed(caddy)) candidates.push({ type: 'caddy', key: 'caddy', target: 'caddy', reason: caddy.msg, max: rc.maxRestarts });

  const wh = byId.get('tg:webhook');
  const ourUrl = 'https://' + cfg.publicHost + '/webhook';
  if (wh && wh.level === 'crit' && wh.meta && wh.meta.fixable === 'webhook' && wh.meta.expected === ourUrl) {
    candidates.push({ type: 'webhook', key: 'webhook', target: '@mbi_mebel_bot', url: ourUrl, current: String(wh.meta.current || ''), max: rc.maxWebhookFixes });
  }

  const active = new Set(candidates.map((c) => c.key));
  for (const k of Object.keys(st.blockedAt)) if (!active.has(k)) delete st.blockedAt[k];

  for (const c of candidates) {
    const { max, ...action } = c;
    const tries = st.attempts[c.key] || [];
    if (tries.length >= max) {
      if (!st.blockedAt[c.key] || now - st.blockedAt[c.key] >= rc.windowMs) {
        st.blockedAt[c.key] = now;
        blocked.push({ ...action, count: tries.length, text: blockedText(c, tries.length, rc) });
      }
      continue;
    }
    const last = tries.length ? tries[tries.length - 1] : null;
    if (last != null && now - last < rc.minGapMs) continue;
    st.attempts[c.key] = [...tries, now];
    actions.push(action);
  }
  return { actions, blocked, state: st, paused: false };
}

function remedyMessage(a, out) {
  if (a.type === 'webhook') {
    const was = a.current ? `boshqa manzilga o'zgartirilgan edi ("${a.current}")` : "o'chib qolgan edi (manzil bo'sh)";
    const render = /onrender\.com/i.test(a.current || '') ? RENDER_NOTE : '';
    return out.ok
      ? `🔧 @mbi_mebel_bot webhook ${was} — qayta o'rnatdim, bot xabarlarni yana oladi.${render}`
      : `❌ @mbi_mebel_bot webhook ${was}, qayta o'rnatib bo'lmadi: ${out.error}.${render}`;
  }
  return out.ok
    ? `🔧 ${whatFor(a)} ishlamay qoldi (${a.reason}) — avtomatik qayta ishga tushirdim, hozir ishlayapti.`
    : `❌ ${whatFor(a)} ishlamay qoldi (${a.reason}), avtomatik qayta ishga tushirib bo'lmadi: ${out.error}. Qo'lda tekshiring: ${hintFor(a)}`;
}

module.exports = { planRemedies, remedyMessage, RECHECKS, DEFAULTS };
