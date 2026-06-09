const https = require('https');
const http = require('http');
const FormData = require('form-data');

const BOT      = '8811277023:AAH_1iBPjb-dlmPDWc1vwMCPQEITzLuWDec';
const ADMIN    = '1487569442';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = 'yakubovibrohim/mbi-bot';

const state = {};
const phoneToChat = {};
// Invoice conversation state for admin
const invoiceState = {}; // { step, photoId, items, total, supplier, invoice_no }

// ─── Telegram helpers ─────────────────────────────────────────
function api(method, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}
function msg(c, t, extra) { return api('sendMessage', { chat_id: c, text: t, parse_mode: 'Markdown', ...extra }); }
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
      hostname: 'api.github.com',
      path: '/repos/' + GH_REPO + '/contents/' + path,
      method: 'GET',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Accept': 'application/vnd.github.v3+json' }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.end();
  });
}

function ghPut(path, content, sha, commitMsg) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ message: commitMsg, content: Buffer.from(content).toString('base64'), sha: sha });
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + GH_REPO + '/contents/' + path,
      method: 'PUT',
      headers: { 'Authorization': 'token ' + GH_TOKEN, 'User-Agent': 'mbi-bot', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function appendToFile(filename, newEntries) {
  try {
    let logs = [], sha = null;
    try {
      const existing = await ghGet(filename);
      sha = existing.sha;
      logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    } catch (e) { logs = []; }
    for (const e of newEntries) logs.push(e);
    if (logs.length > 1000) logs = logs.slice(-1000);
    const label = newEntries.map(e => e.title || e.name || '').join(' | ');
    await ghPut(filename, JSON.stringify(logs, null, 2), sha, label);
    return true;
  } catch (e) { console.error('GitHub error:', e.message); return false; }
}

async function getMonthLogs(filename, monthStr) {
  try {
    const existing = await ghGet(filename);
    const logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    return logs.filter(l => (l.date || '').slice(3) === monthStr);
  } catch (e) { return []; }
}

// ─── Groq Whisper ─────────────────────────────────────────────
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function transcribeAudio(audioBuffer) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', audioBuffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/audio/transcriptions', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY, ...form.getHeaders() }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data).text || ''); } catch (e) { reject(new Error('Whisper: ' + data)); } });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// ─── Groq LLama: parse voice command ─────────────────────────
function parseVoice(text, todayStr) {
  return new Promise((resolve) => {
    const system = `Sen MBI Mebel zavodining AI assistentisan. Bugun: ${todayStr}.

XODIMLAR ISMLARI (har qanday talaffuzda tanib ol):
- Sherzod = Sherzod, Şevzat, Shevzat, Şerzad, Shirzod
- Diyor = Diyor, Diyar, Dyor, Diyer

Bir xabarda BIR NECHTA hodisa/sana bo'lishi mumkin.
FAQAT JSON massiv qaytarasan (boshqa hech narsa, markdown yo'q):
[{"action":"attendance"|"avans"|"oylik"|"xarajat"|"boshqa","worker":"Diyor"|"Sherzod"|"noma'lum","present":true|false|null,"amount":number|null,"currency":"USD"|"UZS"|null,"date":"DD.MM.YYYY","note":"qisqa izoh"}]

SANA QOIDALARI:
- "bugun","bugün","сегодня" → ${todayStr}
- "kecha","kece","dün","вчера" → kechagi sana
- "6-iyun","6 iyun","6-ci iyun" → 06.06.${todayStr.slice(6)}
- "7-iyun" → 07.06.${todayStr.slice(6)}, "8-iyun" → 08.06.${todayStr.slice(6)}
- Oy yo'q → joriy oy

HARAKAT SO'ZLARI:
- keldi/gəldi → present:true
- kelmadi/gəlmədi/kelmədi/işke gəlmədi → present:false
- avans/avans aldı/oldu avans → action:avans`;

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: 600,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }]
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
          const parsed = JSON.parse(raw);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (e) {
          resolve([{ action: 'boshqa', worker: "noma'lum", amount: null, currency: null, date: todayStr, note: text }]);
        }
      });
    });
    req.on('error', () => resolve([{ action: 'boshqa', worker: "noma'lum", amount: null, currency: null, date: todayStr, note: text }]));
    req.write(body); req.end();
  });
}

