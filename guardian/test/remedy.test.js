'use strict';
// guardian: remedy.js (avtomatik tuzatish qarorlari) va actions.js dagi tuzatish amallari testlari.
// Soxta PM2 / systemctl / Telegram bilan — haqiqiy jarayonlarga, Caddy'ga yoki webhook'ga tegmaydi.
// Ishga tushirish: npm test   yoki   node guardian/test/remedy.test.js
const REM = require('../remedy');
const A = require('../actions');
const C = require('../checks');

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (detail ? '\n   ' + detail : '')); }
}
const MIN = 60000, H = 3600000;
const NOW = Date.parse('2026-09-11T11:00:00Z');
const CFG = {
  processes: ['mbi-bot', 'mbi-tannarx-bot'],
  publicHost: '65.21.147.238.nip.io',
  ecosystemFile: '/opt/mbi/ecosystem.config.js',
  localEndpoints: [
    ['local:bot', 'mbi-bot (ichki port 3000)', 'http://127.0.0.1:3000/', 'MBI Bot running', 'mbi-bot'],
    ['local:tannarx', 'Tannarx bot (ichki port 3002)', 'http://127.0.0.1:3002/', 'Tan Narx', 'mbi-tannarx-bot'],
  ],
  remedy: { confirmRuns: 2, minGapMs: 25 * MIN, windowMs: 6 * H, maxRestarts: 3, maxWebhookFixes: 2 },
};
const WH_OK = 'https://65.21.147.238.nip.io/webhook';
const res = (id, level, msg, meta) => (meta ? { id, name: 'N-' + id, level, msg, meta } : { id, name: 'N-' + id, level, msg });
const OKS = () => ['proc:mbi-bot', 'proc:mbi-tannarx-bot', 'local:bot', 'local:tannarx', 'https', 'sys:caddy', 'tg:webhook', 'autofix'].map((id) => res(id, 'ok', 'yaxshi'));
const withR = (...over) => {
  const list = OKS();
  for (const o of over) { const i = list.findIndex((r) => r.id === o.id); if (i >= 0) list[i] = o; else list.push(o); }
  return list;
};
const plan = (results, { issues = {}, remedyState, paused = false, now = NOW } = {}) => REM.planRemedies({ issues, remedyState, results, now, cfg: CFG, paused });
const streak1 = (...ids) => Object.fromEntries(ids.map((id) => [id, { streak: 1, firstSeen: NOW - 15 * MIN, alertedAt: null }]));
const whBad = (current, expected = WH_OK) => res('tg:webhook', 'crit', "manzil noto'g'ri", { fixable: 'webhook', expected, current });

