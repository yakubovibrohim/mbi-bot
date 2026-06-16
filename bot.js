const https = require('https');
const http = require('http');
const FormData = require('form-data');

let BOT = process.env.BOT_TOKEN || '';  // secrets'dan yuklanadi
const ADMIN    = '1487569442';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = 'yakubovibrohim/mbi-bot';
const TZ       = 'Asia/Tashkent';

const state = {};
const phoneToChat = {};
const invoiceState = {};
const orderState = {};   // qadama-qadam yangi buyurtma kiritish
const officePending = {}; // guruhda tasdiq kutayotgan amallar (davomat/avans)
const USD_UZS = 12000;   // 1 USD = 12000 so'm

// ─── Time helpers ─────────────────────────────────────────────
function nowTZ() { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })); }
function todayStr() { return nowTZ().toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function nowHHMM() { const d = nowTZ(); return ('0'+d.getHours()).slice(-2) + ':' + ('0'+d.getMinutes()).slice(-2); }

// ─── Telegram helpers ─────────────────────────────────────────
function api(method, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT + '/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}
function msg(c, t) { return api('sendMessage', { chat_id: c, text: t, parse_mode: 'Markdown' }); }
function btn(c, t, b) { return api('sendMessage', { chat_id: c, text: t, reply_markup: { inline_keyboard: b } }); }
function fwd(c, f, m) { return api('forwardMessage', { chat_id: c, from_chat_id: f, message_id: m }); }
function acb(i) { return api('answerCallbackQuery', { callback_query_id: i }); }
function anketa(c, l) {
  const uz = 'Buyurtma berish uchun anketani toldiring:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html\n\nAnketani toldirgach ustamiz siz bilan boglanadi!';
  const ru = 'Dlya zakaza zapolnite anketu:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html\n\nMaster svyazhetsya s vami!';
  return msg(c, l === 'uz' ? uz : ru);
}

// ─── GitHub helpers ───────────────────────────────────────────
function ghGet(path) {
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/' + GH_REPO + '/contents/' + path, method: 'GET',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Accept': 'application/vnd.github.v3+json' }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
}
function ghPut(path, content, sha, commitMsg) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ message: commitMsg, content: Buffer.from(content).toString('base64'), sha: sha });
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/' + GH_REPO + '/contents/' + path, method: 'PUT',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}
async function ghRead(file) {
  try {
    const d = await ghGet(file);
    return { data: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')), sha: d.sha };
  } catch (e) { return { data: [], sha: null }; }
}
async function ghWrite(file, newEntry, label) {
  try {
    const { data, sha } = await ghRead(file);
    data.push(newEntry);
    if (data.length > 500) data.splice(0, data.length - 500);
    await ghPut(file, JSON.stringify(data, null, 2), sha, label || 'update');
    return true;
  } catch (e) { console.error('ghWrite error:', e.message); return false; }
}
async function ghReadAll(file) {
  const { data } = await ghRead(file);
  return data;
}

// ─── Eski yozuvlarni yangi formatga moslash (migration) ──────
// Eski deal'larda id/payments/expenses/status bo'lmasligi mumkin.
// Buzmasdan, faqat yetishmayotgan maydonlarni to'ldiramiz.
function migrateDeal(o) {
  let changed = false;
  if (!o.id) { o.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); changed = true; }
  if (!o.status) { o.status = 'active'; changed = true; }
  if (!Array.isArray(o.payments)) {
    o.payments = [];
    // eski advance_uzs ni birinchi to'lov sifatida ko'chiramiz
    if (o.advance_uzs && o.advance_uzs > 0) {
      o.payments.push({ id: Date.now().toString(36) + 'a', date: o.date || '', amount_uzs: o.advance_uzs, rate: o.rate || 12000, note: 'Avans (eski)' });
    }
    changed = true;
  }
  if (!Array.isArray(o.expenses)) { o.expenses = []; changed = true; }
  if (!Array.isArray(o.types)) { o.types = o.types ? [o.types] : []; changed = true; }
  if (o.finished_date === undefined) { o.finished_date = null; changed = true; }
  if (o.cancelled_date === undefined) { o.cancelled_date = null; changed = true; }
  return changed;
}
// Barcha deal'larni o'qib, kerak bo'lsa migratsiya qilib, qaytaradi
async function readDealsMigrated() {
  const { data, sha } = await ghRead('deals-log.json');
  let anyChanged = false;
  for (const o of data) { if (migrateDeal(o)) anyChanged = true; }
  if (anyChanged) {
    try { await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'migrate: eski yozuvlarni yangilash'); } catch (e) { console.error('migrate save:', e.message); }
    return (await ghRead('deals-log.json'));
  }
  return { data, sha };
}

// ══════════════════════════════════════════════════════════════
// 1-BOSQICH: Yangi buyurtma oqimi + mijoz bo'limi
// ══════════════════════════════════════════════════════════════
const fmtUzs = n => Math.round(n || 0).toLocaleString('ru-RU');
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// "45$" yoki "540000" → so'm. $ bo'lsa kurs bilan o'tkazadi.
function parseMoneyToUzs(txt) {
  const hasUsd = /\$|dollar|dol\b/i.test(txt);
  const n = parseFloat(String(txt).replace(/[^\d.,]/g, '').replace(/,/g, '.'));
  if (isNaN(n) || n < 0) return null;
  return hasUsd ? Math.round(n * USD_UZS) : Math.round(n);
}

// Ish kuni qo'shish: bugundan boshlab N ta ish kuni (yakshanba o'tkaziladi)
function addWorkdays(startDate, workdays) {
  const d = new Date(startDate);
  let added = 0;
  while (added < workdays) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) added++; // 0 = yakshanba
  }
  return d;
}
// Ikki sana orasidagi ish kunlari soni (yakshanbasiz)
function workdaysBetween(from, to) {
  const a = new Date(from), b = new Date(to);
  if (b < a) return 0;
  let cnt = 0;
  const d = new Date(a);
  while (d < b) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0) cnt++; }
  return cnt;
}
function fmtDate(d) {
  return ('0' + d.getDate()).slice(-2) + '.' + ('0' + (d.getMonth() + 1)).slice(-2) + '.' + d.getFullYear();
}

const ORDER_STAGES = ['Yangi buyurtma', "O'lchov olindi", 'Ishlab chiqarilmoqda', 'Yetkazildi', 'To\'landi'];

function orderPrompt(step) {
  switch (step) {
    case 'client':   return '👤 *Mijoz ismini* yozing:';
    case 'phone':    return '📞 *Telefon raqami* (majburiy):';
    case 'types':    return '🪚 *Buyurtma turini* yozing:\n\n_Masalan: Oshxona mebeli_';
    case 'amount':   return '💵 *Shartnoma summasi* (dollarda):\n\n_Masalan: 800_';
    case 'advance':  return '💰 *Avans* (dollarda):\n\n_Avans yo\'q bo\'lsa «O\'tkazib yuborish»_';
    case 'address':  return '📍 *Manzil* (o\'lchov/yetkazish joyi):';
    case 'deadline': return '📅 *Topshirish muddati* (necha kun):\n\n_Faqat ish kunlari sanaladi (yakshanbasiz). Masalan: 30_';
    case 'note':     return '📝 *Izoh* (material va h.k.):';
  }
}
function orderNav(step, withSkip) {
  const rows = [];
  if (withSkip) rows.push([{ text: "⏭ O'tkazib yuborish", callback_data: 'ord_skip' }]);
  const nav = [];
  if (step !== 'client') nav.push({ text: '◀️ Ortga', callback_data: 'ord_back' });
  nav.push({ text: '❌ Bekor qilish', callback_data: 'ord_cancel' });
  rows.push(nav);
  return rows;
}

async function orderStart(c) {
  orderState[c] = { step: 'client', data: { types: [] } };
  await btn(c, '🆕 *Yangi buyurtma*\n\nQadama-qadam to\'ldiramiz. Adashsangiz «Ortga» bosing.\n\n' + orderPrompt('client'), orderNav('client', false));
}

// Buyurtma turi bosqichida — "Yana +" / "Davom etamiz" tugmalari
async function orderTypesMenu(c) {
  const st = orderState[c];
  const list = st.data.types.length ? st.data.types.join(', ') : '_(hali yo\'q)_';
  await btn(c, `🪚 *Buyurtma turlari:* ${list}\n\nYana qo\'shasizmi yoki davom etamizmi?`, [
    [{ text: '➕ Yana +', callback_data: 'ord_type_more' }, { text: '✅ Davom etamiz', callback_data: 'ord_type_done' }],
    [{ text: '◀️ Ortga', callback_data: 'ord_back' }, { text: '❌ Bekor qilish', callback_data: 'ord_cancel' }]
  ]);
}

async function orderAsk(c) {
  const st = orderState[c];
  const withSkip = ['advance', 'address', 'deadline', 'note'].includes(st.step);
  await btn(c, orderPrompt(st.step), orderNav(st.step, withSkip));
}

function orderSummary(d) {
  const amtUzs = (d.amount_usd || 0) * USD_UZS;
  const advUzs = (d.advance_usd || 0) * USD_UZS;
  const debtUzs = amtUzs - advUzs;
  let dl = '-';
  if (d.deadline_days) dl = `${d.deadline_days} ish kuni → *${d.deadline_date}*`;
  const text = `📋 *Tekshiring:*\n\n` +
    `👤 Mijoz: *${d.client}*\n` +
    `📞 Tel: ${d.phone}\n` +
    `🪚 Turi: ${d.types.join(', ')}\n` +
    `💵 Shartnoma: *$${d.amount_usd}* (${fmtUzs(amtUzs)} so'm)\n` +
    `💰 Avans: *$${d.advance_usd || 0}* (${fmtUzs(advUzs)} so'm)\n` +
    `📉 Qolgan qarz: *${fmtUzs(debtUzs)} so'm* ($${(d.amount_usd || 0) - (d.advance_usd || 0)})\n` +
    `📍 Manzil: ${d.address || '-'}\n` +
    `📅 Muddat: ${dl}\n` +
    `📝 Izoh: ${d.note || '-'}`;
  return { text, amtUzs, advUzs, debtUzs };
}

async function orderConfirm(c) {
  const st = orderState[c];
  st.step = 'confirm';
  await btn(c, orderSummary(st.data).text, [
    [{ text: '✅ Saqlash', callback_data: 'ord_save' }],
    [{ text: '◀️ Ortga', callback_data: 'ord_back' }, { text: '❌ Bekor qilish', callback_data: 'ord_cancel' }]
  ]);
}

async function orderSave(c) {
  const d = orderState[c].data;
  const s = orderSummary(d);
  const today = todayStr();
  const advUsd = d.advance_usd || 0;
  const entry = {
    id: uid(),
    date: today,
    ts: new Date().toISOString(),
    client: d.client,
    phone: d.phone,
    types: d.types,
    contract_sum_usd: d.amount_usd || 0,
    contract_sum_uzs: s.amtUzs,
    rate: USD_UZS,
    address: d.address || '',
    deadline_days: d.deadline_days || null,
    deadline_date: d.deadline_date || null,
    note: d.note || '',
    stage: 'Yangi buyurtma',
    status: 'active',            // active | done | cancelled
    payments: advUsd > 0 ? [{ id: uid(), date: today, amount_uzs: advUsd * USD_UZS, rate: USD_UZS, note: 'Avans' }] : [],
    expenses: [],                // {id,date,products:[{name,qty,price_uzs,rate}],total_uzs,note,source}
    finished_date: null,
    cancelled_date: null,
    cancel_reason: ''
  };
  const ok = await ghWrite('deals-log.json', entry, `order: ${d.client} $${d.amount_usd}`);
  delete orderState[c];
  if (ok) {
    await msg(c, `✅ *Buyurtma saqlandi!*\n\n👤 ${d.client}\n💵 $${d.amount_usd}\n📉 Qarz: ${fmtUzs(s.debtUzs)} so'm\n📅 ${d.deadline_date || '-'}\n\n📁 Ko'rish: bosh menyu → Buyurtmalar`);
  } else {
    await msg(c, '⚠️ Saqlashda xatolik. Qayta urinib ko\'ring.');
  }
}

// Matn javobi → bosqich. true = oqim davom etdi
async function orderHandleText(c, t) {
  const st = orderState[c];
  if (!st) return false;
  const txt = (t || '').trim();
  if (!txt) return false;

  switch (st.step) {
    case 'client':
      st.data.client = txt; st.step = 'phone'; await orderAsk(c); return true;
    case 'phone':
      st.data.phone = txt; st.step = 'types'; await orderAsk(c); return true;
    case 'types': {
      st.data.types.push(txt);
      st.step = 'types_menu'; await orderTypesMenu(c); return true;
    }
    case 'types_menu':
      // bu bosqichda matn kelsa, yana tur sifatida qo'sh
      st.data.types.push(txt); await orderTypesMenu(c); return true;
    case 'amount': {
      const n = parseFloat(txt.replace(/[^\d.]/g, ''));
      if (isNaN(n) || n <= 0) { await msg(c, '❗️ Faqat raqam yozing. Masalan: 800'); return true; }
      st.data.amount_usd = n; st.step = 'advance'; await orderAsk(c); return true;
    }
    case 'advance': {
      const n = parseFloat(txt.replace(/[^\d.]/g, ''));
      if (isNaN(n) || n < 0) { await msg(c, '❗️ Faqat raqam yozing yoki «O\'tkazib yuborish».'); return true; }
      if (n > st.data.amount_usd) { await msg(c, `❗️ Avans shartnomadan ($${st.data.amount_usd}) ko'p bo'lmasin.`); return true; }
      st.data.advance_usd = n; st.step = 'address'; await orderAsk(c); return true;
    }
    case 'address':
      st.data.address = txt; st.step = 'deadline'; await orderAsk(c); return true;
    case 'deadline': {
      const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
      if (isNaN(n) || n <= 0) { await msg(c, '❗️ Necha kun? Faqat raqam yozing. Masalan: 30'); return true; }
      st.data.deadline_days = n;
      st.data.deadline_date = fmtDate(addWorkdays(nowTZ(), n));
      st.step = 'note';
      await msg(c, `✅ ${n} ish kuni → *${st.data.deadline_date}*\n_(yakshanbalar o'tkazildi)_`);
      await orderAsk(c); return true;
    }
    case 'note':
      st.data.note = (txt === '-') ? '' : txt; await orderConfirm(c); return true;
  }
  return false;
}

