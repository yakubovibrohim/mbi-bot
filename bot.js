const https = require('https');
const http = require('http');
const FormData = require('form-data');

let BOT = process.env.BOT_TOKEN || '';  // secrets'dan yuklanadi
const ADMIN    = '1487569442';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;

// Tizim xatolari jurnali (Botir o'qiydi) — oxirgi 100 ta
const sysErrors = [];
const __origConsoleError = console.error.bind(console);
console.error = (...a) => {
  try {
    const m = a.map(x => (x && x.message) ? x.message : (typeof x === 'string' ? x : JSON.stringify(x))).join(' ').slice(0, 200);
    sysErrors.push({ ts: new Date().toISOString(), msg: m });
    if (sysErrors.length > 100) sysErrors.shift();
  } catch (e) {}
  __origConsoleError(...a);
};
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
function todayStr() { const d = nowTZ(); return ('0'+d.getDate()).slice(-2) + '.' + ('0'+(d.getMonth()+1)).slice(-2) + '.' + d.getFullYear(); }
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
// Xodim uchun doimiy reply-keyboard (klaviatura ustida turadi)
function workerKeyboard() {
  return {
    keyboard: [
      [{ text: '✅ Keldim' }, { text: '🏁 Ketdim' }],
      [{ text: '🙋 Javob so\'rash' }, { text: '💵 Hisobim' }],
      [{ text: '📅 Jadval' }, { text: '🏠 Bosh menyu' }]
    ],
    resize_keyboard: true, is_persistent: true
  };
}
function msgKb(c, t, kb) { return api('sendMessage', { chat_id: c, text: t, parse_mode: 'Markdown', reply_markup: kb }); }
// Admin uchun doimiy reply-keyboard
function adminKeyboard() {
  return {
    keyboard: [
      [{ text: '🏠 Bosh menyu' }, { text: '📊 Hisobot' }],
      [{ text: '👷 Xodimlar' }, { text: '👥 Davomat' }],
      [{ text: '💰 Kassa' }, { text: '📋 Bugun' }]
    ],
    resize_keyboard: true, is_persistent: true
  };
}
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
  const m = String(s).match(/(\d{2})[.\/](\d{2})[.\/](\d{4})/);
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
      [{ text: '👷 Xodimlar', callback_data: 'menu_staff' }, { text: '💰 Kassa', callback_data: 'menu_cash' }],
      [{ text: '🏭 Ishxona xarajatlari', callback_data: 'menu_office_exp' }],
      [{ text: '👛 Shaxsiy xarajatlar', callback_data: 'menu_personal_exp' }],
      [{ text: '💳 Qarzlar', callback_data: 'menu_debts' }],
      [{ text: '📊 Umumiy hisobot', callback_data: 'menu_summary' }]
    ] } });
}

// ══════════════════════════════════════════════════════════════
// 2-BOSQICH: Xodimlar tizimi (oylik)
// staff-log.json: [{id,name,salary_usd,active,created,
//   absences:[{date}], advances:[{id,date,amount_usd}]}]
// ══════════════════════════════════════════════════════════════

const UZ_MONTHS = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentyabr','Oktyabr','Noyabr','Dekabr'];

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
// "DD.MM.YYYY" yoki "DD/MM/YYYY" → {y,m,d}
function dmyParts(s) {
  const mm = String(s).match(/(\d{2})[.\/](\d{2})[.\/](\d{4})/);
  if (!mm) return null;
  return { d: +mm[1], m: +mm[2] - 1, y: +mm[3] };
}

// Ish staji: "3 oy 1 kun" ko'rinishida
function tenureText(hireDate) {
  const p = dmyParts(hireDate);
  if (!p) return '';
  const from = new Date(p.y, p.m, p.d);
  const now = nowTZ();
  if (from > now) return '';
  let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  let dayDiff = now.getDate() - from.getDate();
  if (dayDiff < 0) {
    months -= 1;
    const prevMonthDays = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    dayDiff += prevMonthDays;
  }
  if (months < 0) months = 0;
  const parts = [];
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (years > 0) parts.push(`${years} yil`);
  if (remMonths > 0) parts.push(`${remMonths} oy`);
  parts.push(`${dayDiff} kun`);
  return parts.join(' ');
}

async function readStaff() {
  const { data, sha } = await ghRead('staff-log.json');
  let changed = false;
  for (const s of data) {
    if (!Array.isArray(s.absences)) { s.absences = []; changed = true; }
    if (!Array.isArray(s.advances)) { s.advances = []; changed = true; }
    if (s.hire_date === undefined) { s.hire_date = null; changed = true; }
    if (s.active === undefined) { s.active = true; changed = true; }
    if (s.created && s.created.indexOf('/') >= 0) { s.created = s.created.replace(/\//g, '.'); changed = true; }
    if (s.hire_date && s.hire_date.indexOf('/') >= 0) { s.hire_date = s.hire_date.replace(/\//g, '.'); changed = true; }
  }
  if (changed) { try { await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'migrate staff'); } catch (e) { console.error('staff migrate:', e.message); } }
  return data;
}
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
// Berilgan oy uchun bitta oylik hisob (carry-oversiz, faqat shu oy)
// partial=true bo'lsa, faqat shu kungacha o'tgan ish kunlarini sanaydi (joriy oy uchun)
// ─── Soat hisobi (yo'qlama tizimi) ────────────────────────────
// "HH:MM" → daqiqa (soat boshidan)
function hmToMin(hm) {
  const m = String(hm).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return (+m[1]) * 60 + (+m[2]);
}
function minToHm(min) {
  const h = Math.floor(min / 60), mm = Math.round(min % 60);
  return ('0' + h).slice(-2) + ':' + ('0' + mm).slice(-2);
}
// Bir kunlik yozuvdan oddiy va qo'shimcha soatni hisoblaydi.
// Qoidalar: ish oynasi 09:00–18:00. Oddiy = shu oyna ichidagi vaqt.
// 14:00 (840 daq) dan QAT'IY OLDIN kelgan bo'lsa −1 soat tushlik.
// Qo'shimcha = 18:00 dan keyingi vaqt (alohida, maoshsiz).
const WORK_START = 9 * 60;    // 09:00
const WORK_END = 18 * 60;     // 18:00
const LUNCH_CUTOFF = 14 * 60; // 14:00
const LUNCH_MIN = 60;         // 1 soat
const LATE_AFTER = 9 * 60 + 20;  // 09:20 — bundan keyin kech hisoblanadi
const EARLY_BEFORE = 18 * 60;    // 18:00 — bundan oldin ketsa erta hisoblanadi
function computeDayHours(inHm, outHm, leaveMin) {
  const inM = hmToMin(inHm), outM = hmToMin(outHm);
  if (inM == null || outM == null || outM <= inM) return { normalH: 0, extraH: 0 };
  // Oddiy oyna: max(in,9:00) .. min(out,18:00)
  const ns = Math.max(inM, WORK_START);
  const ne = Math.min(outM, WORK_END);
  let normalMin = Math.max(0, ne - ns);
  // tushlik: faqat 14:00 dan oldin kelgan bo'lsa
  if (inM < LUNCH_CUTOFF && normalMin > 0) normalMin = Math.max(0, normalMin - LUNCH_MIN);
  // javob (vaqtincha chiqish) soatlari ayriladi
  if (leaveMin && leaveMin > 0) normalMin = Math.max(0, normalMin - leaveMin);
  // qo'shimcha: 18:00 dan keyin
  const extraMin = Math.max(0, outM - Math.max(inM, WORK_END));
  return { normalH: normalMin / 60, extraH: extraMin / 60 };
}

function payrollForMonth(s, y, m, partial, uptoDay) {
  const totalWd = workdaysInMonth(y, m);
  const dailyUsd = s.salary_usd ? s.salary_usd / totalWd : 0;
  const hourlyUsd = s.salary_usd ? s.salary_usd / (totalWd * 8) : 0; // soatlik = oylik / (ish kunlari × 8)

  // Shu oyda attendance (soat) yozuvlari bormi?
  const att = (s.attendance || []).filter(a => { const p = dmyParts(a.date); return p && p.y === y && p.m === m; });
  const hasHours = att.length > 0;

  // KUNLIK rejim (eski oylar — attendance yo'q)
  const consideredWd = partial ? workdaysPassed(y, m, uptoDay) : totalWd;
  const absDates = (s.absences || []).filter(a => {
    const p = dmyParts(a.date); if (!p) return false;
    if (p.y !== y || p.m !== m) return false;
    if (new Date(p.y, p.m, p.d).getDay() === 0) return false;
    if (partial && p.d > uptoDay) return false;
    return true;
  });
  const absCount = absDates.length;
  const workedWd = Math.max(0, consideredWd - absCount);

  // avanslar (faqat tasdiqlangan)
  const advUsd = (s.advances || []).filter(a => {
    if (a.pending) return false; // tasdiqlanmagan hisobga olinmaydi
    const p = dmyParts(a.date); if (!p || p.y !== y || p.m !== m) return false;
    if (partial && p.d > uptoDay) return false;
    return true;
  }).reduce((sum, a) => sum + (a.amount_usd || 0), 0);
  // bonuslar (haqqa qo'shiladi)
  const bonusUsd = (s.bonuses || []).filter(b => {
    const p = dmyParts(b.date); if (!p || p.y !== y || p.m !== m) return false;
    if (partial && p.d > uptoDay) return false;
    return true;
  }).reduce((sum, b) => sum + (b.amount_usd || 0), 0);
  // qo'shimcha to'lovlar (ishlaganidan ortiq berilgan — "qo'shimcha haq")
  const extraPayUsd = (s.extra_pays || []).filter(b => {
    const p = dmyParts(b.date); if (!p || p.y !== y || p.m !== m) return false;
    if (partial && p.d > uptoDay) return false;
    return true;
  }).reduce((sum, b) => sum + (b.amount_usd || 0), 0);

  let earnedUsd, normalHours = 0, extraHours = 0;
  if (hasHours) {
    for (const a of att) {
      const d = computeDayHours(a.in, a.out, a.leave_min);
      normalHours += (a.normalH != null ? a.normalH : d.normalH);
      extraHours += (a.extraH != null ? a.extraH : d.extraH);
    }
    earnedUsd = normalHours * hourlyUsd;
  } else {
    earnedUsd = dailyUsd * workedWd;
  }
  earnedUsd += bonusUsd; // bonus haqqa qo'shiladi

  // oy yopilgan bo'lsa, balans 0 (qo'lda yopilgan oylar)
  const closed = (s.closed_months || []).find(cm => cm.y === y && cm.m === m);
  const monthBalance = closed ? 0 : (earnedUsd - advUsd);

  return { y, m, totalWd, dailyUsd, hourlyUsd, hasHours, absCount, workedWd, normalHours, extraHours, earnedUsd, advUsd, bonusUsd, monthBalance, closed: !!closed };
}

// Ishga kelgan oydan to joriy oygacha — har oy balansi + jami carry
// Qoldiq avtomatik keyingi oyga o'tadi (musbat=siz qarzdor, manfiy=xodim qarzdor)
function staffPayrollHistory(s) {
  const now = nowTZ();
  const cy = now.getFullYear(), cm = now.getMonth(), cd = now.getDate();
  // boshlanish oyi: hire_date bor bo'lsa o'sha, bo'lmasa joriy oy
  let sy, sm;
  const hp = dmyParts(s.hire_date);
  if (hp) { sy = hp.y; sm = hp.m; } else { sy = cy; sm = cm; }
  // agar manual_carry bo'lsa (eski oylar botdan oldin bo'lgan), o'shandan boshlanadi
  const history = [];
  let carry = s.opening_balance_usd || 0;
  let y = sy, m = sm;
  // xavfsizlik: ko'pi bilan 120 oy
  for (let i = 0; i < 120; i++) {
    const isCurrent = (y === cy && m === cm);
    const future = (y > cy || (y === cy && m > cm));
    if (future) break;
    const pr = payrollForMonth(s, y, m, isCurrent, cd);
    const carryIn = carry;
    const balance = carryIn + pr.monthBalance;
    history.push({ y, m, ...pr, carryIn, balance, isCurrent });
    carry = balance;
    if (isCurrent) break;
    m++; if (m > 11) { m = 0; y++; }
  }
  return { history, currentBalance: carry };
}

async function showStaffList(c) {
  const list = await readStaff();
  const active = list.filter(s => s.active !== false);
  const rows = active.map(s => [{ text: `👷 ${s.name} ($${s.salary_usd || 0})`, callback_data: 'stf_open_' + s.id }]);
  rows.push([{ text: '➕ Yangi xodim', callback_data: 'stf_add' }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'menu_home' }]);
  await btn(c, '👷 *Xodimlar*' + (active.length ? '' : '\n\n_Hozircha xodim yo\'q. «Yangi xodim» qo\'shing._'), rows);
}
// Admin: bugungi hammaning davomati (real vaqt)
async function showAllAttendance(c) {
  const list = (await readStaff()).filter(s => s.active !== false);
  const today = todayStr();
  let txt = `👥 *Bugungi davomat — ${today}*\n\n`;
  if (!list.length) { txt += '_Xodim yo\'q._'; await msg(c, txt); return; }
  for (const s of list) {
    const rec = (s.attendance || []).find(a => a.date === today);
    const absent = (s.absences || []).find(a => a.date === today);
    // bugun tasdiqlangan javob bormi
    const todayLeave = (s.leaves || []).find(l => l.date === today && l.status === 'approved');
    let line;
    if (absent) line = `❌ kelmadi${absent.reason ? ` (${absent.reason})` : ''}`;
    else if (rec && rec.in && rec.out) line = `✅ ${rec.in} → ${rec.out}${rec.late ? ' ⚠️kech' : ''}${rec.early ? ' 🏃erta' : ''}`;
    else if (rec && rec.in) line = `🟢 ishda (${rec.in} dan)${rec.late ? ' ⚠️kech' : ''}`;
    else line = `⚪️ hali belgilamagan`;
    txt += `👷 *${s.name}*: ${line}\n`;
    if (rec && rec.in_reason) txt += `   └ kech: _${rec.in_reason}_\n`;
    if (rec && rec.out_reason) txt += `   └ erta: _${rec.out_reason}_\n`;
    if (todayLeave) txt += `   └ 🙋 javob: ${todayLeave.type === 'partial' ? todayLeave.hours + ' soat' : todayLeave.type === 'early' ? 'erta ' + todayLeave.time : 'kelmaslik'}\n`;
  }
  await btn(c, txt, [[{ text: '🔄 Yangilash', callback_data: 'all_att' }], [{ text: '📋 Intizom hisoboti', callback_data: 'disc_report' }]]);
}
// Admin: oylik intizom hisoboti (kech/erta/kelmagan/javob)
async function showDisciplineReport(c) {
  const list = (await readStaff()).filter(s => s.active !== false);
  const now = nowTZ(); const mo = now.getMonth(), yr = now.getFullYear();
  const inMonth = (ds) => { const p = (ds || '').split('.'); return p.length === 3 && parseInt(p[1]) - 1 === mo && parseInt(p[2]) === yr; };
  let txt = `📋 *Intizom hisoboti — ${UZ_MONTHS[mo]}*\n\n`;
  if (!list.length) { txt += '_Xodim yo\'q._'; await msg(c, txt); return; }
  for (const s of list) {
    const att = (s.attendance || []).filter(a => inMonth(a.date));
    const lateCnt = att.filter(a => a.late).length;
    const earlyCnt = att.filter(a => a.early).length;
    const absCnt = (s.absences || []).filter(a => inMonth(a.date)).length;
    const leaveCnt = (s.leaves || []).filter(l => inMonth(l.requested || l.date)).length;
    txt += `👷 *${s.name}*\n`;
    txt += `   ⚠️ Kech: ${lateCnt}  🏃 Erta: ${earlyCnt}  ❌ Kelmagan: ${absCnt}  🙋 Javob: ${leaveCnt}\n`;
    // eng ko'p sabablar
    const reasons = att.filter(a => a.in_reason).map(a => a.in_reason);
    if (reasons.length) txt += `   _Kech sabablari: ${reasons.slice(0, 3).join(', ')}_\n`;
    txt += '\n';
  }
  await msg(c, txt);
}

async function showStaffCard(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Xodim topilmadi.'); return; }
  const { history, currentBalance } = staffPayrollHistory(s);
  const cur = history[history.length - 1] || {};
  const monthName = UZ_MONTHS[nowTZ().getMonth()];
  let hireLine = '';
  if (s.hire_date) { const tn = tenureText(s.hire_date); hireLine = `📅 Ishga kelgan: ${s.hire_date}${tn ? ' (' + tn + ')' : ''}\n`; }
  const balSign = currentBalance >= 0 ? `SIZ qarzdorsiz` : `${s.name} qarzdor`;
  const tgLine = s.tg_chat_id ? `📲 Telegram: ulangan ✅\n` : `📲 Telegram: ulanmagan ❌\n`;

  // shu oy ish ko'rsatkichi (soat yoki kun)
  let workLine;
  if (cur.hasHours) {
    workLine = `🕐 Ishlangan: ${(cur.normalHours || 0).toFixed(1)} soat` + (cur.extraHours ? ` + ${cur.extraHours.toFixed(1)} qo'shimcha` : '');
  } else {
    workLine = `✅ Ishlangan: ${cur.workedWd || 0} kun${cur.absCount ? ` (${cur.absCount} kelmagan)` : ''}`;
  }
  // tasdiq kutayotgan avanslar soni
  const pendingAdv = (s.advances || []).filter(a => a.pending).length;

  const txt = `👷 *${s.name}*\n\n` +
    hireLine + tgLine +
    `💵 Oylik: *$${s.salary_usd || 0}* · soatlik $${(cur.hourlyUsd || 0).toFixed(2)}\n\n` +
    `📊 *${monthName} (shu oy):*\n` +
    `${workLine}\n` +
    `📈 Hisoblangan haq: $${(cur.earnedUsd || 0).toFixed(2)}\n` +
    (cur.bonusUsd ? `🎁 Bonus: $${cur.bonusUsd.toFixed(2)}\n` : '') +
    `💸 Avans: $${(cur.advUsd || 0).toFixed(2)}\n` +
    `↪️ O'tgan oydan: ${fmtSigned(cur.carryIn || 0)}\n` +
    `━━━━━━━━━━━━\n` +
    `💵 *Joriy balans: ${fmtSigned(currentBalance)}*\n` +
    `_(${balSign})_` +
    (pendingAdv ? `\n\n⏳ ${pendingAdv} ta avans tasdiq kutmoqda` : '');
  await btn(c, txt, [
    [{ text: '💸 Avans qo\'shish', callback_data: 'stf_adv_' + id }, { text: '🎁 Bonus', callback_data: 'stf_bonus_' + id }],
    [{ text: '🕐 Davomat (kun-kun)', callback_data: 'stf_att_' + id }],
    [{ text: '📅 Oylik tarix', callback_data: 'stf_hist_' + id }, { text: '🔒 Oyni yopish', callback_data: 'stf_close_' + id }],
    [{ text: s.tg_chat_id ? '📲 Telegramni uzish' : '📲 Telegram biriktirish', callback_data: 'stf_tg_' + id }],
    [{ text: '✏️ Oylikni o\'zgartirish', callback_data: 'stf_sal_' + id }],
    [{ text: '🗑 Xodimni o\'chirish', callback_data: 'stf_del_' + id }],
    [{ text: '◀️ Ortga', callback_data: 'menu_staff' }]
  ]);
}

// $ belgili formatlash (musbat/manfiy)
function fmtSigned(usd) {
  const v = Math.round(usd * 100) / 100;
  return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
}

// Oylik tarix ko'rsatish
async function showStaffHistory(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const { history } = staffPayrollHistory(s);
  let txt = `📅 *${s.name} — oylik tarix*\n\n`;
  history.forEach(h => {
    const sign = h.balance >= 0 ? 'SIZ qarzdor' : `${s.name} qarzdor`;
    txt += `*${UZ_MONTHS[h.m]} ${h.y}*${h.isCurrent ? ' (joriy)' : ''}\n` +
      `  Ishlagan: ${h.workedWd} kun${h.absCount ? `, kelmagan ${h.absCount}` : ''}\n` +
      `  Topgani: $${h.earnedUsd.toFixed(2)}, avans: $${h.advUsd.toFixed(2)}\n` +
      `  O'tgan: ${fmtSigned(h.carryIn)} → Balans: *${fmtSigned(h.balance)}* (${sign})\n\n`;
  });
  await btn(c, txt, [[{ text: '◀️ Ortga', callback_data: 'stf_open_' + id }]]);
}

// Yangi xodim qo'shish
async function staffAddStart(c) {
  orderState[c] = { step: 'stf_name' };
  await btn(c, '➕ *Yangi xodim*\n\n👤 Ismini yozing:', [[{ text: '❌ Bekor', callback_data: 'menu_staff' }]]);
}
// Oylik kiritilgach — ishga kelgan sanani so'raydi
async function staffAskHireDate(c) {
  const st = orderState[c];
  st.step = 'stf_hire';
  await btn(c, `📅 *${st.staffName}* — ishga kelgan sanasi:\n\n_Yangi xodim bo'lsa «Bugundan». Eski xodim bo'lsa sanani yozing yoki «Noma'lum»._`, [
    [{ text: '📅 Bugundan', callback_data: 'stf_hire_today' }],
    [{ text: "⏭ Noma'lum", callback_data: 'stf_hire_skip' }],
    [{ text: '❌ Bekor', callback_data: 'menu_staff' }]
  ]);
}
async function staffSaveNew(c, name, salaryUsd, hireDate) {
  const { data, sha } = await ghRead('staff-log.json');
  data.push({ id: uid(), name: name.trim(), salary_usd: salaryUsd, active: true, created: todayStr(), hire_date: hireDate || null, opening_balance_usd: 0, absences: [], advances: [] });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff add: ' + name);
  let extra = hireDate ? `\n📅 Ishga kelgan: ${hireDate}` : '';
  await msg(c, `✅ Xodim qo'shildi: *${name}* — oylik $${salaryUsd}${extra}`);
  await showStaffList(c);
}


// Avans (tugma orqali)
async function staffAdvStart(c, id) {
  orderState[c] = { step: 'stf_adv_amount', staffId: id };
  await btn(c, '💸 *Avans summasi:*\n\n_$ bo\'lsa dollar, bo\'lmasa so\'m. Masalan: 100$ yoki 500000 (so\'m)_', [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
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

// ═══════════ YO'QLAMA / SOAT TIZIMI ═══════════

// Telegram biriktirish/uzish
async function staffTgToggle(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  if (s.tg_chat_id) {
    // uzish
    const { data, sha, idx } = await findStaff(id);
    delete data[idx].tg_chat_id;
    await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff tg unbind: ' + s.name);
    await msg(c, `📲 ${s.name} — Telegram uzildi.`);
    await showStaffCard(c, id);
    return;
  }
  // biriktirish: /start bosgan, hali ulanmagan foydalanuvchilarni ko'rsatamiz
  const pend = await ghReadAll('pending-tg.json');
  if (!pend.length) {
    await btn(c, `📲 *Telegram biriktirish — ${s.name}*\n\nXodim botga \`/start\` yozsin, keyin shu tugma orqali tanlaysiz.\n\n_Hozircha /start bosgan yangi foydalanuvchi yo'q._`, [[{ text: '🔄 Yangilash', callback_data: 'stf_tg_' + id }], [{ text: '◀️ Ortga', callback_data: 'stf_open_' + id }]]);
    return;
  }
  const rows = pend.map(p => [{ text: `${p.name || 'Foydalanuvchi'} (${p.chat_id})`, callback_data: 'stf_bindpick_' + id + '_' + p.chat_id }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'stf_open_' + id }]);
  await btn(c, `📲 *${s.name}* uchun Telegram tanlang:\n\n_Quyidagilar botga /start bosgan:_`, rows);
}

async function staffBindPick(c, payload) {
  // payload = "<staffId>_<chatId>"
  const us = payload.lastIndexOf('_');
  const id = payload.slice(0, us), chatId = payload.slice(us + 1);
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].tg_chat_id = chatId;
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff tg bind: ' + data[idx].name);
  // pending'dan o'chiramiz
  const pend = await ghReadAll('pending-tg.json');
  const np = pend.filter(p => String(p.chat_id) !== String(chatId));
  const ps = await ghRead('pending-tg.json');
  await ghPut('pending-tg.json', JSON.stringify(np, null, 2), ps.sha, 'pending tg remove');
  await msg(c, `✅ ${data[idx].name} Telegram'ga ulandi. Endi u botdan keldim/ketdim belgilashi mumkin.`);
  // xodimga xush kelibsiz
  try { await msg(chatId, `Assalomu alaykum, ${data[idx].name}!\n\nSiz MBI Mebel ish vaqti tizimiga ulandingiz. Har kuni ishga kelganda va ketganda shu yerda belgilab borasiz.`); } catch (e) {}
  await showStaffCard(c, id);
}

// Davomat ko'rish (kun-kun, shu oy)
async function showAttendance(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const now = nowTZ();
  const att = (s.attendance || []).filter(a => { const p = dmyParts(a.date); return p && p.y === now.getFullYear() && p.m === now.getMonth(); })
    .sort((a, b) => { const pa = dmyParts(a.date), pb = dmyParts(b.date); return pa.d - pb.d; });
  let txt = `🕐 *${s.name} — davomat (${UZ_MONTHS[now.getMonth()]})*\n\n`;
  if (!att.length) txt += '_Bu oyda hali yo\'qlama yozuvi yo\'q._';
  else {
    att.forEach(a => {
      const d = computeDayHours(a.in, a.out, a.leave_min);
      const nh = (a.normalH != null ? a.normalH : d.normalH);
      const eh = (a.extraH != null ? a.extraH : d.extraH);
      txt += `📅 ${a.date}: ${a.in || '—'}–${a.out || '...'} → ${nh.toFixed(1)} soat${eh ? ` (+${eh.toFixed(1)} qo'sh.)` : ''}\n`;
    });
  }
  await btn(c, txt, [[{ text: '◀️ Ortga', callback_data: 'stf_open_' + id }]]);
}

// Bonus
async function staffBonusStart(c, id) {
  orderState[c] = { step: 'stf_bonus_amount', staffId: id };
  await btn(c, '🎁 *Bonus summasi:*\n\n_$ bo\'lsa dollar, bo\'lmasa so\'m. Masalan: 35$_', [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
}
async function staffSaveBonus(c, id, amountUsd, reason) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].bonuses = data[idx].bonuses || [];
  data[idx].bonuses.push({ id: uid(), date: todayStr(), amount_usd: amountUsd, reason: reason || '' });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff bonus: ' + data[idx].name);
  await msg(c, `✅ Bonus qo'shildi: *${data[idx].name}* — $${amountUsd.toFixed(2)}`);
  // xodimga darrov xabar
  if (data[idx].tg_chat_id) {
    try { await msg(data[idx].tg_chat_id, `🎁 Siz $${amountUsd.toFixed(2)} bonus oldingiz, Ibrohim tomonidan!${reason ? '\n\nSabab: ' + reason : ''}`); } catch (e) {}
  }
  await showStaffCard(c, id);
}

// Oyni qo'lda yopish
async function staffCloseMonthStart(c, id) {
  orderState[c] = { step: 'stf_close_amount', staffId: id };
  const { staff: s } = await findStaff(id);
  const { currentBalance } = staffPayrollHistory(s);
  await btn(c, `🔒 *Oyni yopish — ${s.name}*\n\nJoriy balans: ${fmtSigned(currentBalance)}\n\n_Xodimga shu oy uchun jami qancha to'ladingiz? ($ yoki so'm). Yozsangiz, balans 0 bo'ladi va keyingi oyga o'tmaydi._`, [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
}
async function staffCloseMonth(c, id, paidUsd) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  const now = nowTZ();
  const s = data[idx];
  s.closed_months = s.closed_months || [];
  if (!s.closed_months.some(cm => cm.y === now.getFullYear() && cm.m === now.getMonth()))
    s.closed_months.push({ y: now.getFullYear(), m: now.getMonth(), paid_usd: paidUsd, date: todayStr() });
  // to'langan summani to'lov sifatida yozamiz (avans emas — yopilgan oy uchun)
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'staff close month: ' + s.name);
  await msg(c, `🔒 ${s.name} — ${UZ_MONTHS[now.getMonth()]} oyi yopildi. To'langan: $${paidUsd.toFixed(2)}. Balans 0.`);
  await showStaffCard(c, id);
}

// ─── Xodim check-in/out (yo'qlama) ───
// Xodim chat_id si bo'yicha xodimni topish
async function staffByChat(chatId) {
  const list = await readStaff();
  return list.find(s => String(s.tg_chat_id) === String(chatId) && s.active !== false);
}
// bugungi attendance yozuvini olish/yaratish
function todayAtt(s) {
  const dt = todayStr();
  s.attendance = s.attendance || [];
  let rec = s.attendance.find(a => a.date === dt);
  return { rec, dt };
}
async function attCheckIn(c, timeHm, isLate) {
  const s = await staffByChat(c);
  if (!s) { await msg(c, '⚠️ Siz tizimga ulanmagansiz.'); return; }
  const { data, sha, idx } = await findStaff(s.id);
  const dt = todayStr();
  data[idx].attendance = data[idx].attendance || [];
  let rec = data[idx].attendance.find(a => a.date === dt);
  const inTime = timeHm || nowHHMM();
  const late = hmToMin(inTime) > LATE_AFTER;
  if (rec) { rec.in = inTime; rec.late = late; } else { rec = { date: dt, in: inTime, out: null, late }; data[idx].attendance.push(rec); }
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'attendance in: ' + s.name);
  // guruhga xabar (Botir botidan)
  if (officeChat) { try { await agentMsg(officeChat, 'botir', `🟢 ${s.name} ishga keldi — ${inTime}${late ? ' (kech)' : ''}`); } catch (e) {} }
  if (late) {
    orderState[c] = { step: 'late_reason', staffId: s.id, date: dt, inTime };
    await msg(c, `✅ Belgilandi: ishga keldingiz — *${inTime}*`);
    const rows = REASON_CATS.map(r => [{ text: r.label, callback_data: `rc_late_${r.code}` }]);
    rows.push([{ text: '⏭ Keyinroq aytaman', callback_data: 'late_skip' }]);
    await btn(c, '⚠️ Bugun kech keldingiz. Sababini tanlang:', rows);
  } else {
    await msg(c, `✅ Belgilandi: ishga keldingiz — ${inTime}\n\nIsh kuni yakunida «🏁 Ketdim» ni bosing.`);
  }
}
async function attCheckInLate(c) {
  orderState[c] = { step: 'att_in_time' };
  await btn(c, '🕐 *Nechada keldingiz?*\n\n_Soatni yozing, masalan: 9:20 yoki 11:00_', [[{ text: '❌ Bekor', callback_data: 'noop' }]]);
}
async function attMarkAbsent(c) {
  const s = await staffByChat(c);
  if (!s) { await msg(c, '⚠️ Siz tizimga ulanmagansiz.'); return; }
  const { data, sha, idx } = await findStaff(s.id);
  data[idx].absences = data[idx].absences || [];
  const dt = todayStr();
  if (!data[idx].absences.some(a => a.date === dt)) data[idx].absences.push({ date: dt });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'attendance absent: ' + s.name);
  await msg(c, '✅ Belgilandi: bugun kelmaysiz. Sog' + "'" + ' bo\'ling!');
  // guruhga xabar (Botir botidan), bo'lmasa adminga
  if (officeChat) { try { await agentMsg(officeChat, 'botir', `⚪️ ${s.name} bugun ishga kelmaydi`); } catch (e) {} }
  else { try { await msg(ADMIN, `❌ ${s.name} bugun ishga kelmaydi deb belgiladi (${dt}).`); } catch (e) {} }
}
async function attCheckOut(c, timeHm) {
  const s = await staffByChat(c);
  if (!s) { await msg(c, '⚠️ Siz tizimga ulanmagansiz.'); return; }
  const { data, sha, idx } = await findStaff(s.id);
  const dt = todayStr();
  data[idx].attendance = data[idx].attendance || [];
  let rec = data[idx].attendance.find(a => a.date === dt);
  const outTime = timeHm || nowHHMM();
  if (rec && rec.in && hmToMin(outTime) <= hmToMin(rec.in)) {
    await msg(c, `⚠️ Ketish vaqti (${outTime}) kelish vaqtidan (${rec.in}) keyin bo'lishi kerak.\\n\\nAgar xato bo'lsa, admin bilan bog'laning.`);
    return;
  }
  if (!rec) { rec = { date: dt, in: '09:00', out: outTime }; data[idx].attendance.push(rec); }
  else rec.out = outTime;
  const early = hmToMin(outTime) < EARLY_BEFORE;
  rec.early = early;
  const d = computeDayHours(rec.in, rec.out, rec.leave_min);
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'attendance out: ' + s.name);
  // guruhga xabar (Botir botidan)
  if (officeChat) { try { await agentMsg(officeChat, 'botir', `🔴 ${s.name} ishdan ketdi — ${outTime}${early ? ' (erta)' : ''}`); } catch (e) {} }
  if (early) {
    orderState[c] = { step: 'early_reason', staffId: s.id, date: dt, outTime };
    await msg(c, `🏁 Belgilandi: ish tugadi — *${outTime}*\n📊 Bugun: ${d.normalH.toFixed(1)} soat`);
    const rows = REASON_CATS.map(r => [{ text: r.label, callback_data: `rc_early_${r.code}` }]);
    rows.push([{ text: '⏭ Keyinroq aytaman', callback_data: 'early_skip' }]);
    await btn(c, '⚠️ Bugun erta ketdingiz (18:00 dan oldin). Sababini tanlang:', rows);
  } else {
    await msg(c, `🏁 Belgilandi: ish tugadi — ${outTime}\n\n📊 Bugun: ${d.normalH.toFixed(1)} soat${d.extraH ? ` (+${d.extraH.toFixed(1)} qo'shimcha)` : ''}\n\nRahmat, mehnatingiz uchun!`);
  }
}
async function attStillWorking(c) {
  await msg(c, '⏰ Yaxshi, ishni davom ettiring. Ketganингizда «🏁 Ketdim» ni bosing — o\'sha vaqт yozilади (18:00 dan keyingi vaqt qo\'shimcha bo\'ladi).');
  const s = await staffByChat(c);
  if (s) {
    await btn(c, 'Ishni tugatganda bosing:', [[{ text: '🏁 Hozir ketdim', callback_data: 'att_out_now' }]]);
  }
}
// kech kelish / erta ketish sababini o'sha kun yozuviga saqlash
async function attSaveReason(c, staffId, date, field, reason) {
  const { data, sha, idx } = await findStaff(staffId);
  if (idx < 0) return;
  data[idx].attendance = data[idx].attendance || [];
  let rec = data[idx].attendance.find(a => a.date === date);
  if (!rec) { rec = { date }; data[idx].attendance.push(rec); }
  rec[field] = reason;
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'attendance reason: ' + data[idx].name);
}
// Xodim uchun oylik davomat jadvali
async function showAttTable(c, s) {
  const now = nowTZ();
  const mo = now.getMonth(), yr = now.getFullYear();
  const inMonth = (ds) => { const p = (ds || '').split('.'); return p.length === 3 && parseInt(p[1]) - 1 === mo && parseInt(p[2]) === yr; };
  const att = (s.attendance || []).filter(a => inMonth(a.date)).sort((a, b) => parseInt(a.date) - parseInt(b.date));
  const abs = (s.absences || []).filter(a => inMonth(a.date));
  let txt = `📅 *${UZ_MONTHS[mo]} davomati — ${s.name}*\n\n`;
  if (!att.length && !abs.length) { txt += '_Bu oyda hali yozuv yo\'q._'; await msg(c, txt); return; }
  for (const a of att) {
    const day = a.date.split('.')[0];
    let line = `${day} — ${a.in || '—'} → ${a.out || '—'}`;
    const marks = [];
    if (a.late) marks.push('⚠️kech');
    if (a.early) marks.push('🏃erta');
    if (!a.late && !a.early && a.out) marks.push('✅');
    if (marks.length) line += ' ' + marks.join(' ');
    txt += line + '\n';
    if (a.in_reason) txt += `   └ kech: _${a.in_reason}_\n`;
    if (a.out_reason) txt += `   └ erta: _${a.out_reason}_\n`;
  }
  for (const a of abs) {
    const day = (a.date || '').split('.')[0];
    txt += `${day} — ❌ kelmagan${a.reason ? ` (_${a.reason}_)` : ''}\n`;
  }
  await msg(c, txt);
}

// ─── Avans ikki tomonlama tasdiq ───
async function advConfirm(c, advId, ok) {
  const list = await readStaff();
  let found = null, sIdx = -1, aIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const ai = (list[i].advances || []).findIndex(a => a.id === advId && a.pending);
    if (ai >= 0) { found = list[i]; sIdx = i; aIdx = ai; break; }
  }
  if (!found) { await msg(c, '⚠️ Bu avans topilmadi yoki allaqachon hal qilingan.'); return; }
  const { data, sha } = await ghRead('staff-log.json');
  const adv = data[sIdx].advances[aIdx];
  if (ok) {
    delete adv.pending;
    await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'advance confirmed: ' + found.name);
    await msg(c, `✅ Avans tasdiqlandi: ${found.name} — $${adv.amount_usd.toFixed(2)}`);
    // ikkinchi tomonga xabar
    const other = (adv.entered_by === 'admin') ? found.tg_chat_id : ADMIN;
    if (other) { try { await msg(other, `✅ Avans tasdiqlandi: ${found.name} — $${adv.amount_usd.toFixed(2)}`); } catch (e) {} }
  } else {
    data[sIdx].advances.splice(aIdx, 1);
    await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'advance rejected: ' + found.name);
    await msg(c, `❌ Avans rad etildi: ${found.name} — $${adv.amount_usd.toFixed(2)}`);
    const other = (adv.entered_by === 'admin') ? found.tg_chat_id : ADMIN;
    if (other) { try { await msg(other, `❌ Avans rad etildi: ${found.name} — $${adv.amount_usd.toFixed(2)}`); } catch (e) {} }
  }
}

