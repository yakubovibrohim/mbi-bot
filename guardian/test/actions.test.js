'use strict';
// guardian: actions.js testlari — .env bilan ishlash, IG_TOKEN yangilash qarori va token o'rnatish oqimi.
// Soxta HTTP va soxta PM2 bilan: haqiqiy API ga ham, haqiqiy .mbi.env ga ham tegmaydi.
// Ishga tushirish: npm test   yoki   node guardian/test/actions.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../actions');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}
const H = 3600 * 1000, DAY = 24 * H;

// ── .env funksiyalari ──
{
  const env = ['# izoh', "GITHUB_TOKEN='ghp_abc'", '', "IG_TOKEN='IGAAold123'", 'PORT=3000', 'WEBHOOK_BASE="https://x.nip.io"', ''].join('\n');
  t("readEnvValue: qo'shtirnoqli", A.readEnvValue(env, 'IG_TOKEN') === 'IGAAold123');
  t("readEnvValue: qo'shtirnoqsiz va qo'sh qo'shtirnoq", A.readEnvValue(env, 'PORT') === '3000' && A.readEnvValue(env, 'WEBHOOK_BASE') === 'https://x.nip.io');
  t("readEnvValue: yo'q kalit -> null", A.readEnvValue(env, 'NOPE') === null);
  const p = A.parseEnvFile(env);
  t("parseEnvFile: izoh va bo'sh qatorlar o'tkaziladi", Object.keys(p).join(',') === 'GITHUB_TOKEN,IG_TOKEN,PORT,WEBHOOK_BASE');

  const next = A.replaceEnvLine(env, 'IG_TOKEN', 'IGAAnew_456-x.y');
  const diff = env.split('\n').map((l, i) => [l, next.split('\n')[i]]).filter(([a, b]) => a !== b);
  t("replaceEnvLine: faqat IG_TOKEN qatori o'zgaradi", diff.length === 1 && diff[0][1] === "IG_TOKEN='IGAAnew_456-x.y'", JSON.stringify(diff));
  t("replaceEnvLine: qatorlar soni va oxirgi bo'sh qator saqlanadi", next.split('\n').length === env.split('\n').length && next.endsWith('\n'));
  let threw = null;
  try { A.replaceEnvLine(env, 'IG_TOKEN', "abc'; rm -rf /"); } catch (e) { threw = e.message; }
  t('replaceEnvLine: xavfli belgili token rad etiladi', threw && threw.includes('kutilmagan belgilar'), threw);
  threw = null;
  try { A.replaceEnvLine(env + "IG_TOKEN='dup'\n", 'IG_TOKEN', 'IGAAx'); } catch (e) { threw = e.message; }
  t("replaceEnvLine: ikkita IG_TOKEN qatori bo'lsa yozmaydi", threw && threw.includes('2 ta'), threw);
  threw = null;
  try { A.replaceEnvLine('PORT=1\n', 'IG_TOKEN', 'IGAAx'); } catch (e) { threw = e.message; }
  t("replaceEnvLine: qator yo'q bo'lsa yozmaydi", threw && threw.includes('0 ta'), threw);
}

// ── yangilash qarori ──
{
  const cfg = { refreshDaysLeft: 45, quietFromHour: 3, quietToHour: 5, urgentDaysLeft: 7, retryAfterMs: 6 * H, minTokenAgeMs: 24 * H };
  const base = { tokenAgeMs: 3 * DAY, tashkentHour: 11, lastAttemptAt: null, lastAttemptOk: null, tokenDead: false, force: false, now: 1000 * DAY, cfg };
  const d = (o) => A.shouldRefreshIg({ ...base, ...o });
  t("57 kun qolgan, kunduz -> yo'q (hali erta)", d({ daysLeft: 57 }).run === false && d({ daysLeft: 57 }).reason.includes('erta'));
  t("45 kun, soat 11 -> yo'q (tungi soatni kutadi)", d({ daysLeft: 45 }).run === false && d({ daysLeft: 45 }).reason.includes('kutilyapti'));
  t('45 kun, soat 4 -> HA', d({ daysLeft: 45, tashkentHour: 4 }).run === true);
  t("45 kun, soat 5 -> yo'q (oyna 03:00–05:00)", d({ daysLeft: 45, tashkentHour: 5 }).run === false);
  t('7 kun, soat 14 -> HA (shoshilinch)', d({ daysLeft: 7, tashkentHour: 14 }).run === true);
  t("token o'lik -> yo'q, hatto --force bilan ham", d({ daysLeft: 2, tokenDead: true, force: true }).run === false);
  t("--force -> HA (57 kun bo'lsa ham)", d({ daysLeft: 57, force: true }).run === true);
  t("oxirgi urinish 1 soat oldin xato -> yo'q", d({ daysLeft: 40, tashkentHour: 4, lastAttemptAt: base.now - H, lastAttemptOk: false }).run === false);
  t('oxirgi urinish 7 soat oldin xato -> HA', d({ daysLeft: 40, tashkentHour: 4, lastAttemptAt: base.now - 7 * H, lastAttemptOk: false }).run === true);
  t("token 24 soatdan yosh -> yo'q", d({ daysLeft: 5, tokenAgeMs: 2 * H }).run === false);
  t("muddat noma'lum -> yo'q", d({ daysLeft: null }).run === false);
}

