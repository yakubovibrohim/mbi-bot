// ─────────────────────────────────────────────────────────────
//  CardXabar karta monitoringi
//  Ibrohimning TG sessiyasi orqali @CardXabarBot xabarlarini o'qiydi,
//  har tranzaksiyani admin'ga tugmali savol bilan yuboradi.
//  Javob → tegishli log'ga yoziladi (💳 karta belgisi bilan).
//  Kassa = naqd + karta. Kartaga o'z pulini tushirish = ichki ko'chirish (yozilmaydi).
// ─────────────────────────────────────────────────────────────
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { PromisedWebSockets } = require('telegram/extensions');
const { ConnectionTCPObfuscated } = require('telegram/network');

const WSS_HOST = { 1:'pluto.web.telegram.org',2:'venus.web.telegram.org',3:'aurora.web.telegram.org',4:'vesta.web.telegram.org',5:'flora.web.telegram.org' };

// pending: bir tranzaksiya tasniflanishini kutayotgani
//   key = qisqa id, value = { date, amtUzs, dir, place, rawBalance, step, subType }
const cardPending = {};
// oxirgi ko'rilgan CardXabar xabar id — takror bo'lmasligi uchun
let lastMsgId = 0;
let tgUser = null;
let cardCfg = null;      // { session, api_id, api_hash }
let deps = null;         // { ADMIN, msg, btn, api, ghReadAll, ghWrite, ghRead, ghPut, todayStr, fmtUzs, USD_UZS }