// ─── Xodim paneli (o'zi ko'radigan) ───
async function showWorkerPanel(c, s) {
  const today = todayStr();
  const rec = (s.attendance || []).find(a => a.date === today);
  let statusLine;
  if (rec && rec.in && rec.out) statusLine = `Bugun: ${rec.in}–${rec.out} ✅`;
  else if (rec && rec.in) statusLine = `Bugun keldingiz: ${rec.in} 🟢 (hali ketmadingiz)`;
  else statusLine = 'Bugun hali belgilanmadi';
  const rows = [];
  if (!rec || !rec.in) rows.push([{ text: '✅ Keldim', callback_data: 'att_in_09' }, { text: '🕐 Kechroq', callback_data: 'att_in_late' }, { text: '❌ Kelmayman', callback_data: 'att_absent' }]);
  else if (!rec.out) rows.push([{ text: '🏁 Ketdim', callback_data: 'att_out_18' }, { text: '⏰ Hali ishlayapman', callback_data: 'att_out_working' }]);
  rows.push([{ text: '💵 Mening hisobim', callback_data: 'worker_me' }, { text: '💸 Avans oldim', callback_data: 'worker_adv' }]);
  rows.push([{ text: '⏱ Davomat (qo\'lda)', callback_data: 'att_manual' }]);
  rows.push([{ text: '🙋 Javob so\'rash', callback_data: 'leave_menu' }]);
  await btn(c, `👷 *${s.name}* — ish vaqti\n\n${statusLine}`, rows);
  // doimiy reply-keyboard (klaviatura ustida)
  try { await msgKb(c, '👇 Tezkor amallar pastda turadi:', workerKeyboard()); } catch (e) {}
}
// ─── Qo'lda davomat (istalgan paytda kel/ket belgilash) ───
async function showAttManual(c, s) {
  const today = todayStr();
  const rec = (s.attendance || []).find(a => a.date === today);
  let statusLine;
  if (rec && rec.in && rec.out) statusLine = `Bugun: keldi ${rec.in} — ketdi ${rec.out} ✅`;
  else if (rec && rec.in) statusLine = `Bugun keldingiz: ${rec.in} 🟢 (hali ketmadingiz)`;
  else statusLine = 'Bugun hali hech narsa belgilanmagan';
  const rows = [[
    { text: '✅ Hozir keldim', callback_data: 'att_mark_in' },
    { text: '🏁 Hozir ketdim', callback_data: 'att_mark_out' }
  ]];
  rows.push([{ text: '◀️ Ortga', callback_data: 'worker_panel' }]);
  await btn(c, `⏱ *Davomat — qo'lda belgilash*\n\n${statusLine}\n\n_Istalgan paytda kelgan yoki ketganingizni shu yerdan belgilang. Hozirgi vaqt yoziladi._`, rows);
}
// ─── Sabab toifalari (tugma bilan tez tanlash) ───
const REASON_CATS = [
  { code: 'kasal', label: '🤒 Kasal' },
  { code: 'oilaviy', label: '👨‍👩‍👧 Oilaviy' },
  { code: 'shifokor', label: '🏥 Shifokor' },
  { code: 'yol', label: '🚗 Yo\'l muammosi' },
  { code: 'boshqa', label: '✍️ Boshqa (yozaman)' }
];
function reasonCatLabel(code) {
  const f = REASON_CATS.find(r => r.code === code);
  return f ? f.label.replace(/^[^\s]+\s/, '') : code;
}
// sabab toifa tugmalarini chiqarish. ctx = qaysi oqim uchun (prefiks)
async function askReasonCats(c, ctx, title) {
  const rows = REASON_CATS.map(r => [{ text: r.label, callback_data: `rc_${ctx}_${r.code}` }]);
  await btn(c, title, rows);
}
// ─── Javob so'rash (otpros) ───
async function showLeaveMenu(c, s) {
  const rows = [
    [{ text: '🕐 Vaqtincha chiqish', callback_data: 'leave_partial' }],
    [{ text: '📅 Bugun/ertaga kelmaslik', callback_data: 'leave_dayoff' }],
    [{ text: '🏃 Bugun erta ketish', callback_data: 'leave_early' }],
    [{ text: '◀️ Ortga', callback_data: 'worker_panel' }]
  ];
  await btn(c, `🙋 *Javob so'rash*\n\nQanday javob kerak? Tanlang — so'rovingiz Ibrohimga boradi, u tasdiqlaydi.`, rows);
}
// admin tasdig'iga yuborish
async function sendLeaveToAdmin(s, lv) {
  let desc;
  if (lv.type === 'partial') desc = `🕐 *Vaqtincha chiqish*\n${lv.hours} soatga\nSabab: ${lv.reason}`;
  else if (lv.type === 'dayoff') desc = `📅 *Kelmaslik*\nKun: ${lv.date}\nSabab: ${lv.reason}`;
  else desc = `🏃 *Erta ketish*\nSoat: ${lv.time} da\nSabab: ${lv.reason}`;
  // shu oydagi javob so'rovlari soni (tarix)
  const now = nowTZ(); const mo = now.getMonth(), yr = now.getFullYear();
  const monthLeaves = (s.leaves || []).filter(l => {
    const p = (l.requested || l.date || '').split('.');
    return p.length === 3 && parseInt(p[1]) - 1 === mo && parseInt(p[2]) === yr;
  });
  const cnt = monthLeaves.length;
  let histLine = `\n📊 _Bu oy ${cnt}-marta javob so'rayapti_`;
  if (cnt >= 4) histLine += ` ⚠️`;
  await btn(ADMIN, `🙋 *Javob so'rovi*\n\n👷 ${s.name}\n${desc}${histLine}\n\nRuxsat berasizmi?`, [[
    { text: '✅ Ruxsat', callback_data: 'lvok_' + lv.id },
    { text: '❌ Yo\'q', callback_data: 'lvno_' + lv.id }
  ]]);
}
// leave so'rovini saqlash (pending)
async function saveLeaveRequest(c, staffId, lv) {
  const { data, sha, idx } = await findStaff(staffId);
  if (idx < 0) { await msg(c, '⚠️ Xatolik.'); return null; }
  data[idx].leaves = data[idx].leaves || [];
  data[idx].leaves.push(lv);
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'leave request: ' + data[idx].name);
  return data[idx];
}
// leave oqimini yakunlash (toifa yoki matn sabab bilan)
async function leaveFinalize(c, st) {
  const reason = st.chosenReason || st.typedReason || '—';
  let lv, infoLine;
  if (st.flow === 'partial') {
    lv = { id: uid(), type: 'partial', date: todayStr(), hours: st.leaveHours, reason, status: 'pending', requested: todayStr() };
    infoLine = `${st.leaveHours} soatga chiqish`;
  } else if (st.flow === 'dayoff') {
    lv = { id: uid(), type: 'dayoff', date: st.leaveDate, reason, status: 'pending', requested: todayStr() };
    infoLine = `${st.leaveDate} kelmaslik`;
  } else {
    lv = { id: uid(), type: 'early', date: todayStr(), time: st.leaveTime, reason, status: 'pending', requested: todayStr() };
    infoLine = `bugun ${st.leaveTime} da ketish`;
  }
  const id = st.staffId; delete orderState[c];
  const s2 = await saveLeaveRequest(c, id, lv);
  if (s2) { await msg(c, `⏳ So'rov yuborildi: ${infoLine}.\nIbrohim tasdiqlashini kuting.`); await sendLeaveToAdmin(s2, lv); }
}
// admin tasdiq/rad
async function leaveConfirm(c, lvId, ok) {
  const list = await readStaff();
  let found = null, sIdx = -1, lIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const li = (list[i].leaves || []).findIndex(l => l.id === lvId && l.status === 'pending');
    if (li >= 0) { found = list[i]; sIdx = i; lIdx = li; break; }
  }
  if (!found) { await msg(c, '⚠️ Bu so\'rov topilmadi yoki allaqachon hal qilingan.'); return; }
  const { data, sha } = await ghRead('staff-log.json');
  const lv = data[sIdx].leaves[lIdx];
  if (ok) {
    lv.status = 'approved';
    // hisobga ta'sir
    if (lv.type === 'partial') {
      // o'sha kun yozuviga leave_min qo'shamiz
      const dt = lv.date || todayStr();
      data[sIdx].attendance = data[sIdx].attendance || [];
      let rec = data[sIdx].attendance.find(a => a.date === dt);
      const addMin = Math.round((lv.hours || 0) * 60);
      if (rec) rec.leave_min = (rec.leave_min || 0) + addMin;
      else data[sIdx].attendance.push({ date: dt, in: '09:00', out: '18:00', leave_min: addMin });
    } else if (lv.type === 'dayoff') {
      data[sIdx].absences = data[sIdx].absences || [];
      if (!data[sIdx].absences.find(a => a.date === lv.date)) data[sIdx].absences.push({ date: lv.date, reason: lv.reason });
    } else if (lv.type === 'early') {
      // o'sha kun ketish vaqtini early time ga o'rnatamiz
      const dt = lv.date || todayStr();
      data[sIdx].attendance = data[sIdx].attendance || [];
      let rec = data[sIdx].attendance.find(a => a.date === dt);
      if (rec) rec.out = lv.time;
      // agar hali kelmagan bo'lsa, faqat approved sifatida qoladi, xodim "ketdim" bosadi
    }
    await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'leave approved: ' + found.name);
    await msg(c, `✅ Ruxsat berildi: ${found.name}`);
    if (found.tg_chat_id) { try { await msg(found.tg_chat_id, `✅ *Javobingiz tasdiqlandi!*\n\nIbrohim ruxsat berdi. Ehtiyot bo'ling.`); } catch (e) {} }
  } else {
    lv.status = 'rejected';
    await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'leave rejected: ' + found.name);
    await msg(c, `❌ Rad etildi: ${found.name}`);
    if (found.tg_chat_id) { try { await msg(found.tg_chat_id, `❌ *Javob so'rovingiz rad etildi.*\n\nIbrohim bilan gaplashing.`); } catch (e) {} }
  }
}
async function showWorkerAccount(c, s) {
  const { history, currentBalance } = staffPayrollHistory(s);
  const cur = history[history.length - 1] || {};
  const balSign = currentBalance >= 0 ? `Ibrohim sizga qarzdor` : `Siz Ibrohimga qarzdor`;
  let workLine = cur.hasHours ? `🕐 Ishlangan: ${(cur.normalHours||0).toFixed(1)} soat${cur.extraHours?` + ${cur.extraHours.toFixed(1)} qo'shimcha`:''}` : `✅ Ishlangan: ${cur.workedWd||0} kun`;
  let txt = `💵 *Mening hisobim — ${s.name}*\n\n` +
    `💰 Oylik: $${s.salary_usd||0}\n` +
    `📊 *${UZ_MONTHS[nowTZ().getMonth()]} (shu oy):*\n${workLine}\n` +
    `📈 Hisoblangan haq: $${(cur.earnedUsd||0).toFixed(2)}\n` +
    (cur.bonusUsd?`🎁 Bonus: $${cur.bonusUsd.toFixed(2)}\n`:'') +
    `💸 Avans: $${(cur.advUsd||0).toFixed(2)}\n` +
    `↪️ O'tgan oydan: ${fmtSigned(cur.carryIn||0)}\n` +
    `━━━━━━━━━━━━\n💵 *Joriy balans: ${fmtSigned(currentBalance)}*\n_(${balSign})_`;
  if (history.length > 1) { txt += `\n\n📅 *Oylik tarix:*\n`; history.forEach(h => { txt += `${UZ_MONTHS[h.m]}: ${fmtSigned(h.balance)}\n`; }); }
  await btn(c, txt, [[{ text: '◀️ Ortga', callback_data: 'worker_panel' }]]);
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

// ══════════════════════════════════════════════════════════════
// 3-BOSQICH: Kassa, ishxona xarajatlari, shaxsiy xarajatlar, qarzlar
// ══════════════════════════════════════════════════════════════

// ─── ISHXONA XARAJATLARI (office-expenses-log.json) ───────────
// [{id,date,name,amount_uzs,rate,note}]
async function showOfficeExp(c) {
  const list = await ghReadAll('office-expenses-log.json');
  const now = nowTZ();
  const thisMonth = list.filter(e => { const p = dmyParts(e.date); return p && p.y === now.getFullYear() && p.m === now.getMonth(); });
  const lines = thisMonth.slice(-15).map(e => `• ${e.date} — ${e.name}: ${fmtUzs(e.amount_uzs)} so'm`).join('\n') || '_(shu oyda yo\'q)_';
  const total = thisMonth.reduce((s, e) => s + (e.amount_uzs || 0), 0);
  const monthName = now.toLocaleDateString('uz-UZ', { month: 'long' });
  await btn(c, `🏭 *Ishxona xarajatlari — ${monthName}*\n\n${lines}\n\n*Jami: ${fmtUzs(total)} so'm*`, [
    [{ text: '➕ Xarajat qo\'shish', callback_data: 'ofx_add' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ]);
}
async function officeExpAddStart(c) {
  orderState[c] = { step: 'ofx_name' };
  await btn(c, '🏭 *Ishxona xarajati*\n\nNomi (masalan: Arenda, Svet, Suv):', [[{ text: '❌ Bekor', callback_data: 'menu_office_exp' }]]);
}
async function officeExpSave(c, name, amountUzs) {
  const { data, sha } = await ghRead('office-expenses-log.json');
  data.push({ id: uid(), date: todayStr(), name: name.trim(), amount_uzs: amountUzs, rate: USD_UZS, note: '' });
  await ghPut('office-expenses-log.json', JSON.stringify(data, null, 2), sha, 'office expense: ' + name);
  await msg(c, `✅ Ishxona xarajati saqlandi:\n🏭 ${name} — ${fmtUzs(amountUzs)} so'm`);
  await showOfficeExp(c);
}

// ─── SHAXSIY XARAJATLAR (expenses-personal-log.json) ──────────
async function showPersonalExp(c) {
  const list = await ghReadAll('expenses-personal-log.json');
  const now = nowTZ();
  // turli eski formatlar bo'lishi mumkin — date va summani moslab olamiz
  const norm = list.map(e => {
    const p = e.parsed || {};
    let amtUzs = 0;
    if (e.amount_uzs) amtUzs = e.amount_uzs;
    else if (p.amount) amtUzs = (String(p.currency).toUpperCase() === 'USD') ? p.amount * USD_UZS : p.amount;
    else if (e.amount) amtUzs = (String(e.currency).toUpperCase() === 'USD') ? e.amount * USD_UZS : e.amount;
    const note = e.note || p.text || e.text || '';
    return { date: e.date, amtUzs, note };
  });
  const thisMonth = norm.filter(e => { const p = dmyParts(e.date); return p && p.y === now.getFullYear() && p.m === now.getMonth(); });
  const lines = thisMonth.slice(-15).map(e => `• ${e.date} — ${e.note || 'xarajat'}: ${fmtUzs(e.amtUzs)} so'm`).join('\n') || '_(shu oyda yo\'q)_';
  const total = thisMonth.reduce((s, e) => s + (e.amtUzs || 0), 0);
  const monthName = now.toLocaleDateString('uz-UZ', { month: 'long' });
  await btn(c, `👛 *Shaxsiy xarajatlar — ${monthName}*\n\n${lines}\n\n*Jami: ${fmtUzs(total)} so'm*\n\n_Qo'shish: MBI AI Office guruhiga ovozli yoki matn yuboring (bot tasdiq so'raydi)._`, [
    [{ text: '➕ Qo\'lda qo\'shish', callback_data: 'psx_add' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ]);
}
async function personalExpAddStart(c) {
  orderState[c] = { step: 'psx_note' };
  await btn(c, '👛 *Shaxsiy xarajat*\n\nNima uchun? (izoh, masalan: Benzin):', [[{ text: '❌ Bekor', callback_data: 'menu_personal_exp' }]]);
}
async function personalExpSave(c, note, amountUzs) {
  const { data, sha } = await ghRead('expenses-personal-log.json');
  data.push({ date: todayStr(), note: note.trim(), amount_uzs: amountUzs, rate: USD_UZS, type: 'personal', ts: new Date().toISOString() });
  await ghPut('expenses-personal-log.json', JSON.stringify(data, null, 2), sha, 'personal expense');
  await msg(c, `✅ Shaxsiy xarajat saqlandi:\n👛 ${note} — ${fmtUzs(amountUzs)} so'm`);
  await showPersonalExp(c);
}

// ─── QARZLAR (debts-log.json) ─────────────────────────────────
// [{id,dir:'in'|'out',name,amount_uzs,paid_uzs,date,note}]
// dir 'in' = menga qarzdor, 'out' = men qarzdorman
async function showDebts(c) {
  const manual = await ghReadAll('debts-log.json');
  // mijoz qarzlari (avtomatik, faqat faol buyurtmalar)
  const { data: deals } = await readDealsMigrated();
  const clientDebts = deals.filter(o => (o.status || 'active') === 'active').map(o => ({ name: o.client + ' (buyurtma)', remain: dealDebtUzs(o) })).filter(x => x.remain > 0);
  const inManual = manual.filter(d => d.dir === 'in');
  const out = manual.filter(d => d.dir === 'out');

  let txt = '💳 *Qarzlar*\n\n📥 *Menga qarzdorlar:*\n';
  let totalIn = 0;
  clientDebts.forEach(x => { txt += `• ${x.name}: ${fmtUzs(x.remain)} so'm\n`; totalIn += x.remain; });
  inManual.forEach(d => { const r = (d.amount_uzs || 0) - (d.paid_uzs || 0); txt += `• ${d.name}: ${fmtUzs(r)} so'm${d.note ? ' — ' + d.note : ''}\n`; totalIn += r; });
  if (!clientDebts.length && !inManual.length) txt += '_yo\'q_\n';
  txt += `*Jami menga: ${fmtUzs(totalIn)} so'm*\n\n📤 *Men qarzdorman:*\n`;
  let totalOut = 0;
  out.forEach(d => { const r = (d.amount_uzs || 0) - (d.paid_uzs || 0); txt += `• ${d.name}: ${fmtUzs(r)} so'm${d.note ? ' — ' + d.note : ''}\n`; totalOut += r; });
  if (!out.length) txt += '_yo\'q_\n';
  txt += `*Jami men: ${fmtUzs(totalOut)} so'm*`;

  await btn(c, txt, [
    [{ text: '📥 Menga qarzdor qo\'shish', callback_data: 'debt_add_in' }],
    [{ text: '📤 Men qarzdorman qo\'shish', callback_data: 'debt_add_out' }],
    [{ text: '💵 Qarzni to\'lash', callback_data: 'debt_pay' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ]);
}
async function debtAddStart(c, dir) {
  orderState[c] = { step: 'debt_name', debtDir: dir };
  const who = dir === 'in' ? 'Kim sizga qarzdor' : 'Kimga qarzdorsiz';
  await btn(c, `💳 *${who}* — ism/nom yozing:`, [[{ text: '❌ Bekor', callback_data: 'menu_debts' }]]);
}
async function debtSave(c, dir, name, amountUzs, note) {
  const { data, sha } = await ghRead('debts-log.json');
  data.push({ id: uid(), dir, name: name.trim(), amount_uzs: amountUzs, paid_uzs: 0, date: todayStr(), note: note || '' });
  await ghPut('debts-log.json', JSON.stringify(data, null, 2), sha, 'debt add: ' + name);
  await msg(c, `✅ Qarz qo'shildi:\n${dir === 'in' ? '📥' : '📤'} ${name} — ${fmtUzs(amountUzs)} so'm`);
  await showDebts(c);
}
// To'lash — qarzlar ro'yxatini tugma qilib ko'rsatadi
async function showDebtPayList(c) {
  const manual = await ghReadAll('debts-log.json');
  const open = manual.filter(d => (d.amount_uzs || 0) - (d.paid_uzs || 0) > 0);
  if (!open.length) { await msg(c, '_To\'lanmagan qo\'lda qo\'shilgan qarz yo\'q._\n\n(Mijoz qarzlari buyurtma → To\'lovlar orqali to\'lanadi.)'); await showDebts(c); return; }
  const rows = open.map(d => { const r = (d.amount_uzs || 0) - (d.paid_uzs || 0); return [{ text: `${d.dir === 'in' ? '📥' : '📤'} ${d.name} — ${fmtUzs(r)}`, callback_data: 'debtpay_' + d.id }]; });
  rows.push([{ text: '◀️ Ortga', callback_data: 'menu_debts' }]);
  await btn(c, '💵 *Qaysi qarz to\'landi?*', rows);
}
async function debtPayStart(c, id) {
  orderState[c] = { step: 'debt_pay_amount', debtId: id };
  await btn(c, '💵 *To\'langan summa:*\n\n_So\'mda yoki $ bilan. To\'liq yopilsa — to\'liq summani yozing._', [[{ text: '❌ Bekor', callback_data: 'menu_debts' }]]);
}
async function debtPaySave(c, id, amountUzs) {
  const { data, sha } = await ghRead('debts-log.json');
  const idx = data.findIndex(d => d.id === id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  data[idx].paid_uzs = (data[idx].paid_uzs || 0) + amountUzs;
  if (!Array.isArray(data[idx].payments)) data[idx].payments = [];
  data[idx].payments.push({ date: todayStr(), amount_uzs: amountUzs });
  data[idx].pay_date = todayStr();
  const remain = (data[idx].amount_uzs || 0) - data[idx].paid_uzs;
  await ghPut('debts-log.json', JSON.stringify(data, null, 2), sha, 'debt pay: ' + data[idx].name);
  await msg(c, `✅ To'lov yozildi: ${fmtUzs(amountUzs)} so'm\n${remain > 0 ? '📉 Qoldi: ' + fmtUzs(remain) + ' so\'m' : '✔️ To\'liq yopildi!'}`);
  await showDebts(c);
}

// ─── KASSA (cashbox.json + barcha kirim/chiqimdan hisob) ──────
async function readCashbox() {
  try { const { data } = await ghRead('cashbox.json'); return (data && !Array.isArray(data)) ? data : { opening_uzs: null, opening_date: null }; }
  catch (e) { return { opening_uzs: null, opening_date: null }; }
}
// Kassa qoldig'i = boshlang'ich + barcha kirim − barcha chiqim
async function computeCashbox() {
  const cfg = await readCashbox();
  const opening = cfg.opening_uzs || 0;
  // Boshlang'ich sana: undan OLDINGI harakatlar allaqachon boshlang'ich qoldiqqa
  // kirgan, shuning uchun ular kassa hisobida QAYTA hisoblanmaydi.
  const op = dmyParts(cfg.opening_date);
  const opNum = op ? (op.y * 10000 + op.m * 100 + op.d) : 0;
  const afterOpen = (dateStr) => {
    if (!opNum) return true; // sana yo'q bo'lsa hammasi hisoblanadi
    const p = dmyParts(dateStr);
    if (!p) return false;
    return (p.y * 10000 + p.m * 100 + p.d) >= opNum;
  };
  const { data: deals } = await ghRead('deals-log.json');
  let income = 0, dealExp = 0;
  for (const o of deals) {
    income += (o.payments || []).filter(p => afterOpen(p.date)).reduce((s, p) => s + (p.amount_uzs || 0), 0);
    dealExp += (o.expenses || []).filter(e => afterOpen(e.date)).reduce((s, e) => s + (e.total_uzs || 0), 0);
  }
  const officeExp = (await ghReadAll('office-expenses-log.json')).filter(e => afterOpen(e.date)).reduce((s, e) => s + (e.amount_uzs || 0), 0);
  // shaxsiy
  const pers = (await ghReadAll('expenses-personal-log.json')).filter(e => afterOpen(e.date)).reduce((s, e) => {
    const p = e.parsed || {};
    let a = e.amount_uzs || 0;
    if (!a && p.amount) a = (String(p.currency).toUpperCase() === 'USD') ? p.amount * USD_UZS : p.amount;
    else if (!a && e.amount) a = (String(e.currency).toUpperCase() === 'USD') ? e.amount * USD_UZS : e.amount;
    return s + a;
  }, 0);
  // xodim avanslari (chiqim) — faqat boshlang'ich sanadan keyingilari
  const staff = await ghReadAll('staff-log.json');
  const staffAdv = staff.reduce((s, w) => s + (w.advances || []).filter(x => afterOpen(x.date)).reduce((a, x) => a + (x.amount_usd || 0) * USD_UZS, 0), 0);
  // qarz to'lovlari: paid summani sanasi bo'yicha hisoblash (payments massivi bo'lsa aniq, bo'lmasa pay_date/date)
  const debtsAll = await ghReadAll('debts-log.json');
  const debtPaidSum = (d) => Array.isArray(d.payments)
    ? d.payments.filter(p => afterOpen(p.date)).reduce((s, p) => s + (p.amount_uzs || 0), 0)
    : (afterOpen(d.pay_date || d.date) ? (d.paid_uzs || 0) : 0);
  // men to'laganim (out) — kassadan chiqadi
  const debtPaid = debtsAll.filter(d => d.dir === 'out').reduce((s, d) => s + debtPaidSum(d), 0);
  // qarzdorlar menga to'lagani (in) — kassaga KIRIM
  const debtIn = debtsAll.filter(d => d.dir === 'in').reduce((s, d) => s + debtPaidSum(d), 0);
  const balance = opening + income + debtIn - dealExp - officeExp - pers - staffAdv - debtPaid;
  return { opening, income, debtIn, dealExp, officeExp, pers, staffAdv, debtPaid, balance, hasOpening: cfg.opening_uzs != null };
}
async function showCashbox(c) {
  const k = await computeCashbox();
  if (!k.hasOpening) {
    await btn(c, '💰 *Kassa*\n\n_Boshlang\'ich qoldiq hali kiritilmagan._\nHozir qo\'lingizda/kassada qancha pul borligini kiriting.', [
      [{ text: '➕ Boshlang\'ich qoldiqni kiritish', callback_data: 'cash_set' }],
      [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
    ]);
    return;
  }
  await btn(c, `💰 *Kassa*\n\n` +
    `🏦 Boshlang'ich: ${fmtUzs(k.opening)} so'm\n` +
    `📥 Kirim (to'lovlar): +${fmtUzs(k.income)}\n` +
    `📥 Qarzdor to'lovi: +${fmtUzs(k.debtIn)}\n` +
    `📤 Buyurtma xarajat: −${fmtUzs(k.dealExp)}\n` +
    `🏭 Ishxona: −${fmtUzs(k.officeExp)}\n` +
    `👷 Xodim avans: −${fmtUzs(k.staffAdv)}\n` +
    `🔴 Qarz to'lovi: −${fmtUzs(k.debtPaid)}\n` +
    `👛 Shaxsiy: −${fmtUzs(k.pers)}\n` +
    `━━━━━━━━━━━━\n` +
    `💵 *Hozirgi qoldiq: ${fmtUzs(k.balance)} so'm*`, [
    [{ text: '✏️ Boshlang\'ich qoldiqni o\'zgartirish', callback_data: 'cash_set' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ]);
}
async function cashSetStart(c) {
  orderState[c] = { step: 'cash_amount' };
  await btn(c, '💰 *Boshlang\'ich qoldiq:*\n\n_Hozir qancha pulingiz bor? So\'mda yoki $ bilan._', [[{ text: '❌ Bekor', callback_data: 'menu_cash' }]]);
}
async function cashSetSave(c, amountUzs) {
  const { data, sha } = await ghRead('cashbox.json');
  const cfg = (data && !Array.isArray(data)) ? data : {};
  cfg.opening_uzs = amountUzs;
  cfg.opening_date = todayStr();
  await ghPut('cashbox.json', JSON.stringify(cfg, null, 2), sha, 'cashbox opening');
  await msg(c, `✅ Boshlang'ich qoldiq o'rnatildi: ${fmtUzs(amountUzs)} so'm`);
  await showCashbox(c);
}

// ══════════════════════════════════════════════════════════════
// 4-BOSQICH: Umumiy hisobot, Excel, avtomatik eslatma, backup
// ══════════════════════════════════════════════════════════════

// Berilgan oy uchun barcha ma'lumotni yig'adi (y, m: m=0-11)
async function gatherMonth(y, m) {
  const inMon = (dateStr) => { const p = dmyParts(dateStr); return p && p.y === y && p.m === m; };
  const { data: deals } = await ghRead('deals-log.json');
  // shu oyda olingan buyurtmalar
  const monthDeals = deals.filter(o => inMon(o.date));
  let income = 0, dealExp = 0;
  const allPayments = [], allExpenses = [];
  for (const o of deals) {
    for (const p of (o.payments || [])) if (inMon(p.date)) { income += p.amount_uzs || 0; allPayments.push({ client: o.client, ...p }); }
    for (const e of (o.expenses || [])) if (inMon(e.date)) { dealExp += e.total_uzs || 0; allExpenses.push({ client: o.client, ...e }); }
  }
  const officeAll = await ghReadAll('office-expenses-log.json');
  const officeRows = officeAll.filter(e => inMon(e.date));
  const officeExp = officeRows.reduce((s, e) => s + (e.amount_uzs || 0), 0);
  const persAll = (await ghReadAll('expenses-personal-log.json')).map(e => {
    const p = e.parsed || {}; let a = e.amount_uzs || 0;
    if (!a && p.amount) a = (String(p.currency).toUpperCase() === 'USD') ? p.amount * USD_UZS : p.amount;
    else if (!a && e.amount) a = (String(e.currency).toUpperCase() === 'USD') ? e.amount * USD_UZS : e.amount;
    return { date: e.date, note: e.note || p.text || e.text || '', amtUzs: a };
  });
  const persRows = persAll.filter(e => inMon(e.date));
  const pers = persRows.reduce((s, e) => s + (e.amtUzs || 0), 0);
  const staff = await ghReadAll('staff-log.json');
  let staffAdv = 0;
  for (const w of staff) for (const a of (w.advances || [])) if (inMon(a.date)) staffAdv += (a.amount_usd || 0) * USD_UZS;
  const bizProfit = income - dealExp - officeExp - staffAdv;
  const realRemain = bizProfit - pers;
  // ── Kassa hisobi (boshlang'ich sanadan keyingi harakatlar) ──
  const cfg = await readCashbox();
  const opening = cfg.opening_uzs || 0;
  const op = dmyParts(cfg.opening_date);
  const opNum = op ? (op.y * 10000 + op.m * 100 + op.d) : 0;
  const afterOpen = (dateStr) => {
    if (!opNum) return true;
    const p = dmyParts(dateStr);
    if (!p) return false;
    return (p.y * 10000 + p.m * 100 + p.d) >= opNum;
  };
  let cashIn = 0, cashDealExp = 0, cashOffice = 0, cashPers = 0, cashAdv = 0;
  for (const o of deals) {
    cashIn += (o.payments || []).filter(p => afterOpen(p.date)).reduce((s, p) => s + (p.amount_uzs || 0), 0);
    cashDealExp += (o.expenses || []).filter(e => afterOpen(e.date)).reduce((s, e) => s + (e.total_uzs || 0), 0);
  }
  cashOffice = officeAll.filter(e => afterOpen(e.date)).reduce((s, e) => s + (e.amount_uzs || 0), 0);
  cashPers = persAll.filter(e => afterOpen(e.date)).reduce((s, e) => s + (e.amtUzs || 0), 0);
  for (const w of staff) for (const a of (w.advances || [])) if (afterOpen(a.date)) cashAdv += (a.amount_usd || 0) * USD_UZS;
  const debtsAll = await ghReadAll('debts-log.json');
  const debtOut = debtsAll.filter(d => d.dir === 'out');
  const debtPaidSum = (d) => Array.isArray(d.payments)
    ? d.payments.filter(p => afterOpen(p.date)).reduce((s, p) => s + (p.amount_uzs || 0), 0)
    : (afterOpen(d.pay_date || d.date) ? (d.paid_uzs || 0) : 0);
  const cashDebtPaid = debtOut.reduce((s, d) => s + debtPaidSum(d), 0);
  const cashDebtIn = debtsAll.filter(d => d.dir === 'in').reduce((s, d) => s + debtPaidSum(d), 0);
  // mijoz qarzlari (menga qarzdor)
  const clientDebts = [];
  for (const o of deals) {
    if (o.status === 'active') {
      const paid = (o.payments || []).reduce((s, p) => s + (p.amount_uzs || 0), 0);
      const debt = (o.contract_sum_uzs || 0) - paid;
      if (debt > 0) clientDebts.push({ client: o.client, contract: o.contract_sum_uzs || 0, paid, debt });
    }
  }
  const cashBalance = opening + cashIn + cashDebtIn - cashDealExp - cashOffice - cashPers - cashAdv - cashDebtPaid;
  return { monthDeals, income, dealExp, officeRows, officeExp, persRows, pers, staff, staffAdv, allExpenses, allPayments, bizProfit, realRemain, opening, openingDate: cfg.opening_date, debtOut, cashIn, cashDebtIn, cashDealExp, cashOffice, cashPers, cashAdv, cashDebtPaid, cashBalance, clientDebts };
}

async function showSummary(c) {
  const now = nowTZ();
  const g = await gatherMonth(now.getFullYear(), now.getMonth());
  const monthName = UZ_MONTHS[now.getMonth()];
  await btn(c, `📊 *Umumiy hisobot — ${monthName} ${now.getFullYear()}*\n\n` +
    `🆕 Yangi buyurtmalar: ${g.monthDeals.length} ta\n` +
    `📥 Kirim (to'lovlar): ${fmtUzs(g.income)} so'm\n` +
    `📤 Buyurtma xarajati: ${fmtUzs(g.dealExp)} so'm\n` +
    `🏭 Ishxona xarajati: ${fmtUzs(g.officeExp)} so'm\n` +
    `👷 Xodim avanslari: ${fmtUzs(g.staffAdv)} so'm\n` +
    `━━━━━━━━━━━━\n` +
    `📈 Biznes sof foyda: *${fmtUzs(g.bizProfit)} so'm*\n` +
    `👛 Shaxsiy chiqim: ${fmtUzs(g.pers)} so'm\n` +
    `━━━━━━━━━━━━\n` +
    `💰 *Cho'ntakdagi real pul: ${fmtUzs(g.cashBalance)} so'm*`, [
    [{ text: '📥 Excel yuklash (shu oy)', callback_data: 'xls_now' }],
    [{ text: '📅 Oylik hisobotlar', callback_data: 'xls_list' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ]);
}

// Telegramga fayl (buffer) yuborish
function sendDocBuffer(chatId, buffer, filename, caption) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (caption) form.append('caption', caption);
    form.append('document', buffer, { filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const req = https.request({
      hostname: 'api.telegram.org', path: '/bot' + BOT + '/sendDocument', method: 'POST',
      headers: form.getHeaders()
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } }); });
    req.on('error', () => resolve(null));
    form.pipe(req);
  });
}

// Oylik Excel yaratadi (buffer qaytaradi) — BITTA VARAQ, to'liq hisobot
async function buildMonthExcel(y, m) {
  const XLSX = require('xlsx');
  const g = await gatherMonth(y, m);
  const monthName = UZ_MONTHS[m];
  const inMon = (dateStr) => { const p = dmyParts(dateStr); return p && p.y === y && p.m === m; };

  const rows = [];
  const merges = [];
  const fmtCells = {};
  const R = () => rows.length;
  const push = (arr) => rows.push(arr);
  const moneyAt = (ri, ci) => { fmtCells[XLSX.utils.encode_cell({ r: ri, c: ci })] = 1; };
  const sectionRow = (title) => { const i = R(); push([title, '', '', '', '']); merges.push({ s: { r: i, c: 0 }, e: { r: i, c: 4 } }); };

  // Sarlavha
  let i = R(); push([`MBI MEBEL — ${monthName} ${y} TO'LIQ HISOBOT`, '', '', '', '']);
  merges.push({ s: { r: i, c: 0 }, e: { r: i, c: 4 } });
  i = R(); push(['Kurs: 1$ = 12,000 so\'m', '', '', '', '']);
  merges.push({ s: { r: i, c: 0 }, e: { r: i, c: 4 } });
  push(['', '', '', '', '']);

  // 1. KIRIM
  sectionRow('💰 KIRIM — kim qancha to\'ladi');
  push(['Sana', 'Mijoz', 'Izoh', 'Summa (so\'m)', '']);
  g.allPayments.forEach(p => { const ri = R(); push([p.date, p.client, p.note || 'To\'lov', p.amount_uzs || 0, '']); moneyAt(ri, 3); });
  { const ri = R(); push(['JAMI KIRIM:', '', '', g.income, '']); moneyAt(ri, 3); }
  push(['', '', '', '', '']);

  // 2. ISHXONA RASXODLARI
  sectionRow('🏭 ISHXONA RASXODLARI');
  push(['Sana', 'Nima uchun', '', 'Summa (so\'m)', '']);
  g.officeRows.forEach(e => { const ri = R(); push([e.date, e.name || '', '', e.amount_uzs || 0, '']); moneyAt(ri, 3); });
  { const ri = R(); push(['JAMI ISHXONA:', '', '', g.officeExp, '']); moneyAt(ri, 3); }
  push(['', '', '', '', '']);

  // 3. ISHCHILARGA AVANS / OYLIK
  sectionRow('👷 ISHCHILARGA BERILGAN AVANS / OYLIK');
  push(['Sana', 'Ishchi', 'Izoh', '$', 'so\'m']);
  const advByWorker = {};
  g.staff.filter(s => s.active !== false).forEach(s => {
    (s.advances || []).filter(a => inMon(a.date)).forEach(a => {
      const usd = a.amount_usd || 0, uzs = Math.round(usd * USD_UZS);
      const ri = R(); push([a.date, s.name, a.note || 'Avans/oylik', usd, uzs]); moneyAt(ri, 4);
      advByWorker[s.name] = (advByWorker[s.name] || 0) + uzs;
    });
  });
  { const ri = R(); push(['JAMI AVANS/OYLIK:', '', '', '', g.staffAdv]); moneyAt(ri, 4); }
  push(['', '', '', '', '']);
  // Ishchilar jami
  sectionRow('   Ishchilar bo\'yicha jami');
  push(['Ishchi', 'Oylik ($)', 'Ishlagan kun', 'Olgan avans (so\'m)', '']);
  g.staff.filter(s => s.active !== false).forEach(s => {
    const att = (s.attendance || []).filter(a => inMon(a.date)).length;
    const ri = R(); push([s.name, s.salary_usd || 0, att, advByWorker[s.name] || 0, '']); moneyAt(ri, 3);
  });
  push(['', '', '', '', '']);

  // 4. QARZLARGA TO'LANGAN
  sectionRow('🔴 QARZLARGA TO\'LANGAN (men qarzdorman)');
  push(['Kimga', 'Umumiy qarz', 'To\'langan', 'Qolgan', 'Izoh']);
  let debtRemainTotal = 0, debtPaidTotal = 0;
  g.debtOut.forEach(d => {
    const paid = d.paid_uzs || 0, rem = (d.amount_uzs || 0) - paid; debtRemainTotal += rem; debtPaidTotal += paid;
    const ri = R(); push([d.name, d.amount_uzs || 0, paid, rem, d.note || '']); moneyAt(ri, 1); moneyAt(ri, 2); moneyAt(ri, 3);
  });
  { const ri = R(); push(['JAMI TO\'LANGAN:', '', '', debtPaidTotal, '']); moneyAt(ri, 3); }
  { const ri = R(); push(['JAMI QOLGAN QARZ:', '', '', debtRemainTotal, '']); moneyAt(ri, 3); }
  push(['', '', '', '', '']);

  // 5. SHAXSIY HARAJATLAR
  sectionRow('👛 SHAXSIY HARAJATLAR');
  push(['Sana', 'Nima uchun', '', 'Summa (so\'m)', '']);
  g.persRows.forEach(e => { const ri = R(); push([e.date, e.note || '', '', e.amtUzs || 0, '']); moneyAt(ri, 3); });
  { const ri = R(); push(['JAMI SHAXSIY:', '', '', g.pers, '']); moneyAt(ri, 3); }
  push(['', '', '', '', '']);

  // 6. MENGA QARZDOR
  sectionRow('🟢 MENGA QARZDOR (mijozlar)');
  push(['Mijoz', 'Shartnoma', 'To\'langan', 'Qarzi (so\'m)', '']);
  let clientDebtTotal = 0;
  g.clientDebts.forEach(d => { clientDebtTotal += d.debt; const ri = R(); push([d.client, d.contract, d.paid, d.debt, '']); moneyAt(ri, 1); moneyAt(ri, 2); moneyAt(ri, 3); });
  { const ri = R(); push(['JAMI MENGA QARZ:', '', '', clientDebtTotal, '']); moneyAt(ri, 3); }
  push(['', '', '', '', '']);

  // 7. KASSA — CHO'NTAGIMDAGI REAL PUL
  sectionRow('💵 KASSA — CHO\'NTAGIMDAGI REAL PUL');
  const cashLine = (label, val) => { const ri = R(); push([label, '', '', val, '']); merges.push({ s: { r: ri, c: 0 }, e: { r: ri, c: 2 } }); moneyAt(ri, 3); };
  cashLine(`🏦 Boshlang'ich qoldiq (${g.openingDate || ''})`, g.opening);
  cashLine('(+) Kirim (to\'lovlar)', g.cashIn);
  cashLine('(+) Qarzdorlar to\'lovi', g.cashDebtIn);
  cashLine('(−) Buyurtma xarajati', -g.cashDealExp);
  cashLine('(−) Ishxona rasxodi', -g.cashOffice);
  cashLine('(−) Ishchilar avansi/oyligi', -g.cashAdv);
  cashLine('(−) Shaxsiy harajat', -g.cashPers);
  cashLine('(−) Qarzlarga to\'langan', -g.cashDebtPaid);
  { const ri = R(); push(['💰 CHO\'NTAGIMDAGI REAL PUL', '', '', g.cashBalance, '']); merges.push({ s: { r: ri, c: 0 }, e: { r: ri, c: 2 } }); moneyAt(ri, 3); }
  { const ri = R(); push(['   ($ hisobida)', '', '', Math.round(g.cashBalance / USD_UZS * 10) / 10 + ' $', '']); merges.push({ s: { r: ri, c: 0 }, e: { r: ri, c: 2 } }); }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!merges'] = merges;
  ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 32 }, { wch: 18 }, { wch: 16 }];
  for (const addr in fmtCells) { if (ws[addr] && typeof ws[addr].v === 'number') ws[addr].z = '#,##0'; }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `${monthName} ${y}`);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Oylik hisobotni yaratib: GitHub'ga saqlaydi + adminга yuboradi
async function generateAndSendMonth(y, m, toChat) {
  const buf = await buildMonthExcel(y, m);
  const fname = `${UZ_MONTHS[m]}-${y}.xlsx`;
  // GitHub'ga saqlash (hisobotlar papkasi)
  try { await ghPutRepo('yakubovibrohim/mbi-bot', 'hisobotlar/' + fname, buf, 'report: ' + fname); } catch (e) { console.error('report save:', e.message); }
  await sendDocBuffer(toChat, buf, fname, `📊 ${UZ_MONTHS[m]} ${y} — oylik hisobot`);
}

async function showReportsList(c) {
  // hisobotlar papkasidagi fayllar
  let files = [];
  try {
    const list = await ghGetDir('hisobotlar');
    files = (list || []).filter(f => f.name.endsWith('.xlsx')).map(f => f.name);
  } catch (e) {}
  if (!files.length) { await msg(c, '📅 *Oylik hisobotlar*\n\n_Hali saqlangan hisobot yo\'q. «Excel yuklash» bilan shu oyniki yaratiladi._'); await showSummary(c); return; }
  const rows = files.sort().reverse().map(f => [{ text: '📄 ' + f.replace('.xlsx', ''), callback_data: 'xls_get_' + f }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'menu_summary' }]);
  await btn(c, '📅 *Oylik hisobotlar:*', rows);
}

// GitHub papka ro'yxati
function ghGetDir(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/' + GH_REPO + '/contents/' + path, method: 'GET',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Accept': 'application/vnd.github.v3+json' }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { const j = JSON.parse(d); resolve(Array.isArray(j) ? j : []); } catch (e) { resolve([]); } }); });
    req.on('error', () => resolve([])); req.end();
  });
}
// Saqlangan faylni o'qib yuborish
async function sendSavedReport(c, fname) {
  const buf = await downloadBuffer('https://raw.githubusercontent.com/' + GH_REPO + '/main/hisobotlar/' + fname);
  if (buf) await sendDocBuffer(c, buf, fname, '📊 ' + fname.replace('.xlsx', ''));
  else await msg(c, '⚠️ Fayl topilmadi.');
}

