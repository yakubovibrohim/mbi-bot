'use strict';
// ─── MBI Guardian: Instagram'ni bir bosishda qayta ulash ───
// Token o'lib qolsa guardian ADMIN ga bir martalik havola yuboradi. Foydalanuvchi "Allow" ni bosadi:
//   Instagram -> GitHub Pages callback.html (Meta'da ro'yxatdagi redirect_uri) -> /ig-callback (shu server)
//   -> state tekshiruvi -> kod uzoq muddatli tokenga almashtiriladi -> akkaunt @mbi_mebel ekani tekshiriladi
//   -> actions.installInstagramToken (yozish, mbi-bot qayta yaratish, tekshirish) -> Telegram xabari.
//
// Himoya (bu ochiq manzil production tokenini almashtira oladi):
//   • state — 32 bayt tasodifiy, bir martalik, 24 soat; state.json da faqat SHA-256 izi saqlanadi;
//     tekshirilgan zahoti "ishlatilgan" deb belgilanadi — keyingi qadam xato bo'lsa ham qayta ishlamaydi;
//   • akkaunt: yangi tokenning user_id si kutilganiga teng bo'lmasa RAD ETILADI
//     (aks holda begona odam o'z Instagram akkauntini botga ulab qo'yishi mumkin edi);
//   • kod, state va token hech qachon sahifaga, logga yoki xabarga yozilmaydi;
//   • faqat 127.0.0.1 da tinglaydi (Caddy /ig-callback ni shu yerga uzatadi), faqat GET /ig-callback;
//   • yaroqsiz state bilan kelgan so'rov Telegram'ga xabar bermaydi (spam yo'li bo'lmasin).

const nodeHttp = require('http');
const crypto = require('crypto');
const { igRefreshMessage } = require('./actions');

const DAY = 86400000;
const STATE_RE = /^[A-Za-z0-9_-]{20,100}$/;
const keyOf = (raw) => crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 32);

// ── Bir martalik state ──
function newReauthState(state, now, ttlMs = DAY) {
  state.reauth = state.reauth || {};
  for (const [k, v] of Object.entries(state.reauth)) {
    const stale = (v.usedAt && v.usedAt < now - 7 * DAY) || v.expiresAt < now - 7 * DAY;
    if (stale) delete state.reauth[k];
  }
  const raw = crypto.randomBytes(32).toString('base64url');
  state.reauth[keyOf(raw)] = { createdAt: now, expiresAt: now + ttlMs, usedAt: null };
  return raw;
}
function consumeReauthState(state, raw, now) {
  const e = state.reauth && state.reauth[keyOf(raw)];
  if (!e) return { ok: false, reason: "topilmadi (noto'g'ri yoki eski havola)" };
  if (e.usedAt) return { ok: false, reason: 'allaqachon ishlatilgan' };
  if (now > e.expiresAt) return { ok: false, reason: "muddati o'tgan (24 soat)" };
  e.usedAt = now;
  return { ok: true };
}
function buildAuthorizeUrl(cfg, raw) {
  const q = new URLSearchParams({ client_id: cfg.igClientId, redirect_uri: cfg.igRedirectUri, response_type: 'code', scope: cfg.igScopes, state: raw });
  return 'https://www.instagram.com/oauth/authorize?' + q.toString();
}

// ── Instagram API ──
function apiError(res) {
  const j = res && res.json;
  const m = j && (j.error_message || (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : null))));
  if (m) return String(m).slice(0, 120);
  return res && res.status === 0 ? res.error : 'HTTP ' + (res ? res.status : '?');
}
async function exchangeCodeForLongToken({ code, cfg, appSecret, http }) {
  const body = new URLSearchParams({ client_id: cfg.igClientId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: cfg.igRedirectUri, code }).toString();
  const r1 = await http('https://api.instagram.com/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, timeoutMs: 30000,
  });
  const j1 = r1.json && (Array.isArray(r1.json.data) ? r1.json.data[0] : r1.json);
  const short = j1 && j1.access_token;
  if (!short) return { ok: false, error: apiError(r1) };
  const r2 = await http('https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=' + encodeURIComponent(appSecret) + '&access_token=' + encodeURIComponent(short), { timeoutMs: 30000 });
  const j2 = r2.json;
  if (!(j2 && j2.access_token && Number(j2.expires_in) > 0)) return { ok: false, error: apiError(r2) };
  return { ok: true, token: String(j2.access_token), expiresIn: Number(j2.expires_in) };
}
async function verifyAccount({ token, cfg, http }) {
  const r = await http('https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=' + encodeURIComponent(token), { timeoutMs: 20000 });
  const j = r.json || {};
  if (!j.user_id) return { ok: false, error: "yangi token tekshiruvdan o'tmadi (" + apiError(r) + ')' };
  if (String(j.user_id) !== String(cfg.igExpectedUserId)) {
    return { ok: false, username: j.username, error: `boshqa akkaunt bilan ruxsat berilgan (@${j.username || '?'}) — faqat @${cfg.igExpectedUsername} qabul qilinadi` };
  }
  return { ok: true, username: j.username, userId: String(j.user_id) };
}

// ── Sahifa ──
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(status, title, text) {
  const html = '<!doctype html><html lang="uz"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">'
    + '<title>MBI — Instagram</title><style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:12vh auto;padding:0 20px;'
    + 'color:#16211F;background:#F5F7F6;line-height:1.55}h1{font-size:1.35rem;margin:0 0 .6rem}p{margin:0;color:#43524F}</style></head>'
    + `<body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`;
  return { status, html, after: null };
}

