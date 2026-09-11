'use strict';
// ─── MBI Guardian — tizim nazoratchisi ───
// 4-versiya: tekshiruvlar FAQAT O'QIYDI + ruxsat etilgan amallar (actions.js):
//   • IG_TOKEN ni muddatidan oldin yangilash;
//   • token o'lsa — bir bosishli qayta ulash (reauth.js, 127.0.0.1:3003/ig-callback);
//   • avtomatik tuzatish (remedy.js qaror qiladi): to'xtagan yoki qotib qolgan mbi-bot / mbi-tannarx-bot,
//     faol bo'lmagan Caddy, bo'shab qolgan yoki o'zgargan @mbi_mebel_bot webhook.
// Alohida PM2 jarayoni (mbi-guardian): mbi-bot qulasa ham ishlayveradi va Telegram orqali yozadi.
//
// Har 15 daqiqada:
//   1) checks.js — hamma tekshiruvlar; natija status.json ga yoziladi,
//      mbi-bot 18:30 xulosada shu fayldan "🛡 Tizim" qatorini chiqaradi (section.js);
//   2) remedy.js — tasdiqlangan nosozlikni o'zi tuzatish kerakmi (limitlar bilan), actions.js bajaradi;
//      tuzatilgan qism qayta tekshiriladi — ogohlantirishlar tuzatishdan KEYINGI holatga qarab chiqadi;
//   3) alerting.js — xabar kerakmi hal qiladi;
//   4) actions.js — IG_TOKEN yangilash vaqti kelganmi (45 kun qolganda tungi 03–05, 7 kunda darhol);
//   token o'lik bo'lsa xabarga bir martalik qayta ulash havolasi qo'shiladi;
//   xabarlar ADMIN ga ODDIY MATN (Markdown yo'q — tashqi matn uni buzib, xabar jimgina yo'qolmasin).
// Kalitlar har safar /root/.mbi.env dan qayta o'qiladi — token almashsa guardianni qayta ishga tushirish shart emas.
// Kalit qiymatlari hech qachon logga yoki xabarga tushmaydi (redact).
//
// Qo'lda:
//   node guardian.js --once --dry-run          hamma tekshiruv; hech narsa yubormaydi, yozmaydi, tuzatmaydi
//   node guardian.js --refresh-ig --dry-run    IG_TOKEN yangilash qarorini ko'rsatadi, bajarmaydi
//   node guardian.js --refresh-ig --force      IG_TOKEN ni hozir yangilaydi (xabar + jurnal bilan)
//   node guardian.js --reauth-link             bir martalik qayta ulash havolasini Telegram'ga yuboradi
// Texnik ish paytida avtomatik tuzatishni to'xtatish:  touch /var/lib/mbi-guardian/autofix.off
//                                     qayta yoqish:  rm /var/lib/mbi-guardian/autofix.off
//   (o'chiq tursa 18:30 xulosada ⚠️ bilan ko'rinadi — unutilib qolmasin)

const fs = require('fs');
const path = require('path');
const C = require('./checks');
const A = require('./actions');
const R = require('./reauth');
const REM = require('./remedy');
const { planAlerts } = require('./alerting');