const ORDER_SEQ = ['client', 'phone', 'types', 'types_menu', 'amount', 'advance', 'address', 'deadline', 'note', 'confirm'];

async function orderHandleCallback(c, data) {
  const st = orderState[c];
  if (!st) return false;
  if (data === 'ord_cancel') { delete orderState[c]; await msg(c, '❌ Bekor qilindi.'); return true; }

  if (data === 'ord_type_more') { st.step = 'types'; await orderAsk(c); return true; }
  if (data === 'ord_type_done') {
    if (!st.data.types.length) { await msg(c, '❗️ Kamida bitta mebel turini yozing.'); await orderTypesMenu(c); return true; }
    st.step = 'amount'; await orderAsk(c); return true;
  }
  if (data === 'ord_skip') {
    if (st.step === 'advance') { st.data.advance_usd = 0; st.step = 'address'; await orderAsk(c); }
    else if (st.step === 'address') { st.data.address = ''; st.step = 'deadline'; await orderAsk(c); }
    else if (st.step === 'deadline') { st.data.deadline_days = null; st.data.deadline_date = null; st.step = 'note'; await orderAsk(c); }
    else if (st.step === 'note') { st.data.note = ''; await orderConfirm(c); }
    return true;
  }
  if (data === 'ord_back') {
    const idx = ORDER_SEQ.indexOf(st.step);
    if (idx <= 0) { delete orderState[c]; await msg(c, '❌ Bekor qilindi.'); return true; }
    let prev = ORDER_SEQ[idx - 1];
    // types_menu ga qaytsa, oxirgi turni olib tashlaymiz (qayta yozish uchun emas, menyuni ko'rsatamiz)
    st.step = prev;
    if (prev === 'types_menu') { await orderTypesMenu(c); }
    else if (prev === 'confirm') { await orderConfirm(c); }
    else await orderAsk(c);
    return true;
  }
  if (data === 'ord_save') { await orderSave(c); return true; }
  return false;
}

// ─── BUYURTMALAR BO'LIMI (faol/tugatilgan/bekor) ──────────────
function dealDebtUzs(o) {
  const paid = (o.payments || []).reduce((s, p) => s + (p.amount_uzs || 0), 0);
  return (o.contract_sum_uzs || 0) - paid;
}
function dealExpUzs(o) {
  return (o.expenses || []).reduce((s, e) => s + (e.total_uzs || 0), 0);
}
function dealPaidUzs(o) {
  return (o.payments || []).reduce((s, p) => s + (p.amount_uzs || 0), 0);
}

async function showOrdersList(c, status) {
  const { data: deals } = await readDealsMigrated();
  const filtered = deals.filter(o => (o.status || 'active') === status);
  const titleMap = { active: '📁 Faol buyurtmalar', done: '✅ Tugatilgan buyurtmalar', cancelled: '🚫 Bekor qilinganlar' };
  if (!filtered.length) { await msg(c, `${titleMap[status]}\n\n_Hozircha yo'q._`); return; }
  const rows = filtered.map(o => {
    let extra = '';
    if (status === 'active' && o.deadline_date) {
      const left = workdaysBetween(nowTZ(), parseDmy(o.deadline_date));
      extra = ` (${left} kun)`;
    }
    return [{ text: `👤 ${o.client}${extra}`, callback_data: 'ord_open_' + o.id }];
  });
  await btn(c, titleMap[status] + ' — mijozni tanlang:', rows);
}

function parseDmy(s) {
  const m = String(s).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return nowTZ();
  return new Date(+m[3], +m[2] - 1, +m[1]);
}

async function findDeal(id) {
  let { data, sha } = await ghRead('deals-log.json');
  let anyChanged = false;
  for (const o of data) { if (migrateDeal(o)) anyChanged = true; }
  if (anyChanged) {
    try { const r = await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'migrate'); if (r && r.content && r.content.sha) sha = r.content.sha; } catch (e) { console.error('findDeal migrate:', e.message); }
  }
  const idx = data.findIndex(o => o.id === id);
  return { data, sha, idx, deal: idx >= 0 ? data[idx] : null };
}

async function showClientMenu(c, id) {
  const { deal } = await findDeal(id);
  if (!deal) { await msg(c, '⚠️ Buyurtma topilmadi.'); return; }
  let head = `👤 *${deal.client}*\n📞 ${deal.phone || '-'}`;
  if ((deal.status || 'active') === 'active' && deal.deadline_date) {
    const left = workdaysBetween(nowTZ(), parseDmy(deal.deadline_date));
    head += left >= 0 ? `\n📅 Topshirishga *${left} kun* qoldi ⏳` : `\n⚠️ Muddat o'tdi`;
  }
  if ((deal.status) === 'done') head += `\n✅ Tugatilgan: ${deal.finished_date}`;
  if ((deal.status) === 'cancelled') head += `\n🚫 Bekor: ${deal.cancelled_date}`;
  const rows = [
    [{ text: '📊 Hisobot', callback_data: 'cl_report_' + id }, { text: '💸 Xarajatlar', callback_data: 'cl_exp_' + id }],
    [{ text: '💰 To\'lovlar', callback_data: 'cl_pay_' + id }, { text: '👤 Ma\'lumotlar', callback_data: 'cl_info_' + id }],
    [{ text: '📊 Holat: ' + (deal.stage || '-'), callback_data: 'cl_stage_' + id }]
  ];
  if ((deal.status || 'active') === 'active') {
    rows.push([{ text: '🏁 Yakunlash', callback_data: 'cl_finish_' + id }, { text: '🚫 Bekor qilish', callback_data: 'cl_cancel_' + id }]);
  }
  rows.push([{ text: '◀️ Ortga', callback_data: 'cl_back_' + ((deal.status) || 'active') }]);
  await btn(c, head + '\n\nBo\'limni tanlang:', rows);
}

async function showClientReport(c, id) {
  const { deal } = await findDeal(id);
  if (!deal) { await msg(c, '⚠️ Topilmadi.'); return; }
  const contract = deal.contract_sum_uzs || 0;
  const paid = dealPaidUzs(deal);
  const exp = dealExpUzs(deal);
  const debt = contract - paid;
  const profit = contract - exp;
  await btn(c, `📊 *${deal.client} — hisobot*\n\n` +
    `💵 Shartnoma: ${fmtUzs(contract)} so'm\n` +
    `💰 To'langan: ${fmtUzs(paid)} so'm\n` +
    `📉 Qolgan qarz: *${fmtUzs(debt)} so'm*\n` +
    `💸 Xarajat: ${fmtUzs(exp)} so'm\n` +
    `📈 Sof foyda: *${fmtUzs(profit)} so'm*`,
    [[{ text: '◀️ Ortga', callback_data: 'ord_open_' + id }]]);
}

async function showClientInfo(c, id) {
  const { deal } = await findDeal(id);
  if (!deal) { await msg(c, '⚠️ Topilmadi.'); return; }
  await btn(c, `👤 *${deal.client}*\n\n` +
    `📞 ${deal.phone || '-'}\n` +
    `🪚 ${(deal.types || []).join(', ') || '-'}\n` +
    `💵 $${deal.contract_sum_usd} (${fmtUzs(deal.contract_sum_uzs)} so'm)\n` +
    `📍 ${deal.address || '-'}\n` +
    `📅 ${deal.deadline_date || '-'}${deal.deadline_days ? ' (' + deal.deadline_days + ' ish kuni)' : ''}\n` +
    `🗓 Olingan: ${deal.date}\n` +
    `📝 ${deal.note || '-'}`,
    [[{ text: '◀️ Ortga', callback_data: 'ord_open_' + id }]]);
}

async function showClientPayments(c, id) {
  const { deal } = await findDeal(id);
  if (!deal) { await msg(c, '⚠️ Topilmadi.'); return; }
  const lines = (deal.payments || []).map(p => `• ${p.date} — ${fmtUzs(p.amount_uzs)} so'm${p.note ? ' (' + p.note + ')' : ''}`).join('\n') || '_(hali yo\'q)_';
  const debt = dealDebtUzs(deal);
  await btn(c, `💰 *${deal.client} — to'lovlar*\n\n${lines}\n\n📉 Qolgan qarz: *${fmtUzs(debt)} so'm*`,
    [[{ text: '➕ To\'lov qo\'shish', callback_data: 'pay_add_' + id }], [{ text: '◀️ Ortga', callback_data: 'ord_open_' + id }]]);
}

async function showClientExpenses(c, id) {
  const { deal } = await findDeal(id);
  if (!deal) { await msg(c, '⚠️ Topilmadi.'); return; }
  const lines = (deal.expenses || []).map(e => {
    const prods = (e.products || []).map(p => `${p.name} ×${p.qty}`).join(', ');
    return `• ${e.date} — ${prods} = ${fmtUzs(e.total_uzs)} so'm`;
  }).join('\n') || '_(hali yo\'q)_';
  await btn(c, `💸 *${deal.client} — xarajatlar*\n\n${lines}\n\n*Jami: ${fmtUzs(dealExpUzs(deal))} so'm*`,
    [[{ text: '➕ Xarajat qo\'shish', callback_data: 'exp_add_' + id }], [{ text: '◀️ Ortga', callback_data: 'ord_open_' + id }]]);
}

async function showClientStage(c, id) {
  const rows = ORDER_STAGES.map(s => [{ text: s, callback_data: 'stg_' + id + '_' + ORDER_STAGES.indexOf(s) }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'ord_open_' + id }]);
  await btn(c, '📊 *Holatni tanlang:*', rows);
}

async function setStage(c, id, stageIdx) {
  const { data, sha, idx } = await findDeal(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].stage = ORDER_STAGES[stageIdx] || data[idx].stage;
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'stage: ' + data[idx].client);
  await msg(c, `✅ Holat: *${data[idx].stage}*`);
  await showClientMenu(c, id);
}

async function finishOrder(c, id) {
  const { data, sha, idx } = await findDeal(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  const o = data[idx];
  o.status = 'done';
  o.finished_date = todayStr();
  const days = o.deadline_days ? workdaysBetween(parseDmy(o.date), parseDmy(o.finished_date)) : null;
  o.finished_workdays = days;
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'finish: ' + o.client);
  let verdict = '';
  if (o.deadline_days && days != null) {
    if (days <= o.deadline_days) verdict = `\n✅ Muddatida bitdi (${days}/${o.deadline_days} ish kuni)`;
    else verdict = `\n⚠️ Kechikdi (${days} ish kuni, va'da: ${o.deadline_days})`;
  }
  await msg(c, `🏁 *${o.client}* — buyurtma yakunlandi!\n🗓 Tugadi: ${o.finished_date}${verdict}`);
}

async function cancelOrderStart(c, id) {
  orderState[c] = { step: 'cancel_reason', cancelId: id };
  await btn(c, '🚫 *Bekor qilish*\n\nSababini yozing:', [[{ text: '◀️ Bekor qilmaymiz', callback_data: 'ord_open_' + id }]]);
}
async function cancelOrderSave(c, id, reason) {
  const { data, sha, idx } = await findDeal(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].status = 'cancelled';
  data[idx].cancelled_date = todayStr();
  data[idx].cancel_reason = reason;
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'cancel: ' + data[idx].client);
  await msg(c, `🚫 *${data[idx].client}* bekor qilindi.\nSabab: ${reason}`);
}

// ─── To'lov qo'shish oqimi ────────────────────────────────────
async function payAddStart(c, id) {
  orderState[c] = { step: 'pay_amount', payId: id };
  await btn(c, '💰 *To\'lov summasi:*\n\n_So\'mda yoki dollarda ($). Masalan: 2000000 yoki 200$_',
    [[{ text: '❌ Bekor', callback_data: 'ord_open_' + id }]]);
}
async function paySave(c, id, amountUzs) {
  const { data, sha, idx } = await findDeal(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].payments = data[idx].payments || [];
  data[idx].payments.push({ id: uid(), date: todayStr(), amount_uzs: amountUzs, rate: USD_UZS, note: '' });
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'payment: ' + data[idx].client);
  await msg(c, `✅ To'lov qo'shildi: ${fmtUzs(amountUzs)} so'm\n📉 Qolgan qarz: *${fmtUzs(dealDebtUzs(data[idx]))} so'm*`);
  await showClientPayments(c, id);
}

// ─── Xarajat qo'shish oqimi (qo'lda) ──────────────────────────
async function expAddStart(c, id) {
  orderState[c] = { step: 'exp_name', expId: id, expProducts: [], expCur: {} };
  await btn(c, '💸 *Mahsulot nomi:*\n\n_Masalan: LMDF Nazif oq_', [[{ text: '❌ Bekor', callback_data: 'ord_open_' + id }]]);
}
async function expProductsMenu(c) {
  const st = orderState[c];
  const lines = st.expProducts.map(p => `• ${p.name} ×${p.qty} — ${fmtUzs(p.price_uzs)} = ${fmtUzs(p.qty * p.price_uzs)}`).join('\n') || '_(hali yo\'q)_';
  const total = st.expProducts.reduce((s, p) => s + p.qty * p.price_uzs, 0);
  await btn(c, `💸 *Mahsulotlar:*\n${lines}\n\n*Jami: ${fmtUzs(total)} so'm*`, [
    [{ text: '➕ Yana mahsulot', callback_data: 'exp_more' }, { text: '✅ Tugatish', callback_data: 'exp_done' }],
    [{ text: '❌ Bekor', callback_data: 'ord_open_' + st.expId }]
  ]);
}
async function expSave(c) {
  const st = orderState[c];
  const id = st.expId;
  const total = st.expProducts.reduce((s, p) => s + p.qty * p.price_uzs, 0);
  const { data, sha, idx } = await findDeal(id);
  if (idx < 0) { delete orderState[c]; await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].expenses = data[idx].expenses || [];
  data[idx].expenses.push({ id: uid(), date: todayStr(), products: st.expProducts, total_uzs: total, rate: USD_UZS, note: '', source: 'manual' });
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'expense: ' + data[idx].client);
  delete orderState[c];
  await msg(c, `✅ Xarajat saqlandi: ${fmtUzs(total)} so'm`);
  await showClientExpenses(c, id);
}

