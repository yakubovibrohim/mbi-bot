'use strict';
// ─── MBI Guardian: RUXSAT ETILGAN yozuv amallari ───
// Guardian "faqat o'qish" rejimidan chiqadigan YAGONA joy. Bu fayldan tashqarida hech narsa o'zgartirilmaydi.
//
// Ruxsat ro'yxati:
//   ig_token_refresh — IG_TOKEN ni muddati tugashidan oldin yangilash (refreshInstagramToken).
//   ig_reauth        — bir bosishli qayta ulashdan kelgan tokenni o'rnatish (reauth.js -> installInstagramToken).
// Ikkalasi ham bitta tekshirilgan yo'ldan o'tadi — installInstagramToken:
//   • token satri o'zgarsa: /root/.mbi.env dagi FAQAT IG_TOKEN qatori almashtiriladi
//     (oldin zaxira, 600 ruxsat, guardian zaxiralaridan oxirgi 3 tasi saqlanadi),
//     mbi-bot toza muhitdan qayta yaratiladi va bot yangi tokenni olgani PM2 env izidan tekshiriladi.
//   autofix_restart  — mbi-bot / mbi-tannarx-bot ni ecosystem'dan toza muhit bilan qayta yaratish (recreateProcess);
//                      faqat cfg.processes dagi nomlar, mbi-guardian o'zi emas.
//   autofix_caddy    — faol bo'lmagan Caddy'ni `systemctl start caddy` (startCaddy); konfiguratsiyaga tegmaydi.
//   autofix_webhook  — @mbi_mebel_bot webhook'ini WEBHOOK_BASE/webhook ga qayta o'rnatish (setTelegramWebhook);
//                      faqat url yuboriladi — kutilayotgan xabarlar o'chirilmaydi.
//   Qachon va necha marta — remedy.js hal qiladi (tasdiq, 25 daqiqa oraliq, 6 soatlik limit, autofix.off).
// Har amal actions.log ga yoziladi (kalit qiymatlarisiz) va ADMIN ga xabar qilinadi.
// Buxgalteriya ma'lumotlari, pul, kod, boshqa kalitlar, Render — HECH QACHON.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DAY = 86400000;
const fp = (tok) => crypto.createHash('sha256').update(String(tok)).digest('hex').slice(0, 12);
const dmy = (ms) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent' }).split('/').join('.');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── .env matni bilan ishlash (sof funksiyalar) ──
const unquote = (v) => ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')) ? v.slice(1, -1) : v);

function parseEnvFile(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = unquote(t.slice(i + 1).trim());
  }
  return out;
}
function readEnvValue(text, key) {
  const v = parseEnvFile(text)[key];
  return v === undefined ? null : v;
}
// Faqat bitta KEY=... qatorini almashtiradi; izohlar, tartib va boshqa qatorlar o'zgarmaydi.
function replaceEnvLine(text, key, value) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(value))) throw new Error("token kutilmagan belgilarga ega — yozilmadi");
  let hits = 0;
  const next = String(text).split('\n').map((line) => {
    if (line.trim().startsWith(key + '=')) { hits++; return `${key}='${value}'`; }
    return line;
  });
  if (hits !== 1) throw new Error(`${key} qatori ${hits} ta topildi (1 kutilgan) — yozilmadi`);
  return next.join('\n');
}