// Yillik Excel: har oy bo'yicha yakun + umumiy
async function buildYearExcel(y) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const rows = [];
  let totIncome = 0, totExp = 0, totProfit = 0, totPers = 0;
  for (let m = 0; m < 12; m++) {
    const g = await gatherMonth(y, m);
    const exp = g.dealExp + g.officeExp + g.staffAdv;
    rows.push({
      'Oy': UZ_MONTHS[m], 'Buyurtma': g.monthDeals.length,
      'Kirim': g.income, 'Xarajat': exp, 'Biznes foyda': g.bizProfit, 'Shaxsiy': g.pers, 'Real qoldiq': g.realRemain
    });
    totIncome += g.income; totExp += exp; totProfit += g.bizProfit; totPers += g.pers;
  }
  rows.push({ 'Oy': 'JAMI', 'Buyurtma': '', 'Kirim': totIncome, 'Xarajat': totExp, 'Biznes foyda': totProfit, 'Shaxsiy': totPers, 'Real qoldiq': totProfit - totPers });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), y + '-yil');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Groq call ────────────────────────────────────────────────
function groqChat(system, userText, maxTokens) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'openai/gpt-oss-120b', max_tokens: maxTokens || 600, reasoning_effort: 'low',
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
      model: 'openai/gpt-oss-120b', max_tokens: maxTokens || 600, reasoning_effort: 'low',
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
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
function geminiTranscribe(buf) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: 'audio/ogg', data: buf.toString('base64') } },
        { text: "Bu ovozli xabarni aynan aytilganidek matnga ko'chir. O'zbek tilida, lotin alifbosida yoz. Kontekst: MBI Mebel biznesi — buyurtma, mijoz, avans, kassa, xarajat, qarz, hisobot. Xodimlar: Diyor, Sherzod. Mijozlar: Boxodir aka, Nodira opa. FAQAT transkripsiya matnini qaytar, izoh yozma." }
      ]}],
      generationConfig: { temperature: 0 }
    });
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_KEY,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const t = ((j.candidates || [{}])[0].content || {}).parts;
          const text = (t || []).map(p => p.text || '').join('').trim();
          if (text) resolve(text); else reject(new Error('gemini empty: ' + d.slice(0, 200)));
        } catch (e) { reject(new Error('gemini parse: ' + d.slice(0, 200))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('gemini timeout')); });
    req.on('error', reject); req.write(body); req.end();
  });
}
async function transcribeAudio(buf) {
  if (GEMINI_KEY) {
    try { return await geminiTranscribe(buf); }
    catch (e) { console.error('Gemini transcribe xato, Whisper zaxiraga o\'tildi:', e.message); }
  }
  return whisperTranscribe(buf);
}
function whisperTranscribe(buf) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', buf, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    form.append('language', 'uz');
    form.append('temperature', '0');
    form.append('prompt', 'MBI Mebel. Mebel buyurtmalari, mijozlar, avans, kassa, xarajat, qarz, hisobot. Xodimlar: Diyor, Sherzod. Mijozlar: Boxodir aka, Nodira opa.');
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
    sys: `Sen Botir — MBI Mebel xo'jayini Ibrohimning bosh AI yordamchisi va TIZIM NAZORATCHISISAN. ${BIZ_INFO}
Vazifang: (1) umumiy savollar va ishlarni muvofiqlashtirish; (2) butun tizimni nazorat qilish — botlar salomatligi, xatolar, reklama natijalari, buyurtma muddatlari, oxirgi o'zgarishlar. Bularning REAL holati senga REAL TIZIM MA'LUMOTLARI bo'limida beriladi — faqat shunga asoslan, o'zingdan hech narsa to'qima. Tahlil so'ralsa: muammolarni muhimlik tartibida ayt, har biriga qisqa yechim taklif qil.
Qisqa, aniq, samimiy o'zbek tilida (lotin alifbosi) gapir. Savol pul/hisob haqida bo'lsa javob oxiriga [[sardor]], mijoz/sotuv/Instagram bo'lsa [[aziza]] qo'sh.` },
  aziza: { name: 'Aziza', role: 'Sotuv menejeri', emoji: '👩‍💼', token: '',
    sys: `Sen Aziza — MBI Mebel sotuv menejerisan. ${BIZ_INFO}
Sen ayni vaqtda Instagram DM'da mijozlar bilan O'ZING yozishasan (avtomatik) — bu suhbatlar va leadlar senga REAL IG MA'LUMOTLAR bo'limida beriladi. Guruhda Ibrohimga suhbatlar holati, leadlar va tahlil bo'yicha javob berasan.
SOTUV QOIDALARING (IG'da ham, matn tuzganingda ham): mijoz tilida javob (ruschaga to'liq ruscha); ism noma'lum — "oka" dema, ayolga "opa"; telefon so'rash — asosiy maqsad; pogonaj metr/m² narxini aytma — faqat umumiy taxminiy, o'lcham aniqlangach; takrorlanma; qisqa va jonli yoz, rasmiy shablon yo'q. Narxni qiymat bilan asosla (Bazis aniqligi, Blum/GTV, 14 kun + shtraf kafolati).
Tahlil so'ralsa: faqat berilgan real ma'lumotga asoslan, raqam to'qima. Javob qisqa, o'zbek tilida (lotin).` },
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
    const [deals, debtsManual, staff] = await Promise.all([
      ghReadAll('deals-log.json'), ghReadAll('debts-log.json'), ghReadAll('staff-log.json')
    ]);
    const f = n => Math.round(n || 0).toLocaleString('ru-RU');
    const statusUz = { active: 'Faol', done: 'Tugatilgan', cancelled: 'Bekor qilingan' };

    // Kelishuvlar — yangi tuzilma (payments[], expenses[])
    const dealLines = deals.slice(-12).map(d => {
      const name = d.client || d.title || '?';
      const contract = Number(d.contract_sum_uzs) || 0;
      const paid = (d.payments || []).reduce((s, p) => s + (Number(p.amount_uzs) || 0), 0)
        + ((!d.payments || !d.payments.length) && d.advance_uzs ? Number(d.advance_uzs) : 0); // eski format faqat payments bo'sh bo'lsa
      const expSum = (d.expenses || []).reduce((s, e) => s + (Number(e.total_uzs) || 0), 0);
      const debt = contract - paid;
      const profit = contract - expSum;
      const st = statusUz[d.status || 'active'] || (d.stage || '-');
      return `• ${name} (${st}${d.stage ? ', ' + d.stage : ''}): shartnoma ${f(contract)} so'm | to'langan ${f(paid)} so'm | QARZ QOLDI ${f(debt)} so'm | xarajatlar jami ${f(expSum)} so'm | sof foyda ${f(profit)} so'm`;
    }).join('\n');

    // Oxirgi xarajatlar — deal'lar ichidagi expenses
    const allExp = [];
    for (const d of deals) for (const e of (d.expenses || [])) {
      const prods = (e.products || []).map(p => `${p.name} x${p.qty}`).join(', ');
      allExp.push({ date: e.date || '', client: d.client, total: e.total_uzs || 0, prods });
    }
    const expLines = allExp.slice(-15).map(e =>
      `• ${e.date} | ${e.client} | ${f(e.total)} so'm | ${e.prods.slice(0, 200)}`
    ).join('\n');

    // Qarzlar (qo'lda + mijoz qarzlari)
    let debtIn = 0, debtOut = 0;
    for (const d of deals) if ((d.status || 'active') === 'active') {
      const contract = Number(d.contract_sum_uzs) || 0;
      const paid = (d.payments || []).reduce((s, p) => s + (Number(p.amount_uzs) || 0), 0) + ((!d.payments || !d.payments.length) && d.advance_uzs ? Number(d.advance_uzs) : 0);
      const r = contract - paid; if (r > 0) debtIn += r;
    }
    (debtsManual || []).forEach(x => { const r = (x.amount_uzs || 0) - (x.paid_uzs || 0); if (x.dir === 'in') debtIn += r; else debtOut += r; });

    // Xodimlar joriy balansi (oddiy: oylik − shu oy avanslari, tahminiy)
    const now = nowTZ();
    const staffLines = (staff || []).filter(s => s.active !== false).map(s => {
      const advThis = (s.advances || []).filter(a => { const p = dmyParts(a.date); return p && p.y === now.getFullYear() && p.m === now.getMonth(); }).reduce((sm, a) => sm + (a.amount_usd || 0), 0);
      return `• ${s.name}: oylik $${s.salary_usd || 0}, shu oy avans $${advThis.toFixed(2)}`;
    }).join('\n');

    // Kassa (tayyor hisob)
    let cashLines = '';
    try {
      const cb = await computeCashbox();
      cashLines = cb.hasOpening
        ? `qoldiq ${f(cb.balance)} so'm (boshlang'ich ${f(cb.opening)} + kirimlar ${f(cb.income)} + qarzdor to'lovlari ${f(cb.debtIn)} − buyurtma xarajatlari ${f(cb.dealExp)} − ofis ${f(cb.officeExp)} − shaxsiy ${f(cb.pers)} − xodim avanslari ${f(cb.staffAdv)} − qarz to'lovlari ${f(cb.debtPaid)})`
        : "boshlang'ich qoldiq kiritilmagan";
    } catch (e) { cashLines = "hisoblab bo'lmadi"; }

    // Ofis va shaxsiy xarajatlar (shu oy)
    const monthOf = (dt) => { const p = dmyParts(dt); return p && p.y === now.getFullYear() && p.m === now.getMonth(); };
    let officeLines = '', persTotal = 0;
    try {
      const [officeExp, persExp] = await Promise.all([
        ghReadAll('office-expenses-log.json'), ghReadAll('expenses-personal-log.json')
      ]);
      const om = (officeExp || []).filter(x => monthOf(x.date));
      const oSum = om.reduce((s, x) => s + (Number(x.amount_uzs) || 0), 0);
      officeLines = `shu oy jami ${f(oSum)} so'm\n` + om.slice(-5).map(x => `• ${x.date} | ${f(x.amount_uzs)} so'm | ${(x.note || x.text || '-').slice(0, 60)}`).join('\n');
      persTotal = (persExp || []).filter(x => monthOf(x.date)).reduce((s, x) => s + (Number(x.amount_uzs) || 0), 0);
    } catch (e) {}

    return `TAYYOR HISOBLANGAN MA'LUMOTLAR (barcha arifmetika bajarilgan, kurs 1 USD = ${USD_RATE} so'm):\n\n` +
      `KASSA: ${cashLines}\n\n` +
      `KELISHUVLAR:\n${dealLines || '—'}\n\n` +
      `OXIRGI XARAJATLAR:\n${expLines || '—'}\n\n` +
      `OFIS XARAJATLARI: ${officeLines || '—'}\n\n` +
      `SHAXSIY XARAJATLAR: shu oy jami ${f(persTotal)} so'm\n\n` +
      `QARZLAR: menga qarzdorlar jami ${f(debtIn)} so'm | men qarzdorman jami ${f(debtOut)} so'm\n\n` +
      `XODIMLAR:\n${staffLines || '—'}`;
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
Shaxsiy xarajat (Ibrohimning shaxsiy harajati, biznesga aloqasiz — benzin, ovqat, shaxsiy): {"action":"personal_expense","amount":raqam,"currency":"UZS","note":"nima uchun"}
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
  // ── Shaxsiy xarajat — tasdiq bilan ──
  if (p.action === 'personal_expense' && p.amount) {
    let uzs = Number(p.amount) || 0;
    if ((p.currency || 'UZS').toUpperCase() === 'USD') uzs = uzs * USD_UZS;
    const pid = 'p' + uid();
    officePending[pid] = { kind: 'personal', uzs, note: p.note || '' };
    await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
      text: `👛 *Shaxsiy xarajat — tasdiqlang*\n\n${p.note || 'xarajat'} — *${fmtUzs(uzs)} so'm* yozilsinmi?`,
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

  // Lead yopish: "Aziza, [ism] bilan gaplashdim"
  const gm = t.match(/aziza[,:\s]+(.{2,40}?)\s*(?:bilan|билан)?\s*(?:gaplashdim|bog'landim|гаплашдим|боғландим)/i);
  if (gm) {
    try {
      const frag = gm[1].trim().toLowerCase().replace('@','');
      const { sha, list } = await leadsRead();
      const l = [...list].reverse().find(x => x.status === 'new' && ((x.username||'').toLowerCase().includes(frag) || (x.need||'').toLowerCase().includes(frag)));
      if (l) { l.status = 'contacted'; l.contactedAt = new Date().toISOString(); await ghPut(LEADS_FILE, JSON.stringify(list, null, 1), sha, 'lead contacted');
        await agentMsg(c, 'aziza', `Yaxshi ✅ ${l.username} "gaplashildi" deb belgilandi.`); return; }
      await agentMsg(c, 'aziza', `"${gm[1].trim()}" nomli yangi lead topilmadi. "Aziza, leadlar" deb ro'yxatni ko'ring.`); return;
    } catch (e) { console.error('lead close:', e.message); }
  }

  const key = await routeAgent(t);
  const hist = officeHistory.slice(-12).map(h => `${h.from}: ${h.text}`).join('\n');
  officeHistory.push({ from: 'Ibrohim', text: t.slice(0, 400) });
  if (officeHistory.length > 24) officeHistory.shift();

  let extra = '';
  if (key === 'sardor') extra = '\n\nREAL MA\'LUMOTLAR:\n' + await financeContext();
  if (key === 'aziza') { try { extra = '\n\nREAL IG MA\'LUMOTLAR:\n' + await igContext(); } catch (e) {} }
  if (key === 'botir') { try { extra = '\n\nREAL TIZIM MA\'LUMOTLARI:\n' + await botirContext(); } catch (e) {} }
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

// Aziza: kechki IG sotuv hisoboti (21:00) va lead eslatmasi (10:00)
let lastEveningReport = '', lastLeadRemindDay = '';
setInterval(async () => {
  try {
    const d = nowTZ();
    if (d.getHours() === 21 && d.getMinutes() < 2) {
      const today = todayStr();
      if (lastEveningReport !== today) {
        lastEveningReport = today;
        const target = officeChat || ADMIN;
        const ctx = await igContext();
        const weekly = d.getDay() === 0 ? "\nBugun yakshanba: qo'shimcha HAFTALIK tahlil qil — uzilgan suhbatlarda ketish sabablari (qimmat, javobsiz, uzoq hudud...), mijozlar qaysi bosqichda ko'p yo'qolyapti, 1-2 taklif." : '';
      const rep = await aiText(AGENTS.aziza.sys,
          `Bugungi Instagram DM ish kuni bo'yicha QISQA kechki hisobot tuz (faqat quyidagi real ma'lumotga asoslan, o'zingdan raqam to'qima): nechta faol suhbat, nechta lead/telefon, telefonsiz uzilganlar, 1-2 e'tibor talab misol.${weekly}\n\n${ctx}`, 900, true);
        if (rep) await agentMsg(target, 'aziza', '🌙 *Aziza — kunlik sotuv hisoboti*\n\n' + rep);
      }
    }
    if (d.getHours() === 10 && d.getMinutes() < 2) {
      const today = todayStr();
      if (lastLeadRemindDay !== today) {
        lastLeadRemindDay = today;
        const { sha, list } = await leadsRead();
        const now = Date.now(); let changed = false; const rem = [];
        for (const l of list) {
          if (l.status !== 'new' || l.reminded || !l.phone) continue;
          if (now - new Date(l.ts).getTime() > 48 * 3600 * 1000) { l.reminded = true; changed = true; rem.push(l); }
        }
        if (rem.length) {
          const txt = rem.map(l => `- ${l.username} | ${l.need || '-'} | 📞 ${l.phone} (${l.ts.slice(0,10)})`).join('\n');
          await agentMsg(officeChat || ADMIN, 'aziza', `⏰ *Eslatma — bu mijozlar bilan gaplashdingizmi?*\n${txt}\n\nGaplashgan bo'lsangiz: "Aziza, [ism] bilan gaplashdim" deb yozing.`);
          if (changed) await ghPut(LEADS_FILE, JSON.stringify(list, null, 1), sha, 'lead reminded');
        }
      }
    }
  } catch (e) { console.error('aziza tick:', e.message); }
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
      model: 'meta-llama/llama-4-scout-17b-16e-instruct', max_tokens: 1000,
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
let lastEveningReminder = '';
let lastDailySummary = '';
async function checkReminders() {
  try {
    const now = nowTZ();
    const today = todayStr();
    const hhmm = nowHHMM();

    // Morning briefing at 09:00
    if (hhmm === '09:00' && lastMorningBriefing !== today) {
      lastMorningBriefing = today;
      await sendDailyBriefing(ADMIN);

      // ── Xodimlarga kelish eslatmasi (faqat ish kuni, telegram ulangan) ──
      try {
        if (now.getDay() !== 0) { // yakshanba emas
          const staff = await readStaff();
          for (const s of staff) {
            if (s.active === false || !s.tg_chat_id) continue;
            const rec = (s.attendance || []).find(a => a.date === today);
            if (rec && rec.in) continue; // allaqachon belgilangan
            await btn(s.tg_chat_id, `🌅 Xayrli tong, ${s.name}!\n\nIshga keldingizmi?`, [[
              { text: '✅ Keldim', callback_data: 'att_in_09' },
              { text: '🕐 Kechroq', callback_data: 'att_in_late' },
              { text: '❌ Kelmayman', callback_data: 'att_absent' }
            ]]);
          }
        }
      } catch (e) { console.error('staff checkin reminder:', e.message); }
      // ── Buyurtma muddati eslatmasi (3 kun yoki kam) ──
      try {
        const { data: deals } = await ghRead('deals-log.json');
        const lines = [];
        for (const o of deals) {
          if ((o.status || 'active') !== 'active' || !o.deadline_date) continue;
          const left = workdaysBetween(now, parseDmy(o.deadline_date));
          const due = parseDmy(o.deadline_date);
          if (due < now && fmtDate(due) !== today) { lines.push(`⚠️ ${o.client} — muddat o'tdi (${o.deadline_date})`); }
          else if (left <= 3) { lines.push(`⏳ ${o.client} — ${left} ish kuni qoldi (${o.deadline_date})`); }
        }
        if (lines.length) await msg(ADMIN, '📅 *Muddat eslatmasi:*\n\n' + lines.join('\n'));
      } catch (e) { console.error('deadline reminder:', e.message); }

      // ── Kunlik backup (barcha ma'lumot fayllari) ──
      try {
        const files = ['deals-log.json', 'staff-log.json', 'office-expenses-log.json', 'expenses-personal-log.json', 'debts-log.json', 'cashbox.json'];
        for (const f of files) {
          try {
            const buf = await downloadBuffer('https://raw.githubusercontent.com/' + GH_REPO + '/main/' + f);
            if (buf) await ghPutRepo('yakubovibrohim/mbi-bot', 'backup/' + today.replace(/\./g, '-') + '/' + f, buf, 'backup ' + today);
          } catch (e) {}
        }
      } catch (e) { console.error('backup:', e.message); }

      // ── Oyning 1-kuni: o'tgan oy Excel hisoboti ──
      if (now.getDate() === 1) {
        try {
          let py = now.getFullYear(), pm = now.getMonth() - 1;
          if (pm < 0) { pm = 11; py -= 1; }
          await generateAndSendMonth(py, pm, ADMIN);
          if (now.getMonth() === 0) {
            try {
              const buf = await buildYearExcel(py);
              const fname = `Yillik-${py}.xlsx`;
              await ghPutRepo('yakubovibrohim/mbi-bot', 'hisobotlar/' + fname, buf, 'report: ' + fname);
              await sendDocBuffer(ADMIN, buf, fname, `📊 ${py}-yil — yillik hisobot`);
            } catch (e) { console.error('yearly:', e.message); }
          }
        } catch (e) { console.error('monthly excel:', e.message); }
      }
    }

    // ── Xodimlarga ketish eslatmasi (18:00) ──
    if (hhmm === '18:00' && lastEveningReminder !== today) {
      lastEveningReminder = today;
      try {
        if (now.getDay() !== 0) {
          const staff = await readStaff();
          for (const s of staff) {
            if (s.active === false || !s.tg_chat_id) continue;
            const rec = (s.attendance || []).find(a => a.date === today);
            if (!rec || !rec.in) continue; // kelmagan bo'lsa eslatma yo'q
            if (rec.out) continue; // allaqachon ketgan
            await btn(s.tg_chat_id, `🌆 Ish vaqti tugadi, ${s.name}.\n\nHali ishlayapsizmi?`, [[
              { text: '🏁 Ketdim', callback_data: 'att_out_18' },
              { text: '⏰ Hali ishlayapman', callback_data: 'att_out_working' }
            ]]);
          }
        }
      } catch (e) { console.error('staff checkout reminder:', e.message); }
    }

    // ── Adminga kunlik davomat xulosasi (18:30) ──
    if (hhmm === '18:30' && lastDailySummary !== today && now.getDay() !== 0) {
      lastDailySummary = today;
      try {
        const staff = (await readStaff()).filter(s => s.active !== false);
        let txt = `🌆 *Kunlik xulosa — ${today}*\n\n`;
        let totalH = 0;
        for (const s of staff) {
          const rec = (s.attendance || []).find(a => a.date === today);
          const absent = (s.absences || []).find(a => a.date === today);
          if (absent) { txt += `❌ ${s.name}: kelmadi${absent.reason ? ` (${absent.reason})` : ''}\n`; continue; }
          if (!rec || !rec.in) { txt += `⚪️ ${s.name}: belgilanmagan\n`; continue; }
          const d = computeDayHours(rec.in, rec.out || nowHHMM(), rec.leave_min);
          totalH += d.normalH;
          let marks = (rec.late ? ' ⚠️kech' : '') + (rec.early ? ' 🏃erta' : '');
          txt += `${rec.out ? '✅' : '🟢'} ${s.name}: ${rec.in} → ${rec.out || 'hali ishda'}${marks} (${d.normalH.toFixed(1)}s)\n`;
          if (rec.in_reason) txt += `   └ ${rec.in_reason}\n`;
          if (rec.out_reason) txt += `   └ ${rec.out_reason}\n`;
        }
        txt += `\n📊 Jami ishlangan: *${totalH.toFixed(1)} soat*`;
        await msg(ADMIN, txt);
      } catch (e) { console.error('daily summary:', e.message); }
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

// ═══════════════════════════════════════════════════════════════
// ─── Windsor.ai — Meta Ads ma'lumotlari ───
const WINDSOR_KEY = process.env.WINDSOR_KEY || '';
async function windsorAds(preset) {
  if (!WINDSOR_KEY) return [];
  const j = await httpsGetJson(`https://connectors.windsor.ai/facebook?api_key=${WINDSOR_KEY}&date_preset=${preset || 'last_7d'}&fields=date,campaign,spend,clicks,actions_onsite_conversion_messaging_conversation_started_7d`);
  return (j && j.data) || [];
}

// ─── Oxirgi o'zgarishlar (GitHub commitlar) ───
function ghCommits(n) {
  return new Promise((res) => {
    https.get({ hostname: 'api.github.com', path: `/repos/${GH_REPO}/commits?per_page=${n || 5}`,
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d).map(c => ({ date: c.commit.author.date.slice(0, 10), msg: (c.commit.message || '').split('\n')[0].slice(0, 70) }))); } catch (e) { res([]); } });
    }).on('error', () => res([]));
  });
}

// ─── Botir uchun tizim konteksti ───
async function botirContext() {
  const parts = [];
  // Botlar holati (MON)
  const st = MON.status || {};
  const bad = Object.entries(st).filter(([, v]) => !v.ok);
  parts.push('BOTLAR HOLATI: ' + (bad.length ? bad.map(([k, v]) => `❌ ${k}: ${v.msg}`).join('; ') : "✅ hammasi ishlayapti (oxirgi tekshiruvlarda muammo yo'q)"));
  // Oxirgi xatolar
  const errs = sysErrors.slice(-12).map(e => `• ${e.ts.slice(5, 16).replace('T', ' ')} ${e.msg}`).join('\n');
  parts.push('OXIRGI TIZIM XATOLARI (jurnal):\n' + (errs || '—'));
  // Muddatlar
  try {
    const { data: deals } = await ghRead('deals-log.json');
    const now = nowTZ(); const dl = [];
    for (const o of deals) {
      if ((o.status || 'active') !== 'active' || !o.deadline_date) continue;
      const due = parseDmy(o.deadline_date);
      const left = workdaysBetween(now, due);
      if (due < now) dl.push(`⚠️ ${o.client} — muddat O'TGAN (${o.deadline_date})`);
      else if (left <= 5) dl.push(`⏳ ${o.client} — ${left} ish kuni qoldi (${o.deadline_date})`);
    }
    parts.push('BUYURTMA MUDDATLARI:\n' + (dl.join('\n') || "✅ yaqin muddat xavfi yo'q"));
  } catch (e) {}
  // Reklama (Windsor, oxirgi 7 kun)
  try {
    const rows = await windsorAds('last_7d');
    const main = rows.filter(r => (r.campaign || '').includes('Xabarlar'));
    const lines = main.map(r => {
      const conv = Number(r.actions_onsite_conversion_messaging_conversation_started_7d) || 0;
      const cpc = conv ? (Number(r.spend) / conv).toFixed(2) : '—';
      return `• ${r.date}: sarf $${Number(r.spend).toFixed(2)} | klik ${Math.round(r.clicks)} | suhbat ${conv} | 1 suhbat $${cpc}`;
    }).join('\n');
    const tSpend = main.reduce((s, r) => s + Number(r.spend || 0), 0);
    const tConv = main.reduce((s, r) => s + (Number(r.actions_onsite_conversion_messaging_conversation_started_7d) || 0), 0);
    parts.push(`REKLAMA (Meta, oxirgi 7 kun, "MBI – Xabarlar – Toshkent"): jami sarf $${tSpend.toFixed(2)}, suhbatlar ${tConv}, o'rtacha 1 suhbat $${tConv ? (tSpend / tConv).toFixed(2) : '—'}\n${lines || '—'}`);
  } catch (e) {}
  // Oxirgi o'zgarishlar
  try {
    const cm = await ghCommits(5);
    parts.push("OXIRGI O'ZGARISHLAR (deploy/kod):\n" + cm.map(c => `• ${c.date} — ${c.msg}`).join('\n'));
  } catch (e) {}
  // IG qisqa
  try {
    const now = Date.now();
    const active = Object.values(igActivity).filter(a => now - (a.lastClientAt || 0) < 24 * 3600 * 1000).length;
    const { list } = await leadsRead();
    parts.push(`IG DM: 24 soatda faol suhbat ${active} ta | jami leadlar ${list.length} ta (yangi: ${list.filter(l => l.status === 'new').length})`);
  } catch (e) {}
  return parts.join('\n\n');
}

// ─── Reklama nazorati: kunlik tekshiruv 12:00 (Botir ogohlantiradi) ───
let lastAdsCheckDay = '';
setInterval(async () => {
  try {
    const d = nowTZ();
    if (d.getHours() !== 12 || d.getMinutes() >= 2) return;
    const today = todayStr();
    if (lastAdsCheckDay === today || !WINDSOR_KEY) return;
    lastAdsCheckDay = today;
    const rows = (await windsorAds('last_7d')).filter(r => (r.campaign || '').includes('Xabarlar'));
    if (rows.length < 3) return;
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = rows[rows.length - 1];
    const prev = rows.slice(0, -1);
    const cpc = (r) => { const c = Number(r.actions_onsite_conversion_messaging_conversation_started_7d) || 0; return c ? Number(r.spend) / c : null; };
    const lastCpc = cpc(last);
    const avgArr = prev.map(cpc).filter(x => x != null);
    const avg = avgArr.length ? avgArr.reduce((s, x) => s + x, 0) / avgArr.length : null;
    let warn = '';
    if (Number(last.spend) > 3 && !Number(last.actions_onsite_conversion_messaging_conversation_started_7d)) warn = `kecha $${Number(last.spend).toFixed(2)} sarflandi, lekin 0 suhbat!`;
    else if (lastCpc && avg && lastCpc > avg * 2) warn = `kecha 1 suhbat narxi $${lastCpc.toFixed(2)} — o'rtachadan ($${avg.toFixed(2)}) 2 barobar qimmat.`;
    if (warn) await agentMsg(officeChat || ADMIN, 'botir', `📉 *Reklama ogohlantirishi:* ${warn}\nTavsiya: kreativ/auditoriyani ko'rib chiqish kerak. "Botir, reklama tahlili" deb so'rasangiz batafsil beraman.`);
  } catch (e) { console.error('ads check:', e.message); }
}, 55 * 1000);

// MBI MONITOR — botlarni nazorat qiluvchi ichki agent (1-bosqich)
// Kuzatadi: tan narx bot, Instagram DM, webhook. Xavfsiz auto-fix + ogohlantirish.
// HECH QACHON tegmaydi: kod/deploy, cashbox/staff/deals ma'lumotlari, tokenlar.
// ═══════════════════════════════════════════════════════════════
const MON = {
  renderKey: process.env.RENDER_API_KEY || '',
  tnSrv: process.env.TN_BOT_SRV || 'srv-d8psu5p194ac739ltph0',
  tnUrl: process.env.TN_BOT_URL || 'https://mbi-tannarx-bot.onrender.com',
  tnToken: process.env.TN_BOT_TOKEN || '',
  mbiSrv: process.env.MBI_BOT_SRV || 'srv-d8fvkdurnols73d2q720',
  webhookUrl: (process.env.WEBHOOK_BASE || 'https://mbi-bot-yw9q.onrender.com') + '/webhook',
  igUserId: '17841464753251739',
  interval: parseInt(process.env.MON_INTERVAL || '300', 10) * 1000,
  cooldown: 3600 * 1000,  // bir muammo soatiga 1 marta
  lastAlert: {},
  fail: {}
};

function monAlert(key, text) {
  const last = MON.lastAlert[key] || 0;
  if (Date.now() - last < MON.cooldown) return;
  MON.lastAlert[key] = Date.now();
  MON.status = MON.status || {}; MON.status[key] = { ok: false, msg: text.slice(0, 120), ts: new Date().toISOString() };
  msg(ADMIN, text).catch(() => {});
  try { if (officeChat && String(officeChat) !== String(ADMIN)) agentMsg(officeChat, 'botir', text).catch(() => {}); } catch (e) {}
}
function monClear(key) { delete MON.lastAlert[key]; MON.status = MON.status || {}; MON.status[key] = { ok: true, ts: new Date().toISOString() }; }
function monTime() {
  const d = nowTZ();
  return ('0'+d.getDate()).slice(-2)+'.'+('0'+(d.getMonth()+1)).slice(-2)+' '+('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
}

async function monFetch(url, opts = {}, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    return r;
  } finally { clearTimeout(tid); }
}

// Health: cold-start uchun bir necha urinish
async function monHealth(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await monFetch(url, {}, 30000);
      if (r.status === 200) return true;
    } catch (e) { /* keyingi urinish */ }
    if (i < retries) await new Promise(r => setTimeout(r, 8000));
  }
  return false;
}

async function monTgAlive(token) {
  try {
    const r = await monFetch(`https://api.telegram.org/bot${token}/getMe`, {}, 15000);
    const d = await r.json();
    return !!d.ok;
  } catch (e) { return false; }
}

async function monRenderState(srv) {
  if (!MON.renderKey) return 'no_key';
  try {
    const r = await monFetch(`https://api.render.com/v1/services/${srv}`, {
      headers: { Authorization: 'Bearer ' + MON.renderKey }
    }, 15000);
    const d = await r.json();
    return d.suspended || 'unknown';
  } catch (e) { return 'error'; }
}

async function monRenderAction(srv, action) {  // 'resume' | 'restart'
  if (!MON.renderKey) return false;
  try {
    const r = await monFetch(`https://api.render.com/v1/services/${srv}/${action}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + MON.renderKey, 'Content-Type': 'application/json' },
      body: '{}'
    }, 20000);
    return r.status >= 200 && r.status < 300;
  } catch (e) { return false; }
}

// Webhook holati (mbi-bot o'zi)
async function monWebhook() {
  try {
    const r = await monFetch(`https://api.telegram.org/bot${BOT}/getWebhookInfo`, {}, 15000);
    const d = (await r.json()).result || {};
    return { url: d.url || '', pending: d.pending_update_count || 0, err: d.last_error_message || '' };
  } catch (e) { return { url: '', pending: 0, err: 'error' }; }
}
async function monFixWebhook() {
  try {
    const r = await monFetch(`https://api.telegram.org/bot${BOT}/setWebhook?url=${encodeURIComponent(MON.webhookUrl)}`, {}, 15000);
    return (await r.json()).ok === true;
  } catch (e) { return false; }
}

// Instagram DM ochiqmi
async function monIG() {
  if (!IG_TOKEN) return { ok: true, err: 'skip' };
  try {
    const r = await monFetch(`https://graph.instagram.com/v21.0/me/conversations?limit=1&access_token=${IG_TOKEN}`, {}, 20000);
    const d = await r.json();
    if (d.error) return { ok: false, err: (d.error.message || '').slice(0, 120) };
    return { ok: true, err: '' };
  } catch (e) { return { ok: false, err: String(e).slice(0, 120) }; }
}
async function monFixIG() {
  try {
    const r = await monFetch(`https://graph.instagram.com/v21.0/${MON.igUserId}/subscribed_apps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `subscribed_fields=messages,comments,live_comments,message_reactions&access_token=${encodeURIComponent(IG_TOKEN)}`
    }, 20000);
    return (await r.json()).success === true;
  } catch (e) { return false; }
}

// Tan narx botni tekshirish (free plan, polling)
async function monCheckTanNarx() {
  const name = 'tan-narx-bot';
  const healthy = await monHealth(MON.tnUrl, 2);
  if (!healthy) {
    MON.fail[name] = (MON.fail[name] || 0) + 1;
    const state = await monRenderState(MON.tnSrv);
    if (state === 'suspended') {
      if (await monRenderAction(MON.tnSrv, 'resume'))
        msg(ADMIN, `🔧 *${name}* to'xtagan edi — qayta yoqdim (${monTime()}).`).catch(() => {});
      else
        monAlert(name + '_resume', `🚨 *${name}* to'xtagan, qayta yoqib bo'lmadi. Qo'lda tekshiring.`);
    } else if (MON.fail[name] >= 3) {  // free cold-start uchun sabr
      if (await monRenderAction(MON.tnSrv, 'restart'))
        monAlert(name + '_restart', `🔧 *${name}* javob bermayapti — restart qildim (${monTime()}).`);
      else
        monAlert(name + '_down', `🚨 *${name}* javob bermayapti, restart ham ishlamadi. Qo'lda tekshiring.`);
    }
    return;
  }
  if (MON.fail[name] > 0) { msg(ADMIN, `✅ *${name}* yana ishlayapti (${monTime()}).`).catch(() => {}); }
  MON.fail[name] = 0;
  monClear(name + '_restart'); monClear(name + '_down');
  // polling tirikligi
  if (MON.tnToken && !(await monTgAlive(MON.tnToken)))
    monAlert(name + '_tg', `⚠️ *${name}* Telegram'ga ulanmayapti (polling to'xtagan bo'lishi mumkin).`);
}

// mbi-bot tashqi qismlari (webhook + Instagram) — o'zini kuzatmaydi
async function monCheckSelf() {
  // Webhook
  const wh = await monWebhook();
  if (wh.url && wh.url !== MON.webhookUrl) {
    if (await monFixWebhook())
      msg(ADMIN, `🔧 mbi-bot webhook noto'g'ri edi — qayta o'rnatdim (${monTime()}).`).catch(() => {});
    else
      monAlert('mbi_wh', `⚠️ mbi-bot webhook noto'g'ri: \`${wh.url.slice(0, 60)}\``);
  }
  if (wh.pending > 50)
    monAlert('mbi_pending', `⚠️ mbi-bot webhook'da ${wh.pending} ta kutilayotgan yangilanish. Bot sekinlashgan bo'lishi mumkin.`);

  // Instagram
  const ig = await monIG();
  if (!ig.ok && ig.err !== 'skip') {
    const e = ig.err.toLowerCase();
    if (e.includes('disabled access') || e.includes('code 200') || e.includes('(#200)')) {
      // Avval avtomatik tuzatishga urinamiz — ba'zan toggle emas, obuna uzilgan bo'ladi (API tuzata oladi)
      const fixed = await monFixIG();
      if (fixed) {
        // Qayta tekshiramiz — chindan tuzaldimi
        const recheck = await monIG();
        if (recheck.ok) {
          msg(ADMIN, `🔧 Instagram DM obunasi uzilgan edi — avtomatik qayta yoqdim, hozir ishlayapti (${monTime()}).`).catch(() => {});
          monClear('mbi_ig'); monClear('mbi_ig_toggle');
          return;
        }
      }
      // API tuzata olmadi — demak haqiqatan toggle qo'lda o'chirilgan
      monAlert('mbi_ig_toggle',
        `⚠️ *Instagram DM yopilgan!*\n\nXato: \`${ig.err}\`\n\nAvtomatik tuzatishga urindim, ammo bu sozlamani faqat qo'lda yoqish mumkin:\nInstagram ilovasi → Sozlamalar → «Сообщения» → «Подключенные инструменты» → «Разрешить доступ к сообщениям» yoqing.`);
    } else {
      if (await monFixIG())
        msg(ADMIN, `🔧 mbi-bot Instagram obunasini qayta yoqdim (${monTime()}).`).catch(() => {});
      else
        monAlert('mbi_ig', `⚠️ mbi-bot Instagram muammo: \`${ig.err}\``);
    }
  } else { monClear('mbi_ig'); monClear('mbi_ig_toggle'); }
}

async function monitorTick() {
  try { await monCheckTanNarx(); } catch (e) { console.error('mon tannarx:', e.message); }
  try { await monCheckSelf(); } catch (e) { console.error('mon self:', e.message); }
  try { await pollIGComments(); } catch (e) { console.error('poll IG comments:', e.message); }
}

if (MON.renderKey || MON.tnToken || IG_TOKEN) {
  setInterval(monitorTick, MON.interval);
  setTimeout(() => { monitorTick().catch(() => {}); }, 30000);  // startdan 30s keyin birinchi tekshiruv
  console.log('🛡 MBI Monitor yoqildi (har ' + (MON.interval / 60000) + ' daqiqada)');
}


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
        } else if (pend.kind === 'personal') {
          const { data, sha } = await ghRead('expenses-personal-log.json');
          data.push({ date: todayStr(), note: pend.note, amount_uzs: pend.uzs, rate: USD_UZS, type: 'personal', ts: new Date().toISOString() });
          await ghPut('expenses-personal-log.json', JSON.stringify(data, null, 2), sha, 'personal expense (voice)');
          await api('sendMessage', { chat_id: c, parse_mode: 'Markdown', text: `✅ Shaxsiy xarajat yozildi: ${pend.note} — ${fmtUzs(pend.uzs)} so'm` });
        }
        return;
      }
      // ── Buyurtmalar bo'limi navigatsiyasi ──
      if (cd === 'start_order') { await orderStart(c); return; }
      if (cd === 'menu_orders') { await showOrdersList(c, 'active'); return; }
      if (cd === 'menu_done') { await showOrdersList(c, 'done'); return; }
      if (cd === 'menu_cancelled') { await showOrdersList(c, 'cancelled'); return; }
      if (cd === 'menu_staff') { await showStaffList(c); return; }
      if (cd === 'all_att') { await showAllAttendance(c); return; }
      if (cd === 'disc_report') { await showDisciplineReport(c); return; }
      if (cd === 'menu_home') { await showHomeMenu(c); return; }
      // ── 3-bosqich: kassa, ishxona, shaxsiy, qarzlar ──
      if (cd === 'menu_cash') { await showCashbox(c); return; }
      if (cd === 'cash_set') { await cashSetStart(c); return; }
      if (cd === 'menu_office_exp') { await showOfficeExp(c); return; }
      if (cd === 'ofx_add') { await officeExpAddStart(c); return; }
      if (cd === 'menu_personal_exp') { await showPersonalExp(c); return; }
      if (cd === 'psx_add') { await personalExpAddStart(c); return; }
      if (cd === 'menu_debts') { await showDebts(c); return; }
      // ── 4-bosqich: hisobot, Excel ──
      if (cd === 'menu_summary') { await showSummary(c); return; }
      if (cd === 'xls_now') { await msg(c, '⏳ Excel tayyorlanyapti...'); const n = nowTZ(); await generateAndSendMonth(n.getFullYear(), n.getMonth(), c); return; }
      if (cd === 'xls_list') { await showReportsList(c); return; }
      if (cd.startsWith('xls_get_')) { await sendSavedReport(c, cd.slice(8)); return; }
      if (cd === 'debt_add_in') { await debtAddStart(c, 'in'); return; }
      if (cd === 'debt_add_out') { await debtAddStart(c, 'out'); return; }
      if (cd === 'debt_pay') { await showDebtPayList(c); return; }
      if (cd.startsWith('debtpay_')) { await debtPayStart(c, cd.slice(8)); return; }
      if (cd === 'debt_note_skip') { const st = orderState[c]; if (st && st.step === 'debt_note') { const dir = st.debtDir, name = st.debtName, amt = st.debtAmount; delete orderState[c]; await debtSave(c, dir, name, amt, ''); } return; }
      // ── Xodimlar ──
      if (cd === 'stf_add') { await staffAddStart(c); return; }
      if (cd === 'stf_hire_today') { const st = orderState[c]; if (st && st.step === 'stf_hire') { const name = st.staffName, sal = st.staffSalary; delete orderState[c]; await staffSaveNew(c, name, sal, todayStr()); } return; }
      if (cd === 'stf_hire_skip') { const st = orderState[c]; if (st && st.step === 'stf_hire') { const name = st.staffName, sal = st.staffSalary; delete orderState[c]; await staffSaveNew(c, name, sal, null); } return; }
      if (cd.startsWith('stf_open_')) { await showStaffCard(c, cd.slice(9)); return; }
      if (cd.startsWith('stf_adv_')) { await staffAdvStart(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_hist_')) { await showStaffHistory(c, cd.slice(9)); return; }
      if (cd.startsWith('stf_att_')) { await showAttendance(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_bonus_')) { await staffBonusStart(c, cd.slice(10)); return; }
      if (cd.startsWith('stf_close_')) { await staffCloseMonthStart(c, cd.slice(10)); return; }
      if (cd.startsWith('stf_tg_')) { await staffTgToggle(c, cd.slice(7)); return; }
      if (cd.startsWith('stf_bindpick_')) { await staffBindPick(c, cd.slice(13)); return; }
      if (cd.startsWith('stf_sal_')) { await staffSalStart(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_del_')) { await staffDelete(c, cd.slice(8)); return; }
      // xodim check-in/out (yo'qlama javoblari)
      if (cd === 'att_in_09') { const cur = nowHHMM(); const useTime = (hmToMin(cur) <= WORK_START) ? '09:00' : cur; await attCheckIn(c, useTime, false); return; }
      if (cd.startsWith('att_in_') && cd !== 'att_in_late') { await attCheckIn(c, null, false); return; }
      if (cd === 'att_in_late') { await attCheckInLate(c); return; }
      if (cd === 'att_absent') { await attMarkAbsent(c); return; }
      if (cd === 'att_out_18') { await attCheckOut(c, nowHHMM()); return; }
      if (cd.startsWith('att_out_') && cd !== 'att_out_working' && cd !== 'att_out_now') { await attCheckOut(c, null); return; }
      if (cd === 'worker_me') { const s = await staffByChat(c); if (s) await showWorkerAccount(c, s); return; }
      if (cd === 'worker_panel') { const s = await staffByChat(c); if (s) await showWorkerPanel(c, s); return; }
      if (cd === 'worker_adv') { const s = await staffByChat(c); if (s) { orderState[c] = { step: 'worker_adv_amount', staffId: s.id }; await btn(c, '💸 *Qancha avans oldingiz?*\n\n_$ bo\'lsa dollar, bo\'lmasa so\'m. Masalan: 100$ yoki 500000_', [[{ text: '❌ Bekor', callback_data: 'worker_panel' }]]); } return; }
      if (cd === 'att_out_now') { const now = nowTZ(); await attCheckOut(c, ('0'+now.getHours()).slice(-2)+':'+('0'+now.getMinutes()).slice(-2)); return; }
      if (cd === 'att_manual') { const s = await staffByChat(c); if (s) await showAttManual(c, s); return; }
      if (cd === 'leave_menu') { const s = await staffByChat(c); if (s) await showLeaveMenu(c, s); return; }
      if (cd === 'late_skip' || cd === 'early_skip') { delete orderState[c]; await msg(c, 'Mayli. Keyin xohlasangiz, jadvalga sabab qo\'shib qo\'yasiz.'); return; }
      // Sabab toifasi tanlandi: rc_<ctx>_<code>
      if (cd.startsWith('rc_')) {
        const parts = cd.split('_'); const ctx = parts[1]; const code = parts.slice(2).join('_');
        const st = orderState[c];
        if (code === 'boshqa') {
          // matn so'raymiz — step o'zgarmaydi, faqat belgilaymiz
          if (st) st.awaitText = true;
          await msg(c, '✍️ Sababini yozing:');
          return;
        }
        const label = reasonCatLabel(code);
        if (ctx === 'late' && st) {
          await attSaveReason(c, st.staffId, st.date, 'in_reason', label);
          const nm = (await staffByChat(c) || {}).name || '';
          delete orderState[c];
          await msg(c, '✅ Rahmat, sabab yozildi.');
          try { await msg(ADMIN, `⚠️ *Kech kelish*\n👷 ${nm}\n🕐 ${st.inTime}\nSabab: ${label}`); } catch (e) {}
        } else if (ctx === 'early' && st) {
          await attSaveReason(c, st.staffId, st.date, 'out_reason', label);
          const nm = (await staffByChat(c) || {}).name || '';
          delete orderState[c];
          await msg(c, '✅ Rahmat, sabab yozildi.');
          try { await msg(ADMIN, `⚠️ *Erta ketish*\n👷 ${nm}\n🕐 ${st.outTime}\nSabab: ${label}`); } catch (e) {}
        } else if ((ctx === 'lvpartial' || ctx === 'lvdayoff' || ctx === 'lvearly') && st) {
          st.chosenReason = label;
          await leaveFinalize(c, st);
        }
        return;
      }
      if (cd === 'att_table') { const s = await staffByChat(c); if (s) await showAttTable(c, s); return; }
      if (cd === 'leave_partial') { const s = await staffByChat(c); if (s) { orderState[c] = { step: 'leave_partial_hours', staffId: s.id }; await btn(c, '🕐 *Vaqtincha chiqish*\\n\\nNecha soatga chiqasiz? Raqam yozing. Masalan: 2 yoki 1.5', [[{ text: '❌ Bekor', callback_data: 'leave_menu' }]]); } return; }
      if (cd === 'leave_dayoff') { const s = await staffByChat(c); if (s) { orderState[c] = { step: 'leave_dayoff_when', staffId: s.id }; await btn(c, '📅 *Kelmaslik*\\n\\nQaysi kun kela olmaysiz?', [[{ text: 'Bugun', callback_data: 'lvday_today' }, { text: 'Ertaga', callback_data: 'lvday_tomorrow' }], [{ text: '❌ Bekor', callback_data: 'leave_menu' }]]); } return; }
      if (cd === 'leave_early') { const s = await staffByChat(c); if (s) { orderState[c] = { step: 'leave_early_time', staffId: s.id }; await btn(c, '🏃 *Erta ketish*\\n\\nBugun soat nechada ketmoqchisiz? HH:MM yozing. Masalan: 16:00', [[{ text: '❌ Bekor', callback_data: 'leave_menu' }]]); } return; }
      if (cd === 'lvday_today' || cd === 'lvday_tomorrow') {
        const s = await staffByChat(c);
        if (s) {
          const d = nowTZ(); if (cd === 'lvday_tomorrow') d.setDate(d.getDate() + 1);
          const ds = ('0'+d.getDate()).slice(-2)+'.'+('0'+(d.getMonth()+1)).slice(-2)+'.'+d.getFullYear();
          orderState[c] = { step: 'leave_reason_cat', flow: 'dayoff', staffId: s.id, leaveDate: ds };
          await askReasonCats(c, 'lvdayoff', `📅 *${ds}* kela olmaysiz.\n\nSababini tanlang:`);
        }
        return;
      }
      if (cd.startsWith('lvok_')) { await leaveConfirm(c, cd.slice(5), true); return; }
      if (cd.startsWith('lvno_')) { await leaveConfirm(c, cd.slice(5), false); return; }
      if (cd === 'att_mark_in') { await attCheckIn(c, nowHHMM(), false); const s = await staffByChat(c); if (s) await showAttManual(c, s); return; }
      if (cd === 'att_mark_out') { await attCheckOut(c, nowHHMM()); const s = await staffByChat(c); if (s) await showAttManual(c, s); return; }
      if (cd === 'bonus_noreason') { const st = orderState[c]; if (st && st.step === 'stf_bonus_reason') { const id = st.staffId, amt = st.bonusUsd; delete orderState[c]; await staffSaveBonus(c, id, amt, ''); } return; }
      if (cd === 'noop') { return; }
      // avans tasdiqlash
      if (cd.startsWith('advok_')) { await advConfirm(c, cd.slice(6), true); return; }
      if (cd.startsWith('advno_')) { await advConfirm(c, cd.slice(6), false); return; }
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

    // ── Xodim reply-keyboard tugmalari (matn sifatida keladi) ──
    if (!isAdmin && t && !orderState[c]) {
      const ws = await staffByChat(c);
      if (ws) {
        if (t === '✅ Keldim') { await attCheckIn(c, nowHHMM(), false); const s2 = await staffByChat(c); if (s2) await showWorkerPanel(c, s2); return; }
        if (t === '🏁 Ketdim') { await attCheckOut(c, nowHHMM()); const s2 = await staffByChat(c); if (s2) await showWorkerPanel(c, s2); return; }
        if (t === '🙋 Javob so\'rash') { await showLeaveMenu(c, ws); return; }
        if (t === '💵 Hisobim') { await showWorkerAccount(c, ws); return; }
        if (t === '📅 Jadval') { await showAttTable(c, ws); return; }
        if (t === '🏠 Bosh menyu') { await showWorkerPanel(c, ws); return; }
      }
    }

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
        st.staffSalary = n; await staffAskHireDate(c); return;
      }
      else if (st.step === 'stf_hire') {
        const p = dmyParts(t);
        if (!p) { await msg(c, '❗️ Sanani DD.MM.YYYY ko\'rinishida yozing. Masalan: 15.03.2026. Yoki «Bugundan»/«Noma\'lum» tugmasini bosing.'); return; }
        const name = st.staffName, sal = st.staffSalary; delete orderState[c];
        await staffSaveNew(c, name, sal, t.trim()); return;
      }
      else if (st.step === 'stf_adv_amount') {
        const hasUsd = /\$|dollar|dol\b/i.test(t);
        const num = parseFloat(t.replace(/[^\d.,]/g, '').replace(/,/g, '.'));
        if (isNaN(num) || num <= 0) { await msg(c, '❗️ Summani raqam bilan yozing. Masalan: 100$ yoki 500000 (so\'m)'); return; }
        const usd = Math.round((hasUsd ? num : num / USD_UZS) * 100) / 100;
        const id = st.staffId; delete orderState[c];
        // admin kiritdi → pending, xodimga tasdiq uchun
        const { data, sha, idx } = await findStaff(id);
        if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
        const s2 = data[idx];
        const advId = uid();
        s2.advances = s2.advances || [];
        const needConfirm = !!s2.tg_chat_id; // telegram ulangan bo'lsa tasdiq kerak
        s2.advances.push({ id: advId, date: todayStr(), amount_usd: usd, entered_by: 'admin', pending: needConfirm });
        await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'advance by admin: ' + s2.name);
        if (needConfirm) {
          await msg(c, `⏳ Avans yuborildi: *${s2.name}* — $${usd.toFixed(2)}\nXodim tasdiqlashini kutmoqda.`);
          await btn(s2.tg_chat_id, `💸 *Avans tasdiqlash*\n\nIbrohim sizga $${usd.toFixed(2)} avans berdi deb belgiladi. To'g'rimi?`, [[{ text: '✅ Ha, oldim', callback_data: 'advok_' + advId }, { text: '❌ Yo\'q', callback_data: 'advno_' + advId }]]);
        } else {
          await msg(c, `✅ Avans qo'shildi: *${s2.name}* — $${usd.toFixed(2)}${hasUsd ? '' : ' (' + fmtUzs(num) + ' so\'m)'}\n\n_(Telegram ulanmagani uchun tasdiqsiz yozildi.)_`);
        }
        await showStaffCard(c, id);
        return;
      }
      else if (st.step === 'stf_bonus_amount') {
        const hasUsd = /\$|dollar|dol\b/i.test(t);
        const num = parseFloat(t.replace(/[^\d.,]/g, '').replace(/,/g, '.'));
        if (isNaN(num) || num <= 0) { await msg(c, '❗️ Summani raqam bilan yozing. Masalan: 35$'); return; }
        st.bonusUsd = Math.round((hasUsd ? num : num / USD_UZS) * 100) / 100;
        st.step = 'stf_bonus_reason';
        await btn(c, `🎁 *Bonus sababi?*\n\n_Qisqa yozing (masalan: yaxshi ishlagani uchun) yoki «Sababsiz»._`, [[{ text: 'Sababsiz', callback_data: 'bonus_noreason' }], [{ text: '❌ Bekor', callback_data: 'stf_open_' + st.staffId }]]);
        return;
      }
      else if (st.step === 'stf_bonus_reason') {
        const id = st.staffId, amt = st.bonusUsd; delete orderState[c];
        await staffSaveBonus(c, id, amt, t.trim());
        return;
      }
      else if (st.step === 'stf_close_amount') {
        const hasUsd = /\$|dollar|dol\b/i.test(t);
        const num = parseFloat(t.replace(/[^\d.,]/g, '').replace(/,/g, '.'));
        if (isNaN(num) || num < 0) { await msg(c, '❗️ Summani raqam bilan yozing.'); return; }
        const usd = Math.round((hasUsd ? num : num / USD_UZS) * 100) / 100;
        const id = st.staffId; delete orderState[c];
        await staffCloseMonth(c, id, usd);
        return;
      }
      else if (st.step === 'att_in_time') {
        const hm = hmToMin(t);
        if (hm == null) { await msg(c, '❗️ Soatni HH:MM ko\'rinishida yozing. Masalan: 9:20'); return; }
        delete orderState[c];
        await attCheckIn(c, minToHm(hm), true);
        return;
      }
      else if (st.step === 'worker_adv_amount') {
        const hasUsd = /\$|dollar|dol\b/i.test(t);
        const num = parseFloat(t.replace(/[^\d.,]/g, '').replace(/,/g, '.'));
        if (isNaN(num) || num <= 0) { await msg(c, '❗️ Summani raqam bilan yozing. Masalan: 100$ yoki 500000'); return; }
        const usd = Math.round((hasUsd ? num : num / USD_UZS) * 100) / 100;
        const id = st.staffId; delete orderState[c];
        const { data, sha, idx } = await findStaff(id);
        if (idx < 0) { await msg(c, '⚠️ Xatolik.'); return; }
        const s2 = data[idx];
        const advId = uid();
        s2.advances = s2.advances || [];
        s2.advances.push({ id: advId, date: todayStr(), amount_usd: usd, entered_by: 'worker', pending: true });
        await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, 'advance by worker: ' + s2.name);
        await msg(c, `⏳ Avans yuborildi: $${usd.toFixed(2)}\nIbrohim tasdiqlashini kuting.`);
        // adminga tasdiq uchun
        await btn(ADMIN, `💸 *Avans tasdiqlash*\n\n${s2.name} $${usd.toFixed(2)} avans oldim deb belgiladi. To'g'rimi?`, [[{ text: '✅ Ha, berdim', callback_data: 'advok_' + advId }, { text: '❌ Yo\'q', callback_data: 'advno_' + advId }]]);
        return;
      }
      else if (st.step === 'leave_partial_hours') {
        const num = parseFloat(t.replace(/[^\d.,]/g, '').replace(/,/g, '.'));
        if (isNaN(num) || num <= 0 || num > 9) { await msg(c, '❗️ Soatni raqam bilan yozing. Masalan: 2 yoki 1.5'); return; }
        st.leaveHours = num; st.flow = 'partial'; st.step = 'leave_reason_cat';
        await askReasonCats(c, 'lvpartial', `🕐 *${num} soat*ga chiqasiz.\n\nSababini tanlang:`);
        return;
      }
      else if (st.step === 'leave_reason_cat' && st.awaitText) {
        // "Boshqa" tanlangan — matn kiritildi
        st.typedReason = t.trim(); st.awaitText = false;
        await leaveFinalize(c, st);
        return;
      }
      else if (st.step === 'leave_partial_reason') {
        const id = st.staffId, hours = st.leaveHours, reason = t.trim(); delete orderState[c];
        const lv = { id: uid(), type: 'partial', date: todayStr(), hours, reason, status: 'pending', requested: todayStr() };
        const s2 = await saveLeaveRequest(c, id, lv);
        if (s2) { await msg(c, `⏳ So'rov yuborildi: ${hours} soatga chiqish.\nIbrohim tasdiqlashini kuting.`); await sendLeaveToAdmin(s2, lv); }
        return;
      }
      else if (st.step === 'leave_dayoff_reason') {
        const id = st.staffId, date = st.leaveDate, reason = t.trim(); delete orderState[c];
        const lv = { id: uid(), type: 'dayoff', date, reason, status: 'pending', requested: todayStr() };
        const s2 = await saveLeaveRequest(c, id, lv);
        if (s2) { await msg(c, `⏳ So'rov yuborildi: ${date} kelmaslik.\nIbrohim tasdiqlashini kuting.`); await sendLeaveToAdmin(s2, lv); }
        return;
      }
      else if (st.step === 'leave_early_time') {
        const hm = hmToMin(t);
        if (hm == null) { await msg(c, '❗️ Soatni HH:MM ko\'rinishida yozing. Masalan: 16:00'); return; }
        st.leaveTime = minToHm(hm); st.flow = 'early'; st.step = 'leave_reason_cat';
        await askReasonCats(c, 'lvearly', `🏃 Bugun *${st.leaveTime}* da ketasiz.\n\nSababini tanlang:`);
        return;
      }
      else if (st.step === 'leave_early_reason') {
        const id = st.staffId, time = st.leaveTime, reason = t.trim(); delete orderState[c];
        const lv = { id: uid(), type: 'early', date: todayStr(), time, reason, status: 'pending', requested: todayStr() };
        const s2 = await saveLeaveRequest(c, id, lv);
        if (s2) { await msg(c, `⏳ So'rov yuborildi: bugun ${time} da ketish.\nIbrohim tasdiqlashini kuting.`); await sendLeaveToAdmin(s2, lv); }
        return;
      }
      else if (st.step === 'late_reason') {
        const reason = t.trim(); const { staffId, date, inTime } = st; delete orderState[c];
        await attSaveReason(c, staffId, date, 'in_reason', reason);
        await msg(c, '✅ Rahmat, sabab yozildi.');
        try { await msg(ADMIN, `⚠️ *Kech kelish*\n👷 ${(await staffByChat(c) || {}).name || ''}\n🕐 ${inTime} (${date})\nSabab: ${reason}`); } catch (e) {}
        return;
      }
      else if (st.step === 'early_reason') {
        const reason = t.trim(); const { staffId, date, outTime } = st; delete orderState[c];
        await attSaveReason(c, staffId, date, 'out_reason', reason);
        await msg(c, '✅ Rahmat, sabab yozildi.');
        try { await msg(ADMIN, `⚠️ *Erta ketish*\n👷 ${(await staffByChat(c) || {}).name || ''}\n🕐 ${outTime} (${date})\nSabab: ${reason}`); } catch (e) {}
        return;
      }
      else if (st.step === 'stf_sal_amount') {
        const n = parseFloat(t.replace(/[^\d.]/g, ''));
        if (isNaN(n) || n <= 0) { await msg(c, '❗️ Oylikni raqam bilan yozing.'); return; }
        const id = st.staffId; delete orderState[c]; await staffSetSalary(c, id, n); return;
      }
      // ── Ishxona xarajati ──
      else if (st.step === 'ofx_name') { st.ofxName = t.trim(); st.step = 'ofx_amount'; await btn(c, `🏭 *${t.trim()}* — summasi:\n\n_So'mda yoki $ bilan_`, [[{ text: '❌ Bekor', callback_data: 'menu_office_exp' }]]); return; }
      else if (st.step === 'ofx_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Summani to\'g\'ri yozing. Masalan: 2000000 yoki 150$'); return; }
        const name = st.ofxName; delete orderState[c]; await officeExpSave(c, name, uzs); return;
      }
      // ── Shaxsiy xarajat (qo'lda) ──
      else if (st.step === 'psx_note') { st.psxNote = t.trim(); st.step = 'psx_amount'; await btn(c, `👛 *${t.trim()}* — summasi:\n\n_So'mda yoki $ bilan_`, [[{ text: '❌ Bekor', callback_data: 'menu_personal_exp' }]]); return; }
      else if (st.step === 'psx_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Summani to\'g\'ri yozing.'); return; }
        const note = st.psxNote; delete orderState[c]; await personalExpSave(c, note, uzs); return;
      }
      // ── Qarz qo'shish ──
      else if (st.step === 'debt_name') { st.debtName = t.trim(); st.step = 'debt_amount'; await btn(c, `💳 *${t.trim()}* — summa:\n\n_So'mda yoki $ bilan_`, [[{ text: '❌ Bekor', callback_data: 'menu_debts' }]]); return; }
      else if (st.step === 'debt_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Summani to\'g\'ri yozing.'); return; }
        st.debtAmount = uzs; st.step = 'debt_note';
        await btn(c, '📝 *Izoh* (kim, nima uchun qarz):\n\n_Masalan: Akmal — fanera uchun. Yoki «O\'tkazib yuborish»._', [[{ text: '⏭ O\'tkazib yuborish', callback_data: 'debt_note_skip' }], [{ text: '❌ Bekor', callback_data: 'menu_debts' }]]); return;
      }
      else if (st.step === 'debt_note') {
        const dir = st.debtDir, name = st.debtName, amt = st.debtAmount; delete orderState[c];
        await debtSave(c, dir, name, amt, t.trim()); return;
      }
      else if (st.step === 'debt_pay_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs <= 0) { await msg(c, '❗️ Summani to\'g\'ri yozing.'); return; }
        const id = st.debtId; delete orderState[c]; await debtPaySave(c, id, uzs); return;
      }
      // ── Kassa boshlang'ich qoldiq ──
      else if (st.step === 'cash_amount') {
        const uzs = parseMoneyToUzs(t);
        if (uzs == null || uzs < 0) { await msg(c, '❗️ Summani to\'g\'ri yozing. Masalan: 5000000 yoki 400$'); return; }
        delete orderState[c]; await cashSetSave(c, uzs); return;
      }
      else if (await orderHandleText(c, t)) return;
      else {
        // Noma'lum holat — oqimni tozalaymiz, foydalanuvchi qotib qolmasin
        delete orderState[c];
        await msg(c, 'Bekor qilindi. /start orqali bosh menyuni oching.');
        return;
      }
    }

    // Commands
    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g,'')] = c;

    if (isAdmin && (t === '/yangi' || t === '/buyurtma')) { await orderStart(c); return; }

    if (t === '/start') {
      state[c] = {};
      if (isAdmin) {
        await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
          text: '👋 *Assalomu alaykum, Ibrohim!* (v2.1)\n\n📱 *Botga nima yuborsa bo\'ladi:*\n\n🎤 *Ovozli xabar:*\n  • "Sherzod kelmadi"\n  • "Diyor 100 dollar avans oldi"\n  • "Soat 3 da Boxodir aka bilan uchrashuv"\n  • "Shaxsiy xarajat 50000 so\'m benzin"\n\n📸 *Nakładnoy rasmi* → mijoz so\'raldi → saqlanadi\n\n📋 *Buyruqlar:*\n/hisobot — oylik hisobot\n/bugun — bugungi reja\n/vazifalar — bugungi vazifalar',
          reply_markup: { inline_keyboard: [
            [{ text: '🆕 Yangi buyurtma', callback_data: 'start_order' }],
            [{ text: '📁 Buyurtmalar', callback_data: 'menu_orders' }],
            [{ text: '✅ Tugatilganlar', callback_data: 'menu_done' }, { text: '🚫 Bekor qilinganlar', callback_data: 'menu_cancelled' }],
            [{ text: '👷 Xodimlar', callback_data: 'menu_staff' }, { text: '💰 Kassa', callback_data: 'menu_cash' }],
            [{ text: '🏭 Ishxona xarajatlari', callback_data: 'menu_office_exp' }],
            [{ text: '👛 Shaxsiy xarajatlar', callback_data: 'menu_personal_exp' }],
            [{ text: '💳 Qarzlar', callback_data: 'menu_debts' }],
            [{ text: '📊 Umumiy hisobot', callback_data: 'menu_summary' }]
          ] } });
        try { await msgKb(c, '👇 Tezkor menyu pastda:', adminKeyboard()); } catch (e) {}
        return;
      }
      // Xodimmi? (telegram ulangan)
      const staffMember = await staffByChat(c);
      if (staffMember) { await showWorkerPanel(c, staffMember); return; }
      // Aks holda: pending-tg ga qo'shamiz (admin keyin biriktirishi uchun) + til tanlash
      try {
        const ps = await ghRead('pending-tg.json');
        const pend = Array.isArray(ps.data) ? ps.data : [];
        if (!pend.some(p => String(p.chat_id) === String(c))) {
          const uname = upd.message.from ? [upd.message.from.first_name, upd.message.from.last_name].filter(Boolean).join(' ') : '';
          pend.push({ chat_id: c, name: uname || '', ts: Date.now() });
          await ghPut('pending-tg.json', JSON.stringify(pend, null, 2), ps.sha, 'pending tg add');
        }
      } catch (e) {}
      await btn(c, 'MEBEL BY IBROHIM\n\nTilni tanlang:', [[{text:"O'zbek tili",callback_data:'til_uz'}],[{text:'Russkiy yazyk',callback_data:'til_ru'}]]);
      return;
    }

    if (isAdmin) {
      // Reply-keyboard tugmalari (matn sifatida keladi)
      if (t === '🏠 Bosh menyu') {
        state[c] = {}; delete orderState[c];
        await api('sendMessage', { chat_id: c, parse_mode: 'Markdown',
          text: '🏠 *Bosh menyu*',
          reply_markup: { inline_keyboard: [
            [{ text: '🆕 Yangi buyurtma', callback_data: 'start_order' }],
            [{ text: '📁 Buyurtmalar', callback_data: 'menu_orders' }],
            [{ text: '✅ Tugatilganlar', callback_data: 'menu_done' }, { text: '🚫 Bekor qilinganlar', callback_data: 'menu_cancelled' }],
            [{ text: '👷 Xodimlar', callback_data: 'menu_staff' }, { text: '💰 Kassa', callback_data: 'menu_cash' }],
            [{ text: '🏭 Ishxona xarajatlari', callback_data: 'menu_office_exp' }],
            [{ text: '👛 Shaxsiy xarajatlar', callback_data: 'menu_personal_exp' }],
            [{ text: '💳 Qarzlar', callback_data: 'menu_debts' }],
            [{ text: '📊 Umumiy hisobot', callback_data: 'menu_summary' }]
          ] } });
        return;
      }
      if (t === '📊 Hisobot') { await sendReport(c); return; }
      if (t === '👷 Xodimlar') { await showStaffList(c); return; }
      if (t === '👥 Davomat') { await showAllAttendance(c); return; }
      if (t === '💰 Kassa') { await showCashbox(c); return; }
      if (t === '📋 Bugun') { await sendDailyBriefing(c); return; }
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
  } catch (e) {
    console.error(e);
    try {
      const cc = (upd.callback_query && upd.callback_query.message.chat.id) || (upd.message && upd.message.chat.id);
      if (cc && String(cc) === String(ADMIN)) { await api('sendMessage', { chat_id: cc, text: '⚠️ Texnik xatolik: ' + (e.message || e) + '\n\n/start orqali qayta boshlang.' }); }
    } catch (e2) {}
  }
}
const IG_TOKEN = (process.env.IG_TOKEN || '').trim().replace(/[\r\n]/g, '');
const IG_USER_ID = '17841464753251739';
const IG_VERIFY = 'mbi_secret_2024';
const OR_KEY = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';