// ─── Bosh menyu (tugmalar) ────────────────────────────────────
async function showHomeMenu(c) {
  await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
    text: '🏠 *MBI Mebel — bosh menyu*\n\nKerakli bo\'limni tanlang:',
    reply_markup: { inline_keyboard: [
      [{ text: '🆕 Yangi buyurtma', callback_data: 'start_order' }],
      [{ text: '📁 Buyurtmalar', callback_data: 'menu_orders' }],
      [{ text: '✅ Tugatilganlar', callback_data: 'menu_done' }, { text: '🚫 Bekor qilinganlar', callback_data: 'menu_cancelled' }],
      [{ text: '👷 Xodimlar', callback_data: 'menu_staff' }]
    ] } });
}

// ══════════════════════════════════════════════════════════════
// 2-BOSQICH: Xodimlar tizimi (oylik)
// staff-log.json: [{id,name,salary_usd,active,created,
//   absences:[{date}], advances:[{id,date,amount_usd}]}]
// ══════════════════════════════════════════════════════════════

// Oyning ish kunlari soni (yakshanbasiz). y,m: m = 0-11
function workdaysInMonth(y, m) {
  const days = new Date(y, m + 1, 0).getDate();
  let cnt = 0;
  for (let d = 1; d <= days; d++) { if (new Date(y, m, d).getDay() !== 0) cnt++; }
  return cnt;
}
// Oy boshidan berilgan kungacha o'tgan ish kunlari (shu kun ichida)
function workdaysPassed(y, m, uptoDay) {
  let cnt = 0;
  for (let d = 1; d <= uptoDay; d++) { if (new Date(y, m, d).getDay() !== 0) cnt++; }
  return cnt;
}
// "DD.MM.YYYY" → {y,m,d}
function dmyParts(s) {
  const mm = String(s).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!mm) return null;
  return { d: +mm[1], m: +mm[2] - 1, y: +mm[3] };
}

async function readStaff() { return await ghReadAll('staff-log.json'); }
async function findStaff(id) {
  const { data, sha } = await ghRead('staff-log.json');
  const idx = data.findIndex(s => s.id === id);
  return { data, sha, idx, staff: idx >= 0 ? data[idx] : null };
}
// Ismdan xodim topish (davomat/avans ovozi uchun) — faqat active
function staffByName(list, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return list.find(s => s.active !== false && s.name.trim().toLowerCase() === n)
    || list.find(s => s.active !== false && s.name.trim().toLowerCase().startsWith(n))
    || null;
}

// Joriy oy uchun xodim hisobi (oy o'rtasida — shu kungacha)
function payrollThisMonth(s) {
  const now = nowTZ();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  const totalWd = workdaysInMonth(y, m);
  const passedWd = workdaysPassed(y, m, today);
  const dailyUsd = s.salary_usd ? s.salary_usd / totalWd : 0;
  // shu oydagi kelmagan kunlar (ish kunlari, yakshanba bo'lsa hisoblamaymiz)
  const absDates = (s.absences || []).filter(a => {
    const p = dmyParts(a.date); if (!p) return false;
    if (p.y !== y || p.m !== m) return false;
    return new Date(p.y, p.m, p.d).getDay() !== 0;
  });
  const absCount = absDates.length;
  // hozirgacha ishlangan ish kunlari = o'tgan ish kunlari − kelmaganlar
  const workedWd = Math.max(0, passedWd - absCount);
  const earnedUsd = dailyUsd * workedWd;
  const advUsd = (s.advances || []).filter(a => {
    const p = dmyParts(a.date); return p && p.y === y && p.m === m;
  }).reduce((sum, a) => sum + (a.amount_usd || 0), 0);
  const remainUsd = earnedUsd - advUsd;
  return { y, m, totalWd, passedWd, dailyUsd, absCount, workedWd, earnedUsd, advUsd, remainUsd };
}

async function showStaffList(c) {
  const list = await readStaff();
  const active = list.filter(s => s.active !== false);
  const rows = active.map(s => [{ text: `👷 ${s.name} ($${s.salary_usd || 0})`, callback_data: 'stf_open_' + s.id }]);
  rows.push([{ text: '➕ Yangi xodim', callback_data: 'stf_add' }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'menu_home' }]);
  await btn(c, '👷 *Xodimlar*' + (active.length ? '' : '\n\n_Hozircha xodim yo\'q. «Yangi xodim» qo\'shing._'), rows);
}

async function showStaffCard(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Xodim topilmadi.'); return; }
  const p = payrollThisMonth(s);
  const monthName = nowTZ().toLocaleDateString('uz-UZ', { month: 'long' });
  const txt = `👷 *${s.name}*\n\n` +
    `💵 Oylik: *$${s.salary_usd || 0}*\n` +
    `📅 ${monthName}: ${p.totalWd} ish kuni\n` +
    `📆 Bugungacha: ${p.passedWd} kun\n` +
    `❌ Kelmagan: ${p.absCount} kun\n` +
    `✅ Ishlangan: ${p.workedWd} kun\n` +
    `💰 Kunlik: $${p.dailyUsd.toFixed(2)}\n` +
    `📈 Hozirgacha topgani: *$${p.earnedUsd.toFixed(2)}*\n` +
    `💸 Olgan avans: $${p.advUsd.toFixed(2)}\n` +
    `📉 Qolgan haq: *$${p.remainUsd.toFixed(2)}* (${fmtUzs(p.remainUsd * USD_UZS)} so'm)`;
  await btn(c, txt, [
    [{ text: '💸 Avans qo\'shish', callback_data: 'stf_adv_' + id }, { text: '❌ Kelmagan kun', callback_data: 'stf_abs_' + id }],
    [{ text: '✏️ Oylikni o\'zgartirish', callback_data: 'stf_sal_' + id }],
    [{ text: '🗑 Xodimni o\'chirish', callback_data: 'stf_del_' + id }],
    [{ text: '◀️ Ortga', callback_data: 'menu_staff' }]
  ]);
}

// Yangi xodim qo'shish
async function staffAddStart(c) {
  orderState[c] = { step: 'stf_name' };
  await btn(c, '➕ *Yangi xodim*\n\n👤 Ismini yozing:', [[{ text: '❌ Bekor', callback_data: 'menu_staff' }]]);
}
async function staffSaveNew(c, name, salaryUsd) {
  const { data, sha } = await ghRead('staff-log.json');
  data.push({ id: uid(), name: name.trim(), salary_usd: salaryUsd, active: true, created: todayStr(), absences: [], advances: [] });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff add: ' + name);
  await msg(c, `✅ Xodim qo'shildi: *${name}* — oylik $${salaryUsd}`);
  await showStaffList(c);
}

// Avans (tugma orqali)
async function staffAdvStart(c, id) {
  orderState[c] = { step: 'stf_adv_amount', staffId: id };
  await btn(c, '💸 *Avans summasi:*\n\n_Dollarda yoki $ bilan. Masalan: 100_', [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
}
async function staffAddAdvance(c, id, amountUsd, dateStr) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return false; }
  data[idx].advances = data[idx].advances || [];
  data[idx].advances.push({ id: uid(), date: dateStr || todayStr(), amount_usd: amountUsd });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff advance: ' + data[idx].name);
  return data[idx].name;
}

// Kelmagan kun (tugma orqali — bugun)
async function staffAddAbsence(c, id, dateStr) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return false; }
  data[idx].absences = data[idx].absences || [];
  const dt = dateStr || todayStr();
  if (!data[idx].absences.some(a => a.date === dt)) data[idx].absences.push({ date: dt });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff absence: ' + data[idx].name);
  return data[idx].name;
}

// Oylikni o'zgartirish
async function staffSalStart(c, id) {
  orderState[c] = { step: 'stf_sal_amount', staffId: id };
  await btn(c, '✏️ *Yangi oylik* (dollarda):', [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
}
async function staffSetSalary(c, id, salaryUsd) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].salary_usd = salaryUsd;
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff salary: ' + data[idx].name);
  await msg(c, `✅ Oylik yangilandi: *${data[idx].name}* — $${salaryUsd}`);
  await showStaffCard(c, id);
}

// O'chirish (active=false — ma'lumot saqlanadi)
async function staffDelete(c, id) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].active = false;
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff remove: ' + data[idx].name);
  await msg(c, `🗑 *${data[idx].name}* ro'yxatdan olib tashlandi.`);
  await showStaffList(c);
}

// ─── Groq call ────────────────────────────────────────────────
function groqChat(system, userText, maxTokens) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: maxTokens || 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userText }]
    });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          let raw = JSON.parse(data).choices[0].message.content.trim().replace(/```json|```/g, '').trim();
          resolve(JSON.parse(raw));
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function groqText(system, userText, maxTokens) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: maxTokens || 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userText }]
    });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices[0].message.content.trim()); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function orText(system, userText, maxTokens, model) {
  return new Promise((resolve) => {
    const key = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';
    if (!key) return resolve(null);
    const body = JSON.stringify({
      model: model || 'anthropic/claude-haiku-4.5', max_tokens: maxTokens || 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: userText }]
    });
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).choices[0].message.content.trim()); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}
async function aiText(system, userText, maxTokens, smart) {
  const r = await orText(system, userText, maxTokens, smart ? 'anthropic/claude-sonnet-4.5' : 'anthropic/claude-haiku-4.5');
  return r || groqText(system, userText, maxTokens);
}

// ─── Groq Whisper ─────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => resolve(Buffer.concat(ch))); res.on('error', reject);
    }).on('error', reject);
  });
}
function transcribeAudio(buf) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', buf, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY, ...form.getHeaders() }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).text || ''); } catch (e) { reject(new Error(d)); } });
    });
    req.on('error', reject); form.pipe(req);
  });
}

// ─── Parse ANY voice command ──────────────────────────────────
function parseVoice(text, today) {
  const system = `Sen MBI Mebel xo'jayini Ibrohimning shaxsiy AI assistentisan. Bugun: ${today}.

XODIMLAR: Sherzod (= Şevzat, Shirzod), Diyor (= Diyar)

Xabarni tahlil qilib FAQAT JSON massiv qaytarasan (markdown yo'q):
[{
  "type": "hr"|"meeting"|"task"|"expense"|"deal"|"note",
  "worker": "Diyor"|"Sherzod"|null,
  "present": true|false|null,
  "amount": number|null,
  "currency": "USD"|"UZS"|null,
  "date": "DD.MM.YYYY",
  "time": "HH:MM"|null,
  "client": "mijoz ismi"|null,
  "text": "asosiy matn",
  "remind_before_min": 30|null
}]

TYPE QOIDALARI:
- "keldi/kelmadi/avans/oylik" → type:"hr"
- "soat X da Y bilan uchrashuv/ko'rishish/meeting" → type:"meeting", time:"HH:MM", client:"Y"
- "bugun qilishim kerak/plan/vazifa" → type:"task"
- "shaxsiy xarajat/transport/ovqat/benzin" → type:"expense"
- "X bilan Y dollar kelishdilik/shartnoma" → type:"deal", client:"X", amount:Y
- boshqa eslatma → type:"note"

SANA/VAQT:
- "bugun" → ${today}
- "kecha" → kechagi
- "ertaga" → ertangi
- "soat 3" → "15:00", "soat 3:30" → "15:30", "soat 10" → "10:00"
- "soat 15:00" → "15:00"

MISOLLAR:
- "bugun soat 3 da Boxodir aka bilan uchrashuv" → [{"type":"meeting","client":"Boxodir aka","date":"${today}","time":"15:00","text":"Boxodir aka bilan uchrashuv","remind_before_min":30,"amount":null,"currency":null,"present":null,"worker":null}]
- "Sherzod kelmadi" → [{"type":"hr","worker":"Sherzod","present":false,"date":"${today}","time":null,"client":null,"text":"Sherzod kelmadi","remind_before_min":null,"amount":null,"currency":null}]
- "shaxsiy xarajat 50000 so'm benzin" → [{"type":"expense","amount":50000,"currency":"UZS","text":"Benzin","date":"${today}","time":null,"client":null,"remind_before_min":null,"present":null,"worker":null}]
- "Alisher aka bilan 1500 dollar kelishdilik" → [{"type":"deal","client":"Alisher aka","amount":1500,"currency":"USD","text":"Kelishuv: $1500","date":"${today}","time":null,"remind_before_min":null,"present":null,"worker":null}]
- "bugun qilishim kerak: materiallarni buyurtma berish, Sherzodga ish topshirish" → [{"type":"task","text":"materiallarni buyurtma berish","date":"${today}","time":null,"client":null,"remind_before_min":null,"amount":null,"currency":null,"present":null,"worker":null},{"type":"task","text":"Sherzodga ish topshirish","date":"${today}","time":null,"client":null,"remind_before_min":null,"amount":null,"currency":null,"present":null,"worker":null}]`;

  return groqChat(system, text, 1000).then(r => Array.isArray(r) ? r : (r ? [r] : [{ type: 'note', text, date: today, time: null }]));
}