// ── Qachon yangilash (sof funksiya) ──
function shouldRefreshIg({ daysLeft, tokenAgeMs, tashkentHour, lastAttemptAt, lastAttemptOk, tokenDead, force, now, cfg }) {
  if (tokenDead) return { run: false, reason: "token o'lik — yangilab bo'lmaydi, qayta ruxsat kerak" };
  if (force) return { run: true, reason: "qo'lda majburiy (--force)" };
  if (daysLeft == null || !Number.isFinite(daysLeft)) return { run: false, reason: "muddati noma'lum" };
  if (tokenAgeMs != null && tokenAgeMs < cfg.minTokenAgeMs) return { run: false, reason: 'token 24 soatdan yosh — Instagram hali yangilashga ruxsat bermaydi' };
  if (lastAttemptAt && lastAttemptOk === false && now - lastAttemptAt < cfg.retryAfterMs) {
    return { run: false, reason: "oxirgi urinish muvaffaqiyatsiz — qayta urinish vaqti kelmagan" };
  }
  if (daysLeft <= cfg.urgentDaysLeft) return { run: true, reason: `shoshilinch: ${daysLeft} kun qoldi` };
  if (daysLeft <= cfg.refreshDaysLeft) {
    const quiet = tashkentHour >= cfg.quietFromHour && tashkentHour < cfg.quietToHour;
    return quiet
      ? { run: true, reason: `${daysLeft} kun qoldi, tungi soat` }
      : { run: false, reason: `${daysLeft} kun qoldi — tungi ${cfg.quietFromHour}:00–${cfg.quietToHour}:00 kutilyapti` };
  }
  return { run: false, reason: `${daysLeft} kun qoldi — hali erta (${cfg.refreshDaysLeft} kun qolganda yangilanadi)` };
}

// ── PM2 (toza muhit bilan — BOT_TOKEN merosi tuzog'i takrorlanmasin) ──
const PM2_CANDIDATES = ['/usr/bin/pm2', '/usr/local/bin/pm2'];
const pm2Bin = () => PM2_CANDIDATES.find((p) => fs.existsSync(p)) || 'pm2';
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { HOME: '/root', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}
// pm2 delete → start --only → save, keyin jarayonning ichki porti (cfg.localEndpoints[4] === name) javobini kutadi.
async function recreateProcess({ cfg, http, name, run: exec = run, sleep = wait, waitMs = 90000, pollMs = 3000 }) {
  if (!(cfg.processes || []).includes(name)) return { ok: false, error: `${name} ruxsat ro'yxatida yo'q — tegilmadi` };
  const pm2 = pm2Bin();
  await exec(pm2, ['delete', name], 60000);                           // yo'q bo'lsa ham davom etadi
  const st = await exec(pm2, ['start', cfg.ecosystemFile, '--only', name], 90000);
  if (!st.ok) return { ok: false, error: 'pm2 start muvaffaqiyatsiz' };
  await exec(pm2, ['save'], 60000);
  const ep = (cfg.localEndpoints || []).find((e) => e[4] === name);
  if (!ep) return { ok: true };
  const [, , url, needle] = ep;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const res = await http(url, { timeoutMs: 3000 });
    if (res.status === 200 && (!needle || String(res.text).includes(needle))) return { ok: true };
  }
  return { ok: false, error: `${Math.round(waitMs / 1000)} soniyada javob bermadi` };
}
const recreateBot = (cfg, http) => recreateProcess({ cfg, http, name: 'mbi-bot' });

async function botEnvFingerprint(cfg, key) {
  const r = await run(pm2Bin(), ['jlist'], 30000);
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('[')));
    const p = list.find((x) => x.name === 'mbi-bot');
    const v = p && p.pm2_env && (p.pm2_env[key] || (p.pm2_env.env && p.pm2_env.env[key]));
    return v ? fp(v) : null;
  } catch (e) { return null; }
}

// ── Caddy: faqat ishga tushirish (konfiguratsiya o'zgarmaydi) ──
async function startCaddy({ run: exec = run, sleep = wait, settleMs = 3000 } = {}) {
  const bin = ['/usr/bin/systemctl', '/bin/systemctl'].find((p) => fs.existsSync(p)) || 'systemctl';
  const st = await exec(bin, ['start', 'caddy'], 60000);
  await sleep(settleMs);
  const act = await exec(bin, ['is-active', 'caddy'], 15000);
  const state = String(act.out || '').trim();
  if (state === 'active') return { ok: true };
  return { ok: false, error: `systemctl start ${st.ok ? 'bajarildi' : 'xato berdi'}, holati: ${state || "noma'lum"}` };
}

