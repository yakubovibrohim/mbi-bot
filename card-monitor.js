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
let resolved = [];        // yakunlangan tranzaksiyalar: {date, dir, amt} — kunlik solishtiruv uchun
let lastBalances = {};    // karta oxirgi 4 raqami -> CardXabar'dagi oxirgi balans
let lastReconcileDate = ''; // kunlik solishtiruv qaysi kunda bajarilgani
let tgUser = null;
let cardCfg = null;      // { session, api_id, api_hash }
let deps = null;         // { ADMIN, msg, btn, api, ghReadAll, ghWrite, ghRead, ghPut, todayStr, fmtUzs, USD_UZS }

function shortId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

// Barcha xabarlar guruhga (MBI AI Office); guruh sozlanmagan bo'lsa — adminga zaxira
function target() { return (deps.getOfficeChat && deps.getOfficeChat()) || deps.ADMIN; }

// Tranzaksiya yakunlandi (saqlandi/skip/self) — kunlik solishtiruv ro'yxatiga
function markResolved(p) {
  resolved.push({ date: p.date, dir: p.dir, amt: p.amtUzs });
  // faqat oxirgi 14 kunlik yozuvlar saqlanadi
  if (resolved.length > 400) resolved = resolved.slice(-400);
}

// ── Pending'ni restartga chidamli saqlash (card-pending.json) ──
async function persist() {
  try {
    const { sha } = await deps.ghRead('card-pending.json');
    await deps.ghPut('card-pending.json', JSON.stringify({ lastMsgId, pending: cardPending, resolved, lastBalances, lastReconcileDate }, null, 2), sha, 'card pending');
  } catch (e) { console.error('card persist:', e.message); }
}
async function restorePending() {
  try {
    const { data } = await deps.ghRead('card-pending.json');
    if (data && !Array.isArray(data)) {
      if (data.lastMsgId) lastMsgId = data.lastMsgId;
      if (data.pending) Object.assign(cardPending, data.pending);
      if (Array.isArray(data.resolved)) resolved = data.resolved;
      if (data.lastBalances) lastBalances = data.lastBalances;
      if (data.lastReconcileDate) lastReconcileDate = data.lastReconcileDate;
    }
  } catch (e) {}
  // javobsiz qolgan so'rovlarni qayta yuborish
  for (const [id, p] of Object.entries(cardPending)) {
    try {
      if (p.step === 'note') { await askNote(id, p.kind, target()); }
      else { await reAsk(id); }
    } catch (e) {}
  }
}
async function reAsk(id) {
  const p = cardPending[id]; if (!p) return;
  await sendClassify(id, p);
}

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
  // karta (💳 ***5893)
  const cardM = text.match(/💳\s*\*+(\d{2,4})/);
  const card4 = cardM ? cardM[1] : '0';
  return { dir: isOut ? 'out' : 'in', amtUzs, place, rawBalance, date, title: firstLine, card4 };
}