// ─── Process parsed entries ───────────────────────────────────
async function processEntries(chatId, entries, transcript) {
  const today = todayStr();
  const lines = [];
  const saves = [];

  for (const p of entries) {
    const date = p.date || today;
    let title = '', icon = '', file = 'notes-log.json';

    if (p.type === 'hr') {
      file = 'hr-log.json';
      if (p.present === false) { icon = '❌'; title = `❌ ${date} | ${p.worker} | Ishga KELMADI`; }
      else if (p.present === true) { icon = '✅'; title = `✅ ${date} | ${p.worker} | Ishga KELDI`; }
      else if (p.amount) { icon = '💵'; title = `💵 ${date} | ${p.worker} | Avans: ${p.amount} ${p.currency||''}`; }
      else { icon = '📝'; title = `📝 ${date} | ${p.text}`; }

    } else if (p.type === 'meeting') {
      file = 'meetings-log.json';
      icon = '🤝';
      title = `🤝 ${date} ${p.time||''} | ${p.client||''} | ${p.text}`;

    } else if (p.type === 'task') {
      file = 'tasks-log.json';
      icon = '✅';
      title = `📌 ${date} | ${p.text}`;

    } else if (p.type === 'expense') {
      file = 'expenses-personal-log.json';
      icon = '💸';
      const amt = p.amount ? `${p.amount} ${p.currency||''}` : '';
      title = `💸 ${date} | Shaxsiy: ${p.text} ${amt}`;

    } else if (p.type === 'deal') {
      file = 'deals-log.json';
      icon = '🤝';
      const amt = p.amount ? `$${p.amount}` : '';
      title = `💼 ${date} | ${p.client||''} | Kelishuv: ${amt}`;

    } else {
      file = 'notes-log.json';
      icon = '📝';
      title = `📝 ${date} | ${p.text}`;
    }

    const entry = { date, title, text: p.text, type: p.type, parsed: p, transcript, ts: new Date().toISOString() };
    if (p.time) entry.time = p.time;
    if (p.client) entry.client = p.client;
    if (p.amount) entry.amount = p.amount;
    if (p.currency) entry.currency = p.currency;
    if (p.remind_before_min) entry.remind_before_min = p.remind_before_min;
    entry.reminded = false;

    saves.push(ghWrite(file, entry, title));
    lines.push('• ' + title);
  }

  await Promise.all(saves);
  return lines;
}

// ─── Voice handler ────────────────────────────────────────────
async function handleVoice(chatId, voice) {
  try {
    await msg(chatId, '⏳ Tahlil qilinmoqda...');
    const fi = await api('getFile', { file_id: voice.file_id });
    const url = 'https://api.telegram.org/file/bot' + BOT + '/' + fi.result.file_path;
    const audio = await downloadBuffer(url);
    const transcript = await transcribeAudio(audio);
    const today = todayStr();
    const entries = await parseVoice(transcript, today);
    const lines = await processEntries(chatId, entries, transcript);
    await msg(chatId, '✅ *Saqlandi!*\n\n' + lines.join('\n') + '\n\n🎤 _"' + transcript + '"_');
  } catch (e) {
    console.error('Voice error:', e);
    await msg(chatId, '❌ Xatolik: ' + e.message);
  }
}

// ─── Video handler (admin) ────────────────────────────────────
async function handleVideo(chatId, video) {
  try {
    if (video.file_size && video.file_size > 19 * 1024 * 1024) {
      await msg(chatId, '⚠️ Video 20MB dan katta — Telegram bot yuklab ololmaydi. Videoni qisqartirib yoki siqib qayta yuboring.');
      return;
    }
    await msg(chatId, '📥 Video qabul qilindi, saqlanmoqda...');
    const fi = await api('getFile', { file_id: video.file_id });
    const buf = await downloadBuffer('https://api.telegram.org/file/bot' + BOT + '/' + fi.result.file_path);
    const name = 'videos/video_' + Date.now() + '.mp4';
    const r = await ghPut(name, buf, undefined, 'video from telegram');
    if (r && r.content) {
      await msg(chatId, '✅ Video saqlandi:\nhttps://raw.githubusercontent.com/' + GH_REPO + '/main/' + name);
    } else {
      await msg(chatId, '❌ GitHub xatosi: ' + JSON.stringify(r).slice(0, 200));
    }
  } catch (e) {
    console.error('Video error:', e);
    await msg(chatId, '❌ Video saqlashda xato: ' + e.message);
  }
}

// ─── AI OFFICE ────────────────────────────────────────────────
function apiBot(token, method, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + token + '/' + method, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); });
    req.on('error', () => res(null)); req.write(body); req.end();
  });
}

const BIZ_INFO = `MBI Mebel (Mebel by Ibrohim) — Toshkentda buyurtma asosida mebel ishlab chiqaradi. Korpus: LMDF, fasadlar: akril, furnitura: GTV/Blum, stoleshnitsa: DSP. Narx: 1 pogonaj metr $400 dan. Tel: +998 91 135 44 66. Telegram: @MBI_mebel, Instagram: @mbi_mebel. Ishlab chiqarishda Diyor va Sherzod ishlaydi. Xo'jayin: Ibrohim. Kurs: 12000 so'm = 1 USD.`;

const AGENTS = {
  botir: { name: 'Botir', role: 'Bosh yordamchi', emoji: '🤖', token: '',
    sys: `Sen Botir — MBI Mebel xo'jayini Ibrohimning bosh AI yordamchisisan. ${BIZ_INFO}
Vazifang: umumiy savollarga javob berish va ishlarni muvofiqlashtirish. Qisqa, aniq, samimiy o'zbek tilida (lotin alifbosi) gapir. Agar savol pul/hisob/xarajat haqida bo'lsa, javobing oxiriga [[sardor]] deb qo'sh; mijoz/sotuv/Instagram haqida bo'lsa [[aziza]] deb qo'sh — o'sha hamkasbing davom etadi.` },
  aziza: { name: 'Aziza', role: 'Sotuv menejeri', emoji: '👩‍💼', token: '',
    sys: `Sen Aziza — MBI Mebel sotuv menejerisan. ${BIZ_INFO}
Vazifang: mijozlarga yozish uchun tayyor matnlar, narx takliflari, e'tirozlarga javoblar, Instagram javoblari. Tabiiy, iliq, robotga o'xshamaydigan jonli o'zbek tilida yoz — rasmiy shablon ishlatma. Narxni har doim qiymat bilan asosla: material sifati, aniq muddat, kafolat. Javoblaring qisqa va ishlatishga tayyor bo'lsin.` },
  sardor: { name: 'Sardor', role: 'Hisobchi', emoji: '📊', token: '',
    sys: `Sen Sardor — MBI Mebel hisobchisisan. ${BIZ_INFO}
Senga TAYYOR HISOBLANGAN raqamlar beriladi — barcha arifmetika allaqachon bajarilgan. QOIDALAR:
1. O'ZING HECH QANDAY HISOB-KITOB QILMA (qo'shish, ayirish, ko'paytirish taqiqlanadi). Faqat berilgan tayyor raqamlarni o'qib taqdim et.
2. Berilgan ma'lumotda yo'q raqamni ASLO o'ylab topma.
3. Savolga tegishli raqamlarnigina ayt — hammasini sanama.
4. Javob qisqa, aniq, o'zbek tilida (lotin).
Ma'lumot topilmasa ochiq ayt: "bu haqda logda ma'lumot yo'q, Ibrohim aka aytib qo'ysangiz kiritaman".` },
  dilshod: { name: 'Dilshod', role: 'Dizayner', emoji: '🎨', token: '',
    sys: `Sen Dilshod — MBI Mebel dizaynerisan. ${BIZ_INFO}
Vazifang: render g'oyalari, dizayn maslahatlari, rang va material tanlovi, Bazis loyihalari uchun tavsiyalar. Ibrohim guruhga Bazis skrinshotini yuborsa, sen uni avtomatik fotorealistik render qilasan. Qisqa, amaliy, o'zbek tilida (lotin) gapir.` }
};

// ─── Maxfiy tokenlarni yuklash (mbi-secrets, private repo) ───
let secretsReady = (async function loadSecrets() {
  try {
    const get = (name) => getSecretKey(name);
    const [bt, az, sd, bo, di] = await Promise.all([
      get('bot_token'), get('aziza_token'), get('sardor_token'), get('botir_token'), get('dilshod_token')
    ]);
    if (!BOT && bt) BOT = bt;
    if (az) AGENTS.aziza.token = az;
    if (sd) AGENTS.sardor.token = sd;
    if (bo) AGENTS.botir.token = bo;
    if (di) AGENTS.dilshod.token = di;
    console.log('Secrets loaded. BOT:', BOT ? 'ok' : 'MISSING');
  } catch (e) { console.error('Secrets load error:', e.message); }
})();

let officeChat = null;
let officeHistory = [];
let lastMorningReport = '';

async function loadOfficeConfig() {
  try {
    const d = await ghGet('office-config.json');
    const cfg = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
    officeChat = cfg.chatId || null;
    console.log('Office chat:', officeChat);
  } catch (e) {}
}
async function saveOfficeConfig() {
  try {
    let sha; try { const d = await ghGet('office-config.json'); sha = d.sha; } catch (e) {}
    await ghPut('office-config.json', JSON.stringify({ chatId: officeChat }), sha, 'office config');
  } catch (e) { console.error('office cfg:', e.message); }
}

function agentMsg(chatId, key, text) {
  const a = AGENTS[key];
  officeHistory.push({ from: a.name, text: String(text).slice(0, 400) });
  if (officeHistory.length > 24) officeHistory.shift();
  if (a.token && !a.token.includes('PLACEHOLDER')) {
    return apiBot(a.token, 'sendMessage', { chat_id: chatId, text: String(text), parse_mode: 'Markdown' })
      .then(r => (r && r.ok) ? r : apiBot(a.token, 'sendMessage', { chat_id: chatId, text: String(text) }));
  }
  return msg(chatId, `${a.emoji} *${a.name} | ${a.role}*\n\n${text}`);
}

const USD_RATE = 12000;