// ── Telegram webhook: faqat url (allowed_updates avvalgicha qoladi, kutilayotgan xabarlar o'chirilmaydi) ──
async function setTelegramWebhook({ http, token, url }) {
  if (!token) return { ok: false, error: "bot_token yo'q" };
  const base = 'https://api.telegram.org/bot' + token;
  const res = await http(base + '/setWebhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, timeoutMs: 20000, body: JSON.stringify({ url }),
  });
  if (!(res.json && res.json.ok)) {
    const d = res.json && res.json.description;
    return { ok: false, error: d ? String(d).slice(0, 120) : (res.status === 0 ? res.error : 'HTTP ' + res.status) };
  }
  const info = await http(base + '/getWebhookInfo', { timeoutMs: 15000 });
  const got = info.json && info.json.ok && info.json.result && info.json.result.url;
  if (got !== url) return { ok: false, error: "o'rnatildi, lekin tekshiruvda manzil mos kelmadi" };
  return { ok: true };
}

function pruneBackups(envFile, keep) {
  try {
    const dir = path.dirname(envFile);
    const base = path.basename(envFile) + '.bak.guardian.';
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(base))
      .sort((a, b) => Number(b.slice(base.length)) - Number(a.slice(base.length)));
    for (const f of files.slice(keep)) fs.unlinkSync(path.join(dir, f));
  } catch (e) {}
}

// ── Tekshirilgan tokenni o'rnatish (yangilash ham, qayta ulash ham shu yerdan o'tadi) ──
// Chaqiruvchi yangi token ishlashini OLDINDAN tasdiqlagan bo'lishi shart.
async function installInstagramToken({ cfg, state, now, http, newTok, expiresIn, source = 'refresh', deps = {} }) {
  const recreate = deps.recreateBot || recreateBot;
  const botFp = deps.botEnvFingerprint || botEnvFingerprint;

  const envText = fs.readFileSync(cfg.envFile, 'utf8');
  const oldTok = readEnvValue(envText, 'IG_TOKEN');
  const expiresAt = now + Number(expiresIn) * 1000;
  const newState = { fp: fp(newTok), obtainedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), source };

  if (newTok === oldTok) {
    state.igToken = newState;
    return { ok: true, changed: false, restarted: false, expiresAt };
  }

  let nextText;
  try { nextText = replaceEnvLine(envText, 'IG_TOKEN', newTok); }
  catch (e) { return { ok: false, error: e.message }; }

  const bak = cfg.envFile + '.bak.guardian.' + now;
  fs.copyFileSync(cfg.envFile, bak);
  fs.chmodSync(bak, 0o600);
  const tmp = cfg.envFile + '.tmp.guardian';
  fs.writeFileSync(tmp, nextText, { mode: 0o600 });
  fs.renameSync(tmp, cfg.envFile);
  fs.chmodSync(cfg.envFile, 0o600);
  pruneBackups(cfg.envFile, 3);
  if (readEnvValue(fs.readFileSync(cfg.envFile, 'utf8'), 'IG_TOKEN') !== newTok) {
    return { ok: false, changed: true, error: ".mbi.env ga yozish tasdiqlanmadi (zaxira: " + path.basename(bak) + ')' };
  }
  state.igToken = newState;   // faylda endi yangi token turibdi

  const rb = await recreate(cfg, http);
  if (!rb.ok) return { ok: false, changed: true, botDown: true, error: 'mbi-bot qayta ko’tarilmadi: ' + rb.error, expiresAt };
  const got = await botFp(cfg, 'IG_TOKEN');
  if (got !== newState.fp) return { ok: false, changed: true, restarted: true, error: "mbi-bot yangi tokenni olmadi (PM2 env izi mos emas)", expiresAt };
  return { ok: true, changed: true, restarted: true, expiresAt };
}