// Conversation history: last 6 messages per user (3 turns)
const igConvHistory = {};
const igActivity = {}; // { userId: { lastClientAt, followedUp } }
const IG_HISTORY_FILE = 'ig-dm-history.json';
let igHistSaveTimer = null, igHistSha = null;

// Restart'da suhbatlar o'chmasligi uchun GitHub'dan yuklash
async function loadIgHistory() {
  try {
    const d = await ghGet(IG_HISTORY_FILE);
    igHistSha = d.sha;
    const parsed = JSON.parse(Buffer.from(d.content, 'base64').toString('utf8'));
    if (parsed && parsed.histories) {
      Object.assign(igConvHistory, parsed.histories);
      Object.assign(igActivity, parsed.activity || {});
      console.log('IG tarix yuklandi:', Object.keys(igConvHistory).length, 'suhbat');
    }
  } catch (e) { console.log('IG tarix topilmadi (birinchi ishga tushish):', e.message); }
}

// Har javobdan keyin 30s ichida bir marta saqlash (coalesce)
function saveIgHistoryDebounced() {
  if (igHistSaveTimer) return;
  igHistSaveTimer = setTimeout(async () => {
    igHistSaveTimer = null;
    try {
      // faqat oxirgi 60 kunlik faol suhbatlarni saqlaymiz
      const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
      const histories = {}, activity = {};
      for (const [uid, act] of Object.entries(igActivity)) {
        if (act.lastClientAt > cutoff && igConvHistory[uid]) { histories[uid] = igConvHistory[uid]; activity[uid] = act; }
      }
      const payload = JSON.stringify({ histories, activity }, null, 1);
      await ghPut(IG_HISTORY_FILE, payload, igHistSha, 'IG DM tarix');
      const d = await ghGet(IG_HISTORY_FILE); igHistSha = d.sha;
    } catch (e) { console.error('IG tarix saqlash xato:', e.message); igHistSha = null; }
  }, 30000);
}