async function financeContext() {
  try {
    const [deals, exp] = await Promise.all([ghReadAll('deals-log.json'), ghReadAll('expenses-log.json')]);

    // Har bir xarajatning so'mdagi summasini hisoblash
    const expCalc = exp.map(x => {
      let total = x.total_override != null ? Number(x.total_override)
        : (x.items || []).reduce((s, i) => s + (Number(i.total) || 0), 0);
      const isUsd = (x.currency || '').toUpperCase() === 'USD';
      const totalUzs = isUsd ? Math.round(total * USD_RATE) : total;
      return { ...x, _total: total, _totalUzs: totalUzs, _cur: isUsd ? 'USD' : 'UZS' };
    });

    // Kelishuvlar bo'yicha tayyor hisob
    const dealLines = deals.slice(-10).map(d => {
      const name = d.client || d.title || '?';
      const dealExp = expCalc.filter(e => (e.deal || '').toLowerCase() === name.toLowerCase());
      const expSum = dealExp.reduce((s, e) => s + e._totalUzs, 0);
      const contract = Number(d.contract_sum_uzs) || 0;
      const advance = Number(d.advance_uzs) || 0;
      const debt = d.debt_uzs != null ? Number(d.debt_uzs) : (contract - advance);
      const profit = contract - expSum;
      return `• ${name} (${d.stage || '-'}): shartnoma ${contract.toLocaleString()} so'm | avans olingan ${advance.toLocaleString()} so'm | QARZ QOLDI ${debt.toLocaleString()} so'm | xarajatlar jami ${expSum.toLocaleString()} so'm (${dealExp.length} ta chek) | taxminiy foyda ${profit.toLocaleString()} so'm`;
    }).join('\n');

    const expLines = expCalc.slice(-15).map(e =>
      `• ${e.date || ''} | ${e.supplier || ''} | loyiha: ${e.deal || '-'} | ${e._total.toLocaleString()} ${e._cur}${e._cur === 'USD' ? ` (=${e._totalUzs.toLocaleString()} so'm)` : ''} | ${(e.items || []).map(i => i.name).join(', ').slice(0, 200)}`
    ).join('\n');

    return `TAYYOR HISOBLANGAN MA'LUMOTLAR (barcha arifmetika bajarilgan, kurs 1 USD = ${USD_RATE} so'm):\n\nKELISHUVLAR:\n${dealLines || '—'}\n\nXARAJATLAR RO'YXATI:\n${expLines || '—'}`;
  } catch (e) { return ''; }
}

async function routeAgent(text) {
  const t = text.toLowerCase().trim();
  for (const k of Object.keys(AGENTS)) {
    if (t.startsWith(k) || t.startsWith(AGENTS[k].name.toLowerCase())) return k;
  }
  const r = await groqText(`Sen router'san. Ibrohimning xabariga MBI Mebel jamoasidan qaysi xodim javob berishi kerakligini aniqla. FAQAT bitta so'z qaytar:\naziza — mijozlar, sotuv, narx taklifi, e'tiroz, Instagram, mijozga matn yozish\nsardor — pul, hisob, xarajat, qarz, avans, hisobot, moliya\ndilshod — dizayn, render, rang, material, 3D, Bazis\nbotir — qolgan hammasi`, text, 10);
  const key = String(r || '').toLowerCase().replace(/[^a-z]/g, '');
  return AGENTS[key] ? key : 'botir';
}

// ─── Office: ma'lumot kiritish (xarajat/avans/buyurtma/bosqich) ───
const OFFICE_PARSER_SYS = `Sen parser'san. Ibrohimning xabarini tahlil qil. Agar u YANGI MOLIYAVIY MA'LUMOT kiritayotgan bo'lsa, FAQAT bitta JSON qaytar (boshqa matn yozma):
Xarajat (biror narsa sotib olindi/pul sarflandi): {"action":"expense","supplier":"do'kon nomi","amount":raqam,"currency":"UZS" yoki "USD","deal":"loyiha/mijoz nomi","note":"nima olindi"}
Avans (mijozdan pul olindi): {"action":"advance","deal":"mijoz nomi","amount":raqam}
Xodim ishga kelmadi (davomat): {"action":"staff_absence","worker":"xodim ismi","days":1}
Xodim bir necha kun kelmaydi: {"action":"staff_absence","worker":"xodim ismi","days":raqam}
Xodimga avans berildi (oylik avansi): {"action":"staff_advance","worker":"xodim ismi","amount":raqam,"currency":"USD"}
Yangi buyurtma/kelishuv: {"action":"new_deal","client":"mijoz nomi","contract":raqam,"advance":raqam,"stage":"Yangi buyurtma"}
Bosqich o'zgarishi (masalan yetkazib berishga o'tdi): {"action":"stage","deal":"mijoz nomi","stage":"yangi bosqich"}
Vazifa berish (kimgadir topshiriq): {"action":"task","assignee":"aziza"|"sardor"|"dilshod"|"botir","text":"vazifa matni","deadline":"muddat yoki bo'sh"}
Vazifani yopish: {"action":"task_done","id":raqam}
Vazifani qayta ochish: {"action":"task_reopen","id":raqam}
Vazifalar ro'yxatini so'rash: {"action":"tasks_list"}
Agar bu SAVOL, hisobot so'rovi yoki oddiy suhbat bo'lsa: {"action":"none"}
Raqamlar: "2 mln"=2000000, "500 ming"=500000, "1.5 million"=1500000. Valyuta aytilmasa UZS. Dollar/$ bo'lsa USD.`;

async function createTask(c, assignee, text, deadline) {
  const tasks = await ghReadAll('office-tasks.json');
  const id = tasks.reduce((m, x) => Math.max(m, Number(x.id) || 100), 100) + 1;
  const agentKey = AGENTS[assignee] ? assignee : 'botir';
  await ghWrite('office-tasks.json', {
    id, date: todayStr(), assignee: agentKey, text, deadline: deadline || '', status: 'open', result: ''
  }, 'office: task #' + id);
  await agentMsg(c, agentKey, `Qabul qildim ✅ *Vazifa #${id}*: ${text}${deadline ? '\nMuddat: ' + deadline : ''}\nHozir ishlayman...`);
  const res = await aiText(AGENTS[agentKey].sys,
    `Senga vazifa #${id} berildi: "${text}". Agar buni matn ko'rinishida bajarish mumkin bo'lsa (reja, matn, ro'yxat, tahlil, taklif) — TO'LIQ TAYYOR natijani yoz. Agar jismoniy/tashqi ish bo'lsa — qisqa bajarish rejasi va nimalar kerakligini yoz.`, 1400, true);
  if (res) {
    await agentMsg(c, agentKey, `📌 *Vazifa #${id} natijasi:*\n\n${res}`);
    await updateTask(id, { status: 'done', result: String(res).slice(0, 1500) });
  }
}
async function updateTask(id, patch) {
  const { data, sha } = await ghRead('office-tasks.json');
  const t = data.find(x => Number(x.id) === Number(id));
  if (!t) return false;
  Object.assign(t, patch);
  await ghPut('office-tasks.json', JSON.stringify(data, null, 2), sha, 'office: task #' + id + ' update');
  return true;
}
async function listTasks(c) {
  const tasks = await ghReadAll('office-tasks.json');
  const open = tasks.filter(x => x.status === 'open');
  const done = tasks.filter(x => x.status === 'done').slice(-5);
  let out = open.length
    ? '📋 *OCHIQ VAZIFALAR:*\n' + open.map(x => `#${x.id} → ${AGENTS[x.assignee] ? AGENTS[x.assignee].name : x.assignee}: ${x.text}${x.deadline ? ' (muddat: ' + x.deadline + ')' : ''}`).join('\n')
    : 'Ochiq vazifa yo\'q ✅';
  if (done.length) out += '\n\n*Oxirgi bajarilganlar:*\n' + done.map(x => `✅ #${x.id} ${String(x.text).slice(0, 60)}`).join('\n');
  await agentMsg(c, 'botir', out);
}

async function officeApplyData(c, p) {
  const today = todayStr();
  if (p.action === 'expense' && p.amount) {
    const cur = (p.currency || 'UZS').toUpperCase();
    await ghWrite('expenses-log.json', {
      date: today, supplier: p.supplier || '', deal: p.deal || '', currency: cur,
      total_override: Number(p.amount) || 0,
      items: p.note ? [{ name: String(p.note), qty: 1 }] : []
    }, 'office: expense');
    await agentMsg(c, 'sardor', `Yozib qo'ydim ✅\n📤 Xarajat: ${(Number(p.amount) || 0).toLocaleString()} ${cur}\n🏪 ${p.supplier || '-'}\n📁 Loyiha: ${p.deal || '-'}${p.note ? '\n📝 ' + p.note : ''}`);
    return true;
  }
  if (p.action === 'advance' && p.amount) {
    const { data, sha } = await ghRead('deals-log.json');
    const q = (p.deal || '').toLowerCase();
    const d = data.find(x => (x.client || '').toLowerCase().includes(q) || q.includes((x.client || '').toLowerCase().split(' ')[0]));
    if (!d) { await agentMsg(c, 'sardor', `"${p.deal}" nomli kelishuv logda topilmadi. "Yangi buyurtma: ${p.deal}, shartnoma ..., avans ..." deb kiritsangiz ochaman.`); return true; }
    d.advance_uzs = (Number(d.advance_uzs) || 0) + (Number(p.amount) || 0);
    d.debt_uzs = (Number(d.contract_sum_uzs) || 0) - d.advance_uzs;
    await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'office: advance');
    await agentMsg(c, 'sardor', `Yozib qo'ydim ✅\n💰 ${d.client}: avans +${(Number(p.amount) || 0).toLocaleString()} so'm\nJami avans: ${d.advance_uzs.toLocaleString()} so'm\nQarz qoldi: ${d.debt_uzs.toLocaleString()} so'm`);
    return true;
  }
  if (p.action === 'new_deal' && p.client) {
    const contract = Number(p.contract) || 0, adv = Number(p.advance) || 0;
    await ghWrite('deals-log.json', {
      date: today, client: p.client, contract_sum_uzs: contract,
      advance_uzs: adv, debt_uzs: contract - adv, stage: p.stage || 'Yangi buyurtma'
    }, 'office: new deal');
    await agentMsg(c, 'sardor', `Yangi buyurtma ochildi ✅\n👤 ${p.client}\nShartnoma: ${contract.toLocaleString()} so'm\nAvans: ${adv.toLocaleString()} so'm\nQarz: ${(contract - adv).toLocaleString()} so'm\n\nBitrix'ga ham kiritishni unutmang.`);
    return true;
  }
  if (p.action === 'stage' && p.deal) {
    const { data, sha } = await ghRead('deals-log.json');
    const q = (p.deal || '').toLowerCase();
    const d = data.find(x => (x.client || '').toLowerCase().includes(q) || q.includes((x.client || '').toLowerCase().split(' ')[0]));
    if (!d) { await agentMsg(c, 'sardor', `"${p.deal}" kelishuvi logda topilmadi.`); return true; }
    d.stage = p.stage || d.stage;
    await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'office: stage');
    await agentMsg(c, 'sardor', `✅ ${d.client} bosqichi yangilandi: *${d.stage}*`);
    return true;
  }
  if (p.action === 'task' && p.text) { await createTask(c, p.assignee, p.text, p.deadline); return true; }
  if (p.action === 'task_done' && p.id) {
    const ok = await updateTask(p.id, { status: 'done' });
    await agentMsg(c, 'botir', ok ? `Vazifa #${p.id} yopildi ✅` : `#${p.id} topilmadi`);
    return true;
  }
  if (p.action === 'task_reopen' && p.id) {
    const ok = await updateTask(p.id, { status: 'open' });
    await agentMsg(c, 'botir', ok ? `Vazifa #${p.id} qayta ochildi 🔄` : `#${p.id} topilmadi`);
    return true;
  }
  if (p.action === 'tasks_list') { await listTasks(c); return true; }
  // ── Xodim davomati (kelmadi) — tasdiq bilan ──
  if (p.action === 'staff_absence' && p.worker) {
    const list = await readStaff();
    const s = staffByName(list, p.worker);
    if (!s) { await agentMsg(c, 'sardor', `⚠️ "${p.worker}" nomli xodim ro'yxatda yo'q. Avval botda «👷 Xodimlar → ➕ Yangi xodim» orqali qo'shing.`); return true; }
    const days = Math.max(1, Number(p.days) || 1);
    const pid = 'p' + uid();
    officePending[pid] = { kind: 'absence', staffId: s.id, days };
    await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
      text: `👷 *Davomat — tasdiqlang*\n\n❌ ${s.name} — *${days} kun* kelmaydi/kelmadi deb belgilansinmi?`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Ha, to\'g\'ri', callback_data: 'ofc_ok_' + pid }, { text: '❌ Yo\'q', callback_data: 'ofc_no_' + pid }]] } });
    return true;
  }
  // ── Xodimga avans — tasdiq bilan ──
  if (p.action === 'staff_advance' && p.worker && p.amount) {
    const list = await readStaff();
    const s = staffByName(list, p.worker);
    if (!s) { await agentMsg(c, 'sardor', `⚠️ "${p.worker}" nomli xodim ro'yxatda yo'q. Avval botda qo'shing.`); return true; }
    let usd = Number(p.amount) || 0;
    if ((p.currency || 'USD').toUpperCase() === 'UZS') usd = usd / USD_UZS;
    const pid = 'p' + uid();
    officePending[pid] = { kind: 'advance', staffId: s.id, usd };
    await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
      text: `💸 *Avans — tasdiqlang*\n\n${s.name} — *$${usd.toFixed(2)}* avans berildi deb yozilsinmi?`,
      reply_markup: { inline_keyboard: [[{ text: '✅ Ha, to\'g\'ri', callback_data: 'ofc_ok_' + pid }, { text: '❌ Yo\'q', callback_data: 'ofc_no_' + pid }]] } });
    return true;
  }
  return false;
}

const DEFAULT_RENDER_PROMPT = "photorealistic interior photography of a luxury custom furniture interior, elegant panel cabinets, marble countertop, warm natural daylight, professional architectural photography, 4k, highly detailed";

function getSecretKey(name) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/yakubovibrohim/mbi-secrets/contents/keys.json', method: 'GET',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Accept': 'application/vnd.github.v3+json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(Buffer.from(JSON.parse(d).content, 'base64').toString())[name]); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.end();
  });
}

function ghPutRepo(repo, path, buf, label) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ message: label, content: Buffer.from(buf).toString('base64') });
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/' + repo + '/contents/' + path, method: 'PUT',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d).content.download_url); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