const CFG = {
  intervalMin: Number(process.env.GUARDIAN_INTERVAL_MIN || 15),
  stateFile: process.env.GUARDIAN_STATE_FILE || '/var/lib/mbi-guardian/state.json',
  statusFile: process.env.GUARDIAN_STATUS_FILE || '/var/lib/mbi-guardian/status.json',
  actionsLog: process.env.GUARDIAN_ACTIONS_LOG || '/var/lib/mbi-guardian/actions.log',
  lockFile: process.env.GUARDIAN_LOCK_FILE || '/var/lib/mbi-guardian/run.lock',
  autofixOffFile: process.env.GUARDIAN_AUTOFIX_OFF_FILE || '/var/lib/mbi-guardian/autofix.off',
  envFile: process.env.GUARDIAN_ENV_FILE || '/root/.mbi.env',
  ecosystemFile: '/opt/mbi/ecosystem.config.js',
  adminChat: '1487569442',
  secretsRepo: 'yakubovibrohim/mbi-secrets',
  publicHost: '65.21.147.238.nip.io',
  processes: ['mbi-bot', 'mbi-tannarx-bot'],           // avtomatik qayta ishga tushirish FAQAT shularga
  localEndpoints: [
    // [id, nomi, url, javobda bo'lishi kerak, PM2 jarayoni]
    ['local:bot', 'mbi-bot (ichki port 3000)', 'http://127.0.0.1:3000/', 'MBI Bot running', 'mbi-bot'],
    ['local:tannarx', 'Tannarx bot (ichki port 3002)', 'http://127.0.0.1:3002/', 'Tan Narx', 'mbi-tannarx-bot'],
  ],
  remedy: { confirmRuns: 2, minGapMs: 25 * 60000, windowMs: 6 * 3600000, maxRestarts: 3, maxWebhookFixes: 2 },
  requiredKeys: ['bot_token', 'aziza_token', 'sardor_token', 'botir_token', 'dilshod_token', 'telegram_user_session', 'ig_app_secret', 'uptimerobot_api_key'],
  logs: { botOut: '/var/log/mbi/mbi-bot.out.log', botErr: '/var/log/mbi/mbi-bot.err.log' },
  igTokenSeedObtainedAt: '2026-09-08T12:40:00Z',   // IG_TOKEN 08.09.2026 da OAuth orqali olingan (60 kunlik)
  igRefresh: {
    refreshDaysLeft: 45,          // shu kun qolganda yangilanadi...
    quietFromHour: 3,             // ...faqat Toshkent vaqti 03:00–05:00 da (token o'zgarsa bot qayta ishga tushadi)
    quietToHour: 5,
    urgentDaysLeft: 7,            // shu kun qolsa soatga qaramay darhol
    retryAfterMs: 6 * 3600 * 1000,
    minTokenAgeMs: 24 * 3600 * 1000,
  },
  // Bir bosishli qayta ulash
  callbackHost: '127.0.0.1',
  callbackPort: Number(process.env.GUARDIAN_CALLBACK_PORT || 3003),
  reauthTtlMs: 24 * 3600 * 1000,
  igClientId: '1689794002143625',
  igRedirectUri: 'https://yakubovibrohim.github.io/mbi-bot/callback.html',
  igScopes: 'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments',
  igExpectedUserId: '17841464753251739',   // @mbi_mebel (BUSINESS) — faqat shu akkaunt qabul qilinadi
  igExpectedUsername: 'mbi_mebel',
  igReauthUrl: 'https://www.instagram.com/oauth/authorize?client_id=1689794002143625&redirect_uri=https://yakubovibrohim.github.io/mbi-bot/callback.html&response_type=code&scope=instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments',
};

const args = new Set(process.argv.slice(2));
const REFRESH_IG_CLI = args.has('--refresh-ig');
const REAUTH_CLI = args.has('--reauth-link');
const ONCE = args.has('--once') || REFRESH_IG_CLI;
const DRY = args.has('--dry-run');
const FORCE_IG = REFRESH_IG_CLI && args.has('--force');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const tashkent = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).split('/').join('.');
const tashkentHour = (ms) => Number(new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hourCycle: 'h23' }));
function fileEnv() {
  try { return { ...process.env, ...A.parseEnvFile(fs.readFileSync(CFG.envFile, 'utf8')) }; }
  catch (e) { return { ...process.env }; }
}

// ── Kalit qiymatlarini yashirish ──
let SECRETS = [];
function collectSecrets(env, keys) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string') { if (v.length >= 12) out.push(v); }
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_KEY', 'WINDSOR_KEY', 'IG_TOKEN', 'TN_BOT_TOKEN', 'IG_APP_SECRET'].forEach((k) => add(env[k]));
  add(keys);
  return out.sort((a, b) => b.length - a.length);
}
const redact = (s) => { let t = String(s == null ? '' : s); for (const v of SECRETS) t = t.split(v).join('***'); return t; };