// ─── Groq LLama: read invoice image via URL ──────────────────
function readInvoiceText(text) {
  return new Promise((resolve) => {
    const system = `Sen nakładnoy/chek matnini tahlil qiluvchi assistentsan.
Foydalanuvchi nakładnoy matnini beradi. Sen FAQAT JSON qaytarasan (markdown yo'q):
{
  "supplier": "yetkazuvchi nomi",
  "invoice_no": "nakładnoy raqami yoki null",
  "date": "DD.MM.YYYY yoki null",
  "total": rassm yig'indisi (number),
  "currency": "USD" yoki "UZS",
  "items": [{"name": "mahsulot nomi", "qty": miqdor, "price": narx, "total": summa}]
}`;

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: 1000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: text }]
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

// ─── Build title from parsed entry ───────────────────────────
function buildTitle(p) {
  const d = p.date || '';
  if (p.action === 'attendance') return (p.present ? '✅' : '❌') + ' ' + d + ' | ' + p.worker + ' | ' + (p.present ? 'Ishga KELDI' : 'Ishga KELMADI');
  if (p.action === 'avans') return '💵 ' + d + ' | ' + p.worker + ' | Avans: ' + (p.amount ? p.amount + ' ' + (p.currency || '') : '');
  if (p.action === 'oylik') return '💰 ' + d + ' | ' + p.worker + ' | Oylik: ' + (p.amount ? p.amount + ' ' + (p.currency || '') : '');
  return '📝 ' + d + ' | ' + (p.note || '');
}

// ─── Voice handler ────────────────────────────────────────────
async function handleVoice(chatId, voice) {
  try {
    await msg(chatId, '⏳ Tahlil qilinmoqda...');
    const fileInfo = await api('getFile', { file_id: voice.file_id });
    const fileUrl = 'https://api.telegram.org/file/bot' + BOT + '/' + fileInfo.result.file_path;
    const audio = await downloadBuffer(fileUrl);
    const transcript = await transcribeAudio(audio);
    const todayStr = new Date().toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });
    const parsedList = await parseVoice(transcript, todayStr);

    const entries = parsedList.map(p => ({
      date: p.date || todayStr,
      title: buildTitle(p),
      transcript,
      parsed: p,
      ts: new Date().toISOString()
    }));

    const saved = await appendToFile('hr-log.json', entries);
    const lines = entries.map(e => '📋 ' + e.title).join('\n');
    await msg(chatId, (saved ? '✅ Saqlandi!\n\n' : '⚠️ Xato!\n\n') + lines + '\n\n🎤 _"' + transcript + '"_');
  } catch (e) {
    console.error('Voice error:', e);
    await msg(chatId, '❌ Xatolik: ' + e.message);
  }
}

// ─── Invoice photo handler ────────────────────────────────────
async function handleInvoicePhoto(chatId, photo) {
  try {
    await msg(chatId, '⏳ Nakładnoy o\'qilmoqda...');

    // Get largest photo
    const fileInfo = await api('getFile', { file_id: photo[photo.length - 1].file_id });
    const fileUrl = 'https://api.telegram.org/file/bot' + BOT + '/' + fileInfo.result.file_path;

    // Download image
    const imgBuffer = await downloadBuffer(fileUrl);
    const base64img = imgBuffer.toString('base64');

    // Use Groq vision via llama to read invoice
    const parsed = await readInvoiceFromImage(base64img);

    if (!parsed) {
      await msg(chatId, '❌ Nakładnoyni o\'qib bo\'lmadi. Matnni o\'zingiz yuboring.');
      return;
    }

    // Save state and ask for client
    invoiceState[chatId] = {
      step: 'ask_client',
      invoice: parsed,
      photoId: photo[photo.length - 1].file_id
    };

    const today = new Date().toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });
    const itemList = (parsed.items || []).map(i => `  • ${i.name}: ${i.qty} × ${i.price} = ${i.total}`).join('\n') || '  —';

    await msg(chatId,
      `📄 *Nakładnoy №${parsed.invoice_no || '—'}*\n` +
      `🏭 ${parsed.supplier || '—'}\n` +
      `📅 ${parsed.date || today}\n\n` +
      `*Mahsulotlar:*\n${itemList}\n\n` +
      `*Jami: ${parsed.total} ${parsed.currency || 'USD'}*\n\n` +
      `❓ *Qaysi mijoz uchun? Ismini yozing:*`
    );
  } catch (e) {
    console.error('Invoice error:', e);
    await msg(chatId, '❌ Xatolik: ' + e.message);
  }
}