async function handleOfficeRender(c, m) {
  try {
    await agentMsg(c, 'dilshod', 'Rasmni oldim, fotorealistik render qilyapman... ⏳ (~1 daqiqa)');
    const ph = m.photo[m.photo.length - 1];
    const fi = await api('getFile', { file_id: ph.file_id });
    const buf = await downloadBuffer('https://api.telegram.org/file/bot' + BOT + '/' + fi.result.file_path);
    const url = await ghPutRepo('yakubovibrohim/MBI_anketa', 'renders/office_' + Date.now() + '.jpg', buf, 'office render input');
    const key = await getSecretKey('myarchitectai_api_key');
    if (!url || !key) { await agentMsg(c, 'dilshod', 'Tayyorgarlikda xato bo\'ldi ❌ keyinroq urinib ko\'ring.'); return; }
    let prompt = (m.caption || '').trim();
    if (prompt) {
      prompt = await aiText("Sen interior render prompt mutaxassisisan. Foydalanuvchining istagini ingliz tilida professional photorealistic interior photography prompt'iga aylantir. FAQAT promptni qaytar, boshqa hech narsa yozma.", prompt, 300, false) || DEFAULT_RENDER_PROMPT;
    } else prompt = DEFAULT_RENDER_PROMPT;
    const body = JSON.stringify({ image: url, outputFormat: 'jpg', prompt });
    const res = await new Promise((resolve) => {
      const rq = https.request({
        hostname: 'api.myarchitectai.com', path: '/v1/render/interior', method: 'POST',
        headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, r => { let d = ''; r.on('data', x => d += x); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
      rq.on('error', () => resolve(null));
      rq.setTimeout(170000, () => { rq.destroy(); resolve(null); });
      rq.write(body); rq.end();
    });
    const out = res && (Array.isArray(res.output) ? res.output[0] : res.output);
    if (!out) { await agentMsg(c, 'dilshod', 'Render xatosi ❌ Birozdan keyin qayta yuborib ko\'ring.'); return; }
    await api('sendPhoto', { chat_id: c, photo: out, caption: '🎨 Dilshod | Dizayner — render tayyor! 4K kerak bo\'lsa "4k qil" deb yozing.' });
    lastRenderUrl = out;
  } catch (e) { console.error('office render:', e.message); }
}
let lastRenderUrl = null;

async function handleOffice(upd) {
  const m = upd.message; const c = m.chat.id;
  const fromAdmin = String(m.from.id) === String(ADMIN);
  let t = m.text || '';

  // Rasm -> Dilshod render (fire-and-forget, webhook'ni ushlab turmaslik uchun)
  if (m.photo && fromAdmin) { handleOfficeRender(c, m).catch(e => console.error(e)); return; }

  if (m.voice && fromAdmin) {
    try {
      const fi = await api('getFile', { file_id: m.voice.file_id });
      const buf = await downloadBuffer('https://api.telegram.org/file/bot' + BOT + '/' + fi.result.file_path);
      t = await transcribeAudio(buf);
      if (t) await msg(c, '🎤 _' + t + '_');
    } catch (e) { return; }
  }
  if (!t) return;

  if (t === '/office' || t === '/office@mbi_mebel_bot') {
    if (!fromAdmin) return;
    officeChat = c; await saveOfficeConfig();
    await msg(c, '🏢 *MBI AI Office ishga tushdi!*');
    await agentMsg(c, 'botir', "Assalomu alaykum, Ibrohim aka! Men bosh yordamchiman — istalgan savolni yozavering, keraklisini jamoaga o'zim taqsimlayman.");
    await agentMsg(c, 'aziza', "Salom! Mijozlar bilan yozishmalar, narx takliflari va Instagram javoblari menda. To'g'ridan-to'g'ri \"Aziza, ...\" deb murojaat qilsangiz ham bo'ladi.");
    await agentMsg(c, 'sardor', "Assalomu alaykum. Kirim-chiqim, qarzlar va xarajatlar nazoratimda. Har kuni ertalab soat 8:00 da hisobot beraman.");
    return;
  }
  if (!fromAdmin) return;

  if (t === '/dashboard' || t === '/dashboard@mbi_mebel_bot') {
    await api('sendMessage', { chat_id: c, text: '🖥 *MBI AI Office — boshqaruv paneli*', parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '📊 Dashboard ochish', url: 'https://yakubovibrohim.github.io/mbi-bot/office.html' }]] } });
    return;
  }

  // "4k qil" — oxirgi renderni upscale
  if (/^4k/i.test(t.trim()) && lastRenderUrl) {
    const key = await getSecretKey('myarchitectai_api_key');
    if (key) {
      await agentMsg(c, 'dilshod', '4K qilyapman... ⏳');
      const body = JSON.stringify({ image: lastRenderUrl, outputFormat: 'jpg' });
      const res = await new Promise((resolve) => {
        const rq = https.request({ hostname: 'api.myarchitectai.com', path: '/v1/upscale-4k', method: 'POST',
          headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
          r => { let d = ''; r.on('data', x => d += x); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
        rq.on('error', () => resolve(null)); rq.setTimeout(170000, () => { rq.destroy(); resolve(null); });
        rq.write(body); rq.end();
      });
      if (res && res.output) await api('sendDocument', { chat_id: c, document: res.output, caption: '🎨 4K render (' + (res.balance != null ? 'balans: $' + res.balance : '') + ')' });
      else await agentMsg(c, 'dilshod', '4K xatosi ❌');
    }
    return;
  }

  // Avval: bu yangi ma'lumot kiritishmi?
  try {
    const pr = await aiText(OFFICE_PARSER_SYS, t, 250, false);
    const p = JSON.parse(String(pr || '').replace(/```json|```/g, '').trim());
    if (p && p.action && p.action !== 'none') {
      officeHistory.push({ from: 'Ibrohim', text: t.slice(0, 400) });
      if (officeHistory.length > 24) officeHistory.shift();
      if (await officeApplyData(c, p)) return;
    }
  } catch (e) {}

  const key = await routeAgent(t);
  const hist = officeHistory.slice(-12).map(h => `${h.from}: ${h.text}`).join('\n');
  officeHistory.push({ from: 'Ibrohim', text: t.slice(0, 400) });
  if (officeHistory.length > 24) officeHistory.shift();

  let extra = '';
  if (key === 'sardor') extra = '\n\nREAL MA\'LUMOTLAR:\n' + await financeContext();
  if (hist) extra += `\n\nSO'NGGI SUHBAT:\n${hist}`;

  const reply = await aiText(AGENTS[key].sys + extra, t, 900, true);
  if (!reply) { await msg(c, '⚠️ Javob olinmadi, birozdan keyin qayta urinib ko\'ring.'); return; }

  let main = reply, hand = null;
  const hm = reply.match(/\[\[(\w+)\]\]/);
  if (hm && AGENTS[hm[1].toLowerCase()]) { hand = hm[1].toLowerCase(); }
  main = reply.replace(/\[\[\w+\]\]/g, '').trim();
  await agentMsg(c, key, main);

  if (hand && hand !== key) {
    let extra2 = hand === 'sardor' ? '\n\nREAL MA\'LUMOTLAR:\n' + await financeContext() : '';
    const r2 = await aiText(AGENTS[hand].sys + extra2,
      `Hamkasbing ${AGENTS[key].name} bu so'rovni senga uzatdi. Ibrohimning so'rovi: ${t}`, 700);
    if (r2) await agentMsg(c, hand, r2.replace(/\[\[\w+\]\]/g, '').trim());
  }
}

// Ertalabki hisobot — har kuni 08:00 (Toshkent)
setInterval(async () => {
  try {
    const d = nowTZ();
    if (d.getHours() === 8 && d.getMinutes() < 2) {
      const today = todayStr();
      if (lastMorningReport === today) return;
      lastMorningReport = today;
      const target = officeChat || ADMIN;
      const fin = await financeContext();
      const tasks = await ghReadAll('tasks-log.json');
      const tt = tasks.filter(l => l.date === today).map(l => (l.done ? '✅' : '⬜') + ' ' + l.text).join('\n');
      const rep = await aiText(AGENTS.sardor.sys,
        `Bugun ${today}. Quyidagi real ma'lumotlardan qisqa ertalabki hisobot tuz: kelishuvlar holati, qarzlar, oxirgi xarajatlar, bugungi vazifalar. Faqat mavjud ma'lumotga asoslan.\n\n${fin}\n\nBUGUNGI VAZIFALAR:\n${tt || '—'}`, 800);
      if (rep) await agentMsg(target, 'sardor', '🌅 *Ertalabki hisobot*\n\n' + rep);
    }
  } catch (e) { console.error('morning report:', e.message); }
}, 55 * 1000);
loadOfficeConfig();

// ─── Invoice photo handler ────────────────────────────────────
async function handleInvoicePhoto(chatId, photo) {
  try {
    await msg(chatId, '⏳ Nakładnoy o\'qilmoqda...');
    const fi = await api('getFile', { file_id: photo[photo.length-1].file_id });
    const url = 'https://api.telegram.org/file/bot' + BOT + '/' + fi.result.file_path;
    const imgBuf = await downloadBuffer(url);
    const base64img = imgBuf.toString('base64');

    const body = JSON.stringify({
      model: 'llama-3.2-90b-vision-preview', max_tokens: 1000,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + base64img } },
        { type: 'text', text: 'Bu nakładnoy rasmidan ma\'lumotlarni chiqar. FAQAT JSON (markdown yo\'q):\n{"supplier":"nom","invoice_no":"raqam","date":"DD.MM.YYYY","total":son,"currency":"USD","items":[{"name":"nom","qty":son,"price":son,"total":son}]}' }
      ]}]
    });

    const parsed = await new Promise(resolve => {
      const req = https.request({
        hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(JSON.parse(d).choices[0].message.content.replace(/```json|```/g,'').trim())); } catch(e){ resolve(null); } });
      });
      req.on('error', () => resolve(null)); req.write(body); req.end();
    });

    if (!parsed) { await msg(chatId, '❌ O\'qib bo\'lmadi. Matnni yuboring.'); return; }

    invoiceState[chatId] = { step: 'ask_client', invoice: parsed };
    const itemList = (parsed.items||[]).map(i => `  • ${i.name}: ${i.qty}×${i.price}=${i.total}`).join('\n') || '  —';
    await msg(chatId, `📄 *Nakładnoy №${parsed.invoice_no||'—'}*\n🏭 ${parsed.supplier||'—'}\n\n${itemList}\n\n*Jami: ${parsed.total} ${parsed.currency||'USD'}*\n\n❓ *Qaysi mijoz uchun?*`);
  } catch (e) { await msg(chatId, '❌ Xatolik: ' + e.message); }
}

// ─── /hisobot ─────────────────────────────────────────────────
async function sendReport(chatId) {
  try {
    const month = ('0'+(nowTZ().getMonth()+1)).slice(-2) + '.' + nowTZ().getFullYear();
    const [hr, exp, meetings, deals, tasks, personal] = await Promise.all([
      ghReadAll('hr-log.json'), ghReadAll('expenses-log.json'),
      ghReadAll('meetings-log.json'), ghReadAll('deals-log.json'),
      ghReadAll('tasks-log.json'), ghReadAll('expenses-personal-log.json')
    ]);

    const inMonth = arr => arr.filter(l => (l.date||'').slice(3) === month);
    const today = todayStr();

    let text = `📊 *${month} — Hisobot*\n\n`;

    // Absences
    const kelmadi = inMonth(hr).filter(l => l.parsed && l.parsed.present === false);
    if (kelmadi.length) {
      const byW = {};
      kelmadi.forEach(l => { const w = l.parsed.worker; if(!byW[w]) byW[w]=[]; byW[w].push(l.date); });
      text += '❌ *Kelmagan kunlar:*\n';
      for (const [w,d] of Object.entries(byW)) text += `  • ${w}: ${d.sort().join(', ')}\n`;
      text += '\n';
    }

    // Advances
    const avans = inMonth(hr).filter(l => l.parsed && l.parsed.type === 'hr' && l.parsed.amount);
    if (avans.length) {
      const total = avans.reduce((s,l)=>s+(l.amount||0),0);
      text += `💵 *Avanslar (jami $${total}):*\n`;
      avans.forEach(l => text += `  • ${l.date} — ${l.parsed.worker}: $${l.amount}\n`);
      text += '\n';
    }

    // Deals this month
    const monthDeals = inMonth(deals);
    if (monthDeals.length) {
      const total = monthDeals.reduce((s,l)=>s+(l.amount||0),0);
      text += `💼 *Kelishuvlar (jami $${total}):*\n`;
      monthDeals.forEach(l => text += `  • ${l.date} — ${l.client}: $${l.amount||0}\n`);
      text += '\n';
    }

    // Expenses
    const exp2 = inMonth(exp);
    if (exp2.length) {
      const total = exp2.reduce((s,l)=>s+(l.total||0),0);
      text += `🧾 *Ishlab. xarajatlar ($${total}):*\n`;
      exp2.forEach(l => text += `  • ${l.date} — ${l.client||l.deal||l.supplier||'—'}: $${l.total}\n`);
      text += '\n';
    }

    // Personal expenses
    const pers = inMonth(personal);
    if (pers.length) {
      const usd = pers.filter(l=>l.currency==='USD').reduce((s,l)=>s+(l.amount||0),0);
      const uzs = pers.filter(l=>l.currency==='UZS').reduce((s,l)=>s+(l.amount||0),0);
      text += `💸 *Shaxsiy xarajatlar:*\n`;
      pers.forEach(l => text += `  • ${l.date} — ${l.text}: ${l.amount} ${l.currency||''}\n`);
      if (usd) text += `  USD jami: $${usd}\n`;
      if (uzs) text += `  UZS jami: ${uzs.toLocaleString()} so'm\n`;
      text += '\n';
    }

    // Today's tasks
    const todayTasks = tasks.filter(l => l.date === today && !l.done);
    if (todayTasks.length) {
      text += `📌 *Bugungi vazifalar:*\n`;
      todayTasks.forEach(l => text += `  ⬜ ${l.text}\n`);
    }

    if (!kelmadi.length && !avans.length && !monthDeals.length && !exp2.length && !pers.length) text += '_Hali ma\'lumot yo\'q_';

    await msg(chatId, text);
  } catch (e) { await msg(chatId, '❌ Xato: ' + e.message); }
}

// ─── /bugun — daily briefing ──────────────────────────────────
async function sendDailyBriefing(chatId) {
  try {
    const today = todayStr();
    const [meetings, tasks] = await Promise.all([ghReadAll('meetings-log.json'), ghReadAll('tasks-log.json')]);
    const todayMeetings = meetings.filter(l => l.date === today).sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    const todayTasks = tasks.filter(l => l.date === today && !l.done);

    let text = `☀️ *${today} — Bugungi reja*\n\n`;

    if (todayMeetings.length) {
      text += '🤝 *Uchrashuvlar:*\n';
      todayMeetings.forEach(l => text += `  • ${l.time||'—'} — ${l.client||l.text}\n`);
      text += '\n';
    }
    if (todayTasks.length) {
      text += '📌 *Vazifalar:*\n';
      todayTasks.forEach(l => text += `  ⬜ ${l.text}\n`);
    }
    if (!todayMeetings.length && !todayTasks.length) text += '_Bugun uchun rejalashtirilgan narsa yo\'q_\n\nYaxshi kun! 💪';

    await msg(chatId, text);
  } catch (e) { await msg(chatId, '❌ Xato: ' + e.message); }
}

// ─── Reminder checker (runs every minute) ────────────────────
let lastMorningBriefing = '';
async function checkReminders() {
  try {
    const now = nowTZ();
    const today = todayStr();
    const hhmm = nowHHMM();

    // Morning briefing at 09:00
    if (hhmm === '09:00' && lastMorningBriefing !== today) {
      lastMorningBriefing = today;
      await sendDailyBriefing(ADMIN);
    }

    // Meeting reminders
    const meetings = await ghReadAll('meetings-log.json');
    let changed = false;

    for (const m of meetings) {
      if (m.reminded || m.date !== today || !m.time) continue;
      const [hh, mm] = m.time.split(':').map(Number);
      const meetingDate = new Date(now);
      meetingDate.setHours(hh, mm, 0, 0);
      const diffMin = Math.round((meetingDate - now) / 60000);
      const remindAt = m.remind_before_min || 30;

      if (diffMin <= remindAt && diffMin > 0) {
        await msg(ADMIN, `⏰ *Eslatma!*\n\n🤝 ${diffMin} daqiqadan: *${m.client||m.text}*\n🕐 Soat ${m.time}`);
        m.reminded = true;
        changed = true;
      }
    }

    if (changed) {
      const { sha } = await ghGet('meetings-log.json');
      await ghPut('meetings-log.json', JSON.stringify(meetings, null, 2), sha, 'Reminder sent');
    }
  } catch (e) { /* silent */ }
}

// Start reminder checker every 60 seconds
setInterval(checkReminders, 60000);

