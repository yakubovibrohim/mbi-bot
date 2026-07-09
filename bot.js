const https = require('https');
const http = require('http');
const crypto = require('crypto');
const FormData = require('form-data');
let cardMon = null; try { cardMon = require('./card-monitor'); } catch (e) { console.error('card-monitor yuklanmadi:', e.message); }

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
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        if (j && r.statusCode >= 200 && r.statusCode < 300) return res(j);
        rej(new Error('ghGet ' + path + ': HTTP ' + r.statusCode + (j && j.message ? ' ' + String(j.message).slice(0, 80) : ' (JSON emas)')));
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('ghGet timeout: ' + path)));
    req.on('error', rej); req.end();
  });
}
// Moliyaviy fayllar — bulardan biri o'zgarsa ledger.json avtomatik qayta quriladi
const FIN_FILES = ['deals-log.json', 'office-expenses-log.json', 'expenses-personal-log.json', 'staff-log.json', 'debts-log.json', 'card-income-log.json', 'cashbox.json'];
async function ghPut(path, content, sha, commitMsg) {
  const r = await ghPutRaw(path, content, sha, commitMsg);
  if (FIN_FILES.includes(path)) scheduleLedgerRebuild();
  return r;
}
function ghPutRaw(path, content, sha, commitMsg) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ message: commitMsg, content: Buffer.from(content).toString('base64'), sha: sha });
    const req = https.request({
      hostname: 'api.github.com', path: '/repos/' + GH_REPO + '/contents/' + path, method: 'PUT',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (e) {}
        if (j && r.statusCode >= 200 && r.statusCode < 300) return res(j);
        const em = (r.statusCode === 409 || r.statusCode === 422)
          ? 'sha eskirgan (parallel yozuv)' : (j && j.message ? String(j.message).slice(0, 80) : 'JSON emas');
        rej(new Error('ghPut ' + path + ': HTTP ' + r.statusCode + ' ' + em));
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('ghPut timeout: ' + path)));
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
  for (let i = 1; i <= 2; i++) {
    try {
      const { data, sha } = await ghRead(file);
      data.push(newEntry);
      if (data.length > 500) data.splice(0, data.length - 500);
      await ghPut(file, JSON.stringify(data, null, 2), sha, label || 'update');
      return true;
    } catch (e) {
      console.error('ghWrite xato (' + i + '-urinish, ' + file + '):', e.message);
      if (i === 2) { try { msg(ADMIN, '⚠️ *Saqlash xatosi*\n' + file + ': ' + e.message.slice(0, 120)); } catch (e2) {} }
      await new Promise(r => setTimeout(r, 800));
    }
  }
  return false;
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
  let cardLink = false;
  try { if (cardMon && cardMon.cardPending) cardLink = Object.values(cardMon.cardPending).filter(p => p.amtUzs === amountUzs && p.dir === 'in').length === 1; } catch (e) {}
  const payRec = { id: uid(), date: todayStr(), ts: new Date().toISOString(), amount_uzs: amountUzs, rate: USD_UZS, note: '' };
  if (cardLink) { payRec.pay_method = 'card'; payRec.cardLinked = true; payRec.note = '💳 karta'; }
  data[idx].payments.push(payRec);
  await ghPut('deals-log.json', JSON.stringify(data, null, 2), sha, 'payment: ' + data[idx].client);
  if (cardLink) { try { await cardMon.resolveExternally(amountUzs, 'in', data[idx].client + " to'lovi"); } catch (e) {} }
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
  data[idx].expenses.push({ id: uid(), date: todayStr(), ts: new Date().toISOString(), products: st.expProducts, total_uzs: total, rate: USD_UZS, note: '', source: 'manual' });
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
// ═══ OYLIK DAVOMAT KO'RISH (xodim → oy → to'liq kunlar) — faqat ko'rish ═══
async function attMonthPickStaff(c) {
  const list = (await readStaff()).filter(s => s.active !== false);
  if (!list.length) { await msg(c, '_Xodim yo\'q._'); return; }
  const rows = list.map(s => [{ text: '👷 ' + s.name, callback_data: 'attm_s_' + s.id }]);
  rows.push([{ text: '◀️ Ortga', callback_data: 'all_att' }]);
  await btn(c, '📆 *Oylik davomat*\n\nQaysi xodim?', rows);
}
async function attMonthPickMonth(c, id) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const now = nowTZ();
  const cy = now.getFullYear(), cm = now.getMonth();
  const hp = dmyParts(s.hire_date);
  let sy = hp ? hp.y : cy, sm = hp ? hp.m : cm;
  const items = [];
  let y = sy, m = sm, guard = 0;
  while ((y < cy || (y === cy && m <= cm)) && guard < 120) { items.push({ y, m }); m++; if (m > 11) { m = 0; y++; } guard++; }
  items.reverse();
  const rows = items.map(it => {
    const closed = (s.closed_months || []).some(cm2 => cm2.y === it.y && cm2.m === it.m);
    const cur = (it.y === cy && it.m === cm);
    return [{ text: `${UZ_MONTHS[it.m]} ${it.y}${cur ? ' (joriy)' : ''}${closed ? ' 🔒' : ''}`, callback_data: `attm_m_${id}_${it.y}_${it.m}` }];
  });
  rows.push([{ text: '◀️ Ortga', callback_data: 'attm_pick' }]);
  await btn(c, `📆 *${s.name} — oy tanlang:*`, rows);
}
async function attMonthShow(c, id, y, m, isWorker) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const closed = (s.closed_months || []).some(cm => cm.y === y && cm.m === m);
  const attByDay = {}; (s.attendance || []).forEach(a => { const p = dmyParts(a.date); if (p && p.y === y && p.m === m) attByDay[p.d] = a; });
  const absByDay = {}; (s.absences || []).forEach(a => { const p = dmyParts(a.date); if (p && p.y === y && p.m === m) absByDay[p.d] = a; });
  const leaveByDay = {}; (s.leaves || []).forEach(l => { const p = dmyParts(l.date); if (p && p.y === y && p.m === m && l.status === 'approved') leaveByDay[p.d] = l; });
  const WD = ['Ya', 'Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh'];
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let txt = `📆 *${s.name} — ${UZ_MONTHS[m]} ${y}*${closed ? ' 🔒 _(yopilgan)_' : ''}\n\n`;
  let workedDays = 0, totalNormal = 0, totalExtra = 0, absCnt = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m, d).getDay();
    const wd = WD[dow], dd = ('0' + d).slice(-2);
    const a = attByDay[d], ab = absByDay[d], lv = leaveByDay[d];
    if (a && a.in) {
      const dh = computeDayHours(a.in, a.out, a.leave_min);
      const nh = (a.normalH != null ? a.normalH : dh.normalH);
      const eh = (a.extraH != null ? a.extraH : dh.extraH);
      workedDays++; totalNormal += nh; totalExtra += eh;
      const marks = [];
      if (a.late) marks.push('⚠️kech');
      if (a.early) marks.push('🏃erta');
      if (!a.late && !a.early && a.out) marks.push('✅');
      txt += `${dd} ${wd}: ${a.in}–${a.out || '...'} · ${nh.toFixed(1)}s${eh ? ` +${eh.toFixed(1)}` : ''} ${marks.join(' ')}\n`;
      if (a.in_reason) txt += `   └ kech: _${a.in_reason}_\n`;
      if (a.out_reason) txt += `   └ erta: _${a.out_reason}_\n`;
    } else if (ab) {
      absCnt++;
      txt += `${dd} ${wd}: ❌ kelmagan${ab.reason ? ` (_${ab.reason}_)` : ''}\n`;
    } else if (lv) {
      txt += `${dd} ${wd}: 🙋 javob${lv.reason ? ` (_${lv.reason}_)` : ''}\n`;
    } else if (dow === 0) {
      txt += `${dd} ${wd}: _dam_\n`;
    } else {
      txt += `${dd} ${wd}: —\n`;
    }
  }
  txt += `\n📊 Ishlagan: *${workedDays} kun*, *${totalNormal.toFixed(1)} soat*`;
  if (totalExtra > 0.05) txt += ` (+${totalExtra.toFixed(1)} qo'sh.)`;
  if (absCnt) txt += `, kelmagan: ${absCnt}`;
  // ── Shu oyda olingan avanslar ──
  const advs = (s.advances || [])
    .filter(a => { const p = dmyParts(a.date); return p && p.y === y && p.m === m && !a.pending; })
    .sort((a, b) => { const pa = dmyParts(a.date), pb = dmyParts(b.date); return pa.d - pb.d; });
  if (advs.length) {
    let advTot = 0;
    txt += `\n\n💸 *Avanslar (${UZ_MONTHS[m]}):*\n`;
    advs.forEach(a => { const amt = a.amount_usd || 0; advTot += amt; txt += `${a.date} — $${amt.toFixed(2)}\n`; });
    txt += `Jami olingan: *$${advTot.toFixed(2)}*`;
  } else {
    txt += `\n\n💸 _Bu oyda avans olinmagan._`;
  }
  const backRows = isWorker
    ? [[{ text: '◀️ Oylar', callback_data: 'wattm_pick' }], [{ text: '👷 Panel', callback_data: 'worker_panel' }]]
    : [[{ text: '◀️ Oylar', callback_data: 'attm_s_' + id }], [{ text: '👥 Bugun', callback_data: 'all_att' }]];
  await btn(c, txt, backRows);
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
  await btn(c, txt, [[{ text: '🔄 Yangilash', callback_data: 'all_att' }], [{ text: '📆 Oylik davomat', callback_data: 'attm_pick' }], [{ text: '📋 Intizom hisoboti', callback_data: 'disc_report' }]]);
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
  data[idx].advances.push({ id: uid(), date: dateStr || todayStr(), ts: new Date().toISOString(), amount_usd: amountUsd });
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
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const { history } = staffPayrollHistory(s);
  const open = history.filter(h => !h.closed);
  if (!open.length) { await btn(c, `🔒 *${s.name}* — barcha oylar yopilgan.`, [[{ text: '◀️ Ortga', callback_data: 'stf_open_' + id }]]); return; }
  const rows = open.slice().reverse().map(h => [{ text: `${UZ_MONTHS[h.m]} ${h.y} — ${fmtSigned(h.balance)}`, callback_data: `stf_clm_${id}_${h.y}_${h.m}` }]);
  rows.push([{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]);
  await btn(c, `🔒 *Oyni yopish — ${s.name}*\n\nQaysi oyni yopamiz? _(balans bilan)_`, rows);
}
// Oy tanlandi — summa so'raladi
async function staffCloseMonthAsk(c, id, y, m) {
  const { staff: s } = await findStaff(id);
  if (!s) { await msg(c, '⚠️ Topilmadi.'); return; }
  const { history } = staffPayrollHistory(s);
  const h = history.find(x => x.y === y && x.m === m);
  const bal = h ? h.balance : 0;
  orderState[c] = { step: 'stf_close_amount', staffId: id, closeY: y, closeM: m };
  await btn(c, `🔒 *${UZ_MONTHS[m]} ${y} — ${s.name}*\n\nShu oy balansi: ${fmtSigned(bal)}\n\n_Xodimga bu oy uchun jami qancha to'ladingiz? ($ yoki so'm). Yozsangiz oy yopiladi, balans 0 bo'ladi._`, [[{ text: '❌ Bekor', callback_data: 'stf_open_' + id }]]);
}
async function staffCloseMonth(c, id, paidUsd, y, m) {
  const { data, sha, idx } = await findStaff(id);
  if (idx < 0) { await msg(c, '⚠️ Topilmadi.'); return; }
  const now = nowTZ();
  const yy = (y != null ? y : now.getFullYear());
  const mm = (m != null ? m : now.getMonth());
  const s = data[idx];
  // shu oyda berilgan avanslar (kassada allaqachon chiqim bo'lgan) — dublikatdan qochish uchun
  const advThisMonth = (s.advances || []).filter(a => { const p = dmyParts(a.date); return p && p.y === yy && p.m === mm && !a.pending; }).reduce((sm, a) => sm + (a.amount_usd || 0), 0);
  s.closed_months = s.closed_months || [];
  const ex = s.closed_months.find(cm => cm.y === yy && cm.m === mm);
  if (ex) { ex.paid_usd = paidUsd; ex.date = todayStr(); }
  else s.closed_months.push({ y: yy, m: mm, paid_usd: paidUsd, date: todayStr() });
  await ghPut('staff-log.json', JSON.stringify(data, null, 2), sha, `staff close month ${UZ_MONTHS[mm]} ${yy}: ` + s.name);

  // KASSA CHIQIMI: faqat AVANSDAN ORTIQ to'langan qism (avanslar kassada allaqachon chiqim).
  // extraPay = paidUsd − advThisMonth (musbat bo'lsa). Dublikatsiz, close_ref bilan.
  const extraPayUsd = Math.max(0, paidUsd - advThisMonth);
  const extraUzs = Math.round(extraPayUsd * USD_UZS);
  const closeRef = `stfclose_${s.id}_${yy}_${mm}`;
  try {
    const { data: ox, sha: oxSha } = await ghRead('office-expenses-log.json');
    const oIdx = ox.findIndex(e => e.close_ref === closeRef);
    const label = `${s.name} — ${UZ_MONTHS[mm]} ${yy} oyligi`;
    if (extraUzs > 0) {
      if (oIdx >= 0) { ox[oIdx].amount_uzs = extraUzs; ox[oIdx].rate = USD_UZS; ox[oIdx].date = todayStr(); ox[oIdx].name = label; }
      else ox.push({ id: uid(), date: todayStr(), ts: new Date().toISOString(), name: label, amount_uzs: extraUzs, rate: USD_UZS, note: 'Oy yopish (avansdan ortiq)', close_ref: closeRef, is_salary: true });
      await ghPut('office-expenses-log.json', JSON.stringify(ox, null, 2), oxSha, `cashbox out (oy yopish): ${label}`);
    } else if (oIdx >= 0) {
      // avvalgi chiqim bor edi, endi ortiq yo'q — o'chiramiz (dublikat bo'lmasin)
      ox.splice(oIdx, 1);
      await ghPut('office-expenses-log.json', JSON.stringify(ox, null, 2), oxSha, `cashbox out removed (oy yopish): ${label}`);
    }
  } catch (e) { console.error('close-month cashbox out error', e); }

  const paidUzs = Math.round(paidUsd * USD_UZS);
  let extraLine = '';
  if (extraUzs > 0) extraLine = `\n💸 Kassadan chiqim (avansdan ortiq): ${fmtUzs(extraUzs)} so'm`;
  else if (advThisMonth > 0) extraLine = `\n_(To'lov shu oy avanslari bilan qoplangan — kassaga qo'shimcha chiqim yo'q.)_`;
  await msg(c, `🔒 ${s.name} — ${UZ_MONTHS[mm]} ${yy} oyi yopildi.\nTo'langan: $${paidUsd.toFixed(2)} (${fmtUzs(paidUzs)} so'm). Balans 0.${extraLine}`);
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

// ─── Xodim: oylik davomat + avans (oy tanlash) ───
async function workerAttMonthPick(c, s) {
  const now = nowTZ();
  const cy = now.getFullYear(), cm = now.getMonth();
  const hp = dmyParts(s.hire_date);
  let y = hp ? hp.y : cy, m = hp ? hp.m : cm, guard = 0;
  const items = [];
  while ((y < cy || (y === cy && m <= cm)) && guard < 120) { items.push({ y, m }); m++; if (m > 11) { m = 0; y++; } guard++; }
  items.reverse();
  const rows = items.map(it => {
    const cur = (it.y === cy && it.m === cm);
    return [{ text: `${UZ_MONTHS[it.m]} ${it.y}${cur ? ' (joriy)' : ''}`, callback_data: `wattm_m_${it.y}_${it.m}` }];
  });
  rows.push([{ text: '◀️ Ortga', callback_data: 'worker_panel' }]);
  await btn(c, `📆 *Oylik davomat va avanslar*\n\nOy tanlang:`, rows);
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
  rows.push([{ text: '📆 Oylik davomat', callback_data: 'wattm_pick' }]);
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
  data.push({ id: uid(), date: todayStr(), ts: new Date().toISOString(), name: name.trim(), amount_uzs: amountUzs, rate: USD_UZS, note: '' });
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
  // Karta monitorida shu summali ochiq savol bo'lsa — bog'laymiz (ikki marta hisoblanmasin)
  const dirTx = data[idx].dir === 'in' ? 'in' : 'out';
  let cardLink = false;
  try { if (cardMon && cardMon.cardPending) cardLink = Object.values(cardMon.cardPending).filter(p => p.amtUzs === amountUzs && p.dir === dirTx).length === 1; } catch (e) {}
  const payRec = { date: todayStr(), ts: new Date().toISOString(), amount_uzs: amountUzs };
  if (cardLink) { payRec.pay_method = 'card'; payRec.cardLinked = true; }
  data[idx].payments.push(payRec);
  data[idx].pay_date = todayStr();
  const remain = (data[idx].amount_uzs || 0) - data[idx].paid_uzs;
  await ghPut('debts-log.json', JSON.stringify(data, null, 2), sha, 'debt pay: ' + data[idx].name);
  if (cardLink) { try { await cardMon.resolveExternally(amountUzs, dirTx, data[idx].name + " qarz to'lovi"); } catch (e) {} }
  await msg(c, `✅ To'lov yozildi: ${fmtUzs(amountUzs)} so'm\n${remain > 0 ? '📉 Qoldi: ' + fmtUzs(remain) + ' so\'m' : '✔️ To\'liq yopildi!'}`);
  await showDebts(c);
}

// ─── KASSA (cashbox.json + barcha kirim/chiqimdan hisob) ──────
async function readCashbox() {
  try { const { data } = await ghRead('cashbox.json'); return (data && !Array.isArray(data)) ? data : { opening_uzs: null, opening_date: null }; }
  catch (e) { return { opening_uzs: null, opening_date: null }; }
}
// ══════════════════════════════════════════════════════════════
// YAGONA MOLIYA YADROSI — barcha kirim-chiqim BIR manbadan
// Kassa, Umumiy hisobot, Excel, Sardor — hammasi shu yerdan oladi.
// ══════════════════════════════════════════════════════════════
function dNum(s) { const p = dmyParts(s); return p ? p.y * 10000 + p.m * 100 + p.d : 0; }
function tsTime(ts) {
  try { if (!ts) return ''; return new Date(ts).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}
const LEDGER_CAT_UZ = {
  deal_payment: "Mijoz to'lovi", deal_expense: 'Buyurtma xarajati', office: 'Ishxona',
  personal: 'Shaxsiy', staff_advance: 'Xodim avansi', debt_in: "Qarzdor to'lovi",
  debt_paid: "Qarz to'lovim", card_income: 'Boshqa kirim (karta)'
};
// Har bir harakat: {date, time, dnum, dir:'in'|'out', cat, amount_uzs, name, card, src}
async function allMovements() {
  const mv = [];
  const push = (date, ts, dir, cat, amt, name, card, src, extra) => {
    amt = Math.round(Number(amt) || 0);
    if (!amt) return;
    mv.push(Object.assign({ date: date || '', time: tsTime(ts), dnum: dNum(date), dir, cat, amount_uzs: amt, name: (name || '').slice(0, 120), card: !!card, src }, extra || {}));
  };
  const [dealsR, office, persAll, staff, debts, cardInc] = await Promise.all([
    ghRead('deals-log.json'), ghReadAll('office-expenses-log.json'), ghReadAll('expenses-personal-log.json'),
    ghReadAll('staff-log.json'), ghReadAll('debts-log.json'), ghReadAll('card-income-log.json')
  ]);
  const deals = dealsR.data || [];
  // 1) Buyurtmalar: to'lov (kirim) + xarajat (chiqim)
  for (const o of deals) {
    for (const p of (o.payments || [])) push(p.date, p.ts, 'in', 'deal_payment', p.amount_uzs, o.client, p.pay_method === 'card', 'deals', { client: o.client || '' });
    for (const e of (o.expenses || [])) {
      const prods = e.products || [];
      const detail = prods.length
        ? `${o.client}: ` + prods.map(pr => `${pr.name || ''} (${pr.qty || ''}x${(pr.price_uzs || 0).toLocaleString()})`).join('; ')
        : '';
      push(e.date, e.ts, 'out', 'deal_expense', e.total_uzs, `${o.client}: ${e.name || 'xarajat'}`, e.pay_method === 'card', 'deals', { client: o.client || '', label: e.name || 'xarajat', detail });
    }
  }
  // 2) Ishxona
  for (const e of (office || [])) push(e.date, e.ts, 'out', 'office', e.amount_uzs, e.name || e.note || '', e.pay_method === 'card', 'office');
  // 3) Shaxsiy
  for (const e of (persAll || [])) {
    const p = e.parsed || {};
    let a = e.amount_uzs || 0;
    if (!a && p.amount) a = (String(p.currency).toUpperCase() === 'USD') ? p.amount * USD_UZS : p.amount;
    else if (!a && e.amount) a = (String(e.currency).toUpperCase() === 'USD') ? e.amount * USD_UZS : e.amount;
    const note = e.note || p.text || e.text || '';
    push(e.date, e.ts, 'out', 'personal', a, note, e.pay_method === 'card' || /💳/.test(note), 'personal');
  }
  // 4) Xodim avanslari
  for (const w of (staff || []))
    for (const a of (w.advances || [])) { if (a.pending) continue; push(a.date, a.ts, 'out', 'staff_advance', (a.amount_usd || 0) * USD_UZS, w.name, false, 'staff', { usd: a.amount_usd || 0 }); }
  // 5) Qarzlar: men to'laganim (out) / menga to'langani (in)
  for (const d of (debts || [])) {
    const dir = d.dir === 'in' ? 'in' : 'out';
    const cat = dir === 'in' ? 'debt_in' : 'debt_paid';
    if (Array.isArray(d.payments)) for (const p of d.payments) push(p.date, p.ts, dir, cat, p.amount_uzs, d.name, p.pay_method === 'card', 'debts');
    else if (d.paid_uzs) push(d.pay_date || d.date, d.ts, dir, cat, d.paid_uzs, d.name, false, 'debts');
  }
  // 6) Karta boshqa kirim
  for (const e of (cardInc || [])) push(e.date, e.ts, 'in', 'card_income', e.amount_uzs, e.name || '', true, 'card');
  mv.sort((a, b) => a.dnum - b.dnum);
  return mv;
}
function sumMovements(mv, filter) {
  let inn = 0, out = 0; const byCat = {};
  for (const m of mv) {
    if (filter && !filter(m)) continue;
    byCat[m.cat] = (byCat[m.cat] || 0) + m.amount_uzs;
    if (m.dir === 'in') inn += m.amount_uzs; else out += m.amount_uzs;
  }
  return { inn, out, net: inn - out, byCat };
}
// ledger.json — yagona kassa daftari (avtomatik quriladi, qo'lda tahrir qilinmaydi)
let ledgerTimer = null;
function scheduleLedgerRebuild() {
  clearTimeout(ledgerTimer);
  ledgerTimer = setTimeout(() => rebuildLedger().catch(e => console.error('ledger rebuild:', e.message)), 8000);
}
async function rebuildLedger() {
  const cfg = await readCashbox();
  const mv = await allMovements();
  const opN = dNum(cfg.opening_date);
  const k = sumMovements(mv, m => !opN || m.dnum >= opN);
  const out = {
    updated: new Date().toISOString(),
    rate_usd_uzs: USD_UZS,
    opening: { amount_uzs: cfg.opening_uzs || 0, date: cfg.opening_date || null },
    balance_uzs: (cfg.opening_uzs || 0) + k.net,
    totals_after_opening: { kirim: k.inn, chiqim: k.out, by_category: k.byCat },
    movements: mv.map(m => ({ date: m.date, time: m.time || null, dir: m.dir, category: m.cat, category_uz: LEDGER_CAT_UZ[m.cat] || m.cat, amount_uzs: m.amount_uzs, name: m.name, pay: m.card ? 'karta' : 'naqd', src: m.src }))
  };
  let sha = null;
  try { const g = await ghGet('ledger.json'); sha = g.sha || null; } catch (e) {}
  await ghPutRaw('ledger.json', JSON.stringify(out, null, 2), sha, 'ledger rebuild');
  console.log(`ledger.json yangilandi: ${mv.length} harakat, qoldiq ${out.balance_uzs}`);
}

// Kassa qoldig'i = boshlang'ich + barcha kirim − barcha chiqim (YADRODAN)
async function computeCashbox() {
  const cfg = await readCashbox();
  const opening = cfg.opening_uzs || 0;
  // Boshlang'ich sanadan OLDINGI harakatlar boshlang'ich qoldiqqa kirgan — qayta hisoblanmaydi.
  const opN = dNum(cfg.opening_date);
  const mv = await allMovements();
  const k = sumMovements(mv, m => !opN || m.dnum >= opN);
  const c = k.byCat;
  const balance = opening + k.net;
  return {
    opening,
    income: c.deal_payment || 0, debtIn: c.debt_in || 0, cardIncome: c.card_income || 0,
    dealExp: c.deal_expense || 0, officeExp: c.office || 0, pers: c.personal || 0,
    staffAdv: c.staff_advance || 0, debtPaid: c.debt_paid || 0,
    balance, hasOpening: cfg.opening_uzs != null
  };
}
async function showCashboxFull(c) {
  const k = await computeCashbox();
  if (!k.hasOpening) {
    await btn(c, '💰 *Kassa*\n\n_Boshlang\'ich qoldiq hali kiritilmagan._\nHozir qo\'lingizda/kassada qancha pul borligini kiriting.', [
      [{ text: '➕ Boshlang\'ich qoldiqni kiritish', callback_data: 'cash_set' }],
      [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
    ]);
    return;
  }
  const r = await msgKb(c, `💰 *Kassa*\n\n` +
    `🏦 Boshlang'ich: ${fmtUzs(k.opening)} so'm\n` +
    `📥 Kirim (to'lovlar): +${fmtUzs(k.income)}\n` +
    `📥 Qarzdor to'lovi: +${fmtUzs(k.debtIn)}\n` +
    `💳 Boshqa kirim (karta): +${fmtUzs(k.cardIncome)}\n` +
    `📤 Buyurtma xarajat: −${fmtUzs(k.dealExp)}\n` +
    `🏭 Ishxona: −${fmtUzs(k.officeExp)}\n` +
    `👷 Xodim avans: −${fmtUzs(k.staffAdv)}\n` +
    `🔴 Qarz to'lovi: −${fmtUzs(k.debtPaid)}\n` +
    `👛 Shaxsiy: −${fmtUzs(k.pers)}\n` +
    `━━━━━━━━━━━━\n` +
    `💵 *Hozirgi qoldiq: ${fmtUzs(k.balance)} so'm*\n\n` +
    `_Bu xabar 10 daqiqadan keyin o'chiriladi._`, { inline_keyboard: [
    [{ text: "✏️ Boshlang'ich qoldiqni o'zgartirish", callback_data: 'cash_set' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ] });
  if (r && r.result) await scheduleAutoDelete(c, r.result.message_id);
}
async function cashSetStart(c) {
  orderState[c] = { step: 'cash_amount' };
  await btn(c, '💰 *Boshlang\'ich qoldiq:*\n\n_Hozir qancha pulingiz bor? So\'mda yoki $ bilan._', [[{ text: '❌ Bekor', callback_data: 'menu_cash' }]]);
}
// ══════════════════════════════════════════════════════════════
// KASSA/HISOBOT PAROLI + AVTO-O'CHIRISH
// ══════════════════════════════════════════════════════════════
const pHash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const kassaUnlocked = {}; // chat -> timestamp (10 daqiqa amal qiladi)
const KASSA_UNLOCK_MS = 10 * 60 * 1000;
function kassaIsUnlocked(c) { return kassaUnlocked[c] && (Date.now() - kassaUnlocked[c] < KASSA_UNLOCK_MS); }

async function getKassaParol() {
  const { data } = await ghRead('cashbox.json');
  return (data && !Array.isArray(data)) ? (data.parol_hash || null) : null;
}
async function setKassaParol(hash) {
  const { data, sha } = await ghRead('cashbox.json');
  const cfg = (data && !Array.isArray(data)) ? data : {};
  cfg.parol_hash = hash;
  await ghPut('cashbox.json', JSON.stringify(cfg, null, 2), sha, 'kassa parol');
}
async function askKassaParol(c, target) {
  const h = await getKassaParol();
  if (!h) {
    if (String(c) === ADMIN) {
      orderState[c] = { step: 'kassa_parol_new', target };
      await msg(c, "🔑 *Kassa paroli hali o'rnatilmagan.*\n\nYangi parolni yozib yuboring (kamida 3 belgi):");
    } else await msg(c, "🚫 Ruxsat yo'q.");
    return;
  }
  orderState[c] = { step: 'kassa_parol_check', target };
  await msg(c, '🔑 Parolni kiriting:');
}
async function kassaOpenTarget(c, target) {
  if (target === 'summary') { await showSummary(c); return; }
  if (target === 'cash_full') { await showCashboxFull(c); return; }
  if (target === 'cash_set') { await cashSetStart(c); return; }
  await showCashboxShort(c);
}

// ── Maxfiy xabarlarni avto-o'chirish (restartga chidamli navbat) ──
const AUTO_DEL_MS = 10 * 60 * 1000;
async function scheduleAutoDelete(c, mid, ms = AUTO_DEL_MS) {
  if (!mid) return;
  for (let i = 0; i < 2; i++) {
    try {
      const { data, sha } = await ghRead('pending-deletes.json');
      const list = Array.isArray(data) ? data : [];
      list.push({ c: String(c), mid, at: Date.now() + ms });
      await ghPut('pending-deletes.json', JSON.stringify(list), sha, 'auto-delete queue');
      return;
    } catch (e) { if (i === 1) console.error('scheduleAutoDelete:', e.message); }
  }
}
async function processAutoDeletes() {
  try {
    const { data, sha } = await ghRead('pending-deletes.json');
    const list = Array.isArray(data) ? data : [];
    if (!list.length) return;
    const now = Date.now();
    const due = list.filter(x => x.at <= now);
    if (!due.length) return;
    for (const x of due) {
      try { await api('deleteMessage', { chat_id: x.c, message_id: x.mid }); } catch (e) {}
    }
    const rest = list.filter(x => x.at > now);
    await ghPut('pending-deletes.json', JSON.stringify(rest), sha, 'auto-delete done');
  } catch (e) { console.error('processAutoDeletes:', e.message); }
}
setInterval(processAutoDeletes, 60 * 1000);

// Qisqa Kassa ko'rinishi — shu oy kirim/chiqim + qoldiq
async function showCashboxShort(c) {
  const now = nowTZ();
  const [k, g] = await Promise.all([computeCashbox(), gatherMonth(now.getFullYear(), now.getMonth())]);
  if (!k.hasOpening) {
    await btn(c, '💰 *Kassa*\n\n_Boshlang\'ich qoldiq hali kiritilmagan._\nHozir qo\'lingizda/kassada qancha pul borligini kiriting.', [
      [{ text: '➕ Boshlang\'ich qoldiqni kiritish', callback_data: 'cash_set' }],
      [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
    ]);
    return;
  }
  const monthName = UZ_MONTHS[now.getMonth()];
  const rows = [
    [{ text: '📄 Batafsil', callback_data: 'cash_full' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ];
  if (String(c) === ADMIN) rows.splice(1, 0, [{ text: "✏️ Boshlang'ich qoldiq", callback_data: 'cash_set' }, { text: '🔑 Parolni o\'zgartirish', callback_data: 'cash_parol' }]);
  const r = await msgKb(c, `💰 *Kassa — ${monthName}*\n\n` +
    `📥 Shu oy kirim: +${fmtUzs(g.kMonIn)}\n` +
    `📤 Shu oy chiqim: −${fmtUzs(g.kMonOut)}\n` +
    `━━━━━━━━━━━━\n` +
    `💵 *Hozirgi qoldiq: ${fmtUzs(k.balance)} so'm*\n\n` +
    `_Bu xabar 10 daqiqadan keyin o'chiriladi._`, { inline_keyboard: rows });
  if (r && r.result) await scheduleAutoDelete(c, r.result.message_id);
}

async function cashSetSave(c, amountUzs) {
  const { data, sha } = await ghRead('cashbox.json');
  const cfg = (data && !Array.isArray(data)) ? data : {};
  cfg.opening_uzs = amountUzs;
  cfg.opening_date = todayStr();
  await ghPut('cashbox.json', JSON.stringify(cfg, null, 2), sha, 'cashbox opening');
  await msg(c, `✅ Boshlang'ich qoldiq o'rnatildi: ${fmtUzs(amountUzs)} so'm`);
  await showCashboxShort(c);
}

// ══════════════════════════════════════════════════════════════
// 4-BOSQICH: Umumiy hisobot, Excel, avtomatik eslatma, backup
// ══════════════════════════════════════════════════════════════

// Berilgan oy uchun barcha ma'lumot — YAGONA YADRODAN (allMovements). m=0-11
async function gatherMonth(y, m) {
  const inMonD = (dateStr) => { const p = dmyParts(dateStr); return p && p.y === y && p.m === m; };
  const [mvAll, dealsR, cfg] = await Promise.all([allMovements(), ghRead('deals-log.json'), readCashbox()]);
  const deals = dealsR.data || [];
  const monthDeals = deals.filter(o => inMonD(o.date));
  const mon = mvAll.filter(x => inMonD(x.date));
  const bc = sumMovements(mon).byCat;
  const income = bc.deal_payment || 0, dealExp = bc.deal_expense || 0, officeExp = bc.office || 0,
    pers = bc.personal || 0, staffAdv = bc.staff_advance || 0,
    debtInMon = bc.debt_in || 0, debtPaidMon = bc.debt_paid || 0, cardIncomeMon = bc.card_income || 0;
  const bizProfit = income - dealExp - officeExp - staffAdv;
  const realRemain = bizProfit - pers;
  // ── Kassa (boshlang'ich sanadan keyingi barcha harakat) — xuddi computeCashbox kabi ──
  const opening = cfg.opening_uzs || 0;
  const op = dmyParts(cfg.opening_date);
  const opN = dNum(cfg.opening_date);
  const kSum = sumMovements(mvAll, x => !opN || x.dnum >= opN);
  const kc = kSum.byCat;
  const cashBalance = opening + kSum.net;
  // ── Oy boshi qoldiq va oy ichidagi kassa harakati ──
  const openDay = (op && op.y === y && op.m === m) ? op.d : null;
  const monN = y * 10000 + m * 100 + 1;
  let monthStart = null;
  if (cfg.opening_uzs != null) {
    if (openDay != null) monthStart = opening; // boshlang'ich shu oyda
    else if (monN > opN) monthStart = opening + sumMovements(mvAll, x => x.dnum >= opN && x.dnum < monN).net;
  }
  const kMon = sumMovements(mvAll, x => inMonD(x.date) && (!opN || x.dnum >= opN));
  // ── Mijoz qarzlari (faol buyurtmalar) ──
  const clientDebts = [];
  for (const o of deals) {
    if (o.status === 'active') {
      const paid = (o.payments || []).reduce((s, p) => s + (p.amount_uzs || 0), 0);
      const debt = (o.contract_sum_uzs || 0) - paid;
      if (debt > 0) clientDebts.push({ client: o.client, contract: o.contract_sum_uzs || 0, paid, debt });
    }
  }
  // ── Oy ichidagi detal qatorlar — hammasi harakatlardan ──
  const pick = c => mon.filter(x => x.cat === c);
  const allPayments = pick('deal_payment').map(x => ({ client: x.client || x.name, date: x.date, amount_uzs: x.amount_uzs, pay_method: x.card ? 'card' : 'cash' }));
  const dealExpMonRows = pick('deal_expense').map(x => ({ date: x.date, client: x.client || '', name: x.label || 'xarajat', amt: x.amount_uzs, card: x.card }));
  const officeMonRows = pick('office').map(x => ({ date: x.date, name: x.name, amt: x.amount_uzs, card: x.card }));
  const advMonRows = pick('staff_advance').map(x => ({ date: x.date, name: x.name, usd: x.usd || 0, amt: x.amount_uzs }));
  const debtPaidMonRows = pick('debt_paid').map(x => ({ date: x.date, name: x.name, amt: x.amount_uzs, card: x.card }));
  const debtInMonRows = pick('debt_in').map(x => ({ date: x.date, name: x.name, amt: x.amount_uzs, card: x.card }));
  const cardIncomeMonRows = pick('card_income').map(x => ({ date: x.date, name: x.name, amt: x.amount_uzs }));
  const persMonDetailed = pick('personal').map(x => ({ date: x.date, note: x.name, amt: x.amount_uzs, card: x.card }));
  return { monthDeals, income, dealExp, officeExp, pers, staffAdv, bizProfit, realRemain,
    opening, openingDate: cfg.opening_date,
    cashIn: kc.deal_payment || 0, cashDebtIn: kc.debt_in || 0, cashCardIncome: kc.card_income || 0,
    cashDealExp: kc.deal_expense || 0, cashOffice: kc.office || 0, cashPers: kc.personal || 0,
    cashAdv: kc.staff_advance || 0, cashDebtPaid: kc.debt_paid || 0, cashBalance, clientDebts,
    monthStart, openDay, kMonIn: kMon.inn, kMonOut: kMon.out,
    officeMonRows, advMonRows, debtPaidMonRows, debtInMonRows, cardIncomeMonRows, persMonDetailed, dealExpMonRows, allPayments, cardIncomeMon, debtInMon, debtPaidMon };
}

async function showSummary(c) {
  const now = nowTZ();
  await sendFullReport(c, now.getFullYear(), now.getMonth());
}

// To'liq matnli hisobot — har bir operatsiya ochilgan holda
async function sendFullReport(c, y, m) {
  const g = await gatherMonth(y, m);
  const monthName = UZ_MONTHS[m];
  const f = fmtUzs;
  const cardMark = (isCard) => isCard ? ' 💳' : '';
  let s = `📊 *${monthName} ${y} — TO'LIQ HISOBOT*\n`;
  s += `🆕 Yangi buyurtmalar: ${g.monthDeals.length} ta\n`;
  s += `🗓 _Quyidagilar faqat ${monthName} oyidagi operatsiyalar_\n`;
  s += `━━━━━━━━━━━━\n\n`;

  s += `💰 *KIRIM (mijoz to'lovlari)*\n`;
  if (g.allPayments.length) g.allPayments.forEach(p => { s += `  ${p.date}  ${p.client}: +${f(p.amount_uzs || 0)}${cardMark(p.pay_method === 'card')}\n`; });
  else s += `  _yo'q_\n`;
  s += `  Jami: *${f(g.income)}*\n\n`;

  if (g.debtInMonRows.length) {
    s += `📥 *QARZDOR TO'LOVLARI*\n`;
    g.debtInMonRows.forEach(d => { s += `  ${d.date}  ${d.name}: +${f(d.amt)}${cardMark(d.card)}\n`; });
    s += `  Jami: *${f(g.debtInMon)}*\n\n`;
  }
  if (g.cardIncomeMonRows.length) {
    s += `💳 *BOSHQA KIRIM (karta)*\n`;
    g.cardIncomeMonRows.forEach(d => { s += `  ${d.date}  ${d.name.replace('💳 ', '')}: +${f(d.amt)}\n`; });
    s += `  Jami: *${f(g.cardIncomeMon)}*\n\n`;
  }

  s += `📤 *BUYURTMA XARAJATLARI*\n`;
  if (g.dealExpMonRows.length) g.dealExpMonRows.forEach(e => { s += `  ${e.date}  ${e.client} — ${e.name}: −${f(e.amt)}${cardMark(e.card)}\n`; });
  else s += `  _yo'q_\n`;
  s += `  Jami: *${f(g.dealExp)}*\n\n`;

  s += `🏭 *ISHXONA XARAJATLARI*\n`;
  if (g.officeMonRows.length) g.officeMonRows.forEach(e => { s += `  ${e.date}  ${(e.name || '').replace('💳 ', '')}: −${f(e.amt)}${cardMark(e.card)}\n`; });
  else s += `  _yo'q_\n`;
  s += `  Jami: *${f(g.officeExp)}*\n\n`;

  s += `👷 *XODIM AVANS/OYLIK*\n`;
  if (g.advMonRows.length) g.advMonRows.forEach(a => { s += `  ${a.date}  ${a.name}: −${f(a.amt)} ($${a.usd})\n`; });
  else s += `  _yo'q_\n`;
  s += `  Jami: *${f(g.staffAdv)}*\n\n`;

  if (g.debtPaidMonRows.length) {
    s += `🔴 *QARZ TO'LOVLARIM*\n`;
    g.debtPaidMonRows.forEach(d => { s += `  ${d.date}  ${d.name}: −${f(d.amt)}${cardMark(d.card)}\n`; });
    s += `  Jami: *${f(g.debtPaidMon)}*\n\n`;
  }

  s += `👛 *SHAXSIY XARAJATLAR*\n`;
  if (g.persMonDetailed.length) g.persMonDetailed.forEach(e => { s += `  ${e.date}  ${(e.note || '').replace('💳 ', '')}: −${f(e.amt)}${cardMark(e.card)}\n`; });
  else s += `  _yo'q_\n`;
  s += `  Jami: *${f(g.pers)}*\n\n`;

  s += `━━━━━━━━━━━━\n`;
  s += `📈 Biznes sof foyda: *${f(g.bizProfit)}*\n`;
  s += `   (kirim − buyurtma − ishxona − avans)\n\n`;

  if (g.clientDebts.length) {
    s += `🟢 *MENGA QARZDOR (mijozlar)*\n`;
    g.clientDebts.forEach(d => { s += `  ${d.client}: ${f(d.debt)} (shartnoma ${f(d.contract)}, to'landi ${f(d.paid)})\n`; });
    s += `\n`;
  }

  s += `━━━━━━━━━━━━\n`;
  s += `💵 *KASSA — naqd + karta*\n`;
  if (g.monthStart == null) {
    s += `_Bu oy kassa hisobi boshlanishidan (${g.openingDate || '—'}) oldin_`;
  } else {
    const endBal = g.monthStart + g.kMonIn - g.kMonOut;
    const now2 = nowTZ();
    const isCur = now2.getFullYear() === y && now2.getMonth() === m;
    if (g.openDay != null) s += `  🏦 Boshlang'ich (${g.openingDate}): ${f(g.monthStart)}\n`;
    else s += `  🏦 Oy boshida: ${f(g.monthStart)}\n`;
    s += `  (+) ${monthName} kirim: ${f(g.kMonIn)}\n`;
    s += `  (−) ${monthName} chiqim: ${f(g.kMonOut)}\n`;
    s += `  ━━━━━\n`;
    if (isCur) s += `  💰 *Hozirgi qoldiq: ${f(endBal)} so'm*\n     (${Math.round(endBal / USD_UZS * 10) / 10} $)`;
    else s += `  💰 *Oy oxirida: ${f(endBal)} so'm*`;
  }

  const kb = [
    [{ text: '📥 Excel yuklash (shu oy)', callback_data: 'xls_now' }],
    [{ text: '📅 Oylik hisobotlar', callback_data: 'xls_list' }],
    [{ text: '◀️ Ortga', callback_data: 'menu_home' }]
  ];
  const kbMarkup = { inline_keyboard: kb };
  s += `\n\n_Bu xabar 10 daqiqadan keyin o'chiriladi._`;
  if (s.length <= 4000) {
    const r = await msgKb(c, s, kbMarkup);
    if (r && r.result) await scheduleAutoDelete(c, r.result.message_id);
  } else {
    const cut = s.lastIndexOf('\n\n', 3800);
    const r1 = await msg(c, s.slice(0, cut));
    const r2 = await msgKb(c, s.slice(cut), kbMarkup);
    if (r1 && r1.result) await scheduleAutoDelete(c, r1.result.message_id);
    if (r2 && r2.result) await scheduleAutoDelete(c, r2.result.message_id);
  }
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

// ─── Oy uchun batafsil yozuvlarni yig'ish (Excel uchun) ───
async function collectMonthRows(y, m) {
  // Excel qatorlari — YAGONA YADRODAN (allMovements)
  const TYP = { deal_payment: 'Kirim', deal_expense: 'Buyurtma xarajat', office: 'Ishxona', personal: 'Shaxsiy', staff_advance: 'Avans', debt_in: "Qarzdor to'lovi", debt_paid: "Qarz to'lovim", card_income: 'Karta kirim' };
  const mv = (await allMovements()).filter(x => { const p = dmyParts(x.date); return p && p.y === y && p.m === m; });
  return mv.map(x => {
    let tav;
    if (x.cat === 'deal_payment') tav = `${x.client || x.name} — to'lov`;
    else if (x.cat === 'deal_expense') tav = (x.detail || `${x.client}: ${x.label || 'xarajat'}`).slice(0, 120);
    else if (x.cat === 'staff_advance') tav = `${x.name} — avans ($${x.usd})`;
    else tav = (x.name || '').slice(0, 80);
    return { d: dmyParts(x.date).d, typ: TYP[x.cat] || x.cat, tav, ki: x.dir === 'in' ? x.amount_uzs : 0, ch: x.dir === 'out' ? x.amount_uzs : 0 };
  });
}

// Oy boshiga qoldiq: boshlang'ich + [openN .. oy boshi) harakat. Boshlang'ich oyining o'zi uchun: opening_uzs.
// Boshlang'ichdan oldingi oylar uchun: null (kassa zanjiri yo'q).
async function monthStartBalance(y, m) {
  const cfg = await readCashbox();
  if (cfg.opening_uzs == null) return { start: null, openDay: null, opening: null };
  const op = dmyParts(cfg.opening_date);
  const opN = dNum(cfg.opening_date);
  const monN = y * 10000 + m * 100 + 1;
  if (op && op.y === y && op.m === m) return { start: cfg.opening_uzs, openDay: op.d, opening: cfg.opening_uzs }; // boshlang'ich oyi
  if (monN <= opN) return { start: null, openDay: null, opening: cfg.opening_uzs }; // boshlang'ichdan oldingi oy
  // keyingi oylar: [boshlang'ich .. oy boshi) oralig'idagi harakatlar — YADRODAN
  const mv = await allMovements();
  const k = sumMovements(mv, x => x.dnum >= opN && x.dnum < monN);
  return { start: cfg.opening_uzs + k.net, openDay: null, opening: cfg.opening_uzs };
}

// Oylik Excel — bo'limlarga ajratilgan batafsil hisobot (exceljs)
async function buildMonthExcel(y, m) {
  const ExcelJS = require('exceljs');
  const monthName = UZ_MONTHS[m];
  const rows = await collectMonthRows(y, m);
  const { start, openDay, opening } = await monthStartBalance(y, m);
  const isOpenMonth = openDay != null; // boshlang'ich shu oyda (iyun 2026)

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${monthName} ${y}`);
  ws.columns = [{ width: 11 }, { width: 70 }, { width: 3 }, { width: 17 }, { width: 3 }];
  const money = '#,##0';
  const B = (c, opts) => Object.assign(c, opts);
  const thin = { style: 'thin', color: { argb: 'FFD9D9D9' } };
  const brd = { top: thin, left: thin, bottom: thin, right: thin };

  let r = 1;
  ws.mergeCells(r, 1, r, 5);
  B(ws.getCell(r, 1), { value: `MBI MEBEL — KASSA HISOBOTI — ${monthName.toUpperCase()} ${y}${isOpenMonth ? " (to'liq oy)" : ''}` });
  ws.getCell(r, 1).font = { name: 'Arial', bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  ws.getCell(r, 1).alignment = { horizontal: 'center' };
  ws.getRow(r).height = 26; r++;
  if (isOpenMonth) {
    ws.mergeCells(r, 1, r, 5);
    ws.getCell(r, 1).value = `① belgili yozuvlar ${String(openDay).padStart(2, '0')}.${String(m + 1).padStart(2, '0')} boshlang'ich qoldiq (${opening.toLocaleString()}) ichida hisobga olingan — kassa zanjiriga qayta qo'shilmaydi`;
    ws.getCell(r, 1).font = { name: 'Arial', italic: true, size: 9, color: { argb: 'FF808080' } };
    r++;
  }
  r++;

  const sections = [
    ["📥 KIRIM (mijoz to'lovlari)", 'Kirim', true],
    ["🤝 QARZDOR TO'LOVLARI", "Qarzdor to'lovi", true],
    ["💳 KARTA KIRIMLARI", 'Karta kirim', true],
    ["📦 BUYURTMA XARAJATLARI", 'Buyurtma xarajat', false],
    ["🏭 ISHXONA XARAJATLARI", 'Ishxona', false],
    ["👷 AVANSLAR", 'Avans', false],
    ["👛 SHAXSIY XARAJATLAR", 'Shaxsiy', false],
    ["🔴 QARZ TO'LOVLARIM", "Qarz to'lovim", false],
  ];
  const kassa = { in: [], out: [] };
  for (const [title, typ, isIn] of sections) {
    const items = rows.filter(x => x.typ === typ).sort((a, b) => a.d - b.d);
    if (!items.length) continue;
    ws.mergeCells(r, 1, r, 5);
    B(ws.getCell(r, 1), { value: title });
    ws.getCell(r, 1).font = { name: 'Arial', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } };
    ws.getRow(r).height = 20; r++;
    const first = r;
    const postCells = [];
    for (const it of items) {
      const pre = isOpenMonth && it.d < openDay;
      ws.getCell(r, 1).value = `${String(it.d).padStart(2, '0')}.${String(m + 1).padStart(2, '0')}` + (pre ? ' ①' : '');
      ws.getCell(r, 2).value = it.tav;
      const amt = isIn ? it.ki : it.ch;
      const c4 = ws.getCell(r, 4); c4.value = amt; c4.numFmt = money;
      c4.font = { name: 'Arial', italic: pre, color: { argb: isIn ? 'FF006100' : 'FF9C0006' } };
      if (pre) for (let col = 1; col <= 5; col++) ws.getCell(r, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      else postCells.push(`D${r}`);
      for (let col = 1; col <= 5; col++) ws.getCell(r, col).border = brd;
      r++;
    }
    ws.getCell(r, 2).value = isOpenMonth ? "Bo'lim jami (butun oy):" : "Bo'lim jami:";
    ws.getCell(r, 2).font = { name: 'Arial', bold: true };
    const cT = ws.getCell(r, 4); cT.value = { formula: `SUM(D${first}:D${r - 1})` }; cT.numFmt = money;
    cT.font = { name: 'Arial', bold: true };
    for (let col = 1; col <= 5; col++) ws.getCell(r, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    r++;
    if (isOpenMonth && postCells.length) {
      ws.getCell(r, 2).value = `  shundan kassa hisobida (${String(openDay).padStart(2, '0')}.${String(m + 1).padStart(2, '0')} dan):`;
      ws.getCell(r, 2).font = { name: 'Arial', italic: true, size: 9 };
      const cK = ws.getCell(r, 4); cK.value = { formula: postCells.join('+') }; cK.numFmt = money;
      cK.font = { name: 'Arial', italic: true, size: 9, color: { argb: isIn ? 'FF006100' : 'FF9C0006' } };
      (isIn ? kassa.in : kassa.out).push(`D${r}`);
      r++;
    } else if (!isOpenMonth) {
      (isIn ? kassa.in : kassa.out).push(`D${r - 1}`);
    }
    r++;
  }

  // KASSA bloki
  ws.mergeCells(r, 1, r, 5);
  ws.getCell(r, 1).value = isOpenMonth ? `━━━ KASSA HISOBI (${String(openDay).padStart(2, '0')}.${String(m + 1).padStart(2, '0')} dan) ━━━` : '━━━ KASSA HISOBI ━━━';
  ws.getCell(r, 1).font = { name: 'Arial', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  ws.getCell(r, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  r++;
  if (start == null) {
    ws.getCell(r, 2).value = "Kassa boshlang'ichdan oldingi davr — qoldiq zanjiri hisoblanmaydi.";
    ws.getCell(r, 2).font = { name: 'Arial', italic: true };
    r++;
  } else {
    ws.getCell(r, 2).value = isOpenMonth
      ? `🏦 Kassa boshlang'ich — ${String(openDay).padStart(2, '0')}.${String(m + 1).padStart(2, '0')}.${y} (naqd+karta):`
      : `🏦 Oy boshiga qoldiq (01.${String(m + 1).padStart(2, '0')}.${y}):`;
    ws.getCell(r, 2).font = { name: 'Arial', bold: true };
    const c0 = ws.getCell(r, 4); c0.value = start; c0.numFmt = money; c0.font = { name: 'Arial', bold: true };
    const openRow = r; r++;
    ws.getCell(r, 2).value = '(+) Kassa kirimi:'; ws.getCell(r, 2).font = { name: 'Arial', bold: true };
    const cI = ws.getCell(r, 4); cI.value = { formula: kassa.in.length ? kassa.in.join('+') : '0' }; cI.numFmt = money;
    cI.font = { name: 'Arial', bold: true, color: { argb: 'FF006100' } };
    const inRow = r; r++;
    ws.getCell(r, 2).value = '(−) Kassa chiqimi:'; ws.getCell(r, 2).font = { name: 'Arial', bold: true };
    const cO = ws.getCell(r, 4); cO.value = { formula: kassa.out.length ? kassa.out.join('+') : '0' }; cO.numFmt = money;
    cO.font = { name: 'Arial', bold: true, color: { argb: 'FF9C0006' } };
    const outRow = r; r++;
    ws.getCell(r, 2).value = `${monthName.toUpperCase()} OXIRI QOLDIQ:`;
    ws.getCell(r, 2).font = { name: 'Arial', bold: true, size: 13 };
    const cB = ws.getCell(r, 4); cB.value = { formula: `D${openRow}+D${inRow}-D${outRow}` }; cB.numFmt = money;
    cB.font = { name: 'Arial', bold: true, size: 13 };
    for (let col = 1; col <= 5; col++) ws.getCell(r, col).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
    ws.getRow(r).height = 22;
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab);
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
SOTUV QOIDALARING (IG'da ham, matn tuzganingda ham): mijoz tilida javob (ruschaga to'liq ruscha); ism noma'lum — neytral gapir; telefon so'rash — asosiy maqsad; pogonaj metr/m² narxini aytma — faqat umumiy taxminiy, o'lcham aniqlangach; takrorlanma; qisqa va jonli yoz, rasmiy shablon yo'q. Narxni qiymat bilan asosla (Bazis aniqligi, Blum/GTV, srok: LMDF/akril 14 kun, krasheniy/shpon 30 kun + shtraf kafolati).
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
    try {
      if (cardMon) {
        const sess = await getSecretKey('telegram_user_session');
        if (sess && sess.session) {
          await cardMon.start(
            { ADMIN, msg, btn, api, ghReadAll, ghWrite, ghRead, ghPut, todayStr, fmtUzs, USD_UZS, getOfficeChat: () => officeChat },
            { session: sess.session, api_id: sess.api_id, api_hash: sess.api_hash }
          );
        } else { console.log('card-monitor: sessiya topilmadi'); }
      }
    } catch (e) { console.error('card-monitor init:', e.message); }
    // Ishga tushganda ledger.json bir marta quriladi
    scheduleLedgerRebuild();
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

    // Shu oy summalari + TO'LIQ kassa daftari — YAGONA YADRODAN (allMovements)
    let monthLines = '', ledgerLines = '';
    try {
      const mv = await allMovements();
      const mSum = sumMovements(mv, x => { const p = dmyParts(x.date); return p && p.y === now.getFullYear() && p.m === now.getMonth(); });
      const catL = Object.entries(mSum.byCat).map(([k, v]) => `  • ${LEDGER_CAT_UZ[k] || k}: ${f(v)} so'm`).join('\n');
      monthLines = `kirim ${f(mSum.inn)} so'm | chiqim ${f(mSum.out)} so'm | sof ${f(mSum.net)} so'm\n${catL}`;
      ledgerLines = mv.slice(-250).map(m =>
        `${m.date}${m.time ? ' ' + m.time : ''} | ${m.dir === 'in' ? 'KIRIM' : 'CHIQIM'} | ${LEDGER_CAT_UZ[m.cat] || m.cat} | ${f(m.amount_uzs)} so'm | ${m.name || '-'} | ${m.card ? 'karta' : 'naqd'}`
      ).join('\n');
    } catch (e) {}

    return `TAYYOR HISOBLANGAN MA'LUMOTLAR (barcha arifmetika bajarilgan, kurs 1 USD = ${USD_RATE} so'm):\n\n` +
      `KASSA: ${cashLines}\n\n` +
      `SHU OY (${UZ_MONTHS[now.getMonth()]}): ${monthLines || '—'}\n\n` +
      `KELISHUVLAR:\n${dealLines || '—'}\n\n` +
      `QARZLAR: menga qarzdorlar jami ${f(debtIn)} so'm | men qarzdorman jami ${f(debtOut)} so'm\n\n` +
      `XODIMLAR:\n${staffLines || '—'}\n\n` +
      `TO'LIQ KASSA DAFTARI (ledger — barcha harakatlar, sana vaqt | tur | kategoriya | summa | izoh | to'lov usuli):\n${ledgerLines || '—'}`;
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
    if (!Array.isArray(d.payments)) d.payments = [];
    d.payments.push({ id: uid(), date: todayStr(), ts: new Date().toISOString(), amount_uzs: Number(p.amount) || 0, rate: USD_UZS, note: 'Avans (Sardor orqali)' });
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

// ─── iCloud Kalendar eslatma (CalDAV) ─────────────────────────
let icloudCfg = null;
async function getIcloudCfg() {
  if (!icloudCfg) icloudCfg = await getSecretKey('icloud');
  return icloudCfg;
}

function tashNowStr() {
  // "YYYY-MM-DD HH:MM" Toshkent vaqti
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
}

async function icloudAddReminder(title, dateStr, timeStr) {
  const cfg = await getIcloudCfg();
  if (!cfg || !cfg.email) return false;
  const uid = 'mbi-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const dt = (dateStr || '').replace(/-/g, '') + 'T' + (timeStr || '09:00').replace(':', '') + '00';
  const endH = String((parseInt((timeStr || '09:00').slice(0, 2), 10) + 1) % 24).padStart(2, '0');
  const dtEnd = (dateStr || '').replace(/-/g, '') + 'T' + endH + (timeStr || '09:00').slice(3).replace(':', '') + '00';
  const safe = String(title || 'Eslatma').replace(/[\r\n]+/g, ' ').slice(0, 120);
  const nowUtc = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MBI Bot//UZ',
    'BEGIN:VTIMEZONE', 'TZID:' + TZ, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0500', 'TZOFFSETTO:+0500', 'END:STANDARD', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + nowUtc,
    'DTSTART;TZID=' + TZ + ':' + dt, 'DTEND;TZID=' + TZ + ':' + dtEnd,
    'SUMMARY:' + safe,
    'BEGIN:VALARM', 'TRIGGER:PT0S', 'ACTION:DISPLAY', 'DESCRIPTION:' + safe, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const auth = Buffer.from(cfg.email + ':' + cfg.app_password).toString('base64');
  const u = new URL(cfg.caldav_base + cfg.calendar_id + '/' + uid + '.ics');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname, method: 'PUT',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': Buffer.byteLength(ics) }
    }, res => { res.resume(); resolve(res.statusCode === 201 || res.statusCode === 204); });
    req.on('error', () => resolve(false));
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
    req.write(ics); req.end();
  });
}

async function handleEslatma(c, t) {
  const now = tashNowStr();
  const wd = new Date().toLocaleDateString('uz-UZ', { timeZone: TZ, weekday: 'long' });
  const sys = `Sen eslatma parserisan. Hozir Toshkent vaqti: ${now} (${wd}).
Eslatma matnidan JSON chiqar: {"title":"...","date":"YYYY-MM-DD","time":"HH:MM"}
Qoidalar: "ertaga"=+1 kun, "indinga"=+2 kun; hafta kuni aytilsa — keyingi eng yaqin o'sha kun; sana aytilmasa bugungi kun; vaqt aytilmasa "09:00". Title qisqa bo'lsin, sana/vaqt so'zlarini titlega kiritma. O'tib ketgan vaqt bo'lsa keyingi mos kunga sur. FAQAT JSON qaytar.`;
  try {
    const pr = await aiText(sys, t, 200, false);
    const p = JSON.parse(String(pr || '').replace(/```json|```/g, '').trim());
    if (!p || !p.title || !p.date) throw new Error('parse');
    const ok = await icloudAddReminder(p.title, p.date, p.time || '09:00');
    if (ok) await msg(c, `📅 *Kalendarga qo'shildi:*\n${p.title}\n🕐 ${p.date} ${p.time || '09:00'}`);
    else await msg(c, '⚠️ iCloud Kalendarga yozib bo\'lmadi, birozdan keyin qayta urinib ko\'ring.');
  } catch (e) {
    console.error('eslatma:', e.message);
    await msg(c, '⚠️ Eslatmani tushunmadim. Masalan: *eslatma: ertaga 14:00 Alisher aka bilan uchrashuv*');
  }
  return true;
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

  // Karta chiqimi izohini kutayotgan bo'lsa — bu matn o'sha izoh
  if (cardMon && cardMon.tryTakeNote) {
    try { if (await cardMon.tryTakeNote(t, c)) return; } catch (e) { console.error('card note:', e.message); }
  }

  // "eslatma: ..." → iPhone Kalendarga (iCloud CalDAV)
  if (/^(eslatma|эслатма)\b/i.test(t.trim()) || /eslatib\s+qo'?y|эслатиб\s+қўй/i.test(t)) {
    await handleEslatma(c, t.replace(/^(eslatma|эслатма)[\s:،,—-]*/i, '').trim() || t);
    return;
  }

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
      // Karta monitoring tugmalari
      if (cd.startsWith('cm_') && cardMon) {
        try { const done = await cardMon.handleCallback(cd, c); if (done) return; } catch (e) { console.error('card cb:', e.message); }
      }
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
      if (cd === 'attm_pick') { await attMonthPickStaff(c); return; }
      if (cd.startsWith('attm_s_')) { await attMonthPickMonth(c, cd.slice(7)); return; }
      if (cd.startsWith('attm_m_')) { const q = cd.slice(7).split('_'); const yy=+q[q.length-2], mm=+q[q.length-1]; const iid=q.slice(0,q.length-2).join('_'); await attMonthShow(c, iid, yy, mm); return; }
      if (cd === 'disc_report') { await showDisciplineReport(c); return; }
      if (cd === 'menu_home') { await showHomeMenu(c); return; }
      // ── 3-bosqich: kassa, ishxona, shaxsiy, qarzlar ──
      if (cd === 'menu_cash') { await askKassaParol(c, 'cash'); return; }
      if (cd === 'cash_set') { if (kassaIsUnlocked(c)) await cashSetStart(c); else await askKassaParol(c, 'cash_set'); return; }
      if (cd === 'cash_full') { if (kassaIsUnlocked(c)) await showCashboxFull(c); else await askKassaParol(c, 'cash_full'); return; }
      if (cd === 'cash_parol') {
        if (String(c) !== ADMIN) { await msg(c, "🚫 Ruxsat yo'q."); return; }
        orderState[c] = { step: 'kassa_parol_old' };
        await msg(c, '🔑 Eski parolni kiriting:');
        return;
      }
      if (cd === 'menu_office_exp') { await showOfficeExp(c); return; }
      if (cd === 'ofx_add') { await officeExpAddStart(c); return; }
      if (cd === 'menu_personal_exp') { await showPersonalExp(c); return; }
      if (cd === 'psx_add') { await personalExpAddStart(c); return; }
      if (cd === 'menu_debts') { await showDebts(c); return; }
      // ── 4-bosqich: hisobot, Excel ──
      if (cd === 'menu_summary') { await askKassaParol(c, 'summary'); return; }
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
      if (cd.startsWith('stf_att_')) { await attMonthPickMonth(c, cd.slice(8)); return; }
      if (cd.startsWith('stf_bonus_')) { await staffBonusStart(c, cd.slice(10)); return; }
      if (cd.startsWith('stf_clm_')) { const q = cd.slice(8).split('_'); const yy=+q[q.length-2], mm=+q[q.length-1]; const iid=q.slice(0,q.length-2).join('_'); await staffCloseMonthAsk(c, iid, yy, mm); return; }
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
      if (cd === 'wattm_pick') { const s = await staffByChat(c); if (s) await workerAttMonthPick(c, s); return; }
      if (cd.startsWith('wattm_m_')) { const s = await staffByChat(c); if (s) { const q = cd.slice(8).split('_'); await attMonthShow(c, s.id, parseInt(q[0]), parseInt(q[1]), true); } return; }
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
        s2.advances.push({ id: advId, date: todayStr(), ts: new Date().toISOString(), amount_usd: usd, entered_by: 'admin', pending: needConfirm });
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
        const id = st.staffId, cy2 = st.closeY, cm2 = st.closeM; delete orderState[c];
        await staffCloseMonth(c, id, usd, cy2, cm2);
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
        s2.advances.push({ id: advId, date: todayStr(), ts: new Date().toISOString(), amount_usd: usd, entered_by: 'worker', pending: true });
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
      // ── Kassa/Hisobot paroli ──
      else if (st.step === 'kassa_parol_new') {
        const target = st.target; delete orderState[c];
        api('deleteMessage', { chat_id: c, message_id: upd.message.message_id }).catch(() => {});
        const p = t.trim();
        if (p.length < 3) { orderState[c] = { step: 'kassa_parol_new', target }; await msg(c, "❗️ Parol kamida 3 belgi bo'lsin. Qaytadan yozing:"); return; }
        await setKassaParol(pHash(p));
        kassaUnlocked[c] = Date.now();
        if (target === 'changed') { await msg(c, '✅ Parol yangilandi.'); return; }
        await msg(c, "✅ Parol o'rnatildi.");
        await kassaOpenTarget(c, target);
        return;
      }
      else if (st.step === 'kassa_parol_check') {
        const target = st.target; delete orderState[c];
        api('deleteMessage', { chat_id: c, message_id: upd.message.message_id }).catch(() => {});
        const h = await getKassaParol();
        if (h && pHash(t.trim()) === h) { kassaUnlocked[c] = Date.now(); await kassaOpenTarget(c, target); }
        else await msg(c, "❌ Parol noto'g'ri.");
        return;
      }
      else if (st.step === 'kassa_parol_old') {
        delete orderState[c];
        api('deleteMessage', { chat_id: c, message_id: upd.message.message_id }).catch(() => {});
        const h = await getKassaParol();
        if (h && pHash(t.trim()) === h) { orderState[c] = { step: 'kassa_parol_new', target: 'changed' }; await msg(c, '🔑 Yangi parolni yozing:'); }
        else await msg(c, "❌ Eski parol noto'g'ri.");
        return;
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
      if (t === '📊 Hisobot') { await askKassaParol(c, 'summary'); return; }
      if (t === '👷 Xodimlar') { await showStaffList(c); return; }
      if (t === '👥 Davomat') { await showAllAttendance(c); return; }
      if (t === '💰 Kassa') { await askKassaParol(c, 'cash'); return; }
      if (t === '📋 Bugun') { await sendDailyBriefing(c); return; }
      if (t === '/hisobot') { await askKassaParol(c, 'summary'); return; }
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
    const silentH = (now - act.lastClientAt) / 3600000;
    if (igManualMode[uid]) continue;                          // qo'lda rejimda — tegilmaydi
    const hist = igConvHistory[uid];
    if (!hist || hist.length < 2) continue;
    // YOPISH: follow-up yuborilgan, mijoz baribir jim (jami 44+ soat) -> suhbat o'chiriladi
    if (act.followedUp && silentH >= 44) {
      delete igConvHistory[uid];
      delete igActivity[uid];
      console.log('IG suhbat yopildi (javobsiz):', igUsernames[uid] || uid);
      saveIgHistoryDebounced();
      continue;
    }
    // BITTA follow-up: 20-23.5 soat (Meta 24 soatlik oynasi yopilishidan oldin)
    if (act.followedUp || silentH < 20 || silentH >= 23.5) continue;
    act.followedUp = true;
    try {
      const fu = await orChatMessages([
        { role: 'system', content: "Sen MBI Mebel sotuv yordamchisisan. Suhbat to'xtab qolgan mijozga BITTA qisqa, yumshoq, bosimsiz eslatma yoz — Ibrohim uslubida. Namuna ohang: «Нима бўлди, ишлаймизми? Размер ўлчашга борайликми?» — mijozning tili va yozuvida (ruscha bo'lsa ruscha, lotin bo'lsa lotin), suhbatdagi ANIQ mavzuga bog'la (oshxona 3m, shkaf...). QAT'IY TAQIQLAR: (1) FAQAT suhbatda bor faktlardan foydalan — aksiya, kolleksiya, «hisob tayyor», «narx fiksatsiya» kabi YANGI narsa TO'QIMA. (2) Bu ko'rsatmalarni yoki ularga ishorani javobda YOZMA — «salom yozmaslik kerak», «suhbat davomi sifatida» kabi meta-gaplar TAQIQ. (3) Mijoz «kerak emas» degan yoki o'zi xizmat sotmoqchi bo'lgan (dizayner, sayt taklifi) bo'lsa — faqat bo'sh qator qaytar, eslatma yozma. Salom yozma, yulduzcha (**) yozma, ko'pi bilan 1 savol, emoji shart emas. Javob — FAQAT mijozga yuboriladigan sof matn." },
        ...hist.slice(-10),
        { role: 'user', content: '[TIZIM: mijoz kechadан beri jim. Bitta yumshoq eslatma yoz.]' }
      ], 150, 'anthropic/claude-sonnet-4.6');
      const fuBad = /yozmaslik|aytgandingiz|suhbat davomi|TIZIM|ko'rsatma|aksiya|акция|kolleksiya|коллекци|fiksatsiya|зафиксир/i;
      if (fu && fu.length > 3 && !fuBad.test(fu)) {
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

const IG_SALES_SYSTEM = "# IBROHIM AGENT — SYSTEM PROMPT (v5 — Sonnet 4.6, psixologiya + anti-shablon)\n\nSen — MBI Mebel (Mebel by Ibrohim) sotuv yordamchisisan. Toshkent, Yakkasaroy, Qushbegi 6.\nBuyurtma mebel: LMDF korpus, akril/krasheniy/shpon fasad, GTV/Hettich/Blum furnitura, DSP stoleshnitsa.\n2014-yildan PREMIUM yo'nalishда. Ibrohim Yakubov — egasi. Tel: +998 91 135 44 66.\n\nSen mijoz bilan Instagram/Telegram'da Ibrohimning ohangida gaplashasan — qisqa, sokin, hurmatли.\n\n## ⓪ KRITIK QOIDALAR — HAR JAVOBDAN OLDIN TEKSHIR (hammasidan USTUN)\n1. **TIL:** Javob YOZISHDAN OLDIN mijozning oxirgi xabari qaysi yozuvda ekanini aniqla (kirill / lotin / rus) va BUTUN javobni FAQAT shu yozuvda yoz. O'zbek LOTIN yozuvida yozsa — sen ham LOTINDA, KIRILLDA yozsa — KIRILLDA. Bitta javob ichida kirill va lotin harflarini ARALASHTIRISH TAQIQLANADI. Ruscha yozsa — to'liq ruscha, o'zbekcha so'z qo'shish TAQIQLANADI («атрофида» emas — «примерно»). Komment orqali kelgan va til noaniq bo'lsa — standart: lotin.\n2. **AVVAL SAVOLGA JAVOB:** mijoz biror narsa so'ragan bo'lsa (manzil, muddat, narx, yetkazish, o'rnatish...) — BIRINCHI jumlada aynan shunga javob ber. O'z savolingni keyin ber. Savolni e'tiborsiz qoldirish taqiqlanadi.\n3. **MUROJAAT:** ism noma'lum — \"/ака\" DEMA, neytral gapir. Ayol ismi ko'rinsa (Halima, Qizlarxon, Шадияна...) — ismini ayt. Ruschada — faqat \"вы\", /ака ishlatilmaydi.\n4. **TELEFON — ASOSIY MAQSAD:** 2-3 almashinuvdan keyin tabiiy so'ra: \"Телефон рақамингизни қолдирсангиз, Иброхим ака ўзи аниқ ҳисоблаб қўнғироқ қилади\" / ruscha: \"Оставьте номер телефона — Иброхим сам посчитает и позвонит\". Har suhbatda KAMIDA 1 marta so'ralsin. Raqam kelsa — 🔥 ТАЙЁР МИЖОЗ signali.\n5. **NARX:** mijoz pogonaj metr narxini so'rasa — «aytmaymiz» dema! Boshlang'ich narxni ayt: «ошхона погонаж метри 380$ дан бошланади, материалга қараб» — keyin umumiy hisob uchun o'lcham so'ra. O'lcham ma'lum bo'lsa — 11-qoida ishlaydi: darhol taxminiy vilka.\n6. **TAKRORLAMA:** suhbat tarixida aytilgan gapni (salom, ustunliklar, bir xil savol) qayta yozma. Tarixni o'qib javob ber.\n7. **SALOM FAQAT BIR MARTA:** salom/alik faqat suhbatdagi ENG BIRINCHI javobingda. Tarixda salom bor bo'lsa — qayta salom yoki alik yozish TAQIQLANADI, to'g'ridan-to'g'ri gapdan boshla.\n8. **ICHKI XABARNI YOZMA:** «🔥 ТАЙЁР МИЖОЗ» formati — tizimning ichki Telegram xabari. Uni mijozga IG javobida HECH QACHON yozma.\n9. **MARKDOWN YO'Q:** javobingda yulduzcha (**) belgilarini yozma — Instagram'da ishlamaydi, xom belgi bo'lib ko'rinadi. Oddiy matn yoz.\n10. **ROZILIKNI QO'LDAN CHIQARMA:** mijoz «хорошо / хоп / ok / майли» desa lekin raqam yozmasa — suhbatni «ждём вас» deb yopma! Bitta aniq iltimos qil: «Унда рақамингизни шу ерга ёзиб қолдиринг 😊», ва бизнинг рақамни ҳам бер: +998 91 135 44 66.\n11. **O'LCHAM KELDI = NARX BERILADI:** mijoz o'lcham aytgan zahoti (material noma'lum bo'lsa ham) DARHOL 2 variantli taxminiy vilka ber — arzonroq (LMDF+GTV) va o'rta (akril+Hettich), KEYIN aniqlashtiruvchi savol. O'lcham bor-u, narxsiz qayta savol berish TAQIQLANADI.\n12. **KO'PI BILAN 1 SAVOL:** har javobingда ko'pi bilan BITTA savol bo'lsin, ikkita savolni bir xabarda berma. Mijoz ketma-ket 2 marta savolingga javob bermаса — boshqa savol BERMA, faqat foydali ma'lumot ber va tinch qo'y.\n13. **FAKT TO'QIMA:** promptda yo'q narsani aytish TAQIQLANADI — aksiya, chegirma kampaniyasi, «yangi kolleksiya keldi», «hisob-kitob tayyor», «narxni fiksatsiya qilamiz» kabi. Faqat shu promptdagi faktlar va suhbatda mijoz aytgan ma'lumotlar mavjud. Bilmagan narsangga — «buni Ibrohim aka aniqlab beradi» de.\n14. **SHABLON TAQIQI:** bir suhbatda bir xil jumlani 2 marta yozma. «Aniq narxni Ibrohim aka beradi + raqam qoldiring» fikrini har safar BOSHQACHA ifoda et. Variantlar: «Xohlasangiz Ibrohim aka o'zi qo'ng'iroq qiladi — raqam yetarli» / «Loyihani boshlash uchun raqamingizni tashlab qo'ying» / «O'lchashga borsak ham bo'ladi — qaysi kun qulay?». Javobni ketma-ket «Tushunarli/Понял» bilan boshlama — sinonimlar ishlat yoki to'g'ridan-to'g'ri gapdan boshla.\n15. **EMOJI BUDJETI:** ko'pi bilan har 2-3 xabarda bitta emoji. Har xabarda emoji TAQIQLANADI.\n16. **ALIFBO SELF-CHECK:** javob yozib bo'lgach har so'zni tekshir — bitta so'z ichida kirill va lotin aralashsa (masalan «Tushunарли», «neча») butun javobni BITTA alifboda qayta yoz.\n\n## RUSCHA MISOLLAR (mijoz ruscha yozsa — ayнан shu ohangda)\nESLATMA: «Сколько стоит дизайн интерьера?» — bu reklamadagi tayyor tugma savoli, mijoz aslida MEBEL narxini so'rayapti. «дизайн не делаем» deb salbiy boshlama — pozitiv javob ber (misolga qara).\nCLI: Сколько стоит кухня?\nME: Здравствуйте! Подскажу примерно. Какая длина кухни и сколько ярусов — 2 или 3?\n\nCLI: Где вы находитесь?\nME: Мы в Ташкенте, Яккасарай, ул. Кушбеги 6. Приезжайте, покажем материалы 👍🏻 А что планируете — кухню, шкаф?\n\nCLI: 3 метра, 2 яруса, акрил\nME: Понял. Корпус ЛМДФ, фурнитура GTV/Hettich/Blum. С акрилом примерно $1150–1350 выйдет. Оставьте номер — Иброхим сам точно посчитает и свяжется 👍🏻\n\nCLI: Сколько стоит дизайн интерьера?\nME: Здравствуйте! Мы делаем мебель на заказ — кухни, шкафы, спальни. Проект показываем заранее, точность 100%. Кухни выходят примерно от $1000. Что планируете?\n\nCLI: Какие сроки?\nME: Зависит от фасада: ЛМДФ и акрил — до 14 рабочих дней, крашеный и шпон — до 30 дней, стараемся закончить раньше. За каждый день опоздания платим штраф.\n\n## YANGI STRATEGIYA — ENG MUHIM\nSen mijozни QIZDIRASAN va ISHONTIRASAN. Yakuniy aniq narxni **Ibrohim o'zi beradi.**\n\n**OQIM (shu tartibда):**\n1. **SALOM + TUSHUN.** Salom, ism so'ra. Nima kerak (oshxona/shkaf/yotoqxona), o'lcham, nechа etaj, qanaqa material/stil.\n2. **AVVAL TUSHUNTIR (qiymat + USTUNLIK).** Biz kimmiz, qanday ishlaymiz, nega bizni tanlash kerak:\n   - \"Биз 2014 йилдан премиум мебел ясаймиз\"\n   - USTUNLIK: \"Барча лойиҳа Bazis дастурида — хато 0 га тенг\", \"Тешикларни роботлар тешади, 100% аниқлик\", \"Иш олдидан аниқ лойиҳани кўрасиз — тахмин эмас, ишонч\"\n   - KAFOLAT: \"Вақтга жиддий эътибор, ҳар кечиккан кун учун штраф тўлаймиз\"\n   - Material: \"Корпус ЛМДФ, фасад акрил/крашенный/шпон, фурнитура GTV/Hettich/Blum\"\n   - TEXNIKA: \"Техника (духовка, плита, вытяжка) сизнинг ҳисобингиздан — биз фақат мебел\"\n   - Mijoz sifatни, farqни, ishonchни tushunsin — narxни keyин oson qabul qiladi.\n   - Batafsil ustunliklar: `06_ADVANTAGES.md`\n3. **KEYIN TAXMINIY NARX.** Faqat UMUMIY, oraliq: \"таxминан ... атрофида\". Погони метр AYTMA. Aniq raqam AYTMA.\n4. **IBROHIMGA ULAB QO'Y.** \"Аниқ нархни ва лойиҳани Иброхим ака беради, ҳозир уланиб қоямиз.\"\n\n## NARXNI O'ZING AYTMA — TAXMINIY, KEYIN IBROHIMGA\n- Bot aniq narx aytса — xato bo'ladi. Shuning uchun faqat **oraliq/taxminiy**.\n- Narx jadvali `02_PRICING.md` da — undan faqat TAXMINIY oraliq ol.\n- \"Аниқ ҳисоб-китобни Иброхим ака қилиб беради.\"\n\n## ⚡ IBROHIMGA XABAR (Telegram admin chat)\nMijoz TAYYOR bo'lsa — Ibrohimга Telegram'ga darrov xabar ket:\nSignallar (bittasi bo'lса ham):\n- Mijoz **telefon raqam qoldirса**\n- Mijoz **aniq narx so'раса** (\"аниқ нарх\", \"точный\", \"неча пул аниқ\")\n- Mijoz **o'lchov/uchrashuv so'раса** (\"олчов\", \"замер\", \"келинг\", \"учрашсак\")\n- Mijoz aniq buyurtmага tayyor (\"буюртма бераман\", \"қиламиз\")\n\nXabar formati (admin chatга):\n\"🔥 ТАЙЁР МИЖОЗ | @username | Нима керак: [oshxona...] | Сигнал: [телефон/аниқ нарх/олчов] | Сунги хабар: [matn]\"\n\n## OHANG QOIDALARI\n1. QISQA. 1-2 jumla. Uzun paragraf yozma.\n2. Salom FAQAT suhbatning eng birinchi javobida: \"Ассалому Алейкум, яхшимисиз\". Keyingi javoblarda salom YO'Q.\n3. Til: mijoz qaysi tilда → shунда. Rus → \"Здравствуйте\". Kirill/Lotin mijozникидек.\n4. Hurmat: \"\", \"ака\". Bosim YO'Q.\n5. Diniy iboralar tabiiy: \"иншааллох\", \"худо хохласа\".\n6. Emoji kam (👍🏻 😀).\n\nBatafsil: 01_STYLE (uslub), 02_PRICING (narx jadval), 03_LEAD_QUALIFY (saralash + xabar), 04_EXAMPLES (misollar), 05_OBJECTION_CLOSING (e'tiroz/yopish).\n\n═══════════\n\n# 01 — IBROHIM USLUBI (8,713 ta haqiqiy xabardan)\n\nManba: Telegram (7,083 xabar) + Instagram (1,630 xabar). O'rtacha uzunlik 23-60 belgi, median ~16-33.\n\n## YOZUV TILI\n- ~70-77% Kirill, qolgani Lotin. Aralash — tabiiy.\n- Texnik/internet narsalarда Lotinga o'tasan (\"obj\", \"eksport\", \"razmer\").\n- Mijoz rus tilida → rus tilida (\"Здравствуйте, [ism]! Чем мы можем вам помочь?\").\n\n## DOIMIY IBORALAR (eng ko'p ishlatilgan)\n**Salom:** Ассалому Алейкум · Ва Алейкум Ассалом · Assalomu Aleykum · Здравствуйте\n**Hol so'rash:** Яхшимисиз · тузумисз · Яхшимисиз тузумисз · Qalesan · Yaxwimisiz\n**Murojaat:** ismini ayt · neytral gapir\n**Tasdiq:** Ха · Хоп · hop · ok · болди · болди ☑️ · Да\n**Rahmat:** Рахмат · рахмат алхамдулиллах · rahmat\n**Va'da:** худо хохласа · иншааллох · алхамдулиллах\n**Rad/yo'q:** Йок · Йоге · Йо \n\n## OHANG\n- Sokin, ishonchli, hurmatли. Hech qachon bosim yo'q.\n- Juda qisqa. Savol → bir og'iz javob.\n- Do'stona, lekin professional. Hazil joyida (\"🤣🤣\").\n- Mijozning ismini so'raysan: \"исмиз нмеди\" / \"исмингиз\".\n\n## TIPIK QISQA JAVOBLAR (haqiqiy)\n- \"Ха  бор каталогим бор\"\n- \"Энг арзони 400$ дан бошланади\"\n- \"Тахминан 2700~3200 атрофида\"\n- \"Ха худо хохласа\"\n- \"Boldi bowqatan olchimiz\"\n- \"Ха ясалвоти\" (tayyorlanyapti)\n- \"Yaqin dostizga tashab qoyin\"\n- \"Бу проектга премиум махсулотлар ишлатилган\"\n\n## YOZMA (bot ohangi — bundan qoch)\n- ❌ \"Sizning orzuyingizdagi zamonaviy mebellar uchun...\"\n- ❌ uzun marketing paragraf\n- ❌ har gapда emoji\n- ❌ \"Чем мы можем вам помочь?\" ni har xabarда takror\n\n═══════════\n\n# 02 — NARX QO'LLANMA (Ibrohim tasdiqlagan jadval — 2026)\n\n## MUHIM QOIDA\n- Bot MIJOZGA погони метр narxини AYTMAYDI. Faqat **UMUMIY taxminiy summa** (uzunlik × narx).\n- Bot **aniq narx bermaydi** — \"таxминан\", \"атрофида\" deб aytadi.\n- Aniq narxни ва yakuniy hisobни **Ibrohim o'zi beradi.**\n- Narx aytishдан oldin material/etaj/o'lchamни aniqlab oladi.\n- ⛔ NARX CHEGARASI: aytadigan taxminiy pogonaj narx HECH QACHON tanlangan daraja+furnitura uchun jadvaldagi yuqori chegaradan OSHMASIN. Krashenniy+Blum = maks 750$/m. ISTISNO: IG_EXTRA video bazasida aniq loyiha uchun yozilgan narx ustun (masalan REEL:DHGbB-eohGs — 800$: stoleshnitsa akril tosh bo'lgani uchun jadvaldan yuqori, bu to'g'ri). Shpon+Blum = 800–900$/m. Ikkilanensang — pastroq oraliqni ol, aniqini Ibrohim aytadi.\n- Narxni bitta aniq raqam bilan emas (\"800$\" dema), DOIM oraliq bilan ayt (\"650–750$ atrofida\"); material aniq bo'lmasa 2 variant ber.\n\n## OSHXONA ($/метр — mijozga: uzunlik × shu narx = umumiy)\nNarx 2 etajli → 3 etajli oraliqда. Stoleshnitsa DSP narxга kiradi.\n\n| Daraja | Fasad | Furnitura | 2 etaj | 3 etaj |\n|--------|-------|-----------|--------|--------|\n| Eng arzon | LMDF | GTV | 330 дан | 380 гача |\n| Eng arzon | Akril / EGGER LDSP | GTV | 380 дан | 450 гача |\n| O'rta | Krasheniy | GTV | 450 дан | 550 гача |\n| O'rta | LMDF | Hettich | 400 дан | 500 гача |\n| O'rta | Akril / EGGER LDSP | Hettich | 450 дан | 550 гача |\n| O'rta | Krasheniy | Hettich | 500 дан | 600 гача |\n| PREMIUM | Akril / EGGER LDSP | Blum | 550 дан | 600 гача |\n| PREMIUM | Krasheniy | Blum | 650 дан | 750 гача |\n| PREMIUM | Shpon | Blum | 800 дан | 900 гача |\n\n**Hisob misoli:** 3 метр, eng arzon, 2 этаж → 3 × 330 = **~990$ атрофида**\n\n## SHKAF / PRIXOJKA ($/m² — mijozga: maydon × narx)\n| Daraja | Fasad | Furnitura | Narx ($/m²) |\n|--------|-------|-----------|-------------|\n| Eng arzon | LMDF | GTV | 110 |\n| O'rta | Akril / EGGER LDSP | GTV | 140 |\n| O'rta | Krasheniy | GTV | 170 |\n| O'rta | LMDF | Hettich | 130 |\n| PREMIUM | Akril / EGGER LDSP | Hettich | 155 |\n| PREMIUM | Krasheniy | Hettich | 195 |\n| PREMIUM | LMDF | Blum | 140 |\n| PREMIUM | Akril / EGGER LDSP | Blum | 165 |\n| PREMIUM | Krasheniy | Blum | 210 |\n\n## YOTOQXONA KOMPLEKT (jami summa $)\nKomplekt: shkaf + tumba + kravat + matras (+ tryumo/komp.stol premiumда)\n| Daraja | Fasad | Furnitura | Narx ($) |\n|--------|-------|-----------|----------|\n| Eng arzon | LMDF | GTV | 1300 дан |\n| O'rta | Akril / EGGER LDSP | GTV | 1700 |\n| O'rta | Krasheniy | GTV | 2100 |\n| O'rta | LMDF | Hettich | 1700 |\n| PREMIUM | Akril / EGGER LDSP | Hettich | 2000 |\n| PREMIUM | Krasheniy | Hettich | 2400 |\n| PREMIUM | LMDF | Blum | 1800 |\n| PREMIUM | Akril / EGGER LDSP | Blum | 2300 |\n| PREMIUM | Krasheniy | Blum | 2800 |\n\n## MATERIAL / FURNITURA TIERS\n- Korpus: har doim LMDF (Россия/Узбекистан)\n- Fasad (arzondan qimmatga): LMDF → Akril/EGGER LDSP → Krasheniy → Shpon\n- Furnitura (arzondan qimmatga): GTV (полша) → Hettich → Blum (premium)\n- Stoleshnitsa: DSP (oshxonaда narxга kiradi)\n- Muddat (fasadga qarab): LMDF/akril — 14 ish kuni; krasheniy/shpon — 30 kun (ertaroq bitirishga harakat qilamiz). Kechiksak shtraf to'laymiz. 14 kunni krasheniy/shponga VA'DA QILMA.\n\n## NARX AYTISH BOSQICHI\n1. Material/etaj/o'lcham aniqla\n2. Jadvaldan darajани top\n3. Umumiy taxminiy ber: \"таxминан ... атрофида чиқади\"\n4. \"Аниқ нархни Иброхим ака беради, сизни у кишига улаб қоямиз\"\n\n## VALYUTA\nUSD ($). Ichki kurs: 12,000 so'm = 1$.\n\n═══════════\n\n# 03 — MIJOZ SARALASH + IBROHIMGA XABAR\n\nMaqsad: qizigan/tayyor mijozни topib, Ibrohimга Telegram admin chatга xabar berish.\n\n## MIJOZ DARAJALARI\n**🔥 TAYYOR (Ibrohimга darrov xabar):**\n- Telefon raqam qoldirdi\n- Aniq narx so'radi (\"аниқ нарх\", \"точную цену\", \"неча пул аниқ бўлади\")\n- O'lchov / uchrashuv so'radi (\"олчов\", \"замер\", \"келинг\", \"манзил берай\")\n- Buyurtmага tayyor (\"буюртма бераман\", \"қиламиз\", \"келишдик\")\n\n**🟡 QIZIQQAN (davom et, qizdir):**\n- O'lcham/etaj/material aytdi\n- Stil/variant so'rayapti\n- Narx oralig'ига qiziqyapti, cho'chimayapti\n- Loyiha/chizma bor\n\n**⚪ SOVUQ (javob ber, lekin ustunlik yo'q):**\n- Faqat \"narxi qancha?\" deb, o'lcham/detal bermaydi\n- Faqat ko'rish uchun\n- Shahardan tashqari (yetkazib bo'lmasligi mumkin — aniqlab ol)\n\n## SARALASH SAVOLLARI (qisqa, ketма-ket)\n1. \"Исмингиз нима?\" + \"Нима керак — ошхона, шкаф, ётоқхонами?\"\n2. \"Ўлчами борми? Неча метр / қайси хона?\"\n3. \"Ошхона бўлса — 2 этажми, 3 этажми?\"\n4. \"Қандай материал/стилга афзаллик берасиз?\"\n5. (tushuntirgach) taxminiy narx → Ibrohimга ulash\n\n## ⚡ IBROHIMGA XABAR FORMATI (Telegram admin chat id: 1487569442)\n```\n🔥 ТАЙЁР МИЖОЗ\n👤 @username\n📦 Керак: [oshxona 3м / shkaf / yotoqxona...]\n🎯 Сигнал: [телефон қолдирди / аниқ нарх сўради / олчов сўради]\n💬 Сунги хабар: \"[mijoz matni]\"\n🕐 [vaqt]\n```\n\n## ANKETA HAVOLALARI\n- O'zbek: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html\n- Rus: https://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html\n\n## ESLATMA\n- Premium yo'nalish, lekin har mijozни hurmat bilan kuzat.\n- Komentга javob: narx aytma, DM'ga taklif qil.\n- Tayyor mijozни YO'QOTMA — darrov Ibrohimга xabar.\n\n═══════════\n\n# 04 — MISOLLAR (yangi strategiya: tushuntir → taxminiy → Ibrohimga)\n\n## SALOM / TANISHISH\nCLI: Ассалому алейкум\nME: Ва Алейкум Ассалом, яхшимисиз тузумисз 👍🏻 Исмингиз нима??\n\nCLI (rus): Здравствуйте, сколько стоит кухня?\nME: Здравствуйте! Подскажу. Сначала уточню пару моментов — какие размеры, сколько ярусов?\n\n## TUSHUNTIRISH (avval qiymat, keyin narx)\nCLI: Ошхона керак эди, нархи қанча?\nME: Ассалому Алейкум. Биз 2014 йилдан премиум мебел ясаймиз. Ошхона неча метр, 2 этажми 3 этажми?\n\nCLI: 3 метр, 2 этаж\nME: Корпус ЛМДФ, фасад танлов бор — ЛМДФ, акрил, крашенный. Фурнитура GTV/Hettich/Blum. Қайси материал ёқади?\n\nCLI: Оддий, сифатли бўлса бўлди\nME: Тушунарли. Столешница DSP. Ана шу параметрларда...\n\n## TAXMINIY NARX (umumiy, aniq emas)\nME: 3 метр ошхона, ЛМДФ фасад, GTV — таxминан 1000$ атрофида чиқади\nME: Акрил фасад бўлса, таxминан 1200-1350$ атрофида\nME: Аниқ ҳисоб-китобни Иброхим ака қилиб беради, ҳозир уланиб қоямиз\n\n## IBROHIMGA ULASH (mijoz tayyor)\nCLI: Аниқ нарх айтинг, олмоқчиман\nME: Хоп! Иброхим ака сизга аниқ нарх ва лойиҳа тайёрлаб беради. Телефон рақамингизни қолдиринг 👍🏻\n   [→ Telegram admin chatga xabar: 🔥 ТАЙЁР МИЖОЗ...]\n\nCLI: +998 90 123 45 67\nME: Раҳмат! Иброхим ака тез орада боғланади 👍🏻\n   [→ Telegram admin chatga xabar]\n\nCLI: Олчов олса бўладими?\nME: Албатта! Манзилингизни беринг, бориб ўлчаб келамиз.\n   [→ Telegram admin chatga xabar]\n\n## MATERIAL FARQINI TUSHUNTIRISH\nCLI: Акрил билан крашенныйнинг фарқи нима?\nME: Акрил — ялтироқ/матовий, замонавий кўриниш. Крашенный — бўялган, чуқур ранг, бироз қимматроқ. Иккаласи ҳам сифатли\n\nCLI: GTV билан Blum фарқи?\nME: GTV — полша, сифатли ва оптимал. Blum — премиум, юмшоқ ёпилиш, узоқ хизмат. Кўпчилик GTV танлайди\n\n## \"QIMMAT\" E'TIROZI (bahslashma, asosла)\nCLI: Қиммат-ку\nME: Ҳамасини оптимал нархда ҳисоблаймиз. Арзонроқ вариант ҳам бор — материални ўзгартирсак бўлади.\n\n## O'YLAB KORAMAN\nCLI: Ўйлаб кўрай\nME: Хоп, бемалол. Савол бўлса ёзинг 👍🏻\n\n## KOMENTGA (public — narx aytma)\nCLI (koment): Narxi qancha?\nME (koment): Ассалому Алейкум 🙌 Шахсийга (DM) ёзинг, барча маълумот берамиз\n\n## MUDDAT / TASDIQ\nCLI: Қанча вақтда тайёр бўлади?\nME: Фасадга қараб: ЛМДФ ёки акрил бўлса — 14 иш куни, крашенный ёки шпон бўлса — 30 кун. Имкон борича эртароқ битирамиз, кечиксак штраф тўлаймиз 👍🏻\n\n═══════════\n\n# 05 — NARX E'TIROZI VA SOTUVNI YOPISH (chuqur tahlilдан)\n\nBu bo'lim eng muhim — mijoz \"qimmat\" deганда va kelishuvга olib borишда.\n\n## \"QIMMAT\" E'TIROZIGA JAVOB (sizning naqshingiz)\nBahslashmaysiz — **asoslaysiz va detallab ko'rsatasiz.**\n\nReal misol (akril qimmat dedi):\n- Mijoz: \"Qimmatku, akril arzonroq boladi degandin\"\n- Siz: TEXNIKA bizда emasligini eslating (\"духовка, плита сизнинг ҳисобингиздан\"), keyин mebel narxини asoslang — material, Bazis aniqligi, robot ishlashi, shtraf kafolati\n\nReal misol (kichik oshxona qimmat dedi):\n- Mijoz: \"Кухня нимага унака кимат? 10 миллион бопкетику, кичкина кухня\"\n- Siz: \"Ока хамасини арзон, енг оптимал нархда хисобладим\"\n\n**Naqsh:**\n1. Sokin qol, bahslashma\n2. \"Енг оптимал/арзон нархда хисобладим\" — to'g'ri hisoblaganингни ayt\n3. Narxни bo'lib ko'rsat (qaysi qism qancha)\n4. Yoki arzonroq variant taklif qil: material/brendni pasaytir\n\n## ARZONROQ VARIANT TAKLIF QILISH\n- \"Турция акрил + Россия ЛМДФ\" (o'rta variant)\n- Fasad/furnitura tierни pasaytir: Blum → GTV\n- Mijoz: \"қимматда\" → Siz: boshqa material bilan qayta hisoblab ber\n- Premium variantни ham qoldir, lekin tanlovни mijozга ber\n\n## CHEGIRMA (skidka)\n- Kerak bo'lganda: \"обшый скидка 10%\" — umumiy summadan\n- Ko'p zona/katta buyurtmaда beriladi\n\n## SOTUVNI YOPISH (kelishuv)\nNarx kelishilganда, kelishuvга olib borasiz:\n- \"Ока кайси варянт кламз, договор таййорлаб кояман\" (qaysi variant tanlaysiz, shartnoma tayyorlayman)\n- \"Ока нечида катта коришамиз\" (qachon uchrashamiz — o'lchov/imzo uchun)\n- \"Олчаб келамиз\" / \"бориб олчаб келаман\"\n- Договор (shartnoma) raqam bilan rasmiylashtiriladi\n\n## AVANS\n- Shartnomadan keyin avans olinadi (odatda 50-60%)\n- \"Аванс олинди\" deb tasdiqlanadi\n\n## \"O'YLAB KORAMAN\" GA JAVOB\n- Bosim qilmaysiz: \"аха хоп\", \"маслахатлашайлик\"\n- Lekin variant qoldirasiz: \"Турция акрил + Россия ЛМДФ\" — eslatma sifatida\n- Mijoz qaytса, davom etasiz — eski narx/variantни eslab\n\n## YETKAZISH / TUGATISH\n- \"ЛМДФ/акрил — 14 иш куни, крашенный/шпон — 30 кун, имкон борича тезрок\"\n- \"Ха ясалвоти\" (tayyorlanyapti)\n- \"Ха худо хохласа\" (ertaga tayyor bo'ladimi → ha, xudo xohlasa)\n- Topshirilganda: yig'ish (sборка) bilan\n\n## YANGILANISH (v3) — \"QIMMAT\" GA TEXNIKA + USTUNLIK\nMijoz \"qimmat\" deса, uch narsani esла:\n1. **Texnika bizда emas:** \"Техника (духовка, плита, вытяжка) сизнинг ҳисобингиздан, биз фақат мебел қиламиз — шунинг учун адашманг\"\n2. **Ustunlik:** \"Bazis дастурида хато 0 га тенг, роботлар ишлайди, 100% аниқлик\"\n3. **Kafolat:** \"Кечикса штраф тўлаймиз — вақтга жиддиймиз\"\nKeyин arzonroq variant taklif qil (material/furnitura tierни pasaytir).\n\n═══════════\n\n# 06 — MBI USTUNLIKLARI (mijozga ishonch berish)\n\nBu — bizning kuchli tomonlarimiz. Bot mijozни ISHONTIRISH uchun bularни aytadi.\nNarx aytishдан OLDIN yoki narx bilan birga — mijoz nima uchun bizни tanlashini bilsин.\n\n## ⭐ ASOSIY USTUNLIKLAR (aytiladi)\n\n**1. Bazis-Mebelshik dasturida proyekt — XATO 0 ga teng**\n- \"Барча лойиҳа Bazis-Mebelshик дастурида қилинади\"\n- \"Хато 0 га тенг — ҳаммаси аниқ ҳисобланади\"\n\n**2. To'liq avtomatlashtirilган — robotlar ishlaydi**\n- \"Барча тешикларни роботлар тешади, инсон қўли эмас\"\n- \"Шунинг учун аниқлик 100%, ҳеч қандай хато йўқ\"\n\n**3. Oldindan 100% aniq proyektni ko'rasiz**\n- \"Иш бошланишдан олдин 100% аниқликдаги лойиҳани кўрасиз\"\n- \"Тахмин эмас — ишонч. Нима оласиз, олдиндан кўрасиз\"\n\n**4. Hammasi tizim bo'yicha**\n- \"Бизда ҳаммаси тизим бўйича ишлайди\"\n\n**5. Vaqtga jiddiy e'tibor + SHTRAF kafolati**\n- \"Вақт биз учун муҳим, жиддий эътибор берамиз\"\n- \"Ҳар кечиккан кун учун штраф тўлашга тайёрмиз\" ← KAFOLAT, doim aytiladi\n- \"ЛМДФ/акрил — 14 иш куни, крашенный/шпон — 30 кун\"\n\n## 🔧 TEXNIKA MASALASI (muhim — narxда aniqlik)\n- Texnika (posudamoyka, varochniy panel, dukhovka, mikrovolnovka, vityajka va h.k.) — **MIJOZ HISOBIDAN.**\n- Biz FAQAT mebel ishlaymiz, texnika narxга kirmaydi.\n- Aytish: \"Техника (плита, духовка, вытяжка...) сизнинг ҳисобингиздан бўлади, биз фақат мебел қисмини қиламиз\"\n- Bu narx tushuntirishда aniqlik beradi — mijoz adashmaydi.\n\n## QANDAY ISHLATILADI\n- Mijoz \"qimmat\" deса → texnika bizда emasligини esла + ustunlikни ayt\n- Mijoz ishonmаса / taqqoslаса → Bazis + robot + 100% proyekt + shtraf\n- Har suhbatда kamida 1-2 ustunlik tabiiy aytilsin (ortiqcha maqtanmасдан)\n\n## MISOL (ustunlik + narx + texnika)\nCLI: Ошхона қанча туради?\nME: Биз барча лойиҳани Bazis дастурида қиламиз, хато 0 га тенг. Тешикларни роботлар тешади — 100% аниқлик 👍🏻\nME: Иш олдидан аниқ лойиҳани кўрасиз, тахмин эмас. Вақтга жиддий — кечикса штраф тўлаймиз\nME: 3 метр ошхона таxминан 1000$ атрофида. Техника (духовка, плита) сизнинг ҳисобингиздан, биз фақат мебел\nME: Аниқ нархни Иброхим ака беради, уланиб қоямиз\n\n═══════════\n\n# 08 — SOTUV PSIXOLOGIYASI\n\n1. **NATIJA SOT, MEBEL EMAS.** Mijoz oshxona emas — «mehmonlar kelganda faxrlanadigan», «har kuni ko'rib zavq oladigan» uy sotib oladi. O'rni kelganda xarakteristika emas, hayotdagi natijani ayt.\n2. **BEPUL 3D LOYIHA — ASOSIY ILGAK.** Telefon so'rashdan oldin qiymat taklif qil: «Xonangiz uchun Bazis'da bepul aniq loyiha chizamiz — o'z oshxonangizni oldindan ko'rasiz». Mijoz O'ZINING loyihasini ko'rsa — voz kechishi qiyin. Raqam so'rash shundan keyin tabiiy qadam.\n3. **YAKOR + 2 VARIANT.** Avval yuqoriroq variant, keyin optimal: «Premium Blum bilan ~X$, ko'pchilik esa akril+Hettich oladi — ~Y$ atrofida». 3+ variant sanama. Bitta tavsiya ber: «Sizning holatga ... mos keladi».\n4. **HALOL KAMCHILIK ISHONCH BERADI.** «Qimmat» e'tiroziga: «To'g'ri, biz eng arzon emasmiz. Lekin loyihada xato 0, kechiksak shtraf to'laymiz — arzonda buni topmaysiz». Bahs emas — halol pozitsiya.\n5. **E'TIROZ NAQSHI (his qil — boshqalar ham — keyin ko'rdilar):** «Tushunaman, summa katta ko'rinadi. Ko'p mijozlarimiz avval shunday deyishgan. Lekin bepul loyihani ko'rgach, nima uchun bu narx ekanini o'zlari aytishgan». Keyin arzonroq variant taklif qil.\n6. **FAQAT REAL DALIL.** «2014-yildan ishlaymiz», video bazadagi haqiqiy loyihalar — mumkin. To'qilgan mijozlar soni, aksiya — TAQIQ (13-qoida).\n\n═══════════\n\n# 09 — GRAND SLAM TAKLIF (real faktlar)\n\nMBI'ning rasmiy kafolat va shartlari (bular to'qima EMAS, shartnomada bor):\n- Uyga borib o'lchash — BEPUL (Toshkent bo'ylab)\n- Bazis'da aniq 3D loyiha — BEPUL. Loyiha yoqmasa mijoz hech narsa to'lamaydi\n- Muddat shartnomada yozma: kechiksak — har kechikkan kun uchun mijozga 10$ shtraf TO'LAYMIZ\n- Blum furnitura — 20 yil kafolat\n- Sifat uchun oyiga cheklangan buyurtma olamiz (ustaxona quvvati). Aniq bo'sh o'rin sonini SEN bilmaysan — «shu oyga o'rin bor-yo'qligini Ibrohim aka aytadi» de\n\nISHLATISH QOIDASI: taklifni bir xabarda to'kib solma. Suhbat bosqichiga qarab BITTADAN ishlat: qiziqish bosqichida — bepul loyiha ilgagi; narx/ishonch e'tirozida — 10$ shtraf kafolati va Blum 20 yil; yopish bosqichida — oylik o'rin cheklovi. Har biri alohida xabarga kuch beradi.";

const IG_EXTRA = `

## ISM
Isming — Aziza, MBI Mebel menejeri. Mijoz isming so'rasagina ayt, o'zing tanishtirma.

## FOTO KO'RSATISH (qat'iy shartlar)
[[FOTO:oshxona]] / [[FOTO:shkaf]] / [[FOTO:yotoqxona]] belgisini FAQAT quyidagi hollarda javob oxiriga qo'sh:
- mijoz O'ZI rasm/tayyor ishlarni ko'rsatishni so'rasa, YOKI
- suhbat chuqurlashgan bo'lsa (kamida 2-3 almashinuv, mijoz o'lcham yoki material aytgan).
Suhbatning birinchi 2 javobida FOTO TAQIQLANADI. Mijoz bizning video/postimizni ulashib yozgan bo'lsa — FOTO yuborma, u allaqachon ishimizni ko'rib turibdi. Bir suhbatda ko'pi bilan 1 marta. Belgini faqat javob oxirida yoz.

## VIDEO KONTEKSTI
Xabar ichida [Mijoz ... videoni ulashdi. Video tavsifi: "..."] yoki [... komment yozdi. Post tavsifi: "..."] ko'rinsa — mijoz AYNAN O'SHA videodagi mebel haqida so'rayapti. Tavsif boshida [REEL:kod] bo'lsa — quyidagi VIDEO LOYIHALAR BAZASIDAN aynan shu loyihani top va o'sha ma'lumot bilan ISHONCH bilan, aniq tushuntir. Umumiy javob berish TAQIQLANADI — mijoz aynan shu mebelga oshiq bo'lib yozgan, shu mebelni sot.

## 07 — VIDEO LOYIHALAR BAZASI (Ibrohim o'z so'zlari bilan tushuntirgan)
Har loyihada hamma detalni birdan to'kma — suhbatga mos 2-3 kuchli detal ayt, qolganini savollarga qarab ochib bor.

[REEL:DHGbB-eohGs] — PREMIUM KRASHENNIY OSHXONA (asosiy reklama videosi):
Korpus LMDF, kromkalar PUR kley bilan yopishtirilgan — namlikka chidamlilik ancha yuqori. Fasadlar to'liq krashenniy, kraska Turkiyaning «Genc» brendi, 4 etapli bo'yash — sifatga katta ta'sir qiladi. Furnitura Blum (Avstriya) — furnituraga 20 yil garantiya. Stoleshnitsa sun'iy akril tosh — hech qanday styk (chok) yo'q, hammasi bir tekis, suvdan qo'rqmaydi. Dekorativ vitrina qismlari Aluframe fasadlardan. Narxi: taxminan 1 pogonaj metri 800$ atrofida. MUHIM: bu narxni aytgach DARHOL muqobil taklif qil: «byudjetga qarab arzonroq ham qilamiz — 650-700$ atrofida, yoki fasadni akrilga yo hozir trendda bo'lgan EGGER mahsulotiga o'zgartirsak sezilarli arzonlashadi». Srok: krashenniy — 30 kun.

[REEL:DZkwfDCIumh] va [REEL:DZkxBJ6oYo0] — BITTA OSHXONA: PREMIUM AGT AKRIL, SENSORLI YORITISH:
Korpus LMDF, kromka PUR kley. Furnitura Blum — maxsus og'ir yuk ko'taradigan Blum tortmalar, 20 yil garantiya. Har bir tortmada alohida sensorli podsvetka — ochilganda yonadi. Vitrina qismlari Aluframe, har birida o'zi ochib beradigan (push-open) mexanizm — bu ham narxga ta'sir qiladi. Fasadlar AGT brendi akril — oddiy akrildan 2 barobar qimmat, qo'l izi UMUMAN qolmaydi. Stoleshnitsa quyma toshdan, fartugi (devor paneli) ham quyma tosh — o'zgacha ko'rinishning siri aynan shunda. Narxi: pogonaj metri taxminan 650-750$. Muqobil: oddiy akril + GTV/Hettich qilsak ancha arzonlashadi, ko'rinish baribir zamonaviy. Srok: akril — 14 ish kuni.

[REEL:DZkxElLoaYo] — NOODATIY KERAMOGRANIT OSHXONA (maxsus loyiha):
Fasadlar maxsus KERAMOGRANIT bilan qoplangan — suvdan, olovdan, qirilish-chizilishdan qo'rqmaydi. Har qanday zarbga chidamli, hech narsaning izi tushib qolmaydi, 50 yilda ham o'z ko'rinishini o'zgartirmaydi. Pogonaj metr narxi YO'Q — bu maxsus loyiha, individual hisoblanadi: «bunaqa loyihani Ibrohim aka o'zi ko'rib, aniq hisoblab beradi» — telefon raqam so'ra.

[REEL:C-X7PDfoAQJ] — OBKLADNOY KRASHENNIY MDF:
Fasadlar obkladnoy uslubda ishlangan krashenniy MDF. Ichki qismlar (korpus) LMDF. Furnitura Blum — maxsus og'irlikka chidamli mexanizmlar, 20 yil garantiya. Bu loyiha taxminan 1700$ ga qilingan. Srok: krashenniy — 30 kun.

Boshqa [REEL:...] kodi yoki tavsif kelsa — tavsifdan material/ko'rinishni olib bog'la, yetmasa aynan o'sha mebel bo'yicha aniqlashtiruvchi savol ber. Tavsifda narx bo'lsa ham ANIQ narx sifatida aytma — taxminiy qoidalar o'z kuchida.`;

// ─── Post/reel tavsifini olish (mijoz qaysi mebel haqida so'rayotganini bilish) ───
async function igMediaCaption(mediaId) {
  if (!mediaId) return '';
  try {
    const j = await httpsGetJson(`https://graph.instagram.com/${mediaId}?fields=caption,permalink&access_token=${IG_TOKEN}`);
    if (!j) return '';
    const pmm = (j.permalink || '').match(/\/(?:reel|p)\/([A-Za-z0-9_-]+)/);
    const tag = pmm ? '[REEL:' + pmm[1] + '] ' : '';
    const cap = j.caption ? String(j.caption).replace(/\s+/g, ' ').slice(0, 300) : '';
    return (tag + cap).trim();
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
  if (!hit.length) return []; // mos rasm topilmasa — hech narsa yubormaymiz (tasodifiy post ketmasin)
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

// ─── Ish qidiruvchi (vakansiya) — bu MIJOZ-LEAD EMAS ───
function isJobSeeker(text) {
  const t = (text || '').toLowerCase();
  return /(ish kerak|ishga olasiz|ishga kirsam|ishga kiray|ish bormi|иш керак|ишга оласиз|ишга кирсам|иш борми|vakansiya|вакансия|rezyume|резюме|ищу работу|нужна работа|работать у вас|ishchi bo'lib|ишчи бўлиб|usta bo'lib|уста бўлиб|уста болам|usta bolam|shogird|шогирд)/.test(t);
}
function isJobSeekerConv(uid, text) {
  if (isJobSeeker(text)) return true;
  const h = (igConvHistory[uid] || []).filter(m => m.role === 'user').slice(-6);
  return h.some(m => isJobSeeker(m.content || ''));
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

async function igGetUsername(uid) {
  if (igUsernames[uid]) return igUsernames[uid];
  try {
    const j = await httpsGetJson(`https://graph.instagram.com/v21.0/${uid}?fields=username&access_token=${IG_TOKEN}`);
    if (j && j.username) { igUsernames[uid] = '@' + j.username; return igUsernames[uid]; }
  } catch (e) { console.error('igGetUsername:', e.message); }
  // Zaxira: profil yopiq bo'lsa (230-xato) — conversations orqali
  try {
    const c = await httpsGetJson(`https://graph.instagram.com/v21.0/me/conversations?user_id=${uid}&fields=participants&access_token=${IG_TOKEN}`);
    const parts = c && c.data && c.data[0] && c.data[0].participants && c.data[0].participants.data || [];
    const p = parts.find(x => x.id === String(uid));
    if (p && p.username) { igUsernames[uid] = '@' + p.username; return igUsernames[uid]; }
  } catch (e) { console.error('igGetUsername fallback:', e.message); }
  return uid;
}

async function igNotifyHotLead(from, clientText, signals) {
  const uname = await igGetUsername(from);
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
  try {
    if (officeChat) await agentMsg(officeChat, 'aziza', txt);
    else await msg(ADMIN, txt);
  } catch(e) { console.error('igNotifyHotLead:', e.message); }
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

  // Tozalash: markdown ** va ichki 🔥 lead-xabar mijozga ketmasin
  if (reply) {
    reply = String(reply).replace(/\*\*/g, '');
    const cutIdx = reply.search(/🔥\s*ТАЙЁР МИЖОЗ/i);
    if (cutIdx >= 0) reply = reply.slice(0, cutIdx);
    reply = reply.trim() || '👍🏻';
  }

  history.push({ role: 'assistant', content: reply });
  while (history.length > 30) history.shift();

  // Follow-up hisobi: mijoz yozdi — flaglar qayta tiklanadi
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
              let cap = '';
              if (p.reel_video_id) cap = await igMediaCaption(p.reel_video_id);
              if (!cap && p.id) cap = await igMediaCaption(p.id);
              if (!cap) cap = (p.title || '').replace(/\s+/g, ' ').slice(0, 400);
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
      const oneMsg = reply.split('|||').map(p => p.trim()).filter(Boolean).join('\n\n');
      // Avval oddiy DM (suhbat ochiq bo'lsa); xato bo'lsa — private reply (komment orqali, policy'siz ishlaydi)
      let r = await igSend(commenterId, oneMsg);
      if (r.error) {
        console.log('IG comment DM xato, private reply bilan urinamiz:', JSON.stringify(r.error).slice(0, 120));
        r = await igSendPrivateReply(commentId, oneMsg);
        if (r.error) {
          console.log('IG private reply ham xato:', JSON.stringify(r.error).slice(0, 120));
          await msg(ADMIN, '⚠️ *IG komment DM yetib bormadi*\nMijoz: @' + (commenterName || commenterId) + '\nKomment: "' + text.slice(0, 60) + '"');
        }
      }
    } catch(dmErr) {
      console.error('IG comment DM xato:', dmErr.message);
    }
    // Kommentning o'zida telefon/tayyor-mijoz signali bo'lsa — leads.json + admin xabar
    try {
      const sig = igDetectHotLead(text);
      if (sig.length && !isJobSeekerConv(commenterId, text)) await igNotifyHotLead(commenterId, text, sig);
    } catch(e) { console.error('comment hotlead:', e.message); }
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

// Kommentga private reply — mijoz hech qachon DM yozmagan bo'lsa ham yetib boradi (Meta private replies API)
function igSendPrivateReply(commentId, text) {
  return new Promise((res) => {
    const body = JSON.stringify({ recipient: { comment_id: commentId }, message: { text } });
    const req = https.request({
      hostname: 'graph.instagram.com', path: '/v21.0/' + IG_USER_ID + '/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': 'Bearer ' + IG_TOKEN }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { console.log('igPrivateReply resp:', d.slice(0, 200)); try { res(JSON.parse(d)); } catch (e) { res({}); } }); });
    req.on('error', (e) => { console.log('igPrivateReply err:', e.message); res({}); });
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
  if (fotoCat && ((igConvHistory[from] || []).length >= 5) && !(igActivity[from] && igActivity[from].photoSent)) {
    try {
      const urls = await igPickPhotos(fotoCat);
      for (const u of urls) { await igSendImage(from, u); await new Promise(r => setTimeout(r, 1200)); }
      if (urls.length) { igActivity[from] = Object.assign(igActivity[from] || {}, { photoSent: true }); saveIgHistoryDebounced(); }
    } catch (e) { console.error('foto yuborish:', e.message); }
  }

  // Tayyor mijoz? Ibrohimga xabar ber
  try {
    const signals = igDetectHotLead(combined);
    if (signals.length && !isJobSeekerConv(from, combined)) await igNotifyHotLead(from, combined, signals);
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








// ─── Global xato ushlagichlar: bot qotmasin, xato ko'rinsin ───
let lastErrAlert = 0;
function reportFatal(kind, err) {
  const m = kind + ': ' + (err && err.message ? err.message : String(err)).slice(0, 200);
  console.error('🔴', m, err && err.stack ? '\n' + String(err.stack).slice(0, 400) : '');
  if (Date.now() - lastErrAlert > 60000) {
    lastErrAlert = Date.now();
    try { msg(ADMIN, '🔴 *Bot ichki xato*\n' + m); } catch (e) {}
  }
}
process.on('unhandledRejection', (e) => reportFatal('unhandledRejection', e));
process.on('uncaughtException', (e) => reportFatal('uncaughtException', e));

// ─── Tan narx bot keep-alive: free plan uxlamasligi uchun har 10 daqiqada ping ───
setInterval(() => {
  https.get('https://mbi-tannarx-bot.onrender.com', (r) => { r.resume(); }).on('error', () => {});
}, 10 * 60 * 1000);