// Read invoice using Groq vision (llama-3.2-90b-vision)
function readInvoiceFromImage(base64img) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'llama-3.2-90b-vision-preview',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/jpeg;base64,' + base64img }
          },
          {
            type: 'text',
            text: 'Bu nakładnoy/chek rasmidan ma\'lumotlarni chiqar. FAQAT JSON qaytarasan (markdown yo\'q):\n{"supplier":"yetkazuvchi","invoice_no":"raqam yoki null","date":"DD.MM.YYYY yoki null","total":son,"currency":"USD","items":[{"name":"nom","qty":son,"price":son,"total":son}]}'
          }
        ]
      }]
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

// ─── Invoice client reply handler ────────────────────────────
async function handleInvoiceClientReply(chatId, clientName) {
  const s = invoiceState[chatId];
  if (!s) return false;

  const inv = s.invoice;
  const today = new Date().toLocaleDateString('uz-UZ', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });

  const expEntry = {
    date: inv.date || today,
    title: `🧾 ${inv.date || today} | ${clientName} | ${inv.supplier || ''} | $${inv.total}`,
    supplier: inv.supplier || '',
    invoice_no: inv.invoice_no || '',
    client: clientName,
    items: inv.items || [],
    total: inv.total || 0,
    currency: inv.currency || 'USD',
    ts: new Date().toISOString()
  };

  const saved = await appendToFile('expenses-log.json', [expEntry]);
  delete invoiceState[chatId];

  await msg(chatId,
    (saved ? '✅ Saqlandi!\n\n' : '⚠️ Xato!\n\n') +
    `🧾 *${inv.supplier || 'Nakładnoy'}*\n` +
    `👤 Mijoz: *${clientName}*\n` +
    `💰 Summa: *$${inv.total}*\n` +
    `📁 expenses-log.json ga qo\'shildi`
  );
  return true;
}

// ─── /hisobot command ─────────────────────────────────────────
async function sendReport(chatId) {
  try {
    const now = new Date();
    const monthStr = ('0' + (now.getMonth() + 1)).slice(-2) + '.' + now.getFullYear();
    const [hrLogs, expLogs] = await Promise.all([
      getMonthLogs('hr-log.json', monthStr),
      getMonthLogs('expenses-log.json', monthStr)
    ]);

    let text = `📊 *${monthStr} — Oylik hisobot*\n\n`;

    // Absences
    const kelmadi = hrLogs.filter(l => l.parsed && l.parsed.action === 'attendance' && l.parsed.present === false);
    if (kelmadi.length) {
      text += '❌ *Kelmagan kunlar:*\n';
      const byW = {};
      kelmadi.forEach(l => { const w = l.parsed.worker; if (!byW[w]) byW[w] = []; byW[w].push(l.date); });
      for (const [w, dates] of Object.entries(byW)) text += `  • ${w}: ${dates.sort().join(', ')} (${dates.length} kun)\n`;
      text += '\n';
    }

    // Advances
    const avans = hrLogs.filter(l => l.parsed && l.parsed.action === 'avans');
    if (avans.length) {
      text += '💵 *Avanslar:*\n';
      const total = avans.reduce((s, l) => s + (l.parsed.amount || 0), 0);
      avans.forEach(l => text += `  • ${l.date} — ${l.parsed.worker}: $${l.parsed.amount || 0}\n`);
      text += `  *Jami: $${total}*\n\n`;
    }

    // Expenses
    if (expLogs.length) {
      text += '🧾 *Xarajatlar:*\n';
      const totalExp = expLogs.reduce((s, l) => s + (l.total || 0), 0);
      expLogs.forEach(l => text += `  • ${l.date} — ${l.client || ''}: $${l.total || 0} (${l.supplier || ''})\n`);
      text += `  *Jami: $${totalExp}*\n`;
    }

    if (!kelmadi.length && !avans.length && !expLogs.length) text += '_Bu oy hali ma\'lumot yo\'q_';

    await msg(chatId, text);
  } catch (e) { await msg(chatId, '❌ Xato: ' + e.message); }
}

