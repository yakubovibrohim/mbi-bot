const https = require('https');
const http = require('http');
const FormData = require('form-data');

const BOT      = '8811277023:AAH_1iBPjb-dlmPDWc1vwMCPQEITzLuWDec';
const ADMIN    = '1487569442';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = 'yakubovibrohim/mbi-bot';
const TZ       = 'Asia/Tashkent';

const state = {};
const phoneToChat = {};
const invoiceState = {};

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
      if (cq.data==='til_uz'){state[c]={lang:'uz',step:'ask_file'};await btn(c,'Sizda tayyor loyiha yoki xona rasmi bormi?',[[{text:'Ha, bor',callback_data:'file_ha'}],[{text:"Yo'q",callback_data:'file_yoq'}]]);}
      else if(cq.data==='til_ru'){state[c]={lang:'ru',step:'ask_file'};await btn(c,'U vas est gotoviy proekt?',[[{text:'Da, est',callback_data:'file_ha'}],[{text:'Net',callback_data:'file_yoq'}]]);}
      else if(cq.data==='file_ha'){const l=(state[c]||{}).lang||'uz';state[c]={lang:l,step:'waiting_file'};await msg(c,l==='uz'?'Fayl yuboring:':'Otpravte fayl:');}
      else if(cq.data==='file_yoq'){const l=(state[c]||{}).lang||'uz';state[c]={lang:l,step:'done'};await anketa(c,l);}
      return;
    }

    if (!upd.message) return;
    const c = upd.message.chat.id;
    const isAdmin = String(c) === String(ADMIN);
    const ism = upd.message.from.first_name || 'Mijoz';
    const un = upd.message.from.username ? '@'+upd.message.from.username : '-';
    const t = upd.message.text || '';

    // Admin voice
    if (upd.message.voice && isAdmin) { await handleVoice(c, upd.message.voice); return; }

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

    // Commands
    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g,'')] = c;

    if (t === '/start') {
      state[c] = {};
      if (isAdmin) {
        await msg(c, '👋 *Assalomu alaykum, Ibrohim!*\n\n📱 *Botga nima yuborsa bo\'ladi:*\n\n🎤 *Ovozli xabar:*\n  • "Sherzod kelmadi"\n  • "Diyor 100 dollar avans oldi"\n  • "Soat 3 da Boxodir aka bilan uchrashuv"\n  • "Shaxsiy xarajat 50000 so\'m benzin"\n  • "Alisher bilan 2000 dollar kelishdilik"\n  • "Bugun qilishim kerak: ..."\n\n📸 *Nakładnoy rasmi* → mijoz so\'raldi → saqlanadi\n\n📋 *Buyruqlar:*\n/hisobot — oylik hisobot\n/bugun — bugungi reja\n/vazifalar — bugungi vazifalar');
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

async function aiReply(text, userId) {
  // Init history for this user
  if (!igConvHistory[userId]) igConvHistory[userId] = [];
  const history = igConvHistory[userId];
  
  // Add user message to history
  history.push({ role: 'user', content: text });
  
  // Keep only last 6 messages
  while (history.length > 6) history.shift();
  
  const SYSTEM = `Sen MBI Mebel kompaniyasining Instagram menejerisan. Ism: Kamol.

FAQAT O'ZBEK yoki RUS tilida yoz. Boshqa til yo'q.

USLUB - Ibrohim aka kabi (qisqa, oddiy):
- 1-2 jumla. Ko'p yozma.
- Do'stona, "aka/opa" ishlatsa bo'ladi
- Savol bilan tugat

HAQIQIY DIALOGLAR:
Mijoz: "narx kancha" => "390$dan boshlanadi. Qanday xona uchun?"
Mijoz: "kuxnya kerak" => "Zo'r! Necha metr taxminan?"
Mijoz: "adres qayerda" => "Showroom yo'q, uyga borib o'lchaymiz. Qaysi tuman?"
Mijoz: "salom uyimga mebel kerak" => "Wa alaykum! Qaysi xona — oshxona, shkaf?"
Mijoz: "Кухиннийни нархи канча" => "Ассалому Алейкум! 390$дан, ўлчамга қараб. Канча метр?"
Mijoz: "yaxshimisiz" => "Yaxshi! Sizga qanday mebel kerak?"
Mijoz: "nima" => "Ha, ayting! Qaysi xona uchun mebel?"
Mijoz: "qimmat" => "Necha metrga kerak? Arzonroq ham bor."

NARX: Oshxona 390-600$/metr. Shkaf 300-500$/metr. Aniq narx o'lchamga qarab.
JARAYON: Bepul o'lcham -> dizayn -> 2-4 hafta -> yetkazish
TEL: +998 91 135 44 66`;

  return new Promise((res) => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-4-5', max_tokens: 200,
      system: SYSTEM,
      messages: history
    });
    const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OR_KEY, 'HTTP-Referer': 'https://mbi-bot-yw9q.onrender.com' }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => {
      try {
        const reply = JSON.parse(d).choices?.[0]?.message?.content || `Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`;
        // Add assistant reply to history
        igConvHistory[userId].push({ role: 'assistant', content: reply });
        while (igConvHistory[userId].length > 6) igConvHistory[userId].shift();
        res(reply);
      }
      catch(e) { res(`Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`); }
    }); });
    req.on('error', () => res(`Kechirasiz, +998 91 135 44 66 ga qo'ng'iroq qiling!`));
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
        if (!from || !text || m.message?.is_echo) continue;
        console.log('IG DM from:', from, 'text:', text);
        await msg(ADMIN, `📱 *Instagram DM:*\n💬 "${text}"\n_Javob yuborilmoqda..._`);
        
        let reply;
        try {
          reply = await aiReply(text, from);
          console.log('aiReply result:', reply ? reply.slice(0,50) : 'NULL');
        } catch(aiErr) {
          console.error('aiReply xato:', aiErr.message);
          await msg(ADMIN, `❌ AI xato: ${aiErr.message}`);
          reply = 'Salom! Mebel haqida savol uchun: +998 91 135 44 66';
        }
        
        let sendResult;
        try {
          sendResult = await igSend(from, reply);
          console.log('igSend natija:', JSON.stringify(sendResult));
          if (sendResult.error) {
            await msg(ADMIN, `❌ *igSend xato:*\n\`${JSON.stringify(sendResult.error)}\``);
          } else {
            await msg(ADMIN, `✅ *Yuborildi:*\n"${reply}"`);
          }
        } catch(sendErr) {
          console.error('igSend xato:', sendErr.message);
          await msg(ADMIN, `❌ igSend exception: ${sendErr.message}`);
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