// ── Follow-up: mijoz 20 soat jim bo'lsa, 24 soatlik oyna yopilishidan oldin 1 marta yumshoq eslatma ──
async function igFollowupTick() {
  const now = Date.now();
  for (const [uid, act] of Object.entries(igActivity)) {
    if (act.followedUp) continue;
    const silentH = (now - act.lastClientAt) / 3600000;
    if (silentH < 20 || silentH >= 23.5) continue;           // faqat 20–23.5 soat oynasida
    if (igManualMode[uid]) continue;                          // qo'lda rejimda — tegilmaydi
    const hist = igConvHistory[uid];
    if (!hist || hist.length < 2) continue;
    act.followedUp = true;
    try {
      const fu = await orChatMessages([
        { role: 'system', content: "Sen MBI Mebel sotuv yordamchisisan. Suhbat to'xtab qolgan mijozga BITTA qisqa, yumshoq, bosimsiz follow-up xabar yoz — mijozning tilida (ruscha yozgan bo'lsa ruscha). Maqsad: suhbatni jonlantirish yoki telefon raqam so'rash. Faqat xabar matnini qaytar, boshqa hech narsa." },
        ...hist.slice(-10),
        { role: 'user', content: '[TIZIM: mijoz 20 soatdan beri jim. Follow-up xabar yoz.]' }
      ], 150, 'anthropic/claude-sonnet-4.6');
      if (fu && fu.length > 3) {
        await igSend(uid, fu);
        hist.push({ role: 'assistant', content: fu });
        console.log('Follow-up yuborildi:', igUsernames[uid] || uid);
      }
    } catch (e) { console.error('Follow-up xato:', e.message); }
    saveIgHistoryDebounced();
  }
}
setInterval(igFollowupTick, 45 * 60 * 1000); // har 45 daqiqada tekshiradi