// ─── Main handler ─────────────────────────────────────────────
async function handle(upd) {
  try {
    if (upd.callback_query) {
      const cq = upd.callback_query; const c = cq.message.chat.id; await acb(cq.id);
      const cd = cq.data || '';
      // ── Guruhda davomat/avans tasdiqlash ──
      if (cd.startsWith('ofc_ok_') || cd.startsWith('ofc_no_')) {
        const ok = cd.startsWith('ofc_ok_');
        const pid = cd.slice(7);
        const pend = officePending[pid];
        if (!pend) { await api('sendMessage', { chat_id: c, text: '⚠️ Bu so\'rov eskirgan.' }); return; }
        delete officePending[pid];
        if (!ok) { await api('sendMessage', { chat_id: c, text: '❌ Bekor qilindi.' }); return; }
        if (pend.kind === 'absence') {
          const { staff } = await findStaff(pend.staffId);
          if (!staff) { await api('sendMessage', { chat_id: c, text: '⚠️ Xodim topilmadi.' }); return; }
          // bugundan boshlab N ish kunini kelmagan deb belgilaymiz
          let added = 0; const d = nowTZ();
          while (added < pend.days) {
            if (d.getDay() !== 0) { await staffAddAbsence(c, pend.staffId, fmtDate(new Date(d))); added++; }
            d.setDate(d.getDate() + 1);
          }
          await api('sendMessage', { chat_id: c, parse_mode: 'Markdown', text: `✅ ${staff.name} — ${pend.days} kun kelmagan deb belgilandi.` });
        } else if (pend.kind === 'advance') {
          const name = await staffAddAdvance(c, pend.staffId, pend.usd);
          await api('sendMessage', { chat_id: c, parse_mode: 'Markdown', text: `✅ ${name} — $${pend.usd.toFixed(2)} avans yozildi.` });
        }
        return;
      }
      // ── Buyurtmalar bo'limi navigatsiyasi ──
      if (cd === 'start_order') { await orderStart(c); return; }
      if (cd === 'menu_orders') { await showOrdersList(c, 'active'); return; }
      if (cd === 'menu_done') { await showOrdersList(c, 'done'); return; }
      if (cd === 'menu_cancelled') { await showOrdersList(c, 'cancelled'); return; }
      if (cd === 'menu_staff') { await showStaffList(c); return; }
      if (cd === 'menu_home') { await showHomeMenu(c); return; }
      // ── Xodimlar ──
      if (cd === 'stf_add') { await staffAddStart(c); return; }
      if (cd.startsWith('stf_open_')) { await showStaffCard(c, cd.slice(9)); return; }
      if (cd.startsWith('stf_adv_')) { await staffAdvStart(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_abs_')) { const name = await staffAddAbsence(c, cd.slice(8)); if (name) { await msg(c, `❌ ${name} — bugun kelmagan deb belgilandi.`); await showStaffCard(c, cd.slice(8)); } return; }
      if (cd.startsWith('stf_sal_')) { await staffSalStart(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_del_')) { await staffDelete(c, cd.slice(8)); return; }
      if (cd.startsWith('cl_back_')) { await showOrdersList(c, cd.slice(8)); return; }
      if (cd.startsWith('ord_open_')) { await showClientMenu(c, cd.slice(9)); return; }
      if (cd.startsWith('cl_report_')) { await showClientReport(c, cd.slice(10)); return; }
      if (cd.startsWith('cl_info_')) { await showClientInfo(c, cd.slice(8)); return; }
      if (cd.startsWith('cl_pay_')) { await showClientPayments(c, cd.slice(7)); return; }
      if (cd.startsWith('cl_exp_')) { await showClientExpenses(c, cd.slice(7)); return; }
      if (cd.startsWith('cl_stage_')) { await showClientStage(c, cd.slice(9)); return; }
      if (cd.startsWith('cl_finish_')) { await finishOrder(c, cd.slice(10)); return; }
      if (cd.startsWith('cl_cancel_')) { await cancelOrderStart(c, cd.slice(10)); return; }
      if (cd.startsWith('stg_')) { const rest = cd.slice(4); const li = rest.lastIndexOf('_'); await setStage(c, rest.slice(0, li), +rest.slice(li + 1)); return; }
      if (cd.startsWith('pay_add_')) { await payAddStart(c, cd.slice(8)); return; }
      if (cd.startsWith('exp_add_')) { await expAddStart(c, cd.slice(8)); return; }
      if (cd === 'exp_more') { if (orderState[c]) { orderState[c].step = 'exp_name'; await btn(c, '💸 *Mahsulot nomi:*', [[{ text: '❌ Bekor', callback_data: 'ord_open_' + orderState[c].expId }]]); } return; }
      if (cd === 'exp_done') { if (orderState[c] && orderState[c].expProducts && orderState[c].expProducts.length) { await expSave(c); } else { await msg(c, '❗️ Kamida bitta mahsulot qo\'shing.'); if (orderState[c]) await expProductsMenu(c); } return; }
      // ── Yangi buyurtma oqimi tugmalari ──
      if (cd.startsWith('ord_')) { if (await orderHandleCallback(c, cd)) return; }
      if (cd==='til_uz'){state[c]={lang:'uz',step:'ask_file'};await btn(c,'Sizda tayyor loyiha yoki xona rasmi bormi?',[[{text:'Ha, bor',callback_data:'file_ha'}],[{text:"Yo'q",callback_data:'file_yoq'}]]);}
      else if(cq.data==='til_ru'){state[c]={lang:'ru',step:'ask_file'};await btn(c,'U vas est gotoviy proekt?',[[{text:'Da, est',callback_data:'file_ha'}],[{text:'Net',callback_data:'file_yoq'}]]);}
      else if(cq.data==='file_ha'){const l=(state[c]||{}).lang||'uz';state[c]={lang:l,step:'waiting_file'};await msg(c,l==='uz'?'Fayl yuboring:':'Otpravte fayl:');}
      else if(cq.data==='file_yoq'){const l=(state[c]||{}).lang||'uz';state[c]={lang:l,step:'done'};await anketa(c,l);}
      return;
    }

    await secretsReady;
    if (!upd.message) return;
    const c = upd.message.chat.id;

    // AI Office — guruh xabarlari
    if (upd.message.chat.type === 'group' || upd.message.chat.type === 'supergroup') {
      await handleOffice(upd); return;
    }

    const isAdmin = String(c) === String(ADMIN);
    const ism = upd.message.from.first_name || 'Mijoz';
    const un = upd.message.from.username ? '@'+upd.message.from.username : '-';
    const t = upd.message.text || '';

    // Admin voice
    if (upd.message.voice && isAdmin) { await handleVoice(c, upd.message.voice); return; }

    // Admin video
    if ((upd.message.video || upd.message.video_note) && isAdmin) { await handleVideo(c, upd.message.video || upd.message.video_note); return; }
    if (upd.message.document && isAdmin && (upd.message.document.mime_type||'').startsWith('video/')) { await handleVideo(c, upd.message.document); return; }

    // Admin photo → invoice
    if (upd.message.photo && isAdmin) {
      if (invoiceState[c]?.step === 'ask_client') { await msg(c, '❓ Mijoz ismini *matn* yuboring:'); return; }
      await handleInvoicePhoto(c, upd.message.photo); return;
    }

    // Invoice client reply
    if (isAdmin && invoiceState[c]?.step === 'ask_client') {
      const inv = invoiceState[c].invoice;
      const today = todayStr();
      const entry = {
        date: inv.date || today, title: `🧾 ${inv.date||today} | ${t} | ${inv.supplier} | $${inv.total}`,
        supplier: inv.supplier, invoice_no: inv.invoice_no, client: t.trim(),
        items: inv.items||[], total: inv.total||0, currency: inv.currency||'USD', ts: new Date().toISOString()
      };
      const saved = await ghWrite('expenses-log.json', entry, entry.title);
      delete invoiceState[c];
      await msg(c, (saved?'✅ Saqlandi!\n\n':'⚠️ Xato!\n\n') + `🧾 *${inv.supplier}*\n👤 ${t}\n💰 $${inv.total}`);
      return;
    }

    // Yangi buyurtma / xarajat / to'lov / bekor oqimi faol bo'lsa
    if (isAdmin && orderState[c]) {
      const st = orderState[c];
      if (t === '/bekor' || t === '/cancel') { delete orderState[c]; await msg(c, '❌ Bekor qilindi.'); return; }
      if (t && t.startsWith('/')) { delete orderState[c]; }  // boshqa buyruq → oqim bekor
      else if (st.step === 'cancel_reason') { const id = st.cancelId; delete orderState[c]; await cancelOrderSave(c, id, t.trim()); return; }
      else if (st.step === 'pay_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Summani to\'g\'ri yozing. Masalan: 2000000 yoki 200$'); return; }
        const id = st.payId; delete orderState[c]; await paySave(c, id, uzs); return;
      }
      else if (st.step === 'exp_name') { st.expCur = { name: t.trim() }; st.step = 'exp_qty'; await btn(c, '🔢 *Soni:*\n\n_Masalan: 3_', [[{ text: '❌ Bekor', callback_data: 'ord_open_' + st.expId }]]); return; }
      else if (st.step === 'exp_qty') {
        const q = parseFloat(t.replace(/[^\d.]/g, ''));
        if (isNaN(q) || q <= 0) { await msg(c, '❗️ Soni raqam bo\'lsin. Masalan: 3'); return; }
        st.expCur.qty = q; st.step = 'exp_price';
        await btn(c, '💵 *Narxi (1 tasi uchun):*\n\n_So\'mda yoki $ bilan. Masalan: 549000 yoki 45$_', [[{ text: '❌ Bekor', callback_data: 'ord_open_' + st.expId }]]); return;
      }
      else if (st.step === 'exp_price') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Narxni to\'g\'ri yozing. Masalan: 549000 yoki 45$'); return; }
        st.expCur.price_uzs = uzs; st.expCur.rate = USD_UZS;
        st.expProducts.push(st.expCur); st.expCur = {}; st.step = 'exp_menu';
        await expProductsMenu(c); return;
      }
      // ── Xodim oqimlari ──
      else if (st.step === 'stf_name') { st.staffName = t.trim(); st.step = 'stf_salary'; await btn(c, `💵 *${t.trim()}* — oyligi (dollarda):\n\n_Masalan: 600_`, [[{ text: '❌ Bekor', callback_data: 'menu_staff' }]]); return; }
      else if (st.step === 'stf_salary') {
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (isNaN(n) || n <= 0) { await msg(c, '❗️ Oylikni raqam bilan yozing. Masalan: 600'); return; }
        const name = st.staffName; delete orderState[c]; await staffSaveNew(c, name, n); return;
      }
      else if (st.step === 'stf_adv_amount') {
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (isNaN(n) || n <= 0) { await msg(c, '❗️ Summani raqam bilan yozing. Masalan: 100'); return; }
        const id = st.staffId; delete orderState[c];
        const name = await staffAddAdvance(c, id, n);
        if (name) { await msg(c, `✅ Avans qo'shildi: *${name}* — $${n}`); await showStaffCard(c, id); }
        return;
      }
      else if (st.step === 'stf_sal_amount') {
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (isNaN(n) || n <= 0) { await msg(c, '❗️ Oylikni raqam bilan yozing.'); return; }
        const id = st.staffId; delete orderState[c]; await staffSetSalary(c, id, n); return;
      }
      else if (await orderHandleText(c, t)) return;
    }

    // Commands
    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g,'')] = c;

    if (isAdmin && (t === '/yangi' || t === '/buyurtma')) { await orderStart(c); return; }

    if (t === '/start') {
      state[c] = {};
      if (isAdmin) {
        await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
          text: '👋 *Assalomu alaykum, Ibrohim!*\n\n📱 *Botga nima yuborsa bo\'ladi:*\n\n🎤 *Ovozli xabar:*\n  • "Sherzod kelmadi"\n  • "Diyor 100 dollar avans oldi"\n  • "Soat 3 da Boxodir aka bilan uchrashuv"\n  • "Shaxsiy xarajat 50000 so\'m benzin"\n\n📸 *Nakładnoy rasmi* → mijoz so\'raldi → saqlanadi\n\n📋 *Buyruqlar:*\n/hisobot — oylik hisobot\n/bugun — bugungi reja\n/vazifalar — bugungi vazifalar',
          reply_markup: { inline_keyboard: [
            [{ text: '🆕 Yangi buyurtma', callback_data: 'start_order' }],
            [{ text: '📁 Buyurtmalar', callback_data: 'menu_orders' }],
            [{ text: '✅ Tugatilganlar', callback_data: 'menu_done' }, { text: '🚫 Bekor qilinganlar', callback_data: 'menu_cancelled' }],
            [{ text: '👷 Xodimlar', callback_data: 'menu_staff' }]
          ] } });
        return;
      }
      await btn(c, 'MEBEL BY IBROHIM\n\nTilni tanlang:', [[{text:"O'zbek tili",callback_data:'til_uz'}],[{text:'Russkiy yazyk',callback_data:'til_ru'}]]);
      return;
    }

    if (isAdmin) {
      if (t === '/hisobot') { await sendReport(c); return; }
      if (t === '/bugun') { await sendDailyBriefing(c); return; }
      if (t === '/vazifalar') {
        const tasks = await ghReadAll('tasks-log.json');
        const today = todayStr();
        const todayTasks = tasks.filter(l => l.date === today);
        if (!todayTasks.length) { await msg(c, '📌 Bugun uchun vazifa yo\'q.'); return; }
        const lines = todayTasks.map((l,i) => `${l.done?'✅':'⬜'} ${i+1}. ${l.text}`).join('\n');
        await msg(c, `📌 *Bugungi vazifalar:*\n\n${lines}`);
        return;
      }
      // IG bot boshqaruvi
      if (t === '/igstop' || t.startsWith('/igstop ')) {
        const userId = t.split(' ')[1];
        if (userId) {
          igManualMode[userId] = Date.now();
          delete igConvHistory[userId];
          await msg(c, `⏸ Bot to'xtatildi: ${userId}\n/igstart ${userId} bilan qayta yoqing.`);
        } else {
          const paused = Object.keys(igManualMode).join(', ') || 'yo\'q';
          await msg(c, `⏸ Bot to'xtatilgan foydalanuvchilar: ${paused}\n\nTo\'xtatish: /igstop USER_ID\nQayta yoqish: /igstart USER_ID`);
        }
        return;
      }
      if (t.startsWith('/igstart ')) {
        const userId = t.split(' ')[1];
        if (userId) {
          delete igManualMode[userId];
          await msg(c, `▶️ Bot qayta yondi: ${userId}`);
        }
        return;
      }
    }

    if ((upd.message.photo || upd.message.document) && !isAdmin) {
      await msg(ADMIN, 'Yangi fayl! '+ism+' ('+un+') '+c);
      await fwd(ADMIN, c, upd.message.message_id);
      const s = state[c]||{};
      if (s.step==='waiting_file') { state[c]={lang:s.lang,step:'done'}; await msg(c,s.lang==='uz'?'Yuklandi!':'Zagruzhen!'); await anketa(c,s.lang); }
      return;
    }

    if (!(state[c]||{}).lang && !isAdmin) {
      await btn(c,'MEBEL BY IBROHIM\n\nTilni tanlang:',[[{text:"O'zbek tili",callback_data:'til_uz'}],[{text:'Russkiy yazyk',callback_data:'til_ru'}]]);
    }
  } catch (e) { console.error(e); }
}

// ─── Instagram ────────────────────────────────────────────────
const IG_TOKEN = (process.env.IG_TOKEN || '').trim().replace(/[\r\n]/g, '');
const IG_USER_ID = '17841464753251739';
const IG_VERIFY = 'mbi_secret_2024';
const OR_KEY = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';

// Conversation history: last 6 messages per user (3 turns)
const igConvHistory = {};