// ── yangilash oqimi (soxta http, soxta pm2) ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mbi-guardian-actions-'));
const ENV0 = ['# Hetzner', "GITHUB_TOKEN='ghp_keep'", "IG_TOKEN='IGAAold123'", 'PORT=3000', ''].join('\n');
const NOW = Date.parse('2026-09-11T23:30:00Z');
const cfgFor = (dir) => ({ envFile: path.join(dir, '.mbi.env'), ecosystemFile: '/x', igReauthUrl: 'https://reauth', igRefresh: { retryAfterMs: 6 * H } });

function stubHttp({ refresh, me }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('refresh_access_token')) return typeof refresh === 'function' ? refresh() : refresh;
    if (url.includes('/me?')) return typeof me === 'function' ? me(url) : me;
    return { status: 404, json: null };
  };
  fn.calls = calls;
  return fn;
}
const okMe = { status: 200, json: { username: 'mbi_mebel' } };
let caseN = 0;
function setup() {
  const dir = path.join(TMP, 'c' + (++caseN));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mbi.env'), ENV0);
  return dir;
}
const noLeak = (s) => !/IGAA(old|new)/.test(s);

(async () => {
  try {
    // a) token satri o'zgarmadi
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      let restarts = 0;
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: 'IGAAold123', expires_in: 5184000 } }, me: okMe }),
        deps: { recreateBot: async () => { restarts++; return { ok: true }; }, botEnvFingerprint: async () => null } });
      t("o'zgarmagan token: ok, fayl tegilmaydi, bot qayta ishga tushmaydi",
        out.ok && !out.changed && restarts === 0 && fs.readFileSync(cfg.envFile, 'utf8') === ENV0, JSON.stringify(out));
      t("o'zgarmagan token: aniq muddat state ga yoziladi (60 kun)",
        state.igToken && Date.parse(state.igToken.expiresAt) === NOW + 60 * DAY && state.igToken.source === 'refresh');
      t("o'zgarmagan token: zaxira yaratilmaydi", fs.readdirSync(dir).filter((f) => f.includes('.bak.')).length === 0);
      const msg = A.igRefreshMessage(out, cfg, NOW);
      t("xabar: 60 kun, bot qayta ishga tushirilmadi, token ko'rinmaydi", msg.includes('60 kun') && msg.includes("o'zgarmadi") && noLeak(msg), msg);
    }

    // b) token satri o'zgardi — to'liq oqim
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      for (let k = 1; k <= 5; k++) fs.writeFileSync(path.join(dir, '.mbi.env.bak.guardian.' + (NOW - k * DAY)), 'eski');
      let restarts = 0;
      const newFp = A._internal.fp('IGAAnew789');
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: 'IGAAnew789', expires_in: 5184000 } }, me: okMe }),
        deps: { recreateBot: async () => { restarts++; return { ok: true }; }, botEnvFingerprint: async () => newFp } });
      const after = fs.readFileSync(cfg.envFile, 'utf8');
      t('yangi token: ok, changed, restarted', out.ok && out.changed && out.restarted && restarts === 1, JSON.stringify(out));
      t('yangi token: faqat IG_TOKEN qatori almashdi', after === ENV0.replace("IG_TOKEN='IGAAold123'", "IG_TOKEN='IGAAnew789'"), after);
      const baks = fs.readdirSync(dir).filter((f) => f.startsWith('.mbi.env.bak.guardian.'));
      t('zaxiralar: oxirgi 3 tasi qoldi, yangisi ichida', baks.length === 3 && baks.includes('.mbi.env.bak.guardian.' + NOW), baks.join(', '));
      t('zaxirada ESKI token saqlangan', fs.readFileSync(path.join(dir, '.mbi.env.bak.guardian.' + NOW), 'utf8') === ENV0);
      t('state: yangi token izi va aniq muddat', state.igToken.fp === newFp && Date.parse(state.igToken.expiresAt) === NOW + 60 * DAY);
      t('vaqtinchalik .tmp fayl qolmadi', !fs.existsSync(cfg.envFile + '.tmp.guardian'));
      const msg = A.igRefreshMessage(out, cfg, NOW);
      t("xabar: yozildi, qayta ishga tushirildi, token ko'rinmaydi", msg.includes('.mbi.env ga yozildi') && msg.includes('yangi tokenni oldi') && noLeak(msg), msg);
    }

    // c) bot qayta ishga tushdi, lekin yangi tokenni olmadi (eski PM2 env tuzog'i)
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: 'IGAAnew789', expires_in: 5184000 } }, me: okMe }),
        deps: { recreateBot: async () => ({ ok: true }), botEnvFingerprint: async () => A._internal.fp('IGAAold123') } });
      t('bot eski tokenni ushlab qolsa — ok:false va aniq sabab', !out.ok && out.restarted && /env izi/.test(out.error), JSON.stringify(out));
      t('shu holatda ham state faylga mos (yangi token izi)', state.igToken && state.igToken.fp === A._internal.fp('IGAAnew789'));
    }

    // d) bot qayta ko'tarilmadi
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: 'IGAAnew789', expires_in: 5184000 } }, me: okMe }),
        deps: { recreateBot: async () => ({ ok: false, error: '90 soniyada javob bermadi' }), botEnvFingerprint: async () => null } });
      const msg = A.igRefreshMessage(out, cfg, NOW);
      t("bot ko'tarilmasa — botDown va 'Darhol tekshiring'", !out.ok && out.botDown && msg.includes('Darhol tekshiring') && noLeak(msg), msg);
    }

    // e) token o'lik (190)
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      let restarts = 0;
      const http = stubHttp({ refresh: { status: 400, json: { error: { code: 190, message: 'Session has expired' } } }, me: okMe });
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http, deps: { recreateBot: async () => { restarts++; return { ok: true }; } } });
      const msg = A.igRefreshMessage(out, cfg, NOW);
      t("o'lik token: dead, fayl tegilmaydi, bot tegilmaydi, /me chaqirilmaydi",
        !out.ok && out.dead && restarts === 0 && fs.readFileSync(cfg.envFile, 'utf8') === ENV0 && !http.calls.some((u) => u.includes('/me?')), JSON.stringify(out));
      t("o'lik token xabari qayta ruxsat havolasini beradi", msg.includes('https://reauth') && noLeak(msg), msg);
    }

    // f) yangilash ok, lekin yangi token /me dan o'tmadi
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      let restarts = 0;
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: 'IGAAnew789', expires_in: 5184000 } }, me: { status: 400, json: { error: { code: 190 } } } }),
        deps: { recreateBot: async () => { restarts++; return { ok: true }; } } });
      t('yangi token ishlamasa — HECH NARSA yozilmaydi', !out.ok && restarts === 0 && fs.readFileSync(cfg.envFile, 'utf8') === ENV0 && !state.igToken, JSON.stringify(out));
    }

    // g) xavfli belgili token
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 200, json: { access_token: "IGAA'bad", expires_in: 5184000 } }, me: okMe }),
        deps: { recreateBot: async () => ({ ok: true }) } });
      t('xavfli belgili token — yozilmaydi', !out.ok && fs.readFileSync(cfg.envFile, 'utf8') === ENV0 && !state.igToken, JSON.stringify(out));
    }

    // h) tarmoq xatosi
    {
      const dir = setup(), cfg = cfgFor(dir), state = {};
      const out = await A.refreshInstagramToken({ cfg, state, now: NOW, http: stubHttp({ refresh: { status: 0, error: 'javob kelmadi (timeout)', json: null }, me: okMe }) });
      const msg = A.igRefreshMessage(out, cfg, NOW);
      t("tarmoq xatosi — dead emas, '6 soatdan keyin qayta'", !out.ok && !out.dead && msg.includes('6 soatdan keyin'), msg);
    }

    // i) qulf
    {
      const lock = path.join(TMP, 'run.lock');
      const a = A.acquireLock(lock), b = A.acquireLock(lock);
      A.releaseLock(lock);
      const c = A.acquireLock(lock);
      A.releaseLock(lock);
      fs.writeFileSync(lock, 'eski');
      const old = new Date(Date.now() - 20 * 60000);
      fs.utimesSync(lock, old, old);
      const d = A.acquireLock(lock);
      A.releaseLock(lock);
      t("qulf: ikkinchisi olmaydi, bo'shatilgach oladi, 10 daqiqadan eski qulf tozalanadi", a && !b && c && d);
    }

    // j) jurnal
    {
      const log = path.join(TMP, 'actions.log');
      A.audit(log, { action: 'ig_token_refresh', ok: true });
      A.audit(log, { action: 'ig_token_refresh', ok: false, error: 'x' });
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      t('jurnal: har amal alohida JSON qator, vaqt bilan', lines.length === 2 && lines[0].ts && lines[1].ok === false);
    }
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
  process.exit(fail ? 1 : 0);
})();
