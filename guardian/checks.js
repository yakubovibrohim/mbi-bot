'use strict';
// ─── MBI Guardian: tekshiruvlar ───
// FAQAT O'QIYDI: GET so'rovlar, `pm2 jlist`, log fayllarini o'qish.
// Hech narsani o'zgartirmaydi, qayta ishga tushirmaydi, token yangilamaydi.
// Har funksiya natijalar ro'yxatini qaytaradi: { id, name, level, msg, meta? }
//   level: ok | info (ma'lumot) | warn (18:30 xulosada) | crit (darhol xabar)
//   meta.expiry + meta.days — muddati bor kalit (alerting.js 14/7/3/1 kun bosqichlari bilan yuritadi)

const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');
const { execFile } = require('child_process');

const OK = 'ok', INFO = 'info', WARN = 'warn', CRIT = 'crit';
const DAY = 86400000;
const item = (id, name, level, msg, meta) => (meta ? { id, name, level, msg, meta } : { id, name, level, msg });

async function http(url, opts = {}) {
  const { timeoutMs = 20000, ...rest } = opts;
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, headers: res.headers, text, json };
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    // e.message ataylab qaytarilmaydi: unda URL (va ichidagi kalit) bo'lishi mumkin
    return { status: 0, headers: new Headers(), text: '', json: null, error: timeout ? 'javob kelmadi (timeout)' : 'tarmoq xatosi' };
  }
}
const why = (res) => (res.status === 0 ? res.error : 'HTTP ' + res.status);
const daysUntil = (ms, now) => Math.floor((ms - now) / DAY);
const dmy = (ms) => new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent' }).split('/').join('.');

// ── PM2 jarayonlari ──
const PM2_CANDIDATES = ['/usr/bin/pm2', '/usr/local/bin/pm2'];
function pm2List() {
  const bin = PM2_CANDIDATES.find((p) => fs.existsSync(p)) || 'pm2';
  return new Promise((resolve) => {
    execFile(bin, ['jlist'], { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      const s = String(stdout);
      try { resolve(JSON.parse(s.slice(s.indexOf('[')))); } catch (e) { resolve(null); }
    });
  });
}
async function checkProcesses(ctx) {
  const list = await pm2List();
  if (!list) return [item('proc', 'PM2 jarayonlari', WARN, "pm2 ro'yxati o'qilmadi")];
  ctx.state.restarts = ctx.state.restarts || {};
  const out = [];
  for (const name of ctx.cfg.processes) {
    const p = list.find((x) => x.name === name);
    const id = 'proc:' + name;
    if (!p) { out.push(item(id, name, CRIT, 'PM2 da topilmadi — ishlamayapti')); continue; }
    const status = p.pm2_env && p.pm2_env.status;
    const restarts = (p.pm2_env && p.pm2_env.restart_time) || 0;
    const prev = ctx.state.restarts[name];
    ctx.state.restarts[name] = restarts;
    if (status !== 'online') out.push(item(id, name, CRIT, 'holati: ' + status));
    else if (prev != null && restarts - prev >= 3) out.push(item(id, name, WARN, `oxirgi tekshiruvdan beri ${restarts - prev} marta qayta ishga tushgan — qulash sikli bo'lishi mumkin`));
    else out.push(item(id, name, OK, 'online'));
  }
  return out;
}

// ── Server ichidagi portlar ──
async function checkLocal(ctx) {
  const out = [];
  for (const [id, name, url, needle] of ctx.cfg.localEndpoints) {
    const res = await http(url, { timeoutMs: 10000 });
    if (res.status === 200 && (!needle || res.text.includes(needle))) out.push(item(id, name, OK, 'javob beryapti'));
    else out.push(item(id, name, CRIT, res.status === 200 ? 'kutilmagan javob' : "javob yo'q (" + why(res) + ')'));
  }
  return out;
}