// ── /ig-callback ──
// deps: withLock(fn), loadState(), saveState(st), getAppSecret(), install({state,newTok,expiresIn,now}), notify(text), audit(entry)
async function handleCallback({ query = {}, cfg, now = Date.now(), http, deps }) {
  const q = (k) => (typeof query[k] === 'string' ? query[k] : '');
  if (q('error')) return page(400, '⚠️ Ruxsat berilmadi', "Instagram'da ruxsat bekor qilindi. Kerak bo'lsa Telegram'dagi havolani qaytadan oching.");
  const code = q('code'), raw = q('state');
  if (!code || !raw || code.length > 2048 || !STATE_RE.test(raw)) {
    return page(400, "⚠️ Havola to'liq emas", "Telegram'dagi havolani qaytadan oching.");
  }

  // state — bir martalik: tekshirilgan zahoti "ishlatilgan" deb saqlanadi
  const check = await deps.withLock(async () => {
    const st = deps.loadState();
    const r = consumeReauthState(st, raw, now);
    if (r.ok) deps.saveState(st);
    return r;
  });
  if (!check.ok) return page(403, '⛔ Havola yaroqsiz', `Bu havola ${check.reason}. Yangi havola kerak bo'lsa, Claude'dan so'rang.`);

  const fail = async (status, title, text, stage, error, notifyText) => {
    deps.audit({ action: 'ig_reauth', ok: false, stage, error });
    await deps.notify(notifyText);
    return page(status, title, text);
  };

  const secret = await deps.getAppSecret();
  if (!secret) {
    return fail(500, '❌ Server sozlanmagan', "Ilova kaliti topilmadi. Batafsil Telegram'da.", 'secret', "ig_app_secret yo'q",
      "❌ Instagram qayta ulash: ig_app_secret topilmadi — kod tokenga almashtirilmadi.");
  }
  const ex = await exchangeCodeForLongToken({ code, cfg, appSecret: secret, http });
  if (!ex.ok) {
    return fail(502, "❌ Ulab bo'lmadi", "Instagram kodni qabul qilmadi. Batafsil Telegram'da.", 'exchange', ex.error,
      `❌ Instagram qayta ulash muvaffaqiyatsiz: kodni tokenga almashtirib bo'lmadi (${ex.error}). Hech narsa o'zgartirilmadi.`);
  }
  const acc = await verifyAccount({ token: ex.token, cfg, http });
  if (!acc.ok) {
    return fail(403, '⛔ Boshqa akkaunt', `Faqat @${cfg.igExpectedUsername} akkaunti ulanishi mumkin. Hech narsa o'zgartirilmadi.`, 'account', acc.error,
      `⛔ Instagram qayta ulash RAD ETILDI: ${acc.error}. Hech narsa o'zgartirilmadi.`);
  }

  const done = page(200, '✅ Ruxsat olindi', "Bot yangilanmoqda — natija bir daqiqa ichida Telegram'ga keladi. Bu sahifani yopishingiz mumkin.");
  done.after = async () => {
    let out;
    try {
      out = await deps.withLock(async () => {
        const st = deps.loadState();
        const o = await deps.install({ state: st, newTok: ex.token, expiresIn: ex.expiresIn, now });
        st.igRefresh = { lastAttemptAt: now, lastAttemptOk: !!o.ok, lastError: o.ok ? null : o.error };
        deps.saveState(st);
        return o;
      });
    } catch (e) {
      out = { ok: false, error: 'ichki xato: ' + String(e && e.message).slice(0, 100) };
    }
    deps.audit({
      action: 'ig_reauth', ok: !!out.ok, changed: !!out.changed, restartedBot: !!out.restarted,
      expiresAt: out.expiresAt ? new Date(out.expiresAt).toISOString() : null, error: out.ok ? null : out.error,
    });
    await deps.notify(igRefreshMessage(out, cfg, now, { kind: 'reauth' }));
  };
  return done;
}

// ── HTTP server (faqat 127.0.0.1) ──
function startCallbackServer({ host, port, onCallback, log = console }) {
  const server = nodeHttp.createServer(async (req, res) => {
    const send = (status, html) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      });
      res.end(html);
    };
    try {
      if ((req.url || '').length > 4096) return send(414, page(414, 'So‘rov juda uzun', '').html);
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/ig-callback') return send(404, page(404, 'Topilmadi', '').html);
      if (req.method !== 'GET') return send(405, page(405, 'Ruxsat etilmagan usul', '').html);
      const out = await onCallback(Object.fromEntries(u.searchParams));
      send(out.status, out.html);
      if (out.after) out.after().catch((e) => log.error('[guardian] ig-callback keyingi qadam xatosi:', e && e.message));
    } catch (e) {
      log.error('[guardian] ig-callback xatosi:', e && e.message);
      send(500, page(500, '❌ Ichki xato', "Batafsil server logida.").html);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 20000;
  server.on('error', (e) => log.error('[guardian] qayta ulash serveri ishga tushmadi:', e && e.message));
  server.listen(port, host);
  return server;
}

module.exports = {
  newReauthState, consumeReauthState, buildAuthorizeUrl,
  exchangeCodeForLongToken, verifyAccount, handleCallback, startCallbackServer,
  _internal: { keyOf, page, esc, STATE_RE },
};