async function loadKeys(env) {
  if (!env.GITHUB_TOKEN) return { keys: null, error: "GITHUB_TOKEN yo'q" };
  const res = await C.http('https://api.github.com/repos/' + CFG.secretsRepo + '/contents/keys.json', {
    headers: { Authorization: 'token ' + env.GITHUB_TOKEN, 'User-Agent': 'mbi-guardian', Accept: 'application/vnd.github.v3+json' },
  });
  if (res.status !== 200 || !res.json || !res.json.content) return { keys: null, error: C.why(res) };
  try { return { keys: JSON.parse(Buffer.from(res.json.content, 'base64').toString('utf8')) }; }
  catch (e) { return { keys: null, error: 'JSON buzilgan' }; }
}

async function sendTelegram(token, text) {
  const res = await C.http('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 20000,
    body: JSON.stringify({ chat_id: CFG.adminChat, text, disable_web_page_preview: true }),
  });
  return !!(res.json && res.json.ok);
}
async function notifyAdmin(text) {
  const env = fileEnv();
  const { keys } = await loadKeys(env);
  SECRETS = collectSecrets(env, keys);
  if (!(keys && keys.bot_token)) return false;
  return sendTelegram(keys.bot_token, redact(['🛡 MBI Guardian', text].join('\n')));
}

// ── Qulf (qo'lda, fondagi tekshiruv va /ig-callback bir-biriga xalaqit bermasin) ──
async function withLock(fn, maxWaitMs = 150000) {
  const until = Date.now() + maxWaitMs;
  while (!A.acquireLock(CFG.lockFile)) {
    if (Date.now() > until) throw new Error('qulf band — boshqa amal hali tugamagan');
    await new Promise((r) => setTimeout(r, 2000));
  }
  try { return await fn(); }
  finally { A.releaseLock(CFG.lockFile); }
}
const makeReauthLink = (state, now) => R.buildAuthorizeUrl(CFG, R.newReauthState(state, now, CFG.reauthTtlMs));
const reauthLine = (url) => `🔑 Instagram'ni qayta ulash uchun bosing va "Allow" (Ruxsat berish) ni tanlang — havola 24 soat, bir marta ishlaydi, qolganini guardian o'zi qiladi:\n${url}`;

const CHECKS = [
  C.checkProcesses, C.checkLocal, C.checkPublic, C.checkCaddy, C.checkTelegram, C.checkGitHub, C.checkInstagram,
  C.checkAI, C.checkWindsor, C.checkLogs, C.checkSystem, C.checkUptimeRobot, C.checkMeta, C.checkAutofix,
];

async function runOnce(opts) {
  if (DRY) return runOnceLocked(opts);
  if (!A.acquireLock(CFG.lockFile)) {
    console.log("[guardian] boshqa amal hozir ishlayapti — bu tekshiruv o'tkazib yuborildi");
    return { results: [], messages: [] };
  }
  try { return await runOnceLocked(opts); }
  finally { A.releaseLock(CFG.lockFile); }
}