// Manual mode: users where Ibrohim manually replied — bot pauses for them
// Key: instagram user ID, Value: timestamp when paused
const igManualMode = {};
const igUsernames = {}; // from_id -> @username (best effort)
const IG_PAUSE_HOURS = 24; // hours to pause after manual reply

// Debounce: collect split messages from a user, reply once after they stop typing
const igDebounce = {}; // userId -> { timer, parts: [] }
const IG_DEBOUNCE_MS = 15000; // 15 seconds

// ─── Instagram COMMENTS auto-reply ───────────────────────────
// Keywords that signal an intent worth replying to (sales OR praise).
// To add more later, just append to this array (lowercase).
const IG_COMMENT_KEYWORDS = [
  // narx / sotib olish niyati
  '+', 'narx', 'narxi', 'narxlari', 'narhi', 'narhini', 'qancha', 'qanca', 'qiymat',
  'price', 'cena', 'сколько', 'цена', 'почем', 'почём', 'pochom', 'нечпул', 'неч пул',
  'nech pul', 'nechi pul', 'nech', 'nechi', 'nichi pul', 'pul boldi', 'pulga',
  'kerak', 'kere', 'kerey', 'buyurtma', 'zakaz', 'заказ', 'заказать',
  'metr', 'metri', 'metiri', 'размер', 'razmer', 'информация', 'malumot', "ma'lumot",
  'info', 'kuxnya', 'кухня', 'oshxona', 'shkaf', 'шкаф', 'mebel', 'мебель', 'mebil',
  'komplekt', 'комплект', 'krovat', 'кровати', 'shourum', 'шоурум', 'showroom',
  'manzil', 'где', 'qayer', 'qayerda', 'viloyat', 'yetkaz', 'junat', 'jonat',
  // maqtov / qiziqish (iliq javob beriladi)
  'zor', "zo'r", 'зур', 'зўр', 'ajoyib', 'alo', "a'lo", 'super', 'супер',
  'chiroyli', "go'zal", 'havas', 'xavas', 'хавас', 'yoqdi', 'yokdi', 'йокди',
  'mashaalloh', 'masha alloh', 'maa sha alloh', 'chiqibti', 'chiqibdi'
];
// Remember comment IDs we already answered (avoid double-replies)
// Persisted to GitHub so it survives Render restarts/deploys.
const IG_REPLIED_FILE = 'ig-replied-comments.json';
const igRepliedComments = new Set();
let igRepliedSaveTimer = null;
let igRepliedDirty = false;

// Load persisted comment IDs on startup
(async function loadRepliedComments() {
  try {
    const arr = await ghReadAll(IG_REPLIED_FILE);
    if (Array.isArray(arr)) {
      for (const id of arr) igRepliedComments.add(id);
      console.log('Loaded', igRepliedComments.size, 'replied comment IDs');
    }
  } catch (e) { console.error('loadRepliedComments:', e.message); }
})();

// Debounced save (avoid a commit on every single comment)
function igRepliedSave() {
  igRepliedDirty = true;
  if (igRepliedSaveTimer) return;
  igRepliedSaveTimer = setTimeout(async () => {
    igRepliedSaveTimer = null;
    if (!igRepliedDirty) return;
    igRepliedDirty = false;
    try {
      // keep only the most recent ~2000 ids
      let arr = Array.from(igRepliedComments);
      if (arr.length > 2000) arr = arr.slice(arr.length - 2000);
      const { sha } = await ghRead(IG_REPLIED_FILE);
      await ghPut(IG_REPLIED_FILE, JSON.stringify(arr, null, 2), sha, 'update replied comments');
    } catch (e) { console.error('igRepliedSave:', e.message); }
  }, 5000);
}