// ── Tashqi HTTPS va sertifikat ──
function certDaysLeft(host, now) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: 15000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      resolve(c && c.valid_to ? { days: daysUntil(Date.parse(c.valid_to), now), ms: Date.parse(c.valid_to) } : null);
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}
async function checkPublic(ctx) {
  const host = ctx.cfg.publicHost;
  const out = [];
  const res = await http('https://' + host + '/', { timeoutMs: 20000 });
  out.push(res.status === 200
    ? item('https', 'HTTPS tashqi manzil', OK, 'javob beryapti')
    : item('https', 'HTTPS tashqi manzil', CRIT, "javob yo'q (" + why(res) + ') — Telegram va Instagram xabarlari yetib kelmaydi'));
  const cert = await certDaysLeft(host, ctx.now);
  if (!cert) out.push(item('cert', 'HTTPS sertifikat', WARN, "muddatini o'qib bo'lmadi"));
  else {
    // Caddy ~30 kun qolganda o'zi yangilaydi; 14 kun qolgan bo'lsa — yangilay olmayapti
    const level = cert.days <= 3 ? CRIT : cert.days <= 14 ? WARN : OK;
    const note = cert.days <= 14 ? ' — Caddy yangilay olmayapti' : '';
    out.push(item('cert', 'HTTPS sertifikat', level, `${cert.days} kun qoldi (${dmy(cert.ms)})${note}`, { expiry: true, days: cert.days }));
  }
  return out;
}

// ── Telegram ──
async function checkTelegram(ctx) {
  const out = [];
  const tokens = [
    ['@mbi_mebel_bot', ctx.keys.bot_token], ['Aziza', ctx.keys.aziza_token], ['Sardor', ctx.keys.sardor_token],
    ['Botir', ctx.keys.botir_token], ['Dilshod', ctx.keys.dilshod_token], ['Tannarx', ctx.env.TN_BOT_TOKEN],
  ];
  const dead = [], unknown = [];
  for (const [label, tok] of tokens) {
    if (!tok) { dead.push(label + " (yo'q)"); continue; }
    const res = await http('https://api.telegram.org/bot' + tok + '/getMe', { timeoutMs: 15000 });
    if (res.json && res.json.ok) continue;
    if (res.status === 401 || res.status === 404) dead.push(label);
    else unknown.push(label + ' ' + why(res));
  }
  const tn = 'Telegram bot tokenlari';
  if (dead.length) out.push(item('tg:tokens', tn, CRIT, 'ishlamaydi: ' + dead.join(', ') + " — BotFather'da tekshiring"));
  else if (unknown.length) out.push(item('tg:tokens', tn, WARN, "tekshirib bo'lmadi: " + unknown.join(', ')));
  else out.push(item('tg:tokens', tn, OK, `${tokens.length} ta bot ishlaydi`));

  const wn = 'Telegram webhook (@mbi_mebel_bot)';
  if (!ctx.env.WEBHOOK_BASE) { out.push(item('tg:webhook', wn, WARN, "WEBHOOK_BASE sozlanmagan — tekshirib bo'lmaydi")); return out; }
  if (!ctx.keys.bot_token) { out.push(item('tg:webhook', wn, CRIT, "bot_token yo'q")); return out; }
  const expected = ctx.env.WEBHOOK_BASE + '/webhook';
  const res = await http('https://api.telegram.org/bot' + ctx.keys.bot_token + '/getWebhookInfo', { timeoutMs: 15000 });
  const i = res.json && res.json.ok && res.json.result;
  out.push(i ? webhookItem(i, expected, ctx.now) : item('tg:webhook', wn, WARN, "holatini o'qib bo'lmadi (" + why(res) + ')'));
  return out;
}
// Manzil noto'g'ri (bo'sh yoki boshqa joy) bo'lsa meta.fixable — guardian (remedy.js) uni o'zi qayta o'rnatadi.
// Yetkazishdagi xato va navbat — faqat ogohlantirish (webhook'ni qayta o'rnatish ularni tuzatmaydi).
function webhookItem(i, expected, now) {
  const wn = 'Telegram webhook (@mbi_mebel_bot)';
  if (i.url !== expected) {
    return item('tg:webhook', wn, CRIT, `manzil noto'g'ri: "${i.url || "bo'sh"}" — bot xabarlarni olmaydi`, { fixable: 'webhook', expected, current: i.url || '' });
  }
  const errMin = i.last_error_date ? Math.round((now / 1000 - i.last_error_date) / 60) : null;
  if (errMin != null && errMin <= 60) return item('tg:webhook', wn, WARN, `${errMin} daqiqa oldin xato: ${String(i.last_error_message || '').slice(0, 80)}`);
  if (i.pending_update_count > 100) return item('tg:webhook', wn, WARN, `${i.pending_update_count} ta xabar navbatda — bot qayta ishlay olmayapti`);
  return item('tg:webhook', wn, OK, `joyida, navbatda ${i.pending_update_count || 0}`);
}