// ── Tranzaksiya kelganda admin'ga tugmali savol ──
async function askClassify(tx) {
  const id = shortId();
  cardPending[id] = { ...tx, step: 'type', askedAt: Date.now() };
  await persist();
  await sendClassify(id, cardPending[id]);
}
async function sendClassify(id, tx) {
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
  await deps.btn(target(), head, kb);
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
      markResolved(p);
      delete cardPending[id]; await persist();
      await deps.msg(chatId, '⏭ Hisobga olinmadi.');
      return true;
    }
    if (type === 'self') {
      markResolved(p);
      delete cardPending[id]; await persist();
      await deps.msg(chatId, '💵 O\'z pulingizni kartaga tushirdingiz — bu ichki ko\'chirish, kassa jami o\'zgarmaydi (yozilmadi).');
      return true;
    }
    if (type === 'pers') { await askNote(id, 'personal', chatId); return true; }
    if (type === 'office') { await askNote(id, 'office', chatId); return true; }
    if (type === 'other') { await saveCardIncome(id, 'other'); return true; }

    if (type === 'deal') { // buyurtma → mijozlar ro'yxati
      p.subType = 'deal';
      const deals = (await deps.ghReadAll('deals-log.json')).filter(o => o.status === 'active');
      if (!deals.length) { await deps.msg(chatId, '⚠️ Faol buyurtma yo\'q.'); delete cardPending[id]; await persist(); return true; }
      const kb = deals.map(o => [{ text: o.client, callback_data: `cm_d_${id}_${o.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Qaysi buyurtma xarajati?', kb);
      return true;
    }
    if (type === 'client') { // mijoz to'lovi → faol buyurtmalar
      p.subType = 'client';
      const deals = (await deps.ghReadAll('deals-log.json')).filter(o => o.status === 'active');
      if (!deals.length) { await deps.msg(chatId, '⚠️ Faol buyurtma yo\'q.'); delete cardPending[id]; await persist(); return true; }
      const kb = deals.map(o => [{ text: o.client, callback_data: `cm_d_${id}_${o.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Qaysi mijoz to\'lovi?', kb);
      return true;
    }
    if (type === 'debtin') { // qarzdor to'lovi → in-qarzlar
      const debts = (await deps.ghReadAll('debts-log.json')).filter(d => d.dir === 'in' && (d.amount_uzs || 0) - (d.paid_uzs || 0) > 0);
      if (!debts.length) { await deps.msg(chatId, '⚠️ Ochiq qarzdor yo\'q.'); delete cardPending[id]; await persist(); return true; }
      const kb = debts.map(d => [{ text: `${d.name} (qoldi ${deps.fmtUzs((d.amount_uzs || 0) - (d.paid_uzs || 0))})`, callback_data: `cm_din_${id}_${d.id}` }]);
      kb.push([{ text: '↩️ Bekor', callback_data: `cm_t_${id}_skip` }]);
      await deps.btn(chatId, 'Kim qarzini to\'ladi?', kb);
      return true;
    }
    if (type === 'debtout') { // men to'lagan qarz → out-qarzlar
      const debts = (await deps.ghReadAll('debts-log.json')).filter(d => d.dir === 'out' && (d.amount_uzs || 0) - (d.paid_uzs || 0) > 0);
      if (!debts.length) { await deps.msg(chatId, '⚠️ Ochiq qarz yo\'q.'); delete cardPending[id]; await persist(); return true; }
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
  await persist();
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
    ? { id: shortId(), date: p.date, ts: new Date().toISOString(), name: note, amount_uzs: p.amtUzs, rate: deps.USD_UZS, note: p.place || 'karta', pay_method: 'card' }
    : { date: p.date, note, amount_uzs: p.amtUzs, rate: deps.USD_UZS, type: 'personal', pay_method: 'card', place: p.place || '', ts: new Date().toISOString() };
  await deps.ghWrite(file, entry, `card expense: ${note} ${p.amtUzs}`);
  markResolved(p);
  delete cardPending[id]; await persist();
  await deps.msg(target(), `✅ ${kind === 'office' ? '🏭 Ishxona' : '👛 Shaxsiy'} chiqim yozildi: ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)\n📝 ${note.replace('💳 ', '')}`);
}

async function saveCardIncome(id) {
  const p = cardPending[id]; if (!p) return;
  // "boshqa kirim" — buyurtma bilan bog'lanmagan umumiy kirim: personal log'ga manfiy chiqim EMAS,
  // buni alohida income-log'ga yozamiz
  const entry = { id: shortId(), date: p.date, name: `💳 ${p.place || p.title || 'boshqa kirim'}`, amount_uzs: p.amtUzs, rate: deps.USD_UZS, note: 'karta', pay_method: 'card', ts: new Date().toISOString() };
  await deps.ghWrite('card-income-log.json', entry, `card income: ${p.amtUzs}`);
  markResolved(p);
  delete cardPending[id]; await persist();
  await deps.msg(target(), `✅ ➕ Boshqa kirim yozildi: ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDealExpense(id, dealId) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('deals-log.json');
  const o = data.find(x => x.id === dealId);
  if (!o) { await deps.msg(target(), '⚠️ Buyurtma topilmadi.'); delete cardPending[id]; await persist(); return; }
  if (!Array.isArray(o.expenses)) o.expenses = [];
  o.expenses.push({ date: p.date, ts: new Date().toISOString(), name: `💳 ${p.place || p.title || 'karta'}`, total_uzs: p.amtUzs, rate: deps.USD_UZS, pay_method: 'card' });
  await deps.ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, `card deal-expense: ${o.client} ${p.amtUzs}`);
  markResolved(p);
  delete cardPending[id]; await persist();
  await deps.msg(target(), `✅ 📦 Buyurtma xarajati (${o.client}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDealPayment(id, dealId) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('deals-log.json');
  const o = data.find(x => x.id === dealId);
  if (!o) { await deps.msg(target(), '⚠️ Buyurtma topilmadi.'); delete cardPending[id]; await persist(); return; }
  if (!Array.isArray(o.payments)) o.payments = [];
  o.payments.push({ date: p.date, ts: new Date().toISOString(), amount_uzs: p.amtUzs, note: '💳 karta', pay_method: 'card' });
  await deps.ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, `card deal-payment: ${o.client} ${p.amtUzs}`);
  markResolved(p);
  delete cardPending[id]; await persist();
  await deps.msg(target(), `✅ 📦 Mijoz to'lovi (${o.client}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)`);
  await checkBalance(p);
}

async function saveDebtPayment(id, debtId, dir) {
  const p = cardPending[id]; if (!p) return;
  const { data, sha } = await deps.ghRead('debts-log.json');
  const d = data.find(x => x.id === debtId);
  if (!d) { await deps.msg(target(), '⚠️ Qarz topilmadi.'); delete cardPending[id]; await persist(); return; }
  d.paid_uzs = (d.paid_uzs || 0) + p.amtUzs;
  if (!Array.isArray(d.payments)) d.payments = [];
  d.payments.push({ date: p.date, ts: new Date().toISOString(), amount_uzs: p.amtUzs, pay_method: 'card' });
  d.pay_date = p.date;
  await deps.ghPut('debts-log.json', JSON.stringify(data, null, 2), sha, `card debt-${dir}: ${d.name} ${p.amtUzs}`);
  delete cardPending[id]; await persist();
  const remain = (d.amount_uzs || 0) - d.paid_uzs;
  await deps.msg(target(), `✅ ${dir === 'in' ? '📥 Qarzdor to\'lovi' : '🔴 Qarz to\'lovi'} (${d.name}): ${deps.fmtUzs(p.amtUzs)} so'm (💳 karta)\nQolgan qarz: ${deps.fmtUzs(remain > 0 ? remain : 0)} so'm`);
  await checkBalance(p);
}

// ── Balans nazorati: CardXabar balansi sakragan bo'lsa — orada tranzaksiya yo'qolgan ──
async function checkBalanceJump(tx) {
  if (tx.rawBalance == null) return;
  const key = tx.card4 || '0';
  const prev = lastBalances[key];
  if (prev != null) {
    const expected = prev + (tx.dir === 'in' ? tx.amtUzs : -tx.amtUzs);
    const diff = tx.rawBalance - expected;
    if (Math.abs(diff) > 100) {
      try {
        await deps.msg(target(), `⚠️ *Karta balansi nazorati* (***${key})\nKutilgan: ${deps.fmtUzs(expected)} so'm\nCardXabar: ${deps.fmtUzs(tx.rawBalance)} so'm\nFarq: ${diff > 0 ? '+' : ''}${deps.fmtUzs(diff)} so'm\n\n_Orada hisobga tushmagan harakat bo'lgan ko'rinadi (SMS kelmagan tranzaksiya, komissiya yoki bot o'chiq paytdagi o'tkazma)._`);
      } catch (e) {}
    }
  }
  lastBalances[key] = tx.rawBalance;
  await persist();
}
// eski nom bilan chaqiruvlar uchun (save* ichida) — endi hech narsa qilmaydi
async function checkBalance(p) {}

// ── Javobsiz so'rovlarni har 2 soatda eslatish ──
async function remindStalePending() {
  const now = Date.now();
  const TWO_H = 2 * 60 * 60 * 1000;
  for (const [id, p] of Object.entries(cardPending)) {
    const base = p.remindedAt || p.askedAt || 0;
    if (!base || now - base < TWO_H) continue;
    p.remindedAt = now;
    try {
      await deps.msg(target(), `⏰ *Eslatma:* quyidagi karta tranzaksiyasi hali tasniflanmagan:`);
      if (p.step === 'note') await askNote(id, p.kind, target());
      else await sendClassify(id, p);
    } catch (e) {}
    await persist();
  }
}

// ── Kunlik solishtiruv (21:00 Toshkent): CardXabar vs loglar ──
function tashkentHHMM() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}
async function maybeDailyReconcile() {
  const today = deps.todayStr();
  if (lastReconcileDate === today) return;
  const hm = tashkentHHMM();
  if (hm < '21:00') return;
  lastReconcileDate = today;
  await persist();
  await dailyReconcile(today);
}
async function dailyReconcile(today) {
  if (!tgUser) return;
  try {
    const msgs = await tgUser.getMessages('CardXabarBot', { limit: 100 });
    const txs = [];
    for (const m of msgs) {
      const tx = parseCardMsg(m.message || '');
      if (tx && tx.date === today) txs.push(tx);
    }
    if (!txs.length) return;
    // yakunlanganlar va hali pending turganlar — qoplangan hisoblanadi
    const pool = resolved.filter(r => r.date === today).map(r => `${r.dir}:${r.amt}`);
    const pendPool = Object.values(cardPending).filter(p => p.date === today).map(p => `${p.dir}:${p.amtUzs}`);
    const missing = [];
    for (const tx of txs) {
      const k = `${tx.dir}:${tx.amtUzs}`;
      let i = pool.indexOf(k);
      if (i >= 0) { pool.splice(i, 1); continue; }
      i = pendPool.indexOf(k);
      if (i >= 0) { pendPool.splice(i, 1); continue; }
      missing.push(tx);
    }
    if (!missing.length) {
      await deps.msg(target(), `✅ *Kunlik karta solishtiruvi (${today}):* barcha ${txs.length} ta tranzaksiya hisobga olingan.`);
      return;
    }
    await deps.msg(target(), `⚠️ *Kunlik karta solishtiruvi (${today}):* ${missing.length} ta tranzaksiya hisobga olinmagan! Har birini tasniflang:`);
    for (const tx of missing) await askClassify(tx);
  } catch (e) { console.error('dailyReconcile:', e.message); }
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
    const msgs = await tgUser.getMessages('CardXabarBot', { limit: 20 });
    // eng eski→yangi tartibda, faqat yangi id
    const fresh = msgs.filter(m => m.id > lastMsgId).sort((a, b) => a.id - b.id);
    for (const m of fresh) {
      lastMsgId = Math.max(lastMsgId, m.id);
      const tx = parseCardMsg(m.message || '');
      if (tx) { await checkBalanceJump(tx); await askClassify(tx); }
    }
    await remindStalePending();
    await maybeDailyReconcile();
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
    await restorePending(); // saqlangan pending + lastMsgId tiklanadi
    if (!lastMsgId) {
      // birinchi ishga tushish: hozirgi oxirgi xabardan boshlaymiz
      const last = await tgUser.getMessages('CardXabarBot', { limit: 1 });
      if (last && last.length) lastMsgId = last[0].id;
      await persist();
    }
    setInterval(poll, 30000); // har 30 soniya
    console.log('card-monitor: started, lastMsgId=', lastMsgId, 'user:', me.firstName || '');
    return true;
  } catch (e) {
    console.error('card-monitor start error:', e.message);
    try { await deps.msg(deps.ADMIN, `⚠️ Karta monitoringi ulanmadi: ${e.message}`); } catch (_) {}
    return false;
  }
}

module.exports = { start, handleCallback, tryTakeNote, cardPending };