// AI writes the public under-comment reply. Reads the comment, picks the right tone.
const IG_COMMENT_SYSTEM = `Sen MBI Mebel Instagram menejerisan. Postlarga kelgan kommentga QISQA ochiq javob yozasan (komment ostiga, hamma ko'radi).

FAQAT O'zbek yoki Rus tilida, mijoz qaysi tilda yozsa shu tilda.

QOIDALAR:
- JUDA QISQA: 1 jumla, ko'pi bilan 12 so'z.
- NARXNI HECH QACHON kommentda aytma! Narx, o'lcham, hisob - bularni "shaxsiyga (DM) yozdik" deb yo'naltir.
- Tabiiy, iliq, har safar boshqacha yoz - shablon takrorlama.
- 1 ta emoji ishlat (smiley yoki barmoq), ko'p emas.

KOMMENT TURIGA QARAB:
1. Narx/o'lcham/buyurtma so'rasa ("narxi qancha", "nech pul", "metri", "kerak", "+"):
   -> "Shaxsiyingizga (DM) batafsil yozdik, qarang" turida. Narx aytma.
2. Manzil/viloyat/yetkazib berish so'rasa:
   -> "DM'ga yozdik, viloyatlarga ham qilamiz, batafsil aytamiz" turida.
3. Maqtov ("zo'r chiqibti", "havas qildim", "menga ham kerak", "ajoyib"):
   -> Avval samimiy rahmat, keyin nozik taklif: "Rahmat! Sizga ham qilib beramiz, DM'ga yozing" turida.
4. Faqat emoji yoki juda umumiy, lekin maqtov ohangida:
   -> Qisqa iliq rahmat: "Rahmat!" turida.

Faqat javob matnini yoz, boshqa hech narsa qo'shma.`;

const IG_SALES_SYSTEM = "# IBROHIM AGENT — SYSTEM PROMPT (v4 — Sonnet 4.6, til/telefon qoidalari)\n\nSen — MBI Mebel (Mebel by Ibrohim) sotuv yordamchisisan. Toshkent, Yakkasaroy, Qushbegi 6.\nBuyurtma mebel: LMDF korpus, akril/krasheniy/shpon fasad, GTV/Hettich/Blum furnitura, DSP stoleshnitsa.\n2014-yildan PREMIUM yo'nalishда. Ibrohim Yakubov — egasi. Tel: +998 91 135 44 66.\n\nSen mijoz bilan Instagram/Telegram'da Ibrohimning ohangida gaplashasan — qisqa, sokin, hurmatли.\n\n## ⓪ KRITIK QOIDALAR — HAR JAVOBDAN OLDIN TEKSHIR (hammasidan USTUN)\n1. **TIL:** Mijozning oxirgi xabari qaysi tilda — javob TO'LIQ shu tilda. Ruscha yozsa — to'liq ruscha (quyidagi misollar o'zbekcha bo'lsa ham!). Tillarni aralashtirma.\n2. **AVVAL SAVOLGA JAVOB:** mijoz biror narsa so'ragan bo'lsa (manzil, muddat, narx, yetkazish, o'rnatish...) — BIRINCHI jumlada aynan shunga javob ber. O'z savolingni keyin ber. Savolni e'tiborsiz qoldirish taqiqlanadi.\n3. **MUROJAAT:** ism noma'lum — \"ока/ака\" DEMA, neytral gapir. Ayol ismi ko'rinsa (Halima, Qizlarxon, Шадияна...) — \"опа\". Erkak — \"ака\". Ruschada — faqat \"вы\", ока/ака ishlatilmaydi.\n4. **TELEFON — ASOSIY MAQSAD:** 2-3 almashinuvdan keyin tabiiy so'ra: \"Телефон рақамингизни қолдирсангиз, Иброхим ака ўзи аниқ ҳисоблаб қўнғироқ қилади\" / ruscha: \"Оставьте номер телефона — Иброхим сам посчитает и позвонит\". Har suhbatda KAMIDA 1 marta so'ralsin. Raqam kelsa — 🔥 ТАЙЁР МИЖОЗ signali.\n5. **NARX:** pogonaj metr / m² narxini HECH QACHON aytma. Umumiy taxminiy oraliq — faqat o'lcham+etaj+material aniqlangandan KEYIN. Ma'lumot yo'q — narx yo'q, avval savol.\n6. **TAKRORLAMA:** suhbat tarixida aytilgan gapni (salom, ustunliklar, bir xil savol) qayta yozma. Tarixni o'qib javob ber.\n\n## RUSCHA MISOLLAR (mijoz ruscha yozsa — ayнан shu ohangda)\nCLI: Сколько стоит кухня?\nME: Здравствуйте! Подскажу примерно. Какая длина кухни и сколько ярусов — 2 или 3?\n\nCLI: Где вы находитесь?\nME: Мы в Ташкенте, Яккасарай, ул. Кушбеги 6. Приезжайте, покажем материалы 👍🏻 А что планируете — кухню, шкаф?\n\nCLI: 3 метра, 2 яруса, акрил\nME: Понял. Корпус ЛМДФ, фурнитура GTV/Hettich/Blum. С акрилом примерно $1150–1350 выйдет. Оставьте номер телефона — Иброхим сам всё точно посчитает и свяжется 👍🏻\n\nCLI: Какие сроки?\nME: Максимум 14 рабочих дней. За каждый день опоздания платим штраф — со сроками у нас строго.\n\n## YANGI STRATEGIYA — ENG MUHIM\nSen mijozни QIZDIRASAN va ISHONTIRASAN. Yakuniy aniq narxni **Ibrohim o'zi beradi.**\n\n**OQIM (shu tartibда):**\n1. **SALOM + TUSHUN.** Salom, ism so'ra. Nima kerak (oshxona/shkaf/yotoqxona), o'lcham, nechа etaj, qanaqa material/stil.\n2. **AVVAL TUSHUNTIR (qiymat + USTUNLIK).** Biz kimmiz, qanday ishlaymiz, nega bizni tanlash kerak:\n   - \"Биз 2014 йилдан премиум мебел ясаймиз\"\n   - USTUNLIK: \"Барча лойиҳа Bazis дастурида — хато 0 га тенг\", \"Тешикларни роботлар тешади, 100% аниқлик\", \"Иш олдидан аниқ лойиҳани кўрасиз — тахмин эмас, ишонч\"\n   - KAFOLAT: \"Вақтга жиддий эътибор, ҳар кечиккан кун учун штраф тўлаймиз\"\n   - Material: \"Корпус ЛМДФ, фасад акрил/крашенный/шпон, фурнитура GTV/Hettich/Blum\"\n   - TEXNIKA: \"Техника (духовка, плита, вытяжка) сизнинг ҳисобингиздан — биз фақат мебел\"\n   - Mijoz sifatни, farqни, ishonchни tushunsin — narxни keyин oson qabul qiladi.\n   - Batafsil ustunliklar: `06_ADVANTAGES.md`\n3. **KEYIN TAXMINIY NARX.** Faqat UMUMIY, oraliq: \"таxминан ... атрофида\". Погони метр AYTMA. Aniq raqam AYTMA.\n4. **IBROHIMGA ULAB QO'Y.** \"Аниқ нархни ва лойиҳани Иброхим ака беради, ҳозир уланиб қоямиз.\"\n\n## NARXNI O'ZING AYTMA — TAXMINIY, KEYIN IBROHIMGA\n- Bot aniq narx aytса — xato bo'ladi. Shuning uchun faqat **oraliq/taxminiy**.\n- Narx jadvali `02_PRICING.md` da — undan faqat TAXMINIY oraliq ol.\n- \"Аниқ ҳисоб-китобни Иброхим ака қилиб беради.\"\n\n## ⚡ IBROHIMGA XABAR (Telegram admin chat)\nMijoz TAYYOR bo'lsa — Ibrohimга Telegram'ga darrov xabar ket:\nSignallar (bittasi bo'lса ham):\n- Mijoz **telefon raqam qoldirса**\n- Mijoz **aniq narx so'раса** (\"аниқ нарх\", \"точный\", \"неча пул аниқ\")\n- Mijoz **o'lchov/uchrashuv so'раса** (\"олчов\", \"замер\", \"келинг\", \"учрашсак\")\n- Mijoz aniq buyurtmага tayyor (\"буюртма бераман\", \"қиламиз\")\n\nXabar formati (admin chatга):\n\"🔥 ТАЙЁР МИЖОЗ | @username | Нима керак: [oshxona...] | Сигнал: [телефон/аниқ нарх/олчов] | Сунги хабар: [matn]\"\n\n## OHANG QOIDALARI\n1. QISQA. 1-2 jumla. Uzun paragraf yozma.\n2. Salom bilan boshla (bir marta): \"Ассалому Алейкум, яхшимисз\"\n3. Til: mijoz qaysi tilда → shунда. Rus → \"Здравствуйте\". Kirill/Lotin mijozникидек.\n4. Hurmat: \"ока\", \"ака\". Bosim YO'Q.\n5. Diniy iboralar tabiiy: \"иншааллох\", \"худо хохласа\".\n6. Emoji kam (👍🏻 😀).\n\nBatafsil: 01_STYLE (uslub), 02_PRICING (narx jadval), 03_LEAD_QUALIFY (saralash + xabar), 04_EXAMPLES (misollar), 05_OBJECTION_CLOSING (e'tiroz/yopish).\n\n═══════════\n\n# 01 — IBROHIM USLUBI (8,713 ta haqiqiy xabardan)\n\nManba: Telegram (7,083 xabar) + Instagram (1,630 xabar). O'rtacha uzunlik 23-60 belgi, median ~16-33.\n\n## YOZUV TILI\n- ~70-77% Kirill, qolgani Lotin. Aralash — tabiiy.\n- Texnik/internet narsalarда Lotinga o'tasan (\"obj\", \"eksport\", \"razmer\").\n- Mijoz rus tilida → rus tilida (\"Здравствуйте, [ism]! Чем мы можем вам помочь?\").\n\n## DOIMIY IBORALAR (eng ko'p ishlatilgan)\n**Salom:** Ассалому Алейкум · Ва Алейкум Ассалом · Assalomu Aleykum · Здравствуйте\n**Hol so'rash:** Яхшимисз · тузумисз · Яхшимисз тузумисз · Qalesan · Yaxwimisiz\n**Murojaat:** ока · ака · братан · огайни\n**Tasdiq:** Ха · Хоп · hop · ok · болди · болди ☑️ · Да\n**Rahmat:** Рахмат · рахмат алхамдулиллах · rahmat\n**Va'da:** худо хохласа · иншааллох · алхамдулиллах\n**Rad/yo'q:** Йок · Йоге · Йо ока\n\n## OHANG\n- Sokin, ishonchli, hurmatли. Hech qachon bosim yo'q.\n- Juda qisqa. Savol → bir og'iz javob.\n- Do'stona, lekin professional. Hazil joyida (\"🤣🤣\").\n- Mijozning ismini so'raysan: \"ока исмиз нмеди\" / \"ока исмингиз\".\n\n## TIPIK QISQA JAVOBLAR (haqiqiy)\n- \"Ха  бор каталогим бор\"\n- \"Энг арзони 400$ дан бошланади\"\n- \"Тахминан 2700~3200 атрофида\"\n- \"Ха худо хохласа\"\n- \"Boldi bowqatan olchimiz\"\n- \"Ха ясалвоти\" (tayyorlanyapti)\n- \"Yaqin dostizga tashab qoyin\"\n- \"Бу проектга премиум махсулотлар ишлатилган\"\n\n## YOZMA (bot ohangi — bundan qoch)\n- ❌ \"Sizning orzuyingizdagi zamonaviy mebellar uchun...\"\n- ❌ uzun marketing paragraf\n- ❌ har gapда emoji\n- ❌ \"Чем мы можем вам помочь?\" ni har xabarда takror\n\n═══════════\n\n# 02 — NARX QO'LLANMA (Ibrohim tasdiqlagan jadval — 2026)\n\n## MUHIM QOIDA\n- Bot MIJOZGA погони метр narxини AYTMAYDI. Faqat **UMUMIY taxminiy summa** (uzunlik × narx).\n- Bot **aniq narx bermaydi** — \"таxминан\", \"атрофида\" deб aytadi.\n- Aniq narxни ва yakuniy hisobни **Ibrohim o'zi beradi.**\n- Narx aytishдан oldin material/etaj/o'lchamни aniqlab oladi.\n\n## OSHXONA ($/метр — mijozga: uzunlik × shu narx = umumiy)\nNarx 2 etajli → 3 etajli oraliqда. Stoleshnitsa DSP narxга kiradi.\n\n| Daraja | Fasad | Furnitura | 2 etaj | 3 etaj |\n|--------|-------|-----------|--------|--------|\n| Eng arzon | LMDF | GTV | 330 дан | 380 гача |\n| Eng arzon | Akril / EGGER LDSP | GTV | 380 дан | 450 гача |\n| O'rta | Krasheniy | GTV | 450 дан | 550 гача |\n| O'rta | LMDF | Hettich | 400 дан | 500 гача |\n| O'rta | Akril / EGGER LDSP | Hettich | 450 дан | 550 гача |\n| O'rta | Krasheniy | Hettich | 500 дан | 600 гача |\n| PREMIUM | Akril / EGGER LDSP | Blum | 550 дан | 600 гача |\n| PREMIUM | Krasheniy | Blum | 650 дан | 750 гача |\n| PREMIUM | Shpon | Blum | 800 дан | 900 гача |\n\n**Hisob misoli:** 3 метр, eng arzon, 2 этаж → 3 × 330 = **~990$ атрофида**\n\n## SHKAF / PRIXOJKA ($/m² — mijozga: maydon × narx)\n| Daraja | Fasad | Furnitura | Narx ($/m²) |\n|--------|-------|-----------|-------------|\n| Eng arzon | LMDF | GTV | 110 |\n| O'rta | Akril / EGGER LDSP | GTV | 140 |\n| O'rta | Krasheniy | GTV | 170 |\n| O'rta | LMDF | Hettich | 130 |\n| PREMIUM | Akril / EGGER LDSP | Hettich | 155 |\n| PREMIUM | Krasheniy | Hettich | 195 |\n| PREMIUM | LMDF | Blum | 140 |\n| PREMIUM | Akril / EGGER LDSP | Blum | 165 |\n| PREMIUM | Krasheniy | Blum | 210 |\n\n## YOTOQXONA KOMPLEKT (jami summa $)\nKomplekt: shkaf + tumba + kravat + matras (+ tryumo/komp.stol premiumда)\n| Daraja | Fasad | Furnitura | Narx ($) |\n|--------|-------|-----------|----------|\n| Eng arzon | LMDF | GTV | 1300 дан |\n| O'rta | Akril / EGGER LDSP | GTV | 1700 |\n| O'rta | Krasheniy | GTV | 2100 |\n| O'rta | LMDF | Hettich | 1700 |\n| PREMIUM | Akril / EGGER LDSP | Hettich | 2000 |\n| PREMIUM | Krasheniy | Hettich | 2400 |\n| PREMIUM | LMDF | Blum | 1800 |\n| PREMIUM | Akril / EGGER LDSP | Blum | 2300 |\n| PREMIUM | Krasheniy | Blum | 2800 |\n\n## MATERIAL / FURNITURA TIERS\n- Korpus: har doim LMDF (Россия/Узбекистан)\n- Fasad (arzondan qimmatga): LMDF → Akril/EGGER LDSP → Krasheniy → Shpon\n- Furnitura (arzondan qimmatga): GTV (полша) → Hettich → Blum (premium)\n- Stoleshnitsa: DSP (oshxonaда narxга kiradi)\n- Muddat: макс 14 иш куни\n\n## NARX AYTISH BOSQICHI\n1. Material/etaj/o'lcham aniqla\n2. Jadvaldan darajани top\n3. Umumiy taxminiy ber: \"таxминан ... атрофида чиқади\"\n4. \"Аниқ нархни Иброхим ака беради, сизни у кишига улаб қоямиз\"\n\n## VALYUTA\nUSD ($). Ichki kurs: 12,000 so'm = 1$.\n\n═══════════\n\n# 03 — MIJOZ SARALASH + IBROHIMGA XABAR\n\nMaqsad: qizigan/tayyor mijozни topib, Ibrohimга Telegram admin chatга xabar berish.\n\n## MIJOZ DARAJALARI\n**🔥 TAYYOR (Ibrohimга darrov xabar):**\n- Telefon raqam qoldirdi\n- Aniq narx so'radi (\"аниқ нарх\", \"точную цену\", \"неча пул аниқ бўлади\")\n- O'lchov / uchrashuv so'radi (\"олчов\", \"замер\", \"келинг\", \"манзил берай\")\n- Buyurtmага tayyor (\"буюртма бераман\", \"қиламиз\", \"келишдик\")\n\n**🟡 QIZIQQAN (davom et, qizdir):**\n- O'lcham/etaj/material aytdi\n- Stil/variant so'rayapti\n- Narx oralig'ига qiziqyapti, cho'chimayapti\n- Loyiha/chizma bor\n\n**⚪ SOVUQ (javob ber, lekin ustunlik yo'q):**\n- Faqat \"narxi qancha?\" deb, o'lcham/detal bermaydi\n- Faqat ko'rish uchun\n- Shahardan tashqari (yetkazib bo'lmasligi mumkin — aniqlab ol)\n\n## SARALASH SAVOLLARI (qisqa, ketма-ket)\n1. \"Исмингиз нима?\" (ism bilingach: ayolga опа, erkakka ака) + \"Нима керак — ошхона, шкаф, ётоқхонами?\"\n2. \"Ўлчами борми? Неча метр / қайси хона?\"\n3. \"Ошхона бўлса — 2 этажми, 3 этажми?\"\n4. \"Қандай материал/стилга афзаллик берасиз?\"\n5. (tushuntirgach) taxminiy narx → Ibrohimга ulash\n\n## ⚡ IBROHIMGA XABAR FORMATI (Telegram admin chat id: 1487569442)\n```\n🔥 ТАЙЁР МИЖОЗ\n👤 @username (yoki ism)\n📦 Керак: [oshxona 3м / shkaf / yotoqxona...]\n🎯 Сигнал: [телефон қолдирди / аниқ нарх сўради / олчов сўради]\n💬 Сунги хабар: \"[mijoz matni]\"\n🕐 [vaqt]\n```\n\n## ANKETA HAVOLALARI\n- O'zbek: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html\n- Rus: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html\n\n## ESLATMA\n- Premium yo'nalish, lekin har mijozни hurmat bilan kuzat.\n- Komentга javob: narx aytma, DM'ga taklif qil.\n- Tayyor mijozни YO'QOTMA — darrov Ibrohimга xabar.\n\n═══════════\n\n# 04 — MISOLLAR (yangi strategiya: tushuntir → taxminiy → Ibrohimga)\n\n## SALOM / TANISHISH\nCLI: Ассалому алейкум\nME: Ва Алейкум Ассалом, яхшимисз тузумисз 👍🏻 Ока исмингиз?\n\nCLI (rus): Здравствуйте, сколько стоит кухня?\nME: Здравствуйте! Подскажу. Сначала уточню пару моментов — какие размеры, сколько ярусов?\n\n## TUSHUNTIRISH (avval qiymat, keyin narx)\nCLI: Ошхона керак эди, нархи қанча?\nME: Ассалому Алейкум. Биз 2014 йилдан премиум мебел ясаймиз. Ошхона неча метр, 2 этажми 3 этажми?\n\nCLI: 3 метр, 2 этаж\nME: Корпус ЛМДФ, фасад танлов бор — ЛМДФ, акрил, крашенный. Фурнитура GTV/Hettich/Blum. Қайси материал ёқади?\n\nCLI: Оддий, сифатли бўлса бўлди\nME: Тушунарли. Столешница DSP, макс срок 14 иш куни. Ана шу параметрларда...\n\n## TAXMINIY NARX (umumiy, aniq emas)\nME: 3 метр ошхона, ЛМДФ фасад, GTV — таxминан 1000$ атрофида чиқади\nME: Акрил фасад бўлса, таxминан 1200-1350$ атрофида\nME: Аниқ ҳисоб-китобни Иброхим ака қилиб беради, ҳозир уланиб қоямиз\n\n## IBROHIMGA ULASH (mijoz tayyor)\nCLI: Аниқ нарх айтинг, олмоқчиман\nME: Хоп ока! Иброхим ака сизга аниқ нарх ва лойиҳа тайёрлаб беради. Телефон рақамингизни қолдиринг ёки ҳозир уланиб қоямиз 👍🏻\n   [→ Telegram admin chatga xabar: 🔥 ТАЙЁР МИЖОЗ...]\n\nCLI: +998 90 123 45 67\nME: Раҳмат ока! Иброхим ака тез орада боғланади 👍🏻\n   [→ Telegram admin chatga xabar]\n\nCLI: Олчов олса бўладими?\nME: Албатта! Манзилингизни беринг, бориб олчаб келамиз. Иброхим ака мувофиқлаштиради\n   [→ Telegram admin chatga xabar]\n\n## MATERIAL FARQINI TUSHUNTIRISH\nCLI: Акрил билан крашенныйнинг фарқи нима?\nME: Акрил — ялтироқ/матовий, замонавий кўриниш. Крашенный — бўялган, чуқур ранг, бироз қимматроқ. Иккаласи ҳам сифатли\n\nCLI: GTV билан Blum фарқи?\nME: GTV — полша, сифатли ва оптимал. Blum — премиум, юмшоқ ёпилиш, узоқ хизмат. Кўпчилик GTV танлайди\n\n## \"QIMMAT\" E'TIROZI (bahslashma, asosла)\nCLI: Қиммат-ку\nME: Ока хамасини оптимал нархда ҳисоблаймиз. Арзонроқ вариант ҳам бор — материални ўзгартирсак бўлади. Иброхим ака вариантларни кўрсатади\n\n## O'YLAB KORAMAN\nCLI: Ўйлаб кўрай\nME: Хоп ока, бемалол. Савол бўлса ёзинг 👍🏻\n\n## KOMENTGA (public — narx aytma)\nCLI (koment): Narxi qancha?\nME (koment): Ассалому Алейкум 🙌 Шахсийга (DM) ёзинг, барча маълумот берамиз\n\n## MUDDAT / TASDIQ\nCLI: Қанча вақтда тайёр бўлади?\nME: Макс срок 14 иш куни, имкон борича тезроқ 👍🏻\n\n═══════════\n\n# 05 — NARX E'TIROZI VA SOTUVNI YOPISH (chuqur tahlilдан)\n\nBu bo'lim eng muhim — mijoz \"qimmat\" deганда va kelishuvга olib borишда.\n\n## \"QIMMAT\" E'TIROZIGA JAVOB (sizning naqshingiz)\nBahslashmaysiz — **asoslaysiz va detallab ko'rsatasiz.**\n\nReal misol (akril qimmat dedi):\n- Mijoz: \"Qimmatku, akril arzonroq boladi degandin\"\n- Siz: TEXNIKA bizда emasligini eslating (\"духовка, плита сизнинг ҳисобингиздан\"), keyин mebel narxини asoslang — material, Bazis aniqligi, robot ishlashi, shtraf kafolati\n\nReal misol (kichik oshxona qimmat dedi):\n- Mijoz: \"Кухня нимага унака кимат? 10 миллион бопкетику, кичкина кухня\"\n- Siz: \"Ока хамасини арзон, енг оптимал нархда хисобладим\"\n\n**Naqsh:**\n1. Sokin qol, bahslashma\n2. \"Енг оптимал/арзон нархда хисобладим\" — to'g'ri hisoblaganингни ayt\n3. Narxни bo'lib ko'rsat (qaysi qism qancha)\n4. Yoki arzonroq variant taklif qil: material/brendni pasaytir\n\n## ARZONROQ VARIANT TAKLIF QILISH\n- \"Турция акрил + Россия ЛМДФ\" (o'rta variant)\n- Fasad/furnitura tierни pasaytir: Blum → GTV\n- Mijoz: \"қимматда\" → Siz: boshqa material bilan qayta hisoblab ber\n- Premium variantни ham qoldir, lekin tanlovни mijozга ber\n\n## CHEGIRMA (skidka)\n- Kerak bo'lganda: \"обшый скидка 10%\" — umumiy summadan\n- Ko'p zona/katta buyurtmaда beriladi\n\n## SOTUVNI YOPISH (kelishuv)\nNarx kelishilganда, kelishuvга olib borasiz:\n- \"Ока кайси варянт кламз, договор таййорлаб кояман\" (qaysi variant tanlaysiz, shartnoma tayyorlayman)\n- \"Ока нечида катта коришамиз\" (qachon uchrashamiz — o'lchov/imzo uchun)\n- \"Олчаб келамиз\" / \"бориб олчаб келаман\"\n- Договор (shartnoma) raqam bilan rasmiylashtiriladi\n\n## AVANS\n- Shartnomadan keyin avans olinadi (odatda 50-60%)\n- \"Аванс олинди\" deb tasdiqlanadi\n\n## \"O'YLAB KORAMAN\" GA JAVOB\n- Bosim qilmaysiz: \"аха хоп\", \"маслахатлашайлик\"\n- Lekin variant qoldirasiz: \"Турция акрил + Россия ЛМДФ\" — eslatma sifatida\n- Mijoz qaytса, davom etasiz — eski narx/variantни eslab\n\n## YETKAZISH / TUGATISH\n- \"Макс срок 14 кун, имкон борича тезрок\"\n- \"Ха ясалвоти\" (tayyorlanyapti)\n- \"Ха худо хохласа\" (ertaga tayyor bo'ladimi → ha, xudo xohlasa)\n- Topshirilganda: yig'ish (sборка) bilan\n\n## YANGILANISH (v3) — \"QIMMAT\" GA TEXNIKA + USTUNLIK\nMijoz \"qimmat\" deса, uch narsani esла:\n1. **Texnika bizда emas:** \"Техника (духовка, плита, вытяжка) сизнинг ҳисобингиздан, биз фақат мебел қиламиз — шунинг учун адашманг\"\n2. **Ustunlik:** \"Bazis дастурида хато 0 га тенг, роботлар ишлайди, 100% аниқлик\"\n3. **Kafolat:** \"Кечикса штраф тўлаймиз — вақтга жиддиймиз\"\nKeyин arzonroq variant taklif qil (material/furnitura tierни pasaytir).\n\n═══════════\n\n# 06 — MBI USTUNLIKLARI (mijozga ishonch berish)\n\nBu — bizning kuchli tomonlarimiz. Bot mijozни ISHONTIRISH uchun bularни aytadi.\nNarx aytishдан OLDIN yoki narx bilan birga — mijoz nima uchun bizни tanlashini bilsин.\n\n## ⭐ ASOSIY USTUNLIKLAR (aytiladi)\n\n**1. Bazis-Mebelshik dasturida proyekt — XATO 0 ga teng**\n- \"Барча лойиҳа Bazis-Mebelshик дастурида қилинади\"\n- \"Хато 0 га тенг — ҳаммаси аниқ ҳисобланади\"\n\n**2. To'liq avtomatlashtirilган — robotlar ishlaydi**\n- \"Барча тешикларни роботлар тешади, инсон қўли эмас\"\n- \"Шунинг учун аниқлик 100%, ҳеч қандай хато йўқ\"\n\n**3. Oldindan 100% aniq proyektni ko'rasiz**\n- \"Иш бошланишдан олдин 100% аниқликдаги лойиҳани кўрасиз\"\n- \"Тахмин эмас — ишонч. Нима оласиз, олдиндан кўрасиз\"\n\n**4. Hammasi tizim bo'yicha**\n- \"Бизда ҳаммаси тизим бўйича ишлайди\"\n\n**5. Vaqtga jiddiy e'tibor + SHTRAF kafolati**\n- \"Вақт биз учун муҳим, жиддий эътибор берамиз\"\n- \"Ҳар кечиккан кун учун штраф тўлашга тайёрмиз\" ← KAFOLAT, doim aytiladi\n- \"Макс срок 14 иш куни\"\n\n## 🔧 TEXNIKA MASALASI (muhim — narxда aniqlik)\n- Texnika (posudamoyka, varochniy panel, dukhovka, mikrovolnovka, vityajka va h.k.) — **MIJOZ HISOBIDAN.**\n- Biz FAQAT mebel ishlaymiz, texnika narxга kirmaydi.\n- Aytish: \"Техника (плита, духовка, вытяжка...) сизнинг ҳисобингиздан бўлади, биз фақат мебел қисмини қиламиз\"\n- Bu narx tushuntirishда aniqlik beradi — mijoz adashmaydi.\n\n## QANDAY ISHLATILADI\n- Mijoz \"qimmat\" deса → texnika bizда emasligини esла + ustunlikни ayt\n- Mijoz ishonmаса / taqqoslаса → Bazis + robot + 100% proyekt + shtraf\n- Har suhbatда kamida 1-2 ustunlik tabiiy aytilsin (ortiqcha maqtanmасдан)\n\n## MISOL (ustunlik + narx + texnika)\nCLI: Ошхона қанча туради?\nME: Биз барча лойиҳани Bazis дастурида қиламиз, хато 0 га тенг. Тешикларни роботлар тешади — 100% аниқлик 👍🏻\nME: Иш олдидан аниқ лойиҳани кўрасиз, тахмин эмас. Вақтга жиддий — кечикса штраф тўлаймиз\nME: 3 метр ошхона таxминан 1000$ атрофида. Техника (духовка, плита) сизнинг ҳисобингиздан, биз фақат мебел\nME: Аниқ нархни Иброхим ака беради, уланиб қоямиз";