// ── GitHub tokeni va mbi-secrets/keys.json ──
async function checkGitHub(ctx) {
  const out = [];
  const name = 'GitHub tokeni';
  const res = await http('https://api.github.com/user', { headers: { Authorization: 'token ' + (ctx.env.GITHUB_TOKEN || ''), 'User-Agent': 'mbi-guardian' } });
  if (res.status === 401) out.push(item('gh:token', name, CRIT, "bekor qilingan yoki muddati tugagan — bot GitHub'ga yoza olmaydi"));
  else if (res.status !== 200) out.push(item('gh:token', name, WARN, "tekshirib bo'lmadi (" + why(res) + ')'));
  else {
    const scopes = (res.headers.get('x-oauth-scopes') || '').split(',').map((s) => s.trim());
    const exp = res.headers.get('github-authentication-token-expiration');   // "2026-10-01 12:00:00 UTC"
    if (!scopes.includes('repo')) out.push(item('gh:token', name, CRIT, "'repo' ruxsati yo'q — yopiq repolarni o'qiy olmaydi"));
    else if (exp) {
      const ms = Date.parse(exp.replace(' UTC', 'Z').replace(' ', 'T'));
      const days = daysUntil(ms, ctx.now);
      out.push(item('gh:token', name, days <= 3 ? CRIT : days <= 14 ? WARN : OK, `${days} kun qoldi (${dmy(ms)} da tugaydi)`, { expiry: true, days }));
    } else out.push(item('gh:token', name, OK, 'ishlaydi, muddatsiz'));
  }
  const kn = 'mbi-secrets/keys.json';
  if (ctx.keysError) out.push(item('gh:keys', kn, CRIT, "o'qilmadi (" + ctx.keysError + ') — botlar kalitlarini yuklay olmaydi'));
  else {
    const missing = ctx.cfg.requiredKeys.filter((k) => !ctx.keys[k]);
    out.push(missing.length ? item('gh:keys', kn, CRIT, "yo'q kalitlar: " + missing.join(', ')) : item('gh:keys', kn, OK, Object.keys(ctx.keys).length + ' ta kalit'));
  }
  return out;
}

// ── Instagram tokeni ──
// Aniq muddat faqat yangilash (refresh) javobidan ma'lum — actions.js uni state.igToken.expiresAt ga yozadi.
// Undan oldin (yoki token qo'lda almashtirilsa) olingan sana saqlanadi va +60 kun taxminan hisoblanadi.
async function checkInstagram(ctx) {
  const name = 'Instagram tokeni (IG_TOKEN)';
  const tok = ctx.env.IG_TOKEN;
  if (!tok) return [item('ig:token', name, CRIT, 'sozlanmagan — Instagram DM va izohlar ishlamaydi')];
  const fp = crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12);
  const prev = ctx.state.igToken;
  if (!prev || prev.fp !== fp) ctx.state.igToken = { fp, obtainedAt: prev ? new Date(ctx.now).toISOString() : ctx.cfg.igTokenSeedObtainedAt };
  const exact = !!ctx.state.igToken.expiresAt;
  const expMs = exact ? Date.parse(ctx.state.igToken.expiresAt) : Date.parse(ctx.state.igToken.obtainedAt) + 60 * DAY;
  const days = daysUntil(expMs, ctx.now);
  const when = exact ? `${days} kun qoldi (${dmy(expMs)} gacha)` : `taxminan ${days} kun qoldi (~${dmy(expMs)})`;
  const res = await http('https://graph.instagram.com/v21.0/me?fields=username&access_token=' + encodeURIComponent(tok));
  if (res.json && res.json.username) {
    return [item('ig:token', name, days <= 3 ? CRIT : days <= 14 ? WARN : OK, `ishlaydi (@${res.json.username}), ${when}, avtomatik yangilanadi`, { expiry: true, days })];
  }
  if (res.json && res.json.error && res.json.error.code === 190) {
    return [item('ig:token', name, CRIT, "muddati tugagan yoki bekor qilingan — Instagram DM va izohlar ishlamaydi, qayta ruxsat kerak", { dead: true })];
  }
  return [item('ig:token', name, WARN, "tekshirib bo'lmadi (" + why(res) + ')')];
}