// Tasdiqlangan nosozliklarni tuzatadi; tuzatilgan qismlarni qayta tekshirib results ni yangilaydi.
async function applyRemedies({ ctx, results, keys, now }) {
  const paused = results.some((r) => r.id === 'autofix' && r.level !== 'ok');
  const plan = REM.planRemedies({ issues: ctx.state.issues, remedyState: ctx.state.remedy, results, now, cfg: CFG, paused });
  const texts = [];
  if (DRY) {
    for (const a of plan.actions) console.log(`[dry-run] avto-tuzatish bo'lardi: ${a.type} ${a.target}${a.reason ? ' — ' + a.reason : ''}`);
    for (const b of plan.blocked) console.log('[dry-run] ' + redact(b.text));
    return { plan, texts };
  }
  ctx.state.remedy = plan.state;

  const rechecks = new Set();
  for (const a of plan.actions) {
    let out;
    try {
      if (a.type === 'restart') out = await A.recreateProcess({ cfg: CFG, http: C.http, name: a.target });
      else if (a.type === 'caddy') out = await A.startCaddy();
      else if (a.type === 'webhook') out = await A.setTelegramWebhook({ http: C.http, token: keys && keys.bot_token, url: a.url });
      else out = { ok: false, error: "noma'lum amal" };
    } catch (e) { out = { ok: false, error: 'ichki xato: ' + String(e && e.message).slice(0, 100) }; }
    out.error = out.error ? redact(out.error) : out.error;
    A.audit(CFG.actionsLog, {
      action: 'autofix_' + a.type, target: a.target, reason: a.reason ? redact(a.reason) : null,
      from: a.type === 'webhook' ? redact(a.current) : undefined, ok: !!out.ok, error: out.ok ? null : out.error,
    });
    texts.push(redact(REM.remedyMessage(a, out)));
    (REM.RECHECKS[a.type] || []).forEach((n) => rechecks.add(n));
    console.log(`[guardian] avto-tuzatish ${a.type} ${a.target}: ${out.ok ? 'OK' : 'XATO — ' + out.error}`);
  }
  for (const b of plan.blocked) {
    A.audit(CFG.actionsLog, { action: 'autofix_blocked', type: b.type, target: b.target, attempts: b.count });
    texts.push(redact(b.text));
    console.log(`[guardian] avto-tuzatish to'xtatildi: ${b.type} ${b.target} (${b.count} urinish)`);
  }

  for (const n of rechecks) {
    let fresh;
    try { fresh = await C[n](ctx); } catch (e) { continue; }
    for (const f of fresh) {
      f.msg = redact(f.msg); f.name = redact(f.name);
      const i = results.findIndex((r) => r.id === f.id);
      if (i >= 0) results[i] = f; else results.push(f);
    }
  }
  return { plan, texts };
}