// ── Muddatidan oldin yangilash ──
async function refreshInstagramToken({ cfg, state, now, http, deps = {} }) {
  const envText = fs.readFileSync(cfg.envFile, 'utf8');
  const oldTok = readEnvValue(envText, 'IG_TOKEN');
  if (!oldTok) return { ok: false, error: '.mbi.env da IG_TOKEN topilmadi' };

  const res = await http('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(oldTok), { timeoutMs: 30000 });
  const j = res.json;
  if (!(res.status === 200 && j && j.access_token && Number(j.expires_in) > 0)) {
    const code = j && j.error && j.error.code;
    const msg = j && j.error && j.error.message ? String(j.error.message).slice(0, 120) : (res.status === 0 ? res.error : 'HTTP ' + res.status);
    return { ok: false, dead: code === 190, error: msg };
  }
  const newTok = String(j.access_token);

  // Yangi token haqiqatan ishlaydimi — hech narsa yozishdan OLDIN
  const me = await http('https://graph.instagram.com/v21.0/me?fields=username&access_token=' + encodeURIComponent(newTok), { timeoutMs: 20000 });
  if (!(me.json && me.json.username)) return { ok: false, error: "yangi token tekshiruvdan o'tmadi — hech narsa yozilmadi" };

  const out = await installInstagramToken({ cfg, state, now, http, newTok, expiresIn: Number(j.expires_in), source: 'refresh', deps });
  return { ...out, username: me.json.username };
}

// opts.kind: 'refresh' | 'reauth'; opts.reauthUrl: bir martalik qayta ulash havolasi (bo'lmasa cfg.igReauthUrl)
function igRefreshMessage(out, cfg, now, opts = {}) {
  const reauth = opts.kind === 'reauth';
  if (out.ok) {
    const days = Math.floor((out.expiresAt - now) / DAY);
    const head = reauth
      ? `🔑 Instagram qayta ulandi: token ${days} kun amal qiladi (${dmy(out.expiresAt)} gacha).`
      : `🔄 Instagram tokeni yangilandi: endi ${days} kun amal qiladi (${dmy(out.expiresAt)} gacha).`;
    return out.changed
      ? head + ' Yangi token .mbi.env ga yozildi, mbi-bot qayta ishga tushirildi va yangi tokenni oldi.'
      : head + " Token satri o'zgarmadi — bot qayta ishga tushirilmadi.";
  }
  if (out.botDown) return `❌ Instagram tokeni yozildi, lekin ${out.error}. Darhol tekshiring!`;
  if (out.dead) return `❌ Instagram tokenini yangilab bo'lmadi — token o'lik (${out.error}). Qayta ulash uchun bosing (havola 24 soat, bir marta ishlaydi): ${opts.reauthUrl || cfg.igReauthUrl}`;
  if (reauth) return `⚠️ Instagram'ni qayta ulashda xato: ${out.error}.`;
  return `⚠️ Instagram tokenini yangilashda xato: ${out.error}. ${Math.round(cfg.igRefresh.retryAfterMs / 3600000)} soatdan keyin qayta uriniladi.`;
}

// ── Jurnal va qulf ──
function audit(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) {}
}
function acquireLock(file, staleMs = 10 * 60000, retried = false) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (retried) return false;
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > staleMs) { fs.unlinkSync(file); return acquireLock(file, staleMs, true); }
    } catch (e2) {}
    return false;
  }
}
const releaseLock = (file) => { try { fs.unlinkSync(file); } catch (e) {} };

module.exports = {
  refreshInstagramToken, installInstagramToken, igRefreshMessage, shouldRefreshIg,
  recreateProcess, startCaddy, setTelegramWebhook,
  parseEnvFile, readEnvValue, replaceEnvLine,
  audit, acquireLock, releaseLock,
  _internal: { fp, pruneBackups },
};
