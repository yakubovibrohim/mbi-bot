'use strict';
// guardian: reauth.js testlari — bir martalik state, kod almashtirish, akkaunt tekshiruvi, /ig-callback va HTTP server.
// Soxta Instagram API bilan: haqiqiy tokenlarga tegmaydi.
// Ishga tushirish: npm test   yoki   node guardian/test/reauth.test.js
const nodeHttp = require('http');
const R = require('../reauth');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}
const H = 3600 * 1000, DAY = 24 * H;
const CFG = {
  igClientId: '1689794002143625', igRedirectUri: 'https://yakubovibrohim.github.io/mbi-bot/callback.html',
  igScopes: 'instagram_business_basic,instagram_business_manage_messages', igExpectedUserId: '17841464753251739',
  igExpectedUsername: 'mbi_mebel', igReauthUrl: 'https://static', igRefresh: { retryAfterMs: 6 * H },
};
const SECRET = 'appsecret_0123456789abcdef';
const SHORT = 'IGshort_TOKEN_aaaaaaaa', LONG = 'IGAAlong_TOKEN_bbbbbbbbbb', CODE = 'AQcodeFromInstagram_cccccccccccccccc';
const secretsIn = (s) => [SECRET, SHORT, LONG, CODE].filter((v) => String(s).includes(v));

// ── state ──
{
  const st = {};
  const now = 1000 * DAY;
  const raw = R.newReauthState(st, now, DAY);
  const keys = Object.keys(st.reauth);
  t('state: 43 belgilik url-xavfsiz tasodifiy qiymat', /^[A-Za-z0-9_-]{43}$/.test(raw), raw);
  t('state.json da xom qiymat emas, faqat izi saqlanadi', keys.length === 1 && keys[0] !== raw && !JSON.stringify(st).includes(raw));
  t('state: 24 soat muddat', st.reauth[keys[0]].expiresAt === now + DAY);
  t('state: har safar boshqacha', R.newReauthState({}, now) !== R.newReauthState({}, now));

  t("noma'lum state rad etiladi", R.consumeReauthState(st, 'x'.repeat(43), now).ok === false);
  const r1 = R.consumeReauthState(st, raw, now + H);
  t('yaroqli state qabul qilinadi va ishlatilgan deb belgilanadi', r1.ok && st.reauth[keys[0]].usedAt === now + H);
  const r2 = R.consumeReauthState(st, raw, now + 2 * H);
  t("ikkinchi marta ishlatib bo'lmaydi", !r2.ok && r2.reason.includes('ishlatilgan'), JSON.stringify(r2));

  const st2 = {};
  const raw2 = R.newReauthState(st2, now, DAY);
  const r3 = R.consumeReauthState(st2, raw2, now + DAY + 1);
  t("muddati o'tgan state rad etiladi", !r3.ok && r3.reason.includes("muddati o'tgan"), JSON.stringify(r3));

  const st3 = { reauth: { old1: { createdAt: 0, expiresAt: 1, usedAt: null }, old2: { createdAt: 0, expiresAt: now + DAY, usedAt: now - 8 * DAY }, fresh: { createdAt: now, expiresAt: now + DAY, usedAt: null } } };
  R.newReauthState(st3, now, DAY);
  t('eski (7 kundan oshgan) yozuvlar tozalanadi, yangilari qoladi', !st3.reauth.old1 && !st3.reauth.old2 && st3.reauth.fresh && Object.keys(st3.reauth).length === 2);
}

// ── authorize URL ──
{
  const u = new URL(R.buildAuthorizeUrl(CFG, 'STATE_abcdefghijklmnopqrstu'));
  t('authorize URL: instagram.com/oauth/authorize', u.origin === 'https://www.instagram.com' && u.pathname === '/oauth/authorize');
  t('authorize URL: client_id, redirect_uri, response_type, scope, state aniq', u.searchParams.get('client_id') === CFG.igClientId
    && u.searchParams.get('redirect_uri') === CFG.igRedirectUri && u.searchParams.get('response_type') === 'code'
    && u.searchParams.get('scope') === CFG.igScopes && u.searchParams.get('state') === 'STATE_abcdefghijklmnopqrstu');
}