// ── Qarorlar ──
{
  let p = plan(OKS());
  t('hammasi joyida — hech narsa qilinmaydi', p.actions.length === 0 && p.blocked.length === 0);

  const down = res('proc:mbi-bot', 'crit', 'holati: errored');
  p = plan(withR(down));
  t("jarayon birinchi marta to'xtagan ko'rindi — hali tegmaydi (tasdiq kutiladi)", p.actions.length === 0 && p.blocked.length === 0);

  p = plan(withR(down), { issues: streak1('proc:mbi-bot') });
  t('2-marta tasdiqlandi — mbi-bot qayta ishga tushiriladi', p.actions.length === 1 && p.actions[0].type === 'restart' && p.actions[0].target === 'mbi-bot' && p.actions[0].reason === 'holati: errored', JSON.stringify(p.actions));
  t('urinish vaqti bajarishdan oldin state ga yoziladi', JSON.stringify(p.state.attempts['restart:mbi-bot']) === JSON.stringify([NOW]));

  p = plan(withR(res('proc:mbi-bot', 'warn', 'qulash sikli bo‘lishi mumkin')), { issues: streak1('proc:mbi-bot') });
  t("PM2 o'zi qayta ishga tushirayotgan bo'lsa (warn) — aralashmaydi", p.actions.length === 0);

  p = plan(withR(res('local:bot', 'crit', "javob yo'q")), { issues: streak1('local:bot') });
  t('online, lekin porti javob bermayapti (qotgan) — qayta ishga tushiriladi', p.actions.length === 1 && p.actions[0].target === 'mbi-bot' && /qotib/.test(p.actions[0].reason), JSON.stringify(p.actions));

  p = plan(withR(down, res('local:bot', 'crit', "javob yo'q")), { issues: streak1('proc:mbi-bot', 'local:bot') });
  t('jarayon ham, porti ham ishlamasa — bitta amal', p.actions.length === 1);

  p = plan(withR(down, res('proc:mbi-tannarx-bot', 'crit', 'PM2 da topilmadi — ishlamayapti')), { issues: streak1('proc:mbi-bot', 'proc:mbi-tannarx-bot') });
  t('ikkala bot ham tushgan — ikkalasi tiklanadi', p.actions.map((a) => a.target).join(',') === 'mbi-bot,mbi-tannarx-bot');

  p = plan(withR(res('proc', 'warn', "pm2 ro'yxati o'qilmadi")));
  t("pm2 ro'yxati o'qilmasa — hech narsa qilinmaydi", p.actions.length === 0);

  const iss = streak1('proc:mbi-bot');
  p = plan(withR(down), { issues: iss, remedyState: { attempts: { 'restart:mbi-bot': [NOW - 10 * MIN] } } });
  t("oxirgi urinishdan 25 daqiqa o'tmagan — kutadi, xabar ham yo'q", p.actions.length === 0 && p.blocked.length === 0);

  p = plan(withR(down), { issues: iss, remedyState: { attempts: { 'restart:mbi-bot': [NOW - 30 * MIN] } } });
  t('30 daqiqadan keyin yana urinadi', p.actions.length === 1 && p.state.attempts['restart:mbi-bot'].length === 2);

  const three = { attempts: { 'restart:mbi-bot': [NOW - 5 * H, NOW - 3 * H, NOW - 1 * H] } };
  p = plan(withR(down), { issues: iss, remedyState: three });
  t("6 soatda 3 marta urinilgan — to'xtaydi va bitta 🚨 xabar", p.actions.length === 0 && p.blocked.length === 1 && p.blocked[0].text.includes('3 marta') && p.blocked[0].text.includes('pm2 logs mbi-bot'), JSON.stringify(p.blocked));
  const p2 = plan(withR(down), { issues: iss, remedyState: p.state, now: NOW + 15 * MIN });
  t("to'xtatilgandan keyin 🚨 xabar takrorlanmaydi", p2.actions.length === 0 && p2.blocked.length === 0);
  const p3 = plan(OKS(), { remedyState: p.state, now: NOW + 30 * MIN });
  t("tiklangach to'xtatish belgisi tozalanadi", !p3.state.blockedAt['restart:mbi-bot']);

  p = plan(withR(down), { issues: iss, remedyState: { attempts: { 'restart:mbi-bot': [NOW - 7 * H, NOW - 6.5 * H, NOW - 6.1 * H] } } });
  t('6 soatdan eski urinishlar hisobga olinmaydi — yana urinadi', p.actions.length === 1 && p.state.attempts['restart:mbi-bot'].length === 1);

  p = plan(withR(down, whBad('')), { issues: streak1('proc:mbi-bot'), paused: true });
  t("autofix.off — hech narsa tuzatilmaydi, urinish yozilmaydi", p.actions.length === 0 && p.blocked.length === 0 && p.paused === true && !p.state.attempts['restart:mbi-bot']);

  const cd = res('sys:caddy', 'crit', 'faol emas (failed)');
  t('Caddy birinchi marta — kutadi', plan(withR(cd)).actions.length === 0);
  p = plan(withR(cd), { issues: streak1('sys:caddy') });
  t('Caddy tasdiqlandi — ishga tushiriladi', p.actions.length === 1 && p.actions[0].type === 'caddy' && p.actions[0].reason === 'faol emas (failed)');

  p = plan(withR(whBad('')));
  t("webhook bo'sh — darhol (tasdiqsiz) bizning manzilga qayta o'rnatiladi", p.actions.length === 1 && p.actions[0].type === 'webhook' && p.actions[0].url === WH_OK && p.actions[0].current === '', JSON.stringify(p.actions));
  p = plan(withR(whBad('', 'https://boshqa.example.com/webhook')));
  t('WEBHOOK_BASE bu server emas — tegmaydi', p.actions.length === 0);
  p = plan(withR(res('tg:webhook', 'crit', "bot_token yo'q")));
  t('webhook crit, lekin manzil muammosi emas — tegmaydi', p.actions.length === 0);
  const onr = 'https://mbi-bot-yw9q.onrender.com/webhook';
  p = plan(withR(whBad(onr)), { remedyState: { attempts: { webhook: [NOW - 2 * H, NOW - 1 * H] } } });
  t("webhook 6 soatda 2 marta tuzatilib yana o'zgargan — to'xtaydi, Render haqida ogohlantiradi", p.actions.length === 0 && p.blocked.length === 1 && p.blocked[0].text.includes('Render') && p.blocked[0].text.includes(onr), JSON.stringify(p.blocked));

  const rs = { attempts: { 'restart:mbi-bot': [NOW - 30 * MIN] }, blockedAt: {} };
  const snap = JSON.stringify(rs), issSnap = JSON.stringify(iss);
  plan(withR(down), { issues: iss, remedyState: rs });
  t("planRemedies kiruvchi holatni o'zgartirmaydi", JSON.stringify(rs) === snap && JSON.stringify(iss) === issSnap);
}