function shortId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// ── CardXabar xabarini parslash ──
// Namuna:
//  🔴 E-Com oplata / ➖ 1 000.00 UZS / 💳 ***5893 / 📍 PAYME OPLATA, UZ / 🕓 06.07.26 15:19 / 💵 1 259 641.74 UZS
function parseCardMsg(text) {
  if (!text) return null;
  // faqat tranzaksiya xabarlari: ➖ yoki ➕ bo'lishi shart
  const isOut = text.includes('➖');
  const isIn = text.includes('➕');
  if (!isOut && !isIn) return null;
  // summa
  const amtM = text.match(/[➖➕]\s*([\d\s.,]+?)\s*(?:UZS|so'm|сум)/i);
  if (!amtM) return null;
  const amtUzs = Math.round(parseFloat(amtM[1].replace(/\s/g, '').replace(',', '.')));
  if (!amtUzs || amtUzs <= 0) return null;
  // joy / savdogar
  const placeM = text.match(/📍\s*([^\n]+)/);
  const place = placeM ? placeM[1].trim() : '';
  // yangi balans
  const balM = text.match(/💵\s*([\d\s.,]+?)\s*(?:UZS|so'm|сум)/i);
  const rawBalance = balM ? Math.round(parseFloat(balM[1].replace(/\s/g, '').replace(',', '.'))) : null;
  // sana (🕓 06.07.26 15:19)
  const dtM = text.match(/🕓\s*(\d{2})\.(\d{2})\.(\d{2})/);
  const date = dtM ? `${dtM[1]}.${dtM[2]}.20${dtM[3]}` : deps.todayStr();
  // tavsif (birinchi qator, emoji'siz)
  const firstLine = (text.split('\n')[0] || '').replace(/[🔴🟢💳➖➕📍🕓💵💰]/g, '').trim();
  return { dir: isOut ? 'out' : 'in', amtUzs, place, rawBalance, date, title: firstLine };
}

// ── Tranzaksiya kelganda admin'ga tugmali savol ──
async function askClassify(tx) {
  const id = shortId();
  cardPending[id] = { ...tx, step: 'type' };
  const arrow = tx.dir === 'out' ? '🔴 Chiqim' : '🟢 Kirim';
  const head = `💳 *Karta ${tx.dir === 'out' ? 'chiqim' : 'kirim'}*\n` +
    `${arrow}: *${deps.fmtUzs(tx.amtUzs)} so'm*\n` +
    (tx.place ? `📍 ${tx.place}\n` : '') +
    `🕓 ${tx.date}\n` +
    (tx.rawBalance != null ? `💵 Yangi balans: ${deps.fmtUzs(tx.rawBalance)} so'm\n` : '') +
    `\nBu nima?`;
  let kb;
  if (tx.dir === 'out') {
    kb = [
      [{ text: '👛 Shaxsiy', callback_data: `cm_t_${id}_pers` }, { text: '🏭 Ishxona', callback_data: `cm_t_${id}_office` }],
      [{ text: '📦 Buyurtma xarajati', callback_data: `cm_t_${id}_deal` }],
      [{ text: '🔴 Qarz to\'lovi', callback_data: `cm_t_${id}_debtout` }],
      [{ text: '⏭ Hisobga olinmasin', callback_data: `cm_t_${id}_skip` }],
    ];
  } else {
    kb = [
      [{ text: '💵 O\'z pulim (karta to\'ldirish)', callback_data: `cm_t_${id}_self` }],
      [{ text: '📦 Mijoz to\'lovi', callback_data: `cm_t_${id}_client` }],
      [{ text: '📥 Qarzdor to\'lovi', callback_data: `cm_t_${id}_debtin` }],
      [{ text: '➕ Boshqa kirim', callback_data: `cm_t_${id}_other` }],
      [{ text: '⏭ Hisobga olinmasin', callback_data: `cm_t_${id}_skip` }],
    ];
  }
  await deps.btn(deps.ADMIN, head, kb);
}

// ── Callback ishlovchisi (bot.js callback router'idan chaqiriladi) ──
// cd formatlari:
//   cm_t_<id>_<type>          — tur tanlandi
//   cm_d_<id>_<dealId>        — buyurtma tanlandi
//   cm_din_<id>_<debtId>      — qarzdor tanlandi
//   cm_dout_<id>_<debtId>     — qarz to'lovi (kimga)
async function handleCallback(cd, chatId) {
  if (!cd.startsWith('cm_')) return false;

  // izohsiz saqlash
  if (cd.startsWith('cm_nn_')) {
    const id = cd.slice(6);
    const p = cardPending[id];
    if (!p) { await deps.msg(chatId, '⚠️ Eskirgan.'); return true; }
    awaitingNote = null;
    await saveCardExpense(id, p.kind);
    return true;
  }

  // 1-bosqich: tur tanlash
  if (cd.startsWith('cm_t_')) {
    const rest = cd.slice(5);
    const us = rest.lastIndexOf('_');
    const id = rest.slice(0, us);
    const type = rest.slice(us + 1);
    const p = cardPending[id];
    if (!p) { await deps.msg(chatId, '⚠️ Bu so\'rov eskirgan.'); return true; }

    if (type === 'skip') {
      delete cardPending[id];
      await deps.msg(chatId, '⏭ Hisobga olinmadi.');
      return true;
    }
    if (type === 'self') {
      delete cardPending[id];
      await deps.msg(chatId, '💵 O\'z pulingizni kartaga tushirdingiz — bu ichki ko\'chirish, kassa jami o\'zgarmaydi (yozilmadi).');
      return true;
    }
    if (type === 'pers') { await askNote(id, 'personal', chatId); return true; }
    if (type === 'office') { await askNote(id, 'office', chatId); return true; }
    if (type === 'other') { await saveCardIncome(id, 'other'); return true; }

    if (type === 'deal') { // buyurtma → mijozlar ro'yxati
      p.subType = 'deal';
      const deals = (await deps.ghReadAll('deals-log.json')).filter(o => o.status === 'active');
      if (!deals.length) { await deps.msg(chatId, '⚠️ Faol buyurtma yo\'q.'); delete cardPending[id]; return true; }
      const kb = deals.map(o => [{ text: o.client, callback_data: `cm_d_${id}_${o.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Qaysi buyurtma xarajati?', kb);
      return true;
    }
    if (type === 'client') { // mijoz to'lovi → faol buyurtmalar
      p.subType = 'client';
      const deals = (await deps.ghReadAll('deals-log.json')).filter(o => o.status === 'active');
      if (!deals.length) { await deps.msg(chatId, '⚠️ Faol buyurtma yo\'q.'); delete cardPending[id]; return true; }
      const kb = deals.map(o => [{ text: o.client, callback_data: `cm_d_${id}_${o.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Qaysi mijoz to\'lovi?', kb);
      return true;
    }
    if (type === 'debtin') { // qarzdor to'lovi → in-qarzlar
      const debts = (await deps.ghReadAll('debts-log.json')).filter(d => d.dir === 'in' && (d.amount_uzs || 0) - (d.paid_uzs || 0) > 0);
      if (!debts.length) { await deps.msg(chatId, '⚠️ Ochiq qarzdor yo\'q.'); delete cardPending[id]; return true; }
      const kb = debts.map(d => [{ text: `${d.name} (qoldi ${deps.fmtUzs((d.amount_uzs || 0) - (d.paid_uzs || 0))})`, callback_data: `cm_din_${id}_${d.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Kim qarzini to\'ladi?', kb);
      return true;
    }
    if (type === 'debtout') { // men to'lagan qarz → out-qarzlar
      const debts = (await deps.ghReadAll('debts-log.json')).filter(d => d.dir === 'out' && (d.amount_uzs || 0) - (d.paid_uzs || 0) > 0);
      if (!debts.length) { await deps.msg(chatId, '⚠️ Ochiq qarz yo\'q.'); delete cardPending[id]; return true; }
      const kb = debts.map(d => [{ text: `${d.name} (qoldi ${deps.fmtUzs((d.amount_uzs || 0) - (d.paid_uzs || 0))})`, callback_data: `cm_dout_${id}_${d.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Kimning qarzini to\'ladingiz?', kb);
      return true;
    }
  }

  // 2-bosqich: buyurtma tanlandi (xarajat yoki to'lov)
  if (cd.startsWith('cm_d_')) {
    const rest = cd.slice(5);
    const us = rest.lastIndexOf('_');
    const id = rest.slice(0, us);
    const dealId = rest.slice(us + 1);
    const p = cardPending[id];
    if (!p) { await deps.msg(chatId, '⚠️ Eskirgan.'); return true; }
    if (p.subType === 'client') await saveDealPayment(id, dealId);
    else await saveDealExpense(id, dealId);
    return true;
  }
  // qarzdor to'lovi (in)
  if (cd.startsWith('cm_din_')) {
    const rest = cd.slice(7);
    const us = rest.lastIndexOf('_');
    const id = rest.slice(0, us);
    const debtId = rest.slice(us + 1);
    await saveDebtPayment(id, debtId, 'in');
    return true;
  }
  // men to'lagan qarz (out)
  if (cd.startsWith('cm_dout_')) {
    const rest = cd.slice(8);
    const us = rest.lastIndexOf('_');
    const id = rest.slice(0, us);
    const debtId = rest.slice(us + 1);
    await saveDebtPayment(id, debtId, 'out');
    return true;
  }
  return false;
}

// ── Izoh so'rash (chiqim turini tanlagach) ──
async function askNote(id, kind, chatId) {
  const p = cardPending[id];
  if (!p) { await deps.msg(chatId, '⚠️ Eskirgan.'); return; }
  p.kind = kind;
  p.step = 'note';
  awaitingNote = id; // admin keyingi matni shu izoh bo'ladi
  const kb = [[{ text: '⏭ Izohsiz saqlash', callback_data: `cm_nn_${id}` }]];
  await deps.btn(chatId, `✍️ *${kind === 'office' ? '🏭 Ishxona' : '👛 Shaxsiy'}* — nima uchun sarfladingiz?\n(${deps.fmtUzs(p.amtUzs)} so'm)\n\nYozib yuboring yoki izohsiz saqlang:`, kb);
}

// admin matn yozganda chaqiriladi (bot.js msg handleridan) — izoh kutayotgan bo'lsa true qaytaradi
async function tryTakeNote(text, chatId) {
  if (!awaitingNote) return false;
  const id = awaitingNote;
  const p = cardPending[id];
  if (!p || p.step !== 'note') { awaitingNote = null; return false; }
  awaitingNote = null;
  p.userNote = (text || '').trim();
  await saveCardExpense(id, p.kind);
  return true;
}
let awaitingNote = null;
async function saveCardExpense(id, kind) {
  const p = cardPending[id]; if (!p) return;
  const file = kind === 'office' ? 'office-expenses-log.json' : 'expenses-personal-log.json';
  // izoh: foydalanuvchi yozgani birinchi, bo'lmasa joy nomi
  const note = p.userNote ? `💳 ${p.userNote}` : `💳 ${p.place || p.title || 'karta'}`;
  const entry = kind === 'office'
    ? { id: shortId(), date: p.date, name: note, amount_uzs: p.amtUzs, rate: deps.USD_UZS, note: p.place || 'karta', pay_method: 'card' }
    : { date: p.date, note, amount_uzs: p.amtUzs, rate: deps.USD_UZS, type: 'personal', pay_method: 'card', place: p.place || '', ts: new Date().toISOString() };
  await deps.ghWrite(file, entry, `card expense: ${note} ${p.amtUzs}`);
  delete cardPending[id];
  await deps.msg(deps.ADMIN, `✅ ${kind === 'office' ? '🏭 Ishxona' : '👛 Shaxsiy'} chiqim yozildi: ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)\n📝 ${note.replace('💳 ', '')}`);
}

async function saveCardIncome(id) {
  const p = cardPending[id]; if (!p) return;
  // "boshqa kirim" — buyurtma bilan bog'lanmagan umumiy kirim: personal log'ga manfiy chiqim EMAS,
  // buni alohida income-log'ga yozamiz
  const entry = { id: shortId(), date: p.date, name: `💳 ${p.place || p.title || 'boshqa kirim'}`, amount_uzs: p.amtUzs, rate: deps.USD_UZS, note: 'karta', pay_method: 'card', ts: new Date().toISOString() };
  await deps.ghWrite('card-income-log.json', entry, `card income: ${p.amtUzs}`);
  delete cardPending[id];
  await deps.msg(deps.ADMIN, `✅ ➕ Boshqa kirim yozildi: ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDealExpense(id, dealId) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('deals-log.json');
  const o = data.find(x => x.id === dealId);
  if (!o) { await deps.msg(deps.ADMIN, '⚠️ Buyurtma topilmadi.'); delete cardPending[id]; return; }
  if (!Array.isArray(o.expenses)) o.expenses = [];
  o.expenses.push({ date: p.date, name: `💳 ${p.place || p.title || 'karta'}`, total_uzs: p.amtUzs, rate: deps.USD_UZS, pay_method: 'card' });
  await deps.ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, `card deal-expense: ${o.client} ${p.amtUzs}`);
  delete cardPending[id];
  await deps.msg(deps.ADMIN, `✅ 📦 Buyurtma xarajati (${o.client}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDealPayment(id, dealId) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('deals-log.json');
  const o = data.find(x => x.id === dealId);
  if (!o) { await deps.msg(deps.ADMIN, '⚠️ Buyurtma topilmadi.'); delete cardPending[id]; return; }
  if (!Array.isArray(o.payments)) o.payments = [];
  o.payments.push({ date: p.date, amount_uzs: p.amtUzs, note: '💳 karta', pay_method: 'card' });
  await deps.ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, `card deal-payment: ${o.client} ${p.amtUzs}`);
  delete cardPending[id];
  await deps.msg(deps.ADMIN, `✅ 📦 Mijoz to'lovi (${o.client}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDebtPayment(id, debtId, dir) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('debts-log.json');
  const d = data.find(x => x.id === debtId);
  if (!d) { await deps.msg(deps.ADMIN, '⚠️ Qarz topilmadi.'); delete cardPending[id]; return; }
  d.paid_uzs = (d.paid_uzs || 0) + p.amtUzs;
  if (!Array.isArray(d.payments)) d.payments = [];
  d.payments.push({ date: p.date, amount_uzs: p.amtUzs, pay_method: 'card' });
  d.pay_date = p.date;
  await deps.ghPut('debts-log.json', JSON.stringify(data, null, 2), sha, `card debt-${dir}: ${d.name} ${p.amtUzs}`);
  delete cardPending[id];
  const remain = (d.amount_uzs || 0) - d.paid_uzs;
  await deps.msg(deps.ADMIN, `✅ ${dir === 'in' ? '📥 Qarzdor to\'lovi' : '🔴 Qarz to\'lovi'} (${d.name}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)\nQolgan qarz: ${deps.fmtUzs(remain > 0 ? remain : 0)} so'm`);
  await checkBalance(p);
}

// ── CardXabar balansini bot hisobi bilan solishtirish (ogohlantirish) ──
async function checkBalance(p) {
  if (p.rawBalance == null) return;
  // bu yerda faqat CardXabar bergan raw balansni ko'rsatamiz; to'liq karta hisobi bot ichida
  // (kelajakda: bot karta-qoldig'ini hisoblab, farq bo'lsa ogohlantiradi)
}

// ── Sessiya ochish ──
async function connect() {
  const sess = cardCfg.session;
  const dc = 2;
  const stringSession = new StringSession(sess);
  const client = new TelegramClient(stringSession, cardCfg.api_id, cardCfg.api_hash, {
    useWSS: true, networkSocket: PromisedWebSockets, connection: ConnectionTCPObfuscated,
    connectionRetries: 3, autoReconnect: true, retryDelay: 3000,
  });
  await client.connect();
  const me = await client.getMe();
  tgUser = client;
  return me;
}

// ── Yangi CardXabar xabarlarini tekshirish (polling) ──
async function poll() {
  if (!tgUser) return;
  try {
    const msgs = await tgUser.getMessages('CardXabarBot', { limit: 5 });
    // eng eski→yangi tartibda, faqat yangi id
    const fresh = msgs.filter(m => m.id > lastMsgId).sort((a, b) => a.id - b.id);
    for (const m of fresh) {
      lastMsgId = Math.max(lastMsgId, m.id);
      const tx = parseCardMsg(m.message || '');
      if (tx) await askClassify(tx);
    }
  } catch (e) {
    console.error('card poll error:', e.message);
    // sessiya uzilsa qayta ulanish
    if (/disconnect|not connected|CONNECTION/i.test(e.message)) {
      try { await connect(); } catch (_) {}
    }
  }
}

// ── Ishga tushirish ──
async function start(dependencies, cfg) {
  deps = dependencies;
  cardCfg = cfg;
  try {
    const me = await connect();
    // boshlang'ich lastMsgId — hozirgi oxirgi xabar (eski tranzaksiyalarni qayta so'ramaslik uchun)
    const last = await tgUser.getMessages('CardXabarBot', { limit: 1 });
    if (last && last.length) lastMsgId = last[0].id;
    setInterval(poll, 30000); // har 30 soniya
    await deps.msg(deps.ADMIN, `💳 Karta monitoringi yoqildi (${me.firstName || ''}).\nEndi har karta operatsiyasi kelganda so'rayman.`);
    console.log('card-monitor: started, lastMsgId=', lastMsgId);
    return true;
  } catch (e) {
    console.error('card-monitor start error:', e.message);
    try { await deps.msg(deps.ADMIN, `⚠️ Karta monitoringi ulanmadi: ${e.message}`); } catch (_) {}
    return false;
  }
}

module.exports = { start, handleCallback, tryTakeNote, cardPending };