async function runOnceLocked({ forceIg = false } = {}) {
  const now = Date.now();
  const env = fileEnv();
  const prevState = readJson(CFG.stateFile, {});
  const ctx = { env, now, cfg: CFG, state: JSON.parse(JSON.stringify(prevState)) };
  const { keys, error } = await loadKeys(env);
  ctx.keys = keys || {};
  ctx.keysError = keys ? null : error;
  SECRETS = collectSecrets(env, keys);

  const results = [];
  for (const fn of CHECKS) {
    try { results.push(...(await fn(ctx))); }
    catch (e) { results.push({ id: 'internal:' + fn.name, name: 'Guardian tekshiruvi ' + fn.name, level: 'warn', msg: 'ichki xato: ' + String(e && e.message).slice(0, 100) }); }
  }
  for (const r of results) { r.msg = redact(r.msg); r.name = redact(r.name); }

  // ── Ruxsat etilgan amal: avtomatik tuzatish (ogohlantirishlardan OLDIN) ──
  const { plan, texts: remedyTexts } = await applyRemedies({ ctx, results, keys, now });

  const { messages, state } = planAlerts(ctx.state, results, now);
  const actionTexts = [];
  let reauthLink = null;

  // ── Ruxsat etilgan amal: IG_TOKEN yangilash ──
  const igRes = results.find((r) => r.id === 'ig:token');
  const it = state.igToken;
  const expMs = it ? (it.expiresAt ? Date.parse(it.expiresAt) : Date.parse(it.obtainedAt) + 60 * 86400000) : null;
  const decision = A.shouldRefreshIg({
    daysLeft: expMs ? Math.floor((expMs - now) / 86400000) : null,
    tokenAgeMs: it ? now - Date.parse(it.obtainedAt) : null,
    tashkentHour: tashkentHour(now),
    lastAttemptAt: state.igRefresh && state.igRefresh.lastAttemptAt,
    lastAttemptOk: state.igRefresh && state.igRefresh.lastAttemptOk,
    tokenDead: !!(igRes && igRes.meta && igRes.meta.dead),
    force: forceIg, now, cfg: CFG.igRefresh,
  });
  const botJustRestarted = !DRY && plan.actions.some((a) => a.type === 'restart' && a.target === 'mbi-bot');
  if (REFRESH_IG_CLI || decision.run) console.log(`[guardian] IG_TOKEN yangilash qarori: ${decision.run ? 'HA' : "yo'q"} — ${decision.reason}${DRY && decision.run ? ' (dry-run: bajarilmaydi)' : ''}`);
  if (decision.run && botJustRestarted) console.log('[guardian] IG_TOKEN yangilash keyingi tekshiruvga qoldirildi — mbi-bot hozirgina qayta ishga tushirildi');
  if (decision.run && !DRY && !botJustRestarted) {
    let out;
    try { out = await A.refreshInstagramToken({ cfg: CFG, state, now, http: C.http }); }
    catch (e) { out = { ok: false, error: 'ichki xato: ' + String(e && e.message).slice(0, 100) }; }
    out.error = out.error ? redact(out.error) : out.error;
    state.igRefresh = { lastAttemptAt: now, lastAttemptOk: !!out.ok, lastError: out.ok ? null : out.error };
    A.audit(CFG.actionsLog, {
      action: 'ig_token_refresh', reason: decision.reason, ok: !!out.ok, changed: !!out.changed,
      restartedBot: !!out.restarted, expiresAt: out.expiresAt ? new Date(out.expiresAt).toISOString() : null, error: out.ok ? null : out.error,
    });
    if (out.dead) reauthLink = makeReauthLink(state, now);
    actionTexts.push(A.igRefreshMessage(out, CFG, now, { reauthUrl: reauthLink || undefined }));
    console.log(`[guardian] IG_TOKEN yangilash natijasi: ${out.ok ? 'OK' : 'XATO — ' + out.error}${out.changed ? " (token satri o'zgardi)" : ''}`);
  }

  const lines = [
    ...remedyTexts,
    ...messages.map((m) => m.text + (m.kind === 'problem' ? ` (birinchi aniqlangan: ${tashkent(m.firstSeen)}${m.repeat ? ', takroriy eslatma' : ''})` : '')),
    ...actionTexts,
  ];
  // Token o'likligi haqida ogohlantirish ketayotgan bo'lsa — bir martalik qayta ulash havolasini qo'shamiz
  if (!reauthLink && messages.some((m) => m.id === 'ig:token' && m.kind === 'problem')) {
    if (DRY) lines.push("🔑 [dry-run] shu yerda bir martalik qayta ulash havolasi bo'lardi");
    else { reauthLink = makeReauthLink(state, now); lines.push(reauthLine(reauthLink)); }
  }

  let sent = null;
  if (lines.length) {
    const text = redact(['🛡 MBI Guardian', ...lines].join('\n'));
    if (DRY) { console.log('[dry-run] yuborilmaydi:\n' + text); }
    else {
      sent = keys && keys.bot_token ? await sendTelegram(keys.bot_token, text) : false;
      if (!sent) {
        console.error('[guardian] Telegram xabari yuborilmadi — ogohlantirishlar keyingi tekshiruvda qayta uriniladi');
        // yuborilmagan ogohlantirishlar "yuborildi" deb belgilanmasin (bajarilgan amal esa qaytarilmaydi)
        const pi = ctx.state.issues || {}, pe = ctx.state.expiry || {};
        for (const m of messages) {
          if (m.kind === 'problem' && state.issues[m.id]) state.issues[m.id].alertedAt = (pi[m.id] && pi[m.id].alertedAt) || null;
          if (m.kind === 'expiry') { if (pe[m.id] == null) delete state.expiry[m.id]; else state.expiry[m.id] = pe[m.id]; }
          if (m.kind === 'recovered' && pi[m.id]) state.issues[m.id] = pi[m.id];
        }
      }
    }
  }

  if (!DRY) {
    writeJsonAtomic(CFG.statusFile, { checkedAt: new Date(now).toISOString(), items: results.map(({ id, name, level, msg }) => ({ id, name, level, msg })) });
    writeJsonAtomic(CFG.stateFile, state);
  }
  const count = (lv) => results.filter((r) => r.level === lv).length;
  console.log(`[guardian] ${results.length} tekshiruv: ${count('crit')} crit, ${count('warn')} warn, ${count('info')} info | tuzatish: ${plan.actions.length}${plan.blocked.length ? ` (+${plan.blocked.length} to'xtatilgan)` : ''} | xabar: ${lines.length}${sent === false ? ' (YUBORILMADI)' : ''}`);
  return { results, messages };
}

function startReauthServer() {
  const deps = {
    withLock,
    loadState: () => readJson(CFG.stateFile, {}),
    saveState: (st) => writeJsonAtomic(CFG.stateFile, st),
    getAppSecret: async () => {
      const env = fileEnv();
      const { keys } = await loadKeys(env);
      return (keys && keys.ig_app_secret) || env.IG_APP_SECRET || null;
    },
    install: ({ state, newTok, expiresIn, now }) => A.installInstagramToken({ cfg: CFG, state, now, http: C.http, newTok, expiresIn, source: 'reauth' }),
    notify: notifyAdmin,
    audit: (entry) => A.audit(CFG.actionsLog, { ...entry, error: entry.error ? redact(entry.error) : entry.error }),
  };
  R.startCallbackServer({
    host: CFG.callbackHost,
    port: CFG.callbackPort,
    onCallback: async (query) => {
      const out = await R.handleCallback({ query, cfg: CFG, http: C.http, deps });
      console.log(`[guardian] /ig-callback so'rovi: HTTP ${out.status}`);   // kod/state/token logga yozilmaydi
      return out;
    },
  });
  console.log(`[guardian] bir bosishli qayta ulash: ${CFG.callbackHost}:${CFG.callbackPort}/ig-callback tinglanmoqda`);
}

const ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', crit: '❌' };
const printTable = (results) => results.forEach((r) => console.log(`${ICON[r.level] || '?'} ${r.level.padEnd(4)} ${r.name}: ${r.msg}`));

(async () => {
  if (REAUTH_CLI) {
    if (DRY) {
      console.log('[dry-run] havola namunasi (saqlanmaydi va ishlamaydi):\n' + R.buildAuthorizeUrl(CFG, 'DRYRUN_STATE_namuna_ishlamaydi_0000'));
      process.exit(0);
    }
    const now = Date.now();
    const url = await withLock(async () => {
      const st = readJson(CFG.stateFile, {});
      const link = makeReauthLink(st, now);
      writeJsonAtomic(CFG.stateFile, st);
      return link;
    });
    const ok = await notifyAdmin(reauthLine(url));
    A.audit(CFG.actionsLog, { action: 'ig_reauth_link', ok, via: 'cli' });
    console.log(`[guardian] qayta ulash havolasi ${ok ? "Telegram'ga yuborildi" : 'YUBORILMADI'} (havola logga yozilmaydi)`);
    process.exit(ok ? 0 : 1);
  }
  if (ONCE) {
    const { results } = await runOnce({ forceIg: FORCE_IG });
    printTable(results);
    process.exit(0);
  }
  console.log(`[guardian] ishga tushdi — har ${CFG.intervalMin} daqiqada; ruxsat etilgan amallar: IG_TOKEN yangilash, bir bosishli qayta ulash, avto-tuzatish (mbi-bot, mbi-tannarx-bot, Caddy, webhook)`);
  startReauthServer();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce({}); }
    catch (e) { console.error('[guardian] tekshiruv xatosi:', redact(e && e.message)); }
    finally { running = false; }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, CFG.intervalMin * 60 * 1000);
})();