// ── Xabarlar ──
{
  const r = { type: 'restart', target: 'mbi-tannarx-bot', reason: 'holati: errored' };
  let m = REM.remedyMessage(r, { ok: true });
  t('xabar: qayta ishga tushirildi', m.startsWith('🔧') && m.includes('mbi-tannarx-bot') && m.includes('holati: errored'), m);
  m = REM.remedyMessage(r, { ok: false, error: '90 soniyada javob bermadi' });
  t("xabar: tiklab bo'lmadi + qayerdan qarash", m.startsWith('❌') && m.includes('90 soniyada') && m.includes('pm2 logs mbi-tannarx-bot'), m);
  m = REM.remedyMessage({ type: 'caddy', target: 'caddy', reason: 'faol emas (failed)' }, { ok: false, error: 'holati: failed' });
  t('xabar: Caddy — journalctl maslahati', m.includes('Caddy') && m.includes('journalctl -u caddy'), m);
  m = REM.remedyMessage({ type: 'webhook', target: '@mbi_mebel_bot', url: WH_OK, current: '' }, { ok: true });
  t("xabar: webhook o'chib qolgan edi — qayta o'rnatildi", m.startsWith('🔧') && m.includes("o'chib qolgan") && !m.includes('Render'), m);
  m = REM.remedyMessage({ type: 'webhook', target: '@mbi_mebel_bot', url: WH_OK, current: 'https://mbi-bot-yw9q.onrender.com/webhook' }, { ok: true });
  t("xabar: eski manzil Render'niki — ikki joy bir vaqtda ishlashi haqida ogohlantirish", m.includes('Render') && m.includes('takroriy yozuv'), m);
  t('qayta tekshiruv funksiyalari checks.js da bor', Object.values(REM.RECHECKS).flat().every((n) => typeof C[n] === 'function'));
}

// ── Bajaruvchilar (soxta PM2 / systemctl / Telegram) ──
const fakeRun = (answers = {}) => {
  const calls = [];
  const fn = async (bin, args) => {
    calls.push(args.join(' '));
    const a = answers[args[0]];
    return typeof a === 'function' ? a(args) : (a || { ok: true, out: '' });
  };
  fn.calls = calls;
  return fn;
};
const fakeHttp = (handler) => {
  const calls = [];
  const fn = async (url, opts = {}) => { calls.push({ url, opts }); return handler(url, opts, calls.length); };
  fn.calls = calls;
  return fn;
};
const fast = { sleep: () => new Promise((r) => setTimeout(r, 2)), pollMs: 2 };