// Manual mode: users where Ibrohim manually replied — bot pauses for them
// Key: instagram user ID, Value: timestamp when paused
const igManualMode = {};
const IG_PAUSE_HOURS = 24; // hours to pause after manual reply

async function aiReply(text, userId) {
  // Init history for this user
  if (!igConvHistory[userId]) igConvHistory[userId] = [];
  const history = igConvHistory[userId];
  
  // Add user message to history
  history.push({ role: 'user', content: text });
  
  // Keep only last 6 messages
  while (history.length > 6) history.shift();
  
  const SYSTEM = `Sen MBI Mebel Instagram menejerisan. Ism: Kamol.

FAQAT O'ZBEK yoki RUS tilida yoz.

🔴 ASOSIY QOIDA: Suhbat tarixini o'qi. Mijoz aytgan narsani QAYTA SO'RAMA.

IDEAL SUXBAT — 3 QADAM:
1. Qaysi xona? (agar aytmagan bo'lsa)
2. Necha metr? (agar aytmagan bo'lsa)
3. Narx ayt + ANKETA yuborish

ANKETA QACHON YUBORISH:
Mijoz xona va metrni aytgandan keyin — DARHOL anketa linkini yubor.
O'zbek tilida: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html
Rus tilida: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html

MISOL — TO'G'RI OQIM:
Mijoz: "kuxnya kerak" → "Necha metr taxminan?"
Mijoz: "3 metr" → "3 metrli oshxona 390$dan! Anketani to'ldiring, kerak narsalarni bilaylik: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html"
Mijoz agar rus tilida yozsa → rus anketasini yubor

MBI MEBEL:
- Material: LMDF korpus + AKRIL fasad (faqat shu)
- Furnitura: BLUM yoki GTV
- Narx: Oshxona 390-600$/metr. Shkaf 300-500$/metr.
- Manzil: Yakkasaroy, Qushbegi 6 (Tekstilniy 6-blok)
- Tel: +998 91 135 44 66

QOIDALAR:
- Qisqa yoz: 1-2 jumla
- Anketa linkini faqat bir marta yubor (takrorlanmaydi)
- Mijoz "qimmat" desa → "Aniq narx o'lchamga qarab. Anketani to'ldirsangiz aniqlaymiz"
- Mijoz "adres" so'rasa → "Yakkasaroy, Qushbegi 6 (Tekstilniy 6-blok)"`;

  return new Promise((res) => {
    // Use GROQ API - fast, good Uzbek support
    const messages = [{ role: 'system', content: SYSTEM }, ...history];
    const body = JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      max_tokens: 200,
      messages: messages
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + GROQ_KEY
      }
    }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try {
          const reply = JSON.parse(d).choices?.[0]?.message?.content || `Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`;
          igConvHistory[userId].push({ role: 'assistant', content: reply });
          while (igConvHistory[userId].length > 6) igConvHistory[userId].shift();
          res(reply);
        }
        catch(e) {
          console.log('aiReply parse error:', d.slice(0,200));
          res(`Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`);
        }
      });
    });
    req.on('error', (e) => {
      console.log('aiReply network error:', e.message);
      res(`Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`);
    });
    req.write(body); req.end();
  });
}

async function igSend(to, text) {
  return new Promise((res) => {
    const body = JSON.stringify({ recipient: { id: to }, message: { text } });
    console.log('igSend to:', to, '| text:', text.slice(0,50));
    console.log('igSend IG_TOKEN:', IG_TOKEN ? IG_TOKEN.length + ' chars' : 'EMPTY!');
    const req = https.request({ 
      hostname: 'graph.instagram.com', 
      path: '/v21.0/' + IG_USER_ID + '/messages', 
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + IG_TOKEN }
    }, r => { 
      let d = ''; 
      r.on('data', c => d += c); 
      r.on('end', () => {
        console.log('igSend API response:', d.slice(0, 300));
        try { res(JSON.parse(d)); } catch(e) { res({}); }
      }); 
    });
    req.on('error', (e) => { console.log('igSend network error:', e.message); res({}); }); 
    req.write(body); 
    req.end();
  });
}

async function handleIG(body) {
  try {
    if (body.object !== 'instagram') return;
    for (const entry of (body.entry || [])) {
      for (const m of (entry.messaging || [])) {
        const from = m.sender?.id;
        const text = m.message?.text;
        if (!from || !text) continue;

        // Skip echo messages (our own sent messages coming back)
        if (m.message?.is_echo) continue;

        console.log('IG DM from:', from, 'text:', text);

        // Check if bot is paused for this user
        if (igManualMode[from]) {
          const hoursPassed = (Date.now() - igManualMode[from]) / (1000 * 3600);
          if (hoursPassed < IG_PAUSE_HOURS) {
            console.log('Bot paused for user:', from, '- skipping auto-reply');
            continue; // Bot paused — don't auto-reply
          } else {
            // Pause expired — re-enable bot
            delete igManualMode[from];
          }
        }

        // Auto-reply
        let reply;
        try {
          reply = await aiReply(text, from);
        } catch(aiErr) {
          console.error('aiReply xato:', aiErr.message);
          await msg(ADMIN, `⚠️ *IG bot xatolik*\nMijoz: ${from}\nXabar: "${text.slice(0,50)}"\nXato: ${aiErr.message}`);
          reply = `Salom! Mebel haqida savol uchun: +998 91 135 44 66`;
        }

        try {
          const sendResult = await igSend(from, reply);
          if (sendResult.error) {
            await msg(ADMIN, `⚠️ *IG javob yuborilmadi*\nMijoz: ${from}\nXato: ${sendResult.error.message || JSON.stringify(sendResult.error).slice(0,100)}`);
          }
        } catch(sendErr) {
          console.error('igSend xato:', sendErr.message);
          await msg(ADMIN, `⚠️ *IG bot ishlamadi*\nMijoz: ${from}\nXato: ${sendErr.message}`);
        }
      }
    }
  } catch(e) { 
    console.error('IG error:', e);
    await msg(ADMIN, `❌ handleIG xato: ${e.message}`);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  // Instagram verify
  if (req.method === 'GET' && req.url?.startsWith('/instagram')) {
    const u = new URL(req.url, 'http://localhost');
    if (u.searchParams.get('hub.verify_token') === IG_VERIFY) {
      res.writeHead(200); res.end(u.searchParams.get('hub.challenge')); return;
    }
    res.writeHead(403); res.end(); return;
  }
  // Instagram events
  if (req.method === 'POST' && req.url === '/instagram') {
    let b = ''; req.on('data', c => b += c);
    req.on('end', async () => { try { await handleIG(JSON.parse(b)); } catch(e) {} res.writeHead(200); res.end('OK'); }); return;
  }
  if (req.method==='POST' && req.url==='/webhook') {
    let b=''; req.on('data',c=>b+=c);
    req.on('end', async ()=>{ try{await handle(JSON.parse(b));}catch(e){} res.writeHead(200);res.end('OK'); });
  } else if (req.method==='POST' && req.url==='/notify') {
    let b=''; req.on('data',c=>b+=c);
    req.on('end', async ()=>{
      try {
        const d=JSON.parse(b); const phone=(d.phone||'').replace(/\D/g,'');
        const chatId=phoneToChat[phone]||null;
        if(chatId){
          const uz='Tabriklaymiz, '+d.name+'!\n\nArizangiz yuborildi. Tez orada bog\'lanamiz!\n\n+998 91 135 44 66';
          const ru='Pozdavlyaem, '+d.name+'!\n\nZayavka otpravlena. Svyazhemsya!\n\n+998 91 135 44 66';
          await msg(chatId, d.lang==='uz'?uz:ru);
        }
      } catch(e){}
      res.writeHead(200,{'Access-Control-Allow-Origin':'*'});res.end('OK');
    });
  } else if (req.method==='OPTIONS') {
    res.writeHead(200,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});res.end();
  } else if (req.method === 'GET' && req.url === '/rawdump') {
    const token = IG_TOKEN;
    const hex = Buffer.from(token).toString('hex');
    const chars = [...token].map(c => c.charCodeAt(0));
    const nonAscii = chars.filter(c => c > 127);
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(`len=${token.length}\nfirst40=${token.slice(0,40)}\nlast20=${token.slice(-20)}\nhas_non_ascii=${nonAscii.length > 0}\nnon_ascii_codes=${JSON.stringify(nonAscii)}\nhex_first40=${hex.slice(0,80)}`);
    return;

  } else if (req.method === 'GET' && req.url && req.url.startsWith('/convos')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const limit = urlObj.searchParams.get('limit') || '20';
    const convoId = urlObj.searchParams.get('id');

    const makeIgReq = (path, cb) => {
      const r = https.request({ hostname: 'graph.instagram.com', path, method: 'GET' }, res2 => {
        let d = ''; res2.on('data', c => d += c); res2.on('end', () => cb(d));
      });
      r.on('error', e => cb('{"error":"' + e.message + '"}'));
      r.end();
    };

    if (convoId) {
      const path = '/v21.0/' + convoId + '/messages?fields=id,from,message,created_time&limit=50&access_token=' + IG_TOKEN;
      makeIgReq(path, d => {
        try {
          const data = JSON.parse(d);
          const msgs = (data.data || []).reverse().map(m =>
            '[' + (m.created_time || '').slice(0,10) + '] ' + (m.from && (m.from.username || m.from.id) || '?') + ': ' + (m.message || '(media)')
          ).join('\n');
          res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
          res.end(msgs || 'No messages\n' + d.slice(0,300));
        } catch(e) { res.writeHead(200); res.end('Parse error: ' + d.slice(0,300)); }
      });
    } else {
      const path = '/v21.0/' + IG_USER_ID + '/conversations?fields=id,participants,updated_time&limit=' + limit + '&access_token=' + IG_TOKEN;
      makeIgReq(path, d => {
        try {
          const data = JSON.parse(d);
          if (data.error) { res.writeHead(200); res.end('API Error: ' + JSON.stringify(data.error)); return; }
          const convos = (data.data || []).map(c => {
            const parts = (c.participants && c.participants.data || []).map(p => p.username || p.id).join(', ');
            return 'ID: ' + c.id + ' | ' + (c.updated_time || '').slice(0,10) + ' | ' + parts;
          }).join('\n');
          res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'});
          res.end(convos || 'No conversations\n' + d.slice(0,300));
        } catch(e) { res.writeHead(200); res.end('Parse error: ' + d.slice(0,300)); }
      });
    }
    return;
  } else if (req.method === 'GET' && req.url?.startsWith('/verify')) {
    const token = IG_TOKEN;
    const encoded = encodeURIComponent(token);
    const makeReq = (opts, cb) => {
      const r = https.request(opts, rs => {
        let d = ''; rs.on('data', c => d += c); rs.on('end', () => cb(d));
      });
      r.on('error', e => cb('ERR:' + e.message));
      r.end();
    };
    let results = `Token: len=${token.length} first20=${token.slice(0,20)}\n`;
    // Test 1: graph.instagram.com /me Bearer header (new Instagram Business API)
    makeReq({ hostname:'graph.instagram.com', path:'/v21.0/me?fields=id,name,username', method:'GET', headers:{'Authorization':'Bearer '+token} }, d1 => {
      results += 'Test1 instagram.com /me Bearer: ' + d1 + '\n';
      // Test 2: graph.instagram.com with access_token query param
      makeReq({ hostname:'graph.instagram.com', path:'/v21.0/me?fields=id,name&access_token='+encoded, method:'GET' }, d2 => {
        results += 'Test2 instagram.com /me qp: ' + d2 + '\n';
        // Test 3: graph.facebook.com with IG user ID Bearer
        makeReq({ hostname:'graph.facebook.com', path:'/v21.0/'+IG_USER_ID+'?fields=id,name', method:'GET', headers:{'Authorization':'Bearer '+token} }, d3 => {
          results += 'Test3 facebook.com /userID Bearer: ' + d3;
          res.writeHead(200, {'Content-Type': 'text/plain'});
          res.end(results);
        });
      });
    });
    return;
  } else if (req.method === 'GET' && req.url?.startsWith('/exchange')) {
    const u = new URL(req.url, 'http://localhost');
    const authCode = u.searchParams.get('code');
    if (!authCode) { res.writeHead(400); res.end('no code'); return; }
    
    const postData = new URLSearchParams({
      client_id: '1689794002143625',
      client_secret: 'eb2d0afff6b0845abf068abf8bb7e248',
      grant_type: 'authorization_code',
      redirect_uri: 'https://yakubovibrohim.github.io/mbi-bot/callback.html',
      code: authCode
    }).toString();
    
    const igReq = https.request({
      hostname: 'api.instagram.com', path: '/oauth/access_token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) }
    }, igRes => {
      let data = '';
      igRes.on('data', c => data += c);
      igRes.on('end', async () => {
        try {
          const result = JSON.parse(data);
          const shortToken = result.access_token;
          if (shortToken) {
            // Long-lived token olish
            const llReq = https.request({
              hostname: 'graph.instagram.com',
              path: '/access_token?grant_type=ig_exchange_token&client_secret=eb2d0afff6b0845abf068abf8bb7e248&access_token=' + encodeURIComponent(shortToken),
              method: 'GET'
            }, llRes => {
              let llData = '';
              llRes.on('data', c => llData += c);
              llRes.on('end', () => {
                try {
                  const ll = JSON.parse(llData);
                  const finalToken = ll.access_token || shortToken;
                  res.writeHead(200, {'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*'});
                  res.end('<h2>TOKEN:</h2><p style="word-break:break-all">' + finalToken + '</p><p>Bu tokenni Claude ga yuboring!</p>');
                } catch(e) {
                  res.writeHead(200);
                  res.end('Short token: ' + shortToken);
                }
              });
            });
            llReq.on('error', () => {
              res.writeHead(200);
              res.end('Short token: ' + shortToken);
            });
            llReq.end();
          } else {
            res.writeHead(400); res.end(data);
          }
        } catch(e) { res.writeHead(500); res.end(data); }
      });
    });
    igReq.on('error', (e) => { res.writeHead(500); res.end(e.message); });
    igReq.write(postData);
    igReq.end();
    return;
  } else { res.writeHead(200);res.end('MBI Bot running!'); }
}).listen(PORT, ()=>console.log('Bot running on port '+PORT));