// ─── Main handler ─────────────────────────────────────────────
async function handle(upd) {
  try {
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const c = cq.message.chat.id;
      await acb(cq.id);
      if (cq.data === 'til_uz') { state[c] = { lang: 'uz', step: 'ask_file' }; await btn(c, 'Sizda tayyor loyiha yoki xona rasmi bormi?', [[{ text: 'Ha, bor', callback_data: 'file_ha' }], [{ text: "Yo'q", callback_data: 'file_yoq' }]]); }
      else if (cq.data === 'til_ru') { state[c] = { lang: 'ru', step: 'ask_file' }; await btn(c, 'U vas est gotoviy proekt ili foto komnaty?', [[{ text: 'Da, est', callback_data: 'file_ha' }], [{ text: 'Net', callback_data: 'file_yoq' }]]); }
      else if (cq.data === 'file_ha') { const l = (state[c] || {}).lang || 'uz'; state[c] = { lang: l, step: 'waiting_file' }; await msg(c, l === 'uz' ? 'Iltimos, fayl yoki rasmni yuboring:' : 'Pozhaluysta, otpravte fayl ili foto:'); }
      else if (cq.data === 'file_yoq') { const l = (state[c] || {}).lang || 'uz'; state[c] = { lang: l, step: 'done' }; await anketa(c, l); }
      return;
    }

    if (!upd.message) return;
    const c = upd.message.chat.id;
    const isAdmin = String(c) === String(ADMIN);
    const ism = upd.message.from.first_name || 'Mijoz';
    const un = upd.message.from.username ? '@' + upd.message.from.username : '-';
    const t = upd.message.text || '';

    // Admin voice → HR log
    if (upd.message.voice && isAdmin) { await handleVoice(c, upd.message.voice); return; }

    // Admin photo → Invoice
    if (upd.message.photo && isAdmin) {
      // Check if waiting for invoice client name
      if (invoiceState[c] && invoiceState[c].step === 'ask_client') {
        // This shouldn't happen (photo instead of text), just re-ask
        await msg(c, '❓ Mijoz ismini *matn* yuboring:');
        return;
      }
      await handleInvoicePhoto(c, upd.message.photo);
      return;
    }

    // Admin text reply to invoice client question
    if (isAdmin && invoiceState[c] && invoiceState[c].step === 'ask_client') {
      const handled = await handleInvoiceClientReply(c, t.trim());
      if (handled) return;
    }

    // Phone tracking
    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g, '')] = c;

    if (t === '/start') {
      state[c] = {};
      await btn(c, 'MEBEL BY IBROHIM\n\nIltimos tilni tanlang / Pozhaluysta viberite yazyk:', [[{ text: "O'zbek tili", callback_data: 'til_uz' }], [{ text: 'Russkiy yazyk', callback_data: 'til_ru' }]]);
      return;
    }

    if (t === '/hisobot' && isAdmin) { await sendReport(c); return; }

    if ((upd.message.photo || upd.message.document) && !isAdmin) {
      await msg(ADMIN, 'Yangi fayl! ' + ism + ' (' + un + ') ' + c);
      await fwd(ADMIN, c, upd.message.message_id);
      const s = state[c] || {};
      if (s.step === 'waiting_file') {
        state[c] = { lang: s.lang, step: 'done' };
        await msg(c, s.lang === 'uz' ? 'Fayl muvaffaqiyatli yuklandi!' : 'Fayl uspeshno zagruzhen!');
        await anketa(c, s.lang);
      }
      return;
    }

    if (!(state[c] || {}).lang && !isAdmin) {
      await btn(c, 'MEBEL BY IBROHIM\n\nTilni tanlang:', [[{ text: "O'zbek tili", callback_data: 'til_uz' }], [{ text: 'Russkiy yazyk', callback_data: 'til_ru' }]]);
    }
  } catch (e) { console.error(e); }
}

// ─── HTTP server ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try { await handle(JSON.parse(b)); } catch (e) { }
      res.writeHead(200); res.end('OK');
    });
  } else if (req.method === 'POST' && req.url === '/notify') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(b);
        const phone = (data.phone || '').replace(/\D/g, '');
        const lang = data.lang || 'uz';
        const name = data.name || 'Mijoz';
        const chatId = phoneToChat[phone] || null;
        if (chatId) {
          const uzMsg = 'Tabriklaymiz, ' + name + '!\n\nArizangiz muvaffaqiyatli yuborildi.\n\nTez orada siz bilan aloqaga chiqamiz!\n\n+998 91 135 44 66';
          const ruMsg = 'Pozdavlyaem, ' + name + '!\n\nVasha zayavka otpravlena.\n\nSvyazhemsya s vami!\n\n+998 91 135 44 66';
          await msg(chatId, lang === 'uz' ? uzMsg : ruMsg);
        }
      } catch (e) { console.error('notify error:', e); }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('OK');
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
  } else {
    res.writeHead(200); res.end('MBI Bot running!');
  }
}).listen(PORT, () => console.log('Bot running on port ' + PORT));