(async () => {
  {
    const run = fakeRun();
    const http = fakeHttp((url, o, n) => (n >= 2 ? { status: 200, text: 'MBI Bot running' } : { status: 0, text: '', error: 'tarmoq xatosi' }));
    const out = await A.recreateProcess({ cfg: CFG, http, name: 'mbi-bot', run, ...fast, waitMs: 2000 });
    t('recreateProcess: delete → start --only → save, keyin port javobini kutadi', out.ok
      && run.calls.join(' | ') === 'delete mbi-bot | start /opt/mbi/ecosystem.config.js --only mbi-bot | save'
      && http.calls[0].url === 'http://127.0.0.1:3000/', JSON.stringify({ out, calls: run.calls }));
  }
  {
    const run = fakeRun();
    const http = fakeHttp(() => ({ status: 200, text: 'MBI Tan Narx Bot ishlayapti ✅' }));
    const out = await A.recreateProcess({ cfg: CFG, http, name: 'mbi-tannarx-bot', run, ...fast });
    t("recreateProcess: tannarx o'z porti (3002) orqali tekshiriladi", out.ok && http.calls[0].url === 'http://127.0.0.1:3002/');
  }
  {
    const run = fakeRun();
    const out = await A.recreateProcess({ cfg: CFG, http: fakeHttp(() => ({ status: 200, text: '' })), name: 'mbi-guardian', run, ...fast });
    t("recreateProcess: ruxsat ro'yxatida bo'lmagan jarayonga tegmaydi", !out.ok && run.calls.length === 0, JSON.stringify(out));
  }
  {
    const run = fakeRun({ start: { ok: false, out: '' } });
    const out = await A.recreateProcess({ cfg: CFG, http: fakeHttp(() => ({ status: 200, text: 'MBI Bot running' })), name: 'mbi-bot', run, ...fast });
    t('recreateProcess: pm2 start xato — save qilinmaydi', !out.ok && /pm2 start/.test(out.error) && !run.calls.includes('save'));
  }
  {
    const out = await A.recreateProcess({ cfg: CFG, http: fakeHttp(() => ({ status: 502, text: '' })), name: 'mbi-bot', run: fakeRun(), ...fast, waitMs: 40 });
    t('recreateProcess: port javob bermasa — ok emas', !out.ok && /javob bermadi/.test(out.error), JSON.stringify(out));
  }
  {
    const run = fakeRun({ 'is-active': { ok: true, out: 'active\n' } });
    const out = await A.startCaddy({ run, sleep: async () => {}, settleMs: 0 });
    t('startCaddy: systemctl start caddy, keyin is-active tekshiradi', out.ok && run.calls.join(' | ') === 'start caddy | is-active caddy', JSON.stringify(run.calls));
    const out2 = await A.startCaddy({ run: fakeRun({ start: { ok: false, out: '' }, 'is-active': { ok: false, out: 'failed\n' } }), sleep: async () => {}, settleMs: 0 });
    t("startCaddy: faol bo'lmasa — ok emas, holati xabarda", !out2.ok && out2.error.includes('failed'), JSON.stringify(out2));
  }
  {
    const TOK = '123456:ABCdefGhIJKlmnOPQrstUVwxyz0123456789';
    let body = null;
    const http = fakeHttp((url, opts) => {
      if (url.endsWith('/setWebhook')) { body = JSON.parse(opts.body); return { status: 200, json: { ok: true, result: true } }; }
      if (url.endsWith('/getWebhookInfo')) return { status: 200, json: { ok: true, result: { url: WH_OK, pending_update_count: 3 } } };
      return { status: 404, json: null };
    });
    const out = await A.setTelegramWebhook({ http, token: TOK, url: WH_OK });
    t("setTelegramWebhook: o'rnatadi va getWebhookInfo bilan tasdiqlaydi", out.ok && http.calls.length === 2 && http.calls[0].opts.method === 'POST', JSON.stringify(out));
    t("setTelegramWebhook: faqat url yuboriladi — kutilayotgan xabarlar o'chirilmaydi", body && JSON.stringify(Object.keys(body)) === '["url"]' && body.url === WH_OK, JSON.stringify(body));

    const http2 = fakeHttp((url) => (url.endsWith('/setWebhook') ? { status: 200, json: { ok: true } } : { status: 200, json: { ok: true, result: { url: 'https://boshqa/webhook' } } }));
    const o2 = await A.setTelegramWebhook({ http: http2, token: TOK, url: WH_OK });
    t('setTelegramWebhook: tekshiruvda manzil mos kelmasa — ok emas', !o2.ok && /mos kelmadi/.test(o2.error));

    const o3 = await A.setTelegramWebhook({ http: fakeHttp(() => ({ status: 400, json: { ok: false, description: 'Bad Request: bad webhook: HTTPS url must be provided for webhook' } })), token: TOK, url: WH_OK });
    t("setTelegramWebhook: Telegram rad etsa — sababi xabarda, token ko'rinmaydi", !o3.ok && o3.error.includes('bad webhook') && !o3.error.includes(TOK), JSON.stringify(o3));

    const o4 = await A.setTelegramWebhook({ http: fakeHttp(() => ({ status: 0, json: null, error: 'tarmoq xatosi' })), token: TOK, url: WH_OK });
    t('setTelegramWebhook: tarmoq xatosi', !o4.ok && o4.error === 'tarmoq xatosi');

    const h5 = fakeHttp(() => ({ status: 200, json: { ok: true } }));
    const o5 = await A.setTelegramWebhook({ http: h5, token: '', url: WH_OK });
    t("setTelegramWebhook: token yo'q — so'rov yuborilmaydi", !o5.ok && h5.calls.length === 0);
  }

  console.log('\n' + pass + '/' + (pass + fail) + " o'tdi");
  process.exit(fail ? 1 : 0);
})();