// ── AI kalitlari ──
function keyStatus(id, name, res, okMsg) {
  if (res.status === 200) return item(id, name, OK, okMsg || 'ishlaydi');
  const txt = (res.text || '').slice(0, 400);
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key|api_key|invalid.*key/i.test(txt))) return item(id, name, CRIT, 'kalit rad etildi (' + why(res) + ')');
  if (res.status === 402) return item(id, name, CRIT, 'balans tugagan (HTTP 402)');
  if (res.status === 429) return item(id, name, WARN, "so'rovlar limiti (HTTP 429)");
  return item(id, name, WARN, "tekshirib bo'lmadi (" + why(res) + ')');
}
async function checkAI(ctx) {
  const e = ctx.env, out = [];
  const specs = [
    ['ai:anthropic', 'Anthropic (Claude)', e.ANTHROPIC_API_KEY, (k) => http('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' } })],
    ['ai:gemini', 'Google Gemini', e.GEMINI_API_KEY, (k) => http('https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(k))],
    ['ai:groq', 'Groq', e.GROQ_API_KEY, (k) => http('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + k } })],
  ];
  for (const [id, name, key, req] of specs) {
    if (!key) { out.push(item(id, name, INFO, 'kalit sozlanmagan')); continue; }
    out.push(keyStatus(id, name, await req(key)));
  }
  if (!e.OPENROUTER_KEY) out.push(item('ai:openrouter', 'OpenRouter', INFO, 'kalit sozlanmagan'));
  else {
    const res = await http('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + e.OPENROUTER_KEY } });
    const d = res.json && res.json.data;
    if (res.status === 200 && d) {
      if (d.limit != null && d.limit_remaining != null && d.limit_remaining <= Math.max(1, d.limit * 0.1)) {
        out.push(item('ai:openrouter', 'OpenRouter', WARN, `limit tugayapti: $${Number(d.limit_remaining).toFixed(2)} qoldi`));
      } else out.push(item('ai:openrouter', 'OpenRouter', OK, `ishlaydi, jami sarflangan $${Number(d.usage || 0).toFixed(2)}`));
    } else out.push(keyStatus('ai:openrouter', 'OpenRouter', res));
  }
  return out;
}

// ── Windsor (18:30 reklama tekshiruvi shunga tayanadi) ──
async function checkWindsor(ctx) {
  const name = "Windsor.ai (reklama ma'lumoti)";
  if (!ctx.env.WINDSOR_KEY) return [item('windsor', name, WARN, 'kalit sozlanmagan — 18:30 reklama tekshiruvi ishlamaydi')];
  const res = await http('https://connectors.windsor.ai/facebook?api_key=' + encodeURIComponent(ctx.env.WINDSOR_KEY) + '&date_preset=last_1dT&fields=date', { timeoutMs: 60000 });
  if (res.status === 200 && res.json && Array.isArray(res.json.data)) return [item('windsor', name, OK, 'ishlaydi')];
  if (res.status === 401 || res.status === 403) return [item('windsor', name, CRIT, 'kalit rad etildi — 18:30 reklama tekshiruvi ishlamaydi')];
  const detail = res.json && res.json.error ? String(res.json.error).slice(0, 60) : why(res);
  return [item('windsor', name, WARN, "tekshirib bo'lmadi (" + detail + ')')];
}

// ── mbi-bot loglari: karta monitori sessiyasi va GitHub'ga yozish xatolari ──
function tailLines(file, maxBytes = 3 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(maxBytes, size);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch (e) { return null; }
}
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/;          // PM2 `time: true` prefiksi, UTC
const lineTime = (l) => { const m = TS_RE.exec(l); return m ? Date.parse(m[1] + 'Z') : null; };
const within = (lines, ms, now) => lines.filter((l) => { const t = lineTime(l); return t != null && now - t <= ms && now - t >= -300000; });

async function checkLogs(ctx) {
  const errL = tailLines(ctx.cfg.logs.botErr), outL = tailLines(ctx.cfg.logs.botOut);
  if (!errL || !outL) return [item('logs', 'mbi-bot loglari', WARN, "log fayllari o'qilmadi")];
  const out = [];
  const err24 = within(errL, DAY, ctx.now), err1 = within(errL, 3600000, ctx.now), out1 = within(outL, 3600000, ctx.now);

  const cn = 'Karta monitori (Telegram sessiya)';
  const authLost = err24.filter((l) => /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED|sessiya topilmadi/.test(l)).length;
  const pollErr = err1.filter((l) => /card poll error/.test(l)).length;
  const reconnected = out1.some((l) => /card: qayta ulandi|card-monitor: started/.test(l));
  if (authLost) out.push(item('card', cn, CRIT, 'Telegram sessiyasi bekor qilingan — karta monitori ishlamaydi, telefondan qayta kirish kerak'));
  else if (pollErr >= 10 && !reconnected) out.push(item('card', cn, WARN, `oxirgi soatda ${pollErr} ta ulanish xatosi, qayta ulanish ko'rinmadi`));
  else out.push(item('card', cn, OK, "muammo belgisi yo'q"));

  const ghErr = err24.filter((l) => /ghPut|saqlash xato/.test(l)).length;
  out.push(ghErr
    ? item('gh:writes', "GitHub'ga yozish", WARN, `oxirgi 24 soatda ${ghErr} ta xato — ma'lumot saqlanmay qolgan bo'lishi mumkin`)
    : item('gh:writes', "GitHub'ga yozish", OK, "24 soatda xato yo'q"));
  return out;
}

// ── Server resurslari ──
async function checkSystem() {
  const out = [];
  try {
    const s = fs.statfsSync('/');
    const pct = Math.round((1 - s.bavail / s.blocks) * 100);
    out.push(item('sys:disk', 'Disk', pct >= 95 ? CRIT : pct >= 85 ? WARN : OK, `${pct}% band`));
  } catch (e) { out.push(item('sys:disk', 'Disk', WARN, "o'qib bo'lmadi")); }
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    const mb = Math.round(Number(m[1]) / 1024);
    out.push(item('sys:mem', 'Xotira', mb < 100 ? CRIT : mb < 300 ? WARN : OK, `${mb} MB bo'sh`));
  } catch (e) { out.push(item('sys:mem', 'Xotira', WARN, "o'qib bo'lmadi")); }
  return out;
}

// ── UptimeRobot (tashqi kuzatuv) ──
// v2 API dagi alert contact `status` yangi dashboard'dagi yoqish tugmachalarini aks ettirmaydi:
// 11.09.2026 da E-mail va Push dashboard'da YOQILGAN bo'lsa ham API ikkalasiga status=1 qaytardi.
// Shuning uchun 1 "pauza" deb hisoblanmaydi (aks holda har kuni yolg'on ogohlantirish chiqardi).
// Faqat kontakt umuman yo'q yoki hammasi faollashtirilmagan (0) bo'lsa ogohlantiriladi.
function uptimeContactsItem(contacts) {
  const nc = 'UptimeRobot ogohlantirishlari';
  const list = Array.isArray(contacts) ? contacts : [];
  if (!list.length) return item('ur:contacts', nc, WARN, "birorta ogohlantirish kontakti yo'q — server o'chsa sizga xabar kelmaydi");
  const usable = list.filter((c) => String(c.status) !== '0');
  if (!usable.length) return item('ur:contacts', nc, WARN, "kontaktlar faollashtirilmagan (tasdiqlanmagan) — server o'chsa sizga xabar kelmaydi");
  const kinds = [...new Set(usable.map((c) => (Number(c.type) === 2 ? 'email' : Number(c.type) === 12 ? 'push' : 'turi ' + c.type)))];
  return item('ur:contacts', nc, OK, `${usable.length} ta kontakt (${kinds.join(', ')})`);
}
async function checkUptimeRobot(ctx) {
  const key = ctx.keys.uptimerobot_api_key;
  const nm = 'UptimeRobot monitorlari', nc = 'UptimeRobot ogohlantirishlari';
  if (!key) return [item('ur:monitors', nm, WARN, "kalit yo'q — tashqi kuzatuv tekshirilmaydi")];
  const post = (method) => http('https://api.uptimerobot.com/v2/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'format=json&api_key=' + encodeURIComponent(key),
  });
  // Bo'sh yoki xato javob "hammasi UP" degani EMAS — stat=="ok" majburiy
  const good = (res) => res.status === 200 && res.json && res.json.stat === 'ok';
  const out = [];
  const mon = await post('getMonitors');
  if (!good(mon)) {
    const detail = mon.json && mon.json.error ? (mon.json.error.message || mon.json.error.type) : why(mon);
    out.push(item('ur:monitors', nm, WARN, "holatini o'qib bo'lmadi (" + detail + ')'));
  } else {
    const ms = mon.json.monitors || [];
    const down = ms.filter((m) => m.status === 8 || m.status === 9).map((m) => m.friendly_name);
    const paused = ms.filter((m) => m.status === 0).map((m) => m.friendly_name);
    if (!ms.length) out.push(item('ur:monitors', nm, WARN, "birorta monitor yo'q — server tashqaridan kuzatilmayapti"));
    else if (down.length) out.push(item('ur:monitors', nm, WARN, 'DOWN: ' + down.join(', ')));
    else if (paused.length) out.push(item('ur:monitors', nm, WARN, 'pauzada: ' + paused.join(', ')));
    else out.push(item('ur:monitors', nm, OK, `${ms.length} ta monitor UP`));
  }
  const ac = await post('getAlertContacts');
  if (!good(ac)) out.push(item('ur:contacts', nc, WARN, "o'qib bo'lmadi (" + why(ac) + ')'));
  else out.push(uptimeContactsItem(ac.json.alert_contacts));
  return out;
}

// ── Meta (ma'lumot uchun) ──
async function checkMeta(ctx) {
  const out = [];
  if (ctx.keys.fb_ads_token) {
    const exp = ctx.keys.fb_ads_token_expires ? Date.parse(ctx.keys.fb_ads_token_expires + 'T00:00:00Z') : null;
    const note = exp == null ? "muddati noma'lum" : exp < ctx.now ? `${dmy(exp)} da tugagan` : `${daysUntil(exp, ctx.now)} kun qoldi`;
    out.push(item('meta:ads-token', 'fb_ads_token (eski Meta tokeni)', INFO, note + ', bot ishlatmaydi'));
  }
  out.push(item('meta:system-token', 'Meta System User tokeni', INFO, ctx.keys.meta_system_token ? 'bor' : "hali yo'q — reklama boshqaruvi uchun kerak bo'ladi"));
  return out;
}

// ── Caddy (HTTPS server) — systemd unit'da Restart=no, o'lsa o'zi ko'tarilmaydi ──
function caddyItem(state) {
  const n = 'Caddy (HTTPS server)';
  if (state === 'active') return item('sys:caddy', n, OK, 'faol');
  if (state == null) return item('sys:caddy', n, WARN, "holatini o'qib bo'lmadi");
  return item('sys:caddy', n, CRIT, `faol emas (${state}) — tashqi HTTPS, Telegram va Instagram xabarlari ishlamaydi`);
}
async function checkCaddy() {
  const bin = ['/usr/bin/systemctl', '/bin/systemctl'].find((p) => fs.existsSync(p));
  if (!bin) return [caddyItem(null)];
  const state = await new Promise((resolve) => {
    execFile(bin, ['is-active', 'caddy'], { timeout: 15000 }, (err, stdout) => resolve(String(stdout || '').trim() || null));
  });
  return [caddyItem(state)];
}

// ── Avtomatik tuzatish yoqilganmi (autofix.off fayli — texnik ish paytida) ──
function autofixItem(offSinceMs, now) {
  const n = 'Avtomatik tuzatish';
  if (offSinceMs == null) return item('autofix', n, OK, "yoqilgan (to'xtagan bot, Caddy, webhook)");
  const h = Math.max(0, Math.floor((now - offSinceMs) / 3600000));
  return item('autofix', n, WARN, `o'chirilgan (${h} soatdan beri, autofix.off fayli) — guardian hech narsani o'zi tuzatmaydi`);
}
async function checkAutofix(ctx) {
  let since = null;
  try { since = fs.statSync(ctx.cfg.autofixOffFile).mtimeMs; } catch (e) {}
  return [autofixItem(since, ctx.now)];
}

module.exports = {
  http, why,
  checkProcesses, checkLocal, checkPublic, checkCaddy, checkTelegram, checkGitHub, checkInstagram,
  checkAI, checkWindsor, checkLogs, checkSystem, checkUptimeRobot, checkMeta, checkAutofix,
  _internal: { lineTime, within, keyStatus, dmy, uptimeContactsItem, webhookItem, caddyItem, autofixItem },
};
