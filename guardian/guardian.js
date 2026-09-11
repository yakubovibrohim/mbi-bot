'use strict';
// ─── MBI Guardian — tizim nazoratchisi ───
// 1-versiya: FAQAT O'QIYDI. Hech narsani o'zgartirmaydi, qayta ishga tushirmaydi, token yangilamaydi.
// Alohida PM2 jarayoni (mbi-guardian): mbi-bot qulasa ham ishlayveradi va Telegram orqali yozadi.
//
// Har 15 daqiqada:
//   1) checks.js — hamma tekshiruvlar; natija status.json ga yoziladi,
//      mbi-bot 18:30 xulosada shu fayldan "🛡 Tizim" qatorini chiqaradi (section.js);
//   2) alerting.js — xabar kerakmi hal qiladi; kerak bo'lsa ADMIN ga ODDIY MATN
//      (Markdown yo'q — tashqi matn uni buzib, xabar jimgina yo'qolmasin).
// Kalit qiymatlari hech qachon logga yoki xabarga tushmaydi (redact).
//
// Qo'lda sinov:  node guardian.js --once --dry-run   (hech narsa yubormaydi, hech narsa yozmaydi)

const fs = require('fs');
const path = require('path');
const C = require('./checks');
const { planAlerts } = require('./alerting');

const CFG = {
  intervalMin: Number(process.env.GUARDIAN_INTERVAL_MIN || 15),
  stateFile: process.env.GUARDIAN_STATE_FILE || '/var/lib/mbi-guardian/state.json',
  statusFile: process.env.GUARDIAN_STATUS_FILE || '/var/lib/mbi-guardian/status.json',
  adminChat: '1487569442',
  secretsRepo: 'yakubovibrohim/mbi-secrets',
  publicHost: '65.21.147.238.nip.io',
  processes: ['mbi-bot', 'mbi-tannarx-bot'],
  localEndpoints: [
    ['local:bot', 'mbi-bot (ichki port 3000)', 'http://127.0.0.1:3000/', 'MBI Bot running'],
    ['local:tannarx', 'Tannarx bot (ichki port 3002)', 'http://127.0.0.1:3002/', 'Tan Narx'],
  ],
  requiredKeys: ['bot_token', 'aziza_token', 'sardor_token', 'botir_token', 'dilshod_token', 'telegram_user_session', 'ig_app_secret', 'uptimerobot_api_key'],
  logs: { botOut: '/var/log/mbi/mbi-bot.out.log', botErr: '/var/log/mbi/mbi-bot.err.log' },
  igTokenSeedObtainedAt: '2026-09-08T12:40:00Z',   // IG_TOKEN 08.09.2026 da OAuth orqali olingan (60 kunlik)
};

const args = new Set(process.argv.slice(2));
const ONCE = args.has('--once');
const DRY = args.has('--dry-run');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; } };
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const tashkent = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).split('/').join('.');

// ── Kalit qiymatlarini yashirish ──
let SECRETS = [];
function collectSecrets(env, keys) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string') { if (v.length >= 12) out.push(v); }
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  ['GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_KEY', 'WINDSOR_KEY', 'IG_TOKEN', 'TN_BOT_TOKEN'].forEach((k) => add(env[k]));
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

const CHECKS = [
  C.checkProcesses, C.checkLocal, C.checkPublic, C.checkTelegram, C.checkGitHub, C.checkInstagram,
  C.checkAI, C.checkWindsor, C.checkLogs, C.checkSystem, C.checkUptimeRobot, C.checkMeta,
];

async function runOnce() {
  const now = Date.now();
  const env = process.env;
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

  const { messages, state } = planAlerts(ctx.state, results, now);

  let sent = null;
  if (messages.length) {
    const text = ['🛡 MBI Guardian', ...messages.map((m) => m.text + (m.kind === 'problem'
      ? ` (birinchi aniqlangan: ${tashkent(m.firstSeen)}${m.repeat ? ', takroriy eslatma' : ''})` : ''))].join('\n');
    if (DRY) { console.log('[dry-run] yuborilmaydi:\n' + text); }
    else {
      sent = keys && keys.bot_token ? await sendTelegram(keys.bot_token, text) : false;
      if (!sent) {
        console.error('[guardian] Telegram xabari yuborilmadi — keyingi tekshiruvda qayta uriniladi');
        // yuborilmagan xabarlar "yuborildi" deb belgilanmasin
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
  console.log(`[guardian] ${results.length} tekshiruv: ${count('crit')} crit, ${count('warn')} warn, ${count('info')} info | xabar: ${messages.length}${sent === false ? ' (YUBORILMADI)' : ''}`);
  return { results, messages };
}

const ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', crit: '❌' };
const printTable = (results) => results.forEach((r) => console.log(`${ICON[r.level] || '?'} ${r.level.padEnd(4)} ${r.name}: ${r.msg}`));

(async () => {
  if (ONCE) {
    const { results } = await runOnce();
    printTable(results);
    process.exit(0);
  }
  console.log(`[guardian] ishga tushdi — har ${CFG.intervalMin} daqiqada, faqat o'qish rejimi`);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runOnce(); }
    catch (e) { console.error('[guardian] tekshiruv xatosi:', redact(e && e.message)); }
    finally { running = false; }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, CFG.intervalMin * 60 * 1000);
})();