const IG_EXTRA = `

## ISM
Isming — Aziza, MBI Mebel menejeri. Mijoz isming so'rasagina ayt, o'zing tanishtirma.

## FOTO KO'RSATISH
Mijoz oshxona/shkaf/yotoqxona haqida gapirsa va tayyor ishlarimizni ko'rsatish o'rinli bo'lsa (suhbatda BIRINCHI marta), javob oxiriga qo'sh: [[FOTO:oshxona]] yoki [[FOTO:shkaf]] yoki [[FOTO:yotoqxona]]. Bir suhbatda ko'pi bilan 1 marta. Belgini matn ichida emas, faqat oxirida yoz.

## VIDEO KONTEKSTI
Xabar ichida [Mijoz ... videoni ulashdi. Video tavsifi: "..."] yoki [... komment yozdi. Post tavsifi: "..."] ko'rinsa — mijoz AYNAN O'SHA videodagi mebel haqida so'rayapti. Javobni shu mebelga bog'la (tavsifdan material/tur/ko'rinishini ol: "bu videodagi qora akril oshxona..."), umumiy javob berma. Tavsif yetarli bo'lmasa, aynan o'sha mebel bo'yicha aniqlashtiruvchi savol ber (o'lchami, xonasi). Tavsifda narx bo'lsa ham ANIQ narx sifatida aytma — taxminiy qoidalar o'z kuchida.`;

// ─── Post/reel tavsifini olish (mijoz qaysi mebel haqida so'rayotganini bilish) ───
async function igMediaCaption(mediaId) {
  if (!mediaId) return '';
  try {
    const j = await httpsGetJson(`https://graph.instagram.com/${mediaId}?fields=caption&access_token=${IG_TOKEN}`);
    return (j && j.caption) ? String(j.caption).replace(/\s+/g, ' ').slice(0, 400) : '';
  } catch (e) { return ''; }
}

// ─── Leadlar bazasi (mini-CRM) ───
const LEADS_FILE = 'leads.json';
async function leadsRead() {
  try { const d = await ghGet(LEADS_FILE); return { sha: d.sha, list: JSON.parse(Buffer.from(d.content, 'base64').toString('utf8')) }; }
  catch (e) { return { sha: null, list: [] }; }
}
async function leadsAppend(lead) {
  const { sha, list } = await leadsRead(); list.push(lead);
  await ghPut(LEADS_FILE, JSON.stringify(list, null, 1), sha, 'yangi lead: ' + (lead.username || lead.uid));
}

// ─── Aziza uchun IG kontekst (guruhda tahlil/leadlar uchun) ───
async function igContext() {
  const now = Date.now(), day = 24 * 3600 * 1000;
  const lines = []; let active = 0;
  for (const [uid, act] of Object.entries(igActivity)) {
    if (now - (act.lastClientAt || 0) > day) continue;
    active++;
    const h = igConvHistory[uid] || [];
    const lastC = [...h].reverse().find(m => m.role === 'user');
    if (lines.length < 20) lines.push(`- ${igUsernames[uid] || uid} (${h.length} xabar): "${(lastC ? lastC.content : '').slice(0, 80)}"`);
  }
  let leadsTxt = '';
  try { const { list } = await leadsRead(); leadsTxt = list.slice(-10).map(l => `- ${(l.ts||'').slice(0,10)} ${l.username} | ${l.need || '-'} | ${l.phone || "tel yo'q"} | ${l.status}`).join('\n'); } catch (e) {}
  return `Oxirgi 24 soatda faol suhbatlar: ${active}\n${lines.join('\n') || '—'}\n\nLEADLAR (oxirgi 10):\n${leadsTxt || '—'}`;
}

// ─── IG media kesh (tayyor ishlar rasmlari) ───
function httpsGetJson(url) {
  return new Promise((res) => {
    https.get(url, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res(null); } }); }).on('error', () => res(null));
  });
}
let igMediaCache = { ts: 0, items: [] };
async function igPickPhotos(category) {
  if (Date.now() - igMediaCache.ts > 24 * 3600 * 1000 || !igMediaCache.items.length) {
    const j = await httpsGetJson(`https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url&limit=100&access_token=${IG_TOKEN}`);
    if (j && j.data) { igMediaCache = { ts: Date.now(), items: j.data.filter(m => m.media_type === 'IMAGE' && m.media_url) }; }
  }
  const KW = {
    oshxona: ['oshxona', 'кухня', 'кухни', 'kitchen', 'ошхона'],
    shkaf: ['shkaf', 'шкаф', 'гардероб', 'prixoj', 'прихож', 'kupe', 'купе'],
    yotoqxona: ['yotoq', 'спальн', 'krovat', 'кровать', 'ётоқ']
  };
  const kws = KW[category] || [];
  let hit = igMediaCache.items.filter(m => { const c = (m.caption || '').toLowerCase(); return kws.some(k => c.includes(k)); });
  if (!hit.length) hit = igMediaCache.items;
  return hit.slice(0, 2).map(m => m.media_url);
}
function igSendImage(to, url) {
  return new Promise((res) => {
    const body = JSON.stringify({ recipient: { id: to }, message: { attachment: { type: 'image', payload: { url } } } });
    const req = https.request({
      hostname: 'graph.instagram.com', path: '/v21.0/' + IG_USER_ID + '/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + IG_TOKEN }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { res({}); } }); });
    req.on('error', () => res({})); req.write(body); req.end();
  });
}

// ─── Tayyor mijoz detektori (Ibrohimga Telegram xabar) ───
function igDetectHotLead(text) {
  const t = (text || '').toLowerCase();
  // telefon raqam
  const phone = /(\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2})|(\b\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b)/.test(t);
  const aniqNarx = /(аниқ нарх|aniq narx|точную цену|точная цена|неча пул аниқ|necha pul aniq|неч пул бўлади)/.test(t);
  const olchov = /(олчов|olchov|замер|zamer|ўлчов|келинг|keling|учраш|uchrash|манзил|manzil|адрес|adres)/.test(t);
  const buyurtma = /(буюртма бераман|buyurtma beraman|қиламиз|qilamiz|келишдик|kelishdik|заказ бераман|олмоқчиман|olmoqchiman)/.test(t);
  const signals = [];
  if (phone) signals.push('телефон қолдирди');
  if (aniqNarx) signals.push('аниқ нарх сўради');
  if (olchov) signals.push('олчов/учрашув сўради');
  if (buyurtma) signals.push('буюртмага тайёр');
  return signals;
}

async function igNotifyHotLead(from, clientText, signals) {
  const uname = igUsernames[from] || from;
  const pm = (clientText || '').match(/\+?998[\s\-]?\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}|\b\d{2}[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}\b/);
  const phone = pm ? pm[0] : '';
  let need = '';
  try {
    const hist = (igConvHistory[from] || []).filter(m => m.role === 'user').slice(-6).map(m => m.content).join(' | ');
    need = await orChatMessages([
      { role: 'system', content: "Mijoz xabarlaridan nima kerakligini 3-6 so'zda ayt (masalan: oshxona 3m akril). FAQAT shu qisqa iborani qaytar." },
      { role: 'user', content: hist.slice(0, 1500) }
    ], 40, 'anthropic/claude-haiku-4.5') || '';
  } catch (e) {}
  const txt = `🔥 *ТАЙЁР МИЖОЗ*\n👤 ${uname}\n📦 Керак: ${need || '-'}\n🎯 Сигнал: ${signals.join(', ')}${phone ? '\n📞 ' + phone : ''}\n💬 "${(clientText||'').slice(0,150)}"\n🕐 ${new Date().toLocaleString('ru-RU',{timeZone:'Asia/Tashkent'})}`;
  try { await msg(ADMIN, txt); } catch(e) { console.error('igNotifyHotLead:', e.message); }
  try { if (officeChat && String(officeChat) !== String(ADMIN)) await agentMsg(officeChat, 'aziza', txt); } catch(e) {}
  try { await leadsAppend({ ts: new Date().toISOString(), uid: from, username: uname, need, phone, signals, msg: (clientText || '').slice(0, 200), status: 'new' }); } catch(e) { console.error('lead save:', e.message); }
}


// ── IG DM javob: Sonnet 4.6 (OpenRouter, prompt caching) → GROQ zaxira ──
function orChatMessages(messages, maxTokens, model) {
  return new Promise((resolve) => {
    const key = process.env.OPENROUTER_KEY || process.env.OPENROUTER_API_KEY || '';
    if (!key) return resolve(null);
    const body = JSON.stringify({ model, max_tokens: maxTokens || 400, messages });
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d).choices[0].message.content.trim()); }
        catch (e) { console.log('orChatMessages xato:', d.slice(0, 200)); resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

function groqChatMessages(messages, maxTokens) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'openai/gpt-oss-120b', max_tokens: maxTokens || 400, reasoning_effort: 'low', messages });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d).choices?.[0]?.message?.content || null); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.write(body); req.end();
  });
}

async function aiReply(text, userId) {
  if (!igConvHistory[userId]) igConvHistory[userId] = [];
  const history = igConvHistory[userId];
  history.push({ role: 'user', content: text });
  while (history.length > 30) history.shift();

  // Sonnet 4.6 + prompt caching (system prompt keshdan o'qiladi — 10x arzon)
  const systemCached = { role: 'system', content: [{ type: 'text', text: IG_SALES_SYSTEM + IG_EXTRA, cache_control: { type: 'ephemeral' } }] };
  let reply = await orChatMessages([systemCached, ...history], 400, 'anthropic/claude-sonnet-4.6');

  // Zaxira 1: GROQ (Sonnet ishlamasa)
  if (!reply) {
    console.log('aiReply: Sonnet javob bermadi, GROQ zaxiraga o\'tildi');
    reply = await groqChatMessages([{ role: 'system', content: IG_SALES_SYSTEM + IG_EXTRA }, ...history], 400);
  }
  // Zaxira 2: yumshoq javob + adminga xabar
  if (!reply) {
    reply = "Кечирасиз, кичик техник узилиш бўлди. Хабарингизни кўрдим — тез орада аниқ жавоб берамиз 🙏🏻";
    try { await msg(ADMIN, '⚠️ *IG bot: ikkala model ham ishlamadi*\nMijoz: ' + (igUsernames[userId] || userId) + '\nXabar: "' + text.slice(0, 80) + '"\nQo\'lda javob bering!'); } catch (e) {}
  }

  history.push({ role: 'assistant', content: reply });
  while (history.length > 30) history.shift();

  // Follow-up hisobi: mijoz yozdi — followedUp qayta tiklanadi
  igActivity[userId] = Object.assign(igActivity[userId] || {}, { lastClientAt: Date.now(), followedUp: false });
  saveIgHistoryDebounced();
  return reply;
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
        let text = m.message?.text || '';
        // Ulashilgan reel/post — qaysi mebel haqida so'ralayotganini aniqlaymiz
        try {
          for (const a of (m.message?.attachments || [])) {
            const p = a.payload || {};
            if (a.type === 'ig_reel' || a.type === 'share' || a.type === 'story_mention') {
              let cap = (p.title || '').replace(/\s+/g, ' ').slice(0, 400);
              if (!cap && p.reel_video_id) cap = await igMediaCaption(p.reel_video_id);
              if (!cap && p.id) cap = await igMediaCaption(p.id);
              text += (text ? '\n' : '') + `[Mijoz bizning postni/videoni ulashdi${cap ? '. Video tavsifi: "' + cap + '"' : ' (tavsifi topilmadi — qaysi mebel qiziqtirganini so\'ra)'}]`;
            } else if (a.type === 'image' || a.type === 'video' || a.type === 'audio') {
              text += (text ? '\n' : '') + '[Mijoz ' + (a.type === 'image' ? 'rasm' : a.type === 'audio' ? 'ovozli xabar' : 'video') + ' yubordi]';
            }
          }
        } catch (e) { console.error('IG attachment:', e.message); }
        if (!from || !text) continue;

        // Skip echo messages (our own sent messages coming back)
        if (m.message?.is_echo) continue;

        console.log('IG DM from:', from, 'text:', text);
        if (m.sender?.username) igUsernames[from] = '@' + m.sender.username;

        // If bot is paused for this user (manual mode), skip entirely
        if (igManualMode[from]) {
          const hoursPassed = (Date.now() - igManualMode[from]) / (1000 * 3600);
          if (hoursPassed < IG_PAUSE_HOURS) {
            console.log('Bot paused for user:', from, '- skipping');
            continue;
          } else {
            delete igManualMode[from];
          }
        }

        // Debounce: client may send message in several pieces.
        // Collect parts, wait IG_DEBOUNCE_MS after the last one, then reply once.
        if (!igDebounce[from]) igDebounce[from] = { timer: null, parts: [] };
        igDebounce[from].parts.push(text);
        if (igDebounce[from].timer) clearTimeout(igDebounce[from].timer);
        igDebounce[from].timer = setTimeout(() => { igFlush(from); }, IG_DEBOUNCE_MS);
        console.log('IG debounce: buffered for', from, '| parts:', igDebounce[from].parts.length);
      }

      // ── Comments: webhook delivers these in entry.changes ──
      for (const ch of (entry.changes || [])) {
        if (ch.field !== 'comments') continue;
        try { await handleIGComment(ch.value); }
        catch(cErr) {
          console.error('IG comment xato:', cErr.message);
          await msg(ADMIN, `⚠️ *IG komment xatolik*\nXato: ${cErr.message}`);
        }
      }
    }
  } catch(e) { 
    console.error('IG error:', e);
    await msg(ADMIN, `❌ handleIG xato: ${e.message}`);
  }
}

// Handle a single incoming Instagram comment
async function handleIGComment(c) {
  if (!c) return;
  const commentId = c.id;
  const text = (c.text || '').trim();
  const commenterId = c.from?.id;
  const commenterName = c.from?.username || '';

  // Ignore our own comments and empties
  if (!commentId || !text) return;
  if (commenterId && commenterId === IG_USER_ID) return;
  if (igRepliedComments.has(commentId)) return; // already handled

  // No keyword filter — reply to EVERY comment (AI reads it and picks the tone)
  console.log('IG comment from', commenterName, '| text:', text);
  igRepliedComments.add(commentId);
  igRepliedSave();

  // Qaysi post/video ostiga yozilgan — tavsifini olamiz
  let mediaCap = '';
  try { mediaCap = await igMediaCaption(c.media && c.media.id); } catch (e) {}

  // 1) Public reply under the comment (AI reads comment, picks right tone)
  let pub;
  try {
    pub = await aiCommentReply(text, mediaCap);
  } catch(e) {
    console.log('aiCommentReply xato, fallback:', e.message);
  }
  if (!pub) pub = 'Shaxsiyingizga (DM) batafsil yozdik, qarang 😊';
  await igReplyToComment(commentId, pub);

  // 2) Private DM with full sales conversation (seed via aiReply)
  if (commenterId) {
    try {
      const seed = `[Mijoz "${text}" deb postga komment yozdi${mediaCap ? '. Post tavsifi: "' + mediaCap + '"' : ''}]`;
      const reply = await aiReply(seed, commenterId);
      const pieces = reply.split('|||').map(p => p.trim()).filter(Boolean);
      for (let i = 0; i < pieces.length; i++) {
        const r = await igSend(commenterId, pieces[i]);
        if (r.error) {
          // Common: cannot DM a user who never opened a conversation (24h / policy)
          console.log('IG comment DM error:', JSON.stringify(r.error).slice(0, 150));
          break;
        }
        if (i < pieces.length - 1) await new Promise(r => setTimeout(r, 1500));
      }
    } catch(dmErr) {
      console.error('IG comment DM xato:', dmErr.message);
    }
  }
}

// Post a public reply under a specific comment
// Generate a short public comment reply via GROQ
function aiCommentReply(commentText, mediaCap) {
  return new Promise((res) => {
    const body = JSON.stringify({
      model: 'openai/gpt-oss-120b',
      max_tokens: 200,
      reasoning_effort: 'low',
      messages: [
        { role: 'system', content: IG_COMMENT_SYSTEM + (mediaCap ? "\n\nKOMMENT SHU POST OSTIGA YOZILGAN, post tavsifi: \"" + mediaCap + "\" — javobda shu mebelga mos ohang tanla (lekin narx baribir aytilmaydi)." : '') },
        { role: 'user', content: commentText }
      ]
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        try {
          let t = JSON.parse(d).choices?.[0]?.message?.content || '';
          t = t.trim().replace(/^["']|["']$/g, '');
          res(t || null);
        } catch(e) { res(null); }
      });
    });
    req.on('error', () => res(null));
    req.write(body); req.end();
  });
}

function igReplyToComment(commentId, message) {
  return new Promise((res) => {
    const body = 'message=' + encodeURIComponent(message) + '&access_token=' + encodeURIComponent(IG_TOKEN);
    const req = https.request({
      hostname: 'graph.instagram.com',
      path: '/v21.0/' + commentId + '/replies',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { console.log('igReplyToComment resp:', d.slice(0, 200)); try { res(JSON.parse(d)); } catch(e) { res({}); } });
    });
    req.on('error', (e) => { console.log('igReplyToComment err:', e.message); res({}); });
    req.write(body); req.end();
  });
}

// ─── Comment polling: webhook comment event'lari ishonchsiz, shuning uchun
// API orqali har tick'da yangi komentlarni o'zimiz tekshiramiz va javob beramiz.
let igPollStarted = 0;          // birinchi tick vaqti — eski komentlarni o'tkazib yuborish uchun
const IG_POLL_MAX_AGE_MS = 24 * 3600 * 1000;  // faqat oxirgi 24 soatlik komentlarga javob
async function pollIGComments() {
  if (!IG_TOKEN) return;
  if (!igPollStarted) igPollStarted = Date.now();
  const tok = encodeURIComponent(IG_TOKEN);
  try {
    // BARCHA media (paginatsiya bilan) — eng eski postgacha
    let mediaUrl = `https://graph.instagram.com/v21.0/${MON.igUserId}/media?fields=id&limit=50&access_token=${tok}`;
    const allMedia = [];
    let guard = 0;
    while (mediaUrl && guard < 20) {
      guard++;
      const mRes = await monFetch(mediaUrl, {}, 20000);
      const mData = await mRes.json();
      if (!mData.data) break;
      for (const m of mData.data) allMedia.push(m.id);
      mediaUrl = mData.paging?.next || null;
    }

    for (const mediaId of allMedia) {
      // Har media komentlari (eng yangi avval keladi)
      const cRes = await monFetch(`https://graph.instagram.com/v21.0/${mediaId}/comments?fields=id,text,timestamp,username,from&limit=25&access_token=${tok}`, {}, 20000);
      const cData = await cRes.json();
      if (!cData.data || cData.data.length === 0) continue;

      // Optimizatsiya: eng yangi koment 24 soatdan eski bo'lsa, bu postni butunlay o'tkazamiz
      const newestTs = cData.data[0].timestamp ? Date.parse(cData.data[0].timestamp) : 0;
      if (newestTs && (Date.now() - newestTs) > IG_POLL_MAX_AGE_MS) continue;

      for (const cm of cData.data) {
        if (!cm.id || igRepliedComments.has(cm.id)) continue;
        // Vaqt filtri — faqat oxirgi 24 soatlik komentlar
        const ts = cm.timestamp ? Date.parse(cm.timestamp) : 0;
        if (ts && (Date.now() - ts) > IG_POLL_MAX_AGE_MS) continue;
        // O'z komentimizni o'tkazib yuboramiz
        const fromId = cm.from?.id;
        if (fromId && fromId === MON.igUserId) continue;
        // MUHIM: Instagram'dan tekshiramiz — bu komentга allaqachon javob berganmizmi?
        // (RAM restart'da igRepliedComments o'chadi, shuning uchun haqiqiy holatni tekshiramiz)
        try {
          const repRes = await monFetch(`https://graph.instagram.com/v21.0/${cm.id}/replies?fields=from&access_token=${tok}`, {}, 15000);
          const repData = await repRes.json();
          const alreadyReplied = (repData.data || []).some(r => r.from?.id === MON.igUserId || r.from?.username === 'mbi_mebel');
          if (alreadyReplied) {
            igRepliedComments.add(cm.id);  // keyingi tick uchun belgilaymiz
            igRepliedSave();               // persistga ham yozamiz (restart'dan omon qolsin)
            continue;
          }
        } catch (e) { /* tekshira olmasa, davom etadi */ }
        // handleIGComment formatiga moslab uzatamiz
        await handleIGComment({
          id: cm.id,
          text: cm.text || '',
          from: { id: fromId, username: cm.username || cm.from?.username || '' }
        });
        await new Promise(r => setTimeout(r, 800));  // rate-limit ehtiyot
      }
    }
  } catch (e) {
    console.error('pollIGComments xato:', e.message);
  }
}

// After debounce window: combine buffered parts, get AI reply, send split into pieces
async function igFlush(from) {
  const buf = igDebounce[from];
  if (!buf) return;
  delete igDebounce[from];
  const combined = buf.parts.join('\n').trim();
  if (!combined) return;

  // Re-check pause (client may have been picked up manually during the wait)
  if (igManualMode[from]) {
    const hoursPassed = (Date.now() - igManualMode[from]) / (1000 * 3600);
    if (hoursPassed < IG_PAUSE_HOURS) {
      console.log('Bot paused for user:', from, '- skipping flush');
      return;
    } else {
      delete igManualMode[from];
    }
  }

  // Get AI reply
  let reply;
  try {
    reply = await aiReply(combined, from);
  } catch(aiErr) {
    console.error('aiReply xato:', aiErr.message);
    await msg(ADMIN, `⚠️ *IG bot xatolik*\nMijoz: ${from}\nXabar: "${combined.slice(0,50)}"\nXato: ${aiErr.message}`);
    reply = `Кечирасиз, кичик техник узилиш бўлди. Хабарингизни кўрдим — тез орада жавоб берамиз 🙏🏻`;
  }

  // FOTO markeri: [[FOTO:oshxona]] — matndan olib tashlab, keyin rasm yuboramiz
  let fotoCat = null;
  const fm = reply.match(/\[\[FOTO:(\w+)\]\]/i);
  if (fm) { fotoCat = fm[1].toLowerCase(); reply = reply.replace(/\[\[FOTO:\w+\]\]/gi, '').trim(); }

  // Split reply into separate messages on "|||" and send with a small pause
  let pieces = reply.split('|||').map(p => p.trim()).filter(Boolean);
  // Fallback: agar model "|||" qo'ymagan bo'lsa, javob uzun bo'lsa qatorlar/jumlalar bo'yicha bo'lamiz
  if (pieces.length === 1 && pieces[0].length > 90) {
    let parts = pieces[0].split('\n').map(p => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      // qatorlar yo'q — jumlalarga bo'l (. ? !)
      parts = pieces[0].match(/[^.!?]+[.!?]*/g)?.map(p => p.trim()).filter(Boolean) || parts;
    }
    // 3 ta bo'lakdan oshmasin — qolganini birlashtir
    if (parts.length > 3) {
      const head = parts.slice(0, 2);
      head.push(parts.slice(2).join(' '));
      parts = head;
    }
    if (parts.length > 1) pieces = parts;
  }
  for (let i = 0; i < pieces.length; i++) {
    try {
      const sendResult = await igSend(from, pieces[i]);
      if (sendResult.error) {
        await msg(ADMIN, `⚠️ *IG javob yuborilmadi*\nMijoz: ${from}\nXato: ${sendResult.error.message || JSON.stringify(sendResult.error).slice(0,100)}`);
        break;
      }
    } catch(sendErr) {
      console.error('igSend xato:', sendErr.message);
      await msg(ADMIN, `⚠️ *IG bot ishlamadi*\nMijoz: ${from}\nXato: ${sendErr.message}`);
      break;
    }
    if (i < pieces.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  // Tayyor ishlar rasmini yuborish (har suhbatda 1 marta)
  if (fotoCat && !(igActivity[from] && igActivity[from].photoSent)) {
    try {
      const urls = await igPickPhotos(fotoCat);
      for (const u of urls) { await igSendImage(from, u); await new Promise(r => setTimeout(r, 1200)); }
      if (urls.length) { igActivity[from] = Object.assign(igActivity[from] || {}, { photoSent: true }); saveIgHistoryDebounced(); }
    } catch (e) { console.error('foto yuborish:', e.message); }
  }

  // Tayyor mijoz? Ibrohimga xabar ber
  try {
    const signals = igDetectHotLead(combined);
    if (signals.length) await igNotifyHotLead(from, combined, signals);
  } catch(e) { console.error('hotlead notify:', e.message); }
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
loadIgHistory();