// ── soxta Instagram API ──
function stubHttp({ oauth, exch, me }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.includes('api.instagram.com/oauth/access_token')) return typeof oauth === 'function' ? oauth(opts) : oauth;
    if (url.includes('ig_exchange_token')) return exch;
    if (url.includes('/me?')) return me;
    return { status: 404, json: null };
  };
  fn.calls = calls;
  return fn;
}
const OAUTH_OK = { status: 200, json: { access_token: SHORT, user_id: 17841464753251739, permissions: ['instagram_business_basic'] } };
const OAUTH_DATA = { status: 200, json: { data: [{ access_token: SHORT, user_id: '17841464753251739' }] } };
const EXCH_OK = { status: 200, json: { access_token: LONG, token_type: 'bearer', expires_in: 5184000 } };
const ME_OK = { status: 200, json: { user_id: '17841464753251739', username: 'mbi_mebel' } };
const ME_OTHER = { status: 200, json: { user_id: '999', username: 'begona_akkaunt' } };

(async () => {
  // ── exchange ──
  {
    let body = null;
    const http = stubHttp({ oauth: (opts) => { body = new URLSearchParams(opts.body); return OAUTH_OK; }, exch: EXCH_OK, me: ME_OK });
    const ex = await R.exchangeCodeForLongToken({ code: CODE, cfg: CFG, appSecret: SECRET, http });
    t('almashtirish: uzoq muddatli token va muddat', ex.ok && ex.token === LONG && ex.expiresIn === 5184000, JSON.stringify(ex));
    t('almashtirish: POST tanasida redirect_uri, grant_type, code, client_id aniq', body && body.get('redirect_uri') === CFG.igRedirectUri
      && body.get('grant_type') === 'authorization_code' && body.get('code') === CODE && body.get('client_id') === CFG.igClientId);
    const ex2 = await R.exchangeCodeForLongToken({ code: CODE, cfg: CFG, appSecret: SECRET, http: stubHttp({ oauth: OAUTH_DATA, exch: EXCH_OK }) });
    t('almashtirish: javob data[] ichida kelsa ham ishlaydi', ex2.ok && ex2.token === LONG);
    const ex3 = await R.exchangeCodeForLongToken({ code: CODE, cfg: CFG, appSecret: SECRET, http: stubHttp({ oauth: { status: 400, json: { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code' } } }) });
    t('almashtirish: yaroqsiz kod — aniq xato matni', !ex3.ok && ex3.error === 'Invalid authorization code', JSON.stringify(ex3));
    const ex4 = await R.exchangeCodeForLongToken({ code: CODE, cfg: CFG, appSecret: SECRET, http: stubHttp({ oauth: OAUTH_OK, exch: { status: 400, json: { error: { message: 'Error validating client secret' } } } }) });
    t("almashtirish: uzoq muddatliga o'tmasa — qisqa token ishlatilmaydi", !ex4.ok && ex4.error.includes('client secret'), JSON.stringify(ex4));
  }

  // ── akkaunt ──
  {
    const a1 = await R.verifyAccount({ token: LONG, cfg: CFG, http: stubHttp({ me: ME_OK }) });
    t('akkaunt: @mbi_mebel qabul qilinadi', a1.ok && a1.username === 'mbi_mebel');
    const a2 = await R.verifyAccount({ token: LONG, cfg: CFG, http: stubHttp({ me: ME_OTHER }) });
    t('akkaunt: begona akkaunt RAD etiladi (username xabarda)', !a2.ok && a2.error.includes('@begona_akkaunt'), JSON.stringify(a2));
    const a3 = await R.verifyAccount({ token: LONG, cfg: CFG, http: stubHttp({ me: { status: 400, json: { error: { message: 'Invalid OAuth access token', code: 190 } } } }) });
    t('akkaunt: ishlamaydigan token rad etiladi', !a3.ok && a3.error.includes('Invalid OAuth'), JSON.stringify(a3));
  }

  // ── /ig-callback ──
  function mkDeps(stateObj, over = {}) {
    const log = { notified: [], audited: [], installs: 0, saves: 0, locks: 0 };
    let st = JSON.parse(JSON.stringify(stateObj));
    const deps = {
      withLock: async (fn) => { log.locks++; return fn(); },
      loadState: () => JSON.parse(JSON.stringify(st)),
      saveState: (s) => { log.saves++; st = JSON.parse(JSON.stringify(s)); },
      getAppSecret: async () => SECRET,
      install: async ({ state, newTok, expiresIn, now }) => { log.installs++; log.installedTok = newTok; state.igToken = { fp: 'x', expiresAt: new Date(now + expiresIn * 1000).toISOString() }; return { ok: true, changed: true, restarted: true, expiresAt: now + expiresIn * 1000 }; },
      notify: async (text) => { log.notified.push(text); return true; },
      audit: (e) => log.audited.push(e),
      ...over,
    };
    return { deps, log, state: () => st };
  }
  const NOW = Date.parse('2026-09-12T08:00:00Z');
  const freshState = () => { const s = {}; const raw = R.newReauthState(s, NOW - H, DAY); return { s, raw }; };
  const fullHttp = () => stubHttp({ oauth: OAUTH_OK, exch: EXCH_OK, me: ME_OK });

  {
    const { deps, log } = mkDeps({});
    const o = await R.handleCallback({ query: {}, cfg: CFG, now: NOW, http: fullHttp(), deps });
    t("parametrsiz so'rov — 400, hech narsa qilinmaydi", o.status === 400 && log.locks === 0 && log.notified.length === 0);
    const o2 = await R.handleCallback({ query: { error: 'access_denied', state: 'whatever' }, cfg: CFG, now: NOW, http: fullHttp(), deps });
    t("foydalanuvchi rad etsa — 400 'Ruxsat berilmadi', state tegilmaydi", o2.status === 400 && o2.html.includes('Ruxsat berilmadi') && log.locks === 0);
    const o3 = await R.handleCallback({ query: { code: CODE, state: 'bad state with spaces!!' }, cfg: CFG, now: NOW, http: fullHttp(), deps });
    t('buzuq state formati — 400, lockga ham kirmaydi', o3.status === 400 && log.locks === 0);
  }
  {
    const { s } = freshState();
    const { deps, log } = mkDeps(s);
    const http = fullHttp();
    const o = await R.handleCallback({ query: { code: CODE, state: 'Z'.repeat(43) }, cfg: CFG, now: NOW, http, deps });
    t("noto'g'ri state — 403, Instagram'ga so'rov yo'q, Telegram'ga xabar yo'q (spam yo'li yo'q)",
      o.status === 403 && http.calls.length === 0 && log.notified.length === 0 && log.installs === 0);
  }
  {
    const { s, raw } = freshState();
    const { deps, log, state } = mkDeps(s);
    const http = fullHttp();
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http, deps });
    t("to'g'ri oqim: 200 sahifa darhol, o'rnatish keyingi qadamda", o.status === 200 && typeof o.after === 'function' && log.installs === 0);
    t("sahifada kod/token/kalit yo'q", secretsIn(o.html).length === 0 && !o.html.includes(raw));
    t('state darhol ishlatilgan deb saqlandi', Object.values(state().reauth)[0].usedAt === NOW);
    await o.after();
    t("keyingi qadam: UZOQ muddatli token o'rnatildi (bir marta)", log.installs === 1 && log.installedTok === LONG);
    t('keyingi qadam: igRefresh va igToken state ga saqlandi', state().igRefresh && state().igRefresh.lastAttemptOk === true && state().igToken);
    t('jurnal: ig_reauth ok, changed, restartedBot', log.audited.some((e) => e.action === 'ig_reauth' && e.ok && e.changed && e.restartedBot));
    t("Telegram: '🔑 Instagram qayta ulandi', kalitlarsiz", log.notified.length === 1 && log.notified[0].includes('qayta ulandi') && secretsIn(log.notified[0]).length === 0, log.notified[0]);
    const again = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW + 60000, http, deps });
    t("o'sha havolani qayta ochish — 403 'allaqachon ishlatilgan'", again.status === 403 && again.html.includes('ishlatilgan') && log.installs === 1);
  }
  {
    const { s, raw } = freshState();
    const { deps, log, state } = mkDeps(s);
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http: stubHttp({ oauth: OAUTH_OK, exch: EXCH_OK, me: ME_OTHER }), deps });
    t("begona akkaunt: 403, o'rnatilmaydi", o.status === 403 && o.after === null && log.installs === 0);
    t("begona akkaunt: Telegram'ga 'RAD ETILDI' va username", log.notified.length === 1 && log.notified[0].includes('RAD ETILDI') && log.notified[0].includes('@begona_akkaunt'));
    t("begona akkaunt: state baribir ishlatilgan (qayta urinib bo'lmaydi)", Object.values(state().reauth)[0].usedAt === NOW);
    t('begona akkaunt: jurnalga stage=account', log.audited.some((e) => e.stage === 'account' && e.ok === false));
  }
  {
    const { s, raw } = freshState();
    const { deps, log } = mkDeps(s);
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http: stubHttp({ oauth: { status: 400, json: { error_message: 'This authorization code has been used' } } }), deps });
    t("kod almashtirilmasa: 502, o'rnatilmaydi, Telegram'ga sabab", o.status === 502 && log.installs === 0 && log.notified[0].includes('has been used') && secretsIn(log.notified[0]).length === 0);
  }
  {
    const { s, raw } = freshState();
    const { deps, log } = mkDeps(s, { getAppSecret: async () => null });
    const http = fullHttp();
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http, deps });
    t("ilova kaliti yo'q: 500, Instagram'ga so'rov yuborilmaydi", o.status === 500 && http.calls.length === 0 && log.notified[0].includes('ig_app_secret'));
  }
  {
    const { s, raw } = freshState();
    const { deps, log } = mkDeps(s, { install: async () => ({ ok: false, changed: true, botDown: true, error: "mbi-bot qayta ko'tarilmadi: 90 soniyada javob bermadi" }) });
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http: fullHttp(), deps });
    await o.after();
    t("o'rnatishda bot ko'tarilmasa — Telegram'ga 'Darhol tekshiring'", log.notified.some((n) => n.includes('Darhol tekshiring')));
  }
  {
    const { s, raw } = freshState();
    const { deps, log } = mkDeps(s, { install: async () => { throw new Error("disk to'la"); } });
    const o = await R.handleCallback({ query: { code: CODE, state: raw }, cfg: CFG, now: NOW, http: fullHttp(), deps });
    await o.after();
    t("o'rnatish throw qilsa ham guardian qulamaydi, xabar yuboriladi", log.notified.length === 1 && log.notified[0].includes('ichki xato'));
  }
  {
    const p = R._internal.page(200, '<script>alert(1)</script>', 'a"b\'c&d');
    t("sahifa: HTML escape (XSS yo'q)", !p.html.includes('<script>alert') && p.html.includes('&lt;script&gt;') && p.html.includes('&quot;') && p.html.includes('&#39;'));
  }

  // ── haqiqiy HTTP server ──
  {
    let seen = null;
    const server = R.startCallbackServer({
      host: '127.0.0.1', port: 0, log: { error: () => {} },
      onCallback: async (q) => { seen = q; return { status: 200, html: 'OK-PAGE', after: async () => { seen.afterRan = true; } }; },
    });
    await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const req = (method, p) => new Promise((resolve) => {
      const rq = nodeHttp.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
        let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
      });
      rq.on('error', (e) => resolve({ status: 0, body: e.message })); rq.end();
    });
    const a = await req('GET', '/boshqa');
    const b = await req('POST', '/ig-callback?code=x&state=y');
    const c = await req('GET', '/ig-callback?code=abc&state=def');
    await new Promise((r) => setTimeout(r, 50));
    const d = await req('GET', '/ig-callback?x=' + 'a'.repeat(5000));
    server.close();
    t("server: boshqa yo'l — 404", a.status === 404);
    t('server: POST — 405', b.status === 405);
    t("server: GET /ig-callback — handler'ga parametrlar yetadi, after ishlaydi", c.status === 200 && c.body === 'OK-PAGE' && seen && seen.code === 'abc' && seen.state === 'def' && seen.afterRan);
    t('server: xavfsizlik sarlavhalari (no-store, no-referrer, DENY)', c.headers['cache-control'] === 'no-store' && c.headers['referrer-policy'] === 'no-referrer' && c.headers['x-frame-options'] === 'DENY');
    t("server: juda uzun so'rov — 414", d.status === 414);
  }

  console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
  process.exit(fail ? 1 : 0);
})();
