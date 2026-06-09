const https = require('https');
const http = require('http');
const FormData = require('form-data');

const BOT      = '8811277023:AAH_1iBPjb-dlmPDWc1vwMCPQEITzLuWDec';
const ADMIN    = '1487569442';
const GROQ_KEY = process.env.GROQ_API_KEY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO  = 'yakubovibrohim/mbi-bot';
const LOG_FILE = 'hr-log.json';

const state = {};
const phoneToChat = {};

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
function msg(c, t) { return api('sendMessage', { chat_id: c, text: t }); }
function btn(c, t, b) { return api('sendMessage', { chat_id: c, text: t, reply_markup: { inline_keyboard: b } }); }
function fwd(c, f, m) { return api('forwardMessage', { chat_id: c, from_chat_id: f, message_id: m }); }
function acb(i) { return api('answerCallbackQuery', { callback_query_id: i }); }
function anketa(c, l) {
  const uz = 'Buyurtma berish uchun anketani toldiring:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html\n\nAnketani toldirgach ustamiz siz bilan boglanadi!';
  const ru = 'Dlya zakaza zapolnite anketu:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html\n\nMaster svyazhetsya s vami!';
  return msg(c, l === 'uz' ? uz : ru);
}

// ─── GitHub log ───────────────────────────────────────────────
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

async function appendLogs(entries) {
  try {
    let logs = [], sha = null;
    try {
      const existing = await ghGet(LOG_FILE);
      sha = existing.sha;
      logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    } catch (e) { logs = []; }

    for (const entry of entries) logs.push(entry);
    if (logs.length > 1000) logs = logs.slice(-1000);

    const label = entries.map(e => e.title).join(' | ');
    await ghPut(LOG_FILE, JSON.stringify(logs, null, 2), sha, 'HR: ' + label);
    return true;
  } catch (e) {
    console.error('GitHub log error:', e.message);
    return false;
  }
}

async function getMonthLogs(monthStr) {
  try {
    const existing = await ghGet(LOG_FILE);
    const logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    return logs.filter(l => l.date && l.date.slice(3) === monthStr);
  } catch (e) { return []; }
}

// ─── Audio download & transcribe ─────────────────────────────
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
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
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

// ─── Groq LLama parser — returns ARRAY of entries ────────────
function parseWithGroq(text, todayStr) {
  return new Promise((resolve) => {
    const system = `Sen MBI Mebel zavodining AI assistentisan. Bugun: ${todayStr}.

XODIMLAR ISMLARI (har qanday talaffuzda tanib ol):
- Sherzod = Sherzod, Şevzat, Shevzat, Шерзод, Şerzad, Şirzad, Shirzod
- Diyor = Diyor, Diyar, Диёр, Dyor, Diyer

XODIM YO'Q → "noma'lum" emas, eng yaqin ismni ol.

Bir xabarda BIR NECHTA hodisa/sana bo'lishi mumkin.
FAQAT JSON massiv qaytarasan (boshqa hech narsa, markdown yo'q):
[{"action":"attendance"|"avans"|"oylik"|"xarajat"|"boshqa","worker":"Diyor"|"Sherzod"|"noma'lum","present":true|false|null,"amount":number|null,"currency":"USD"|"UZS"|null,"date":"DD.MM.YYYY","note":"qisqa izoh"}]

SANA QOIDALARI (o'zbek/ozarbayjon/rus aralash):
- "bugun","bu gun","bugün","сегодня" → ${todayStr}
- "kecha","kece","dün","вчера" → kechagi sana
- "6-iyun","6 iyun","6-ci iyun","iyunun 6","6 июня" → 06.06.${todayStr.slice(6)}
- "7-iyun","8-iyun" → 07/08.06.${todayStr.slice(6)}
- Bir nechta sana → har biri uchun alohida entry
- Oy yo'q → joriy oy (${todayStr.slice(3)})

HARAKAT SO'ZLARI:
- keldi/gəldi/пришёл → present:true
- kelmadi/gəlmədi/kelmədi/işke gəlmədi/не пришёл → present:false
- avans/avans aldı/oldu avans → action:avans
- oylik/maosh → action:oylik

MISOLLAR:
- "bugun Sherzod kelmadi" → [{"action":"attendance","worker":"Sherzod","present":false,"date":"${todayStr}","note":"Sherzod bugun kelmadi","amount":null,"currency":null}]
- "Şevzat 6-ci və 8-ci iyun işke gəlmədi" → [{"action":"attendance","worker":"Sherzod","present":false,"date":"06.06.${todayStr.slice(6)}","note":"Sherzod 6-iyun kelmadi","amount":null,"currency":null},{"action":"attendance","worker":"Sherzod","present":false,"date":"08.06.${todayStr.slice(6)}","note":"Sherzod 8-iyun kelmadi","amount":null,"currency":null}]
- "Diyar kece 100 dollar avans aldı" → [{"action":"avans","worker":"Diyor","present":null,"amount":100,"currency":"USD","date":"KECHAGI_SANA","note":"Diyor $100 avans oldi"}]`;

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 800,
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
          let raw = JSON.parse(data).choices[0].message.content.trim();
          raw = raw.replace(/```json|```/g, '').trim();
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

// ─── Build title from parsed entry ───────────────────────────
function buildTitle(p) {
  const d = p.date || '';
  if (p.action === 'attendance') {
    return (p.present ? '✅' : '❌') + ' ' + d + ' | ' + p.worker + ' | ' + (p.present ? 'Ishga KELDI' : 'Ishga KELMADI');
  } else if (p.action === 'avans') {
    return '💵 ' + d + ' | ' + p.worker + ' | Avans: ' + (p.amount ? p.amount + ' ' + (p.currency || '') : '');
  } else if (p.action === 'oylik') {
    return '💰 ' + d + ' | ' + p.worker + ' | Oylik: ' + (p.amount ? p.amount + ' ' + (p.currency || '') : '');
  } else if (p.action === 'xarajat') {
    return '🧾 ' + d + ' | Xarajat: ' + (p.amount ? p.amount + ' ' + (p.currency || '') : '') + ' | ' + (p.note || '');
  }
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
    const parsedList = await parseWithGroq(transcript, todayStr);

    const entries = parsedList.map(p => ({
      date: p.date || todayStr,
      title: buildTitle(p),
      transcript,
      parsed: p,
      ts: new Date().toISOString()
    }));

    const saved = await appendLogs(entries);

    const lines = entries.map(e => '📋 ' + e.title).join('\n');
    const statusIcon = saved ? '✅ Saqlandi!' : '⚠️ Xato, qayta urinib ko\'ring';

    await api('sendMessage', {
      chat_id: chatId,
      text: statusIcon + '\n\n' + lines + '\n\n🎤 "' + transcript + '"',
      parse_mode: 'Markdown'
    });

  } catch (e) {
    console.error('Voice error:', e);
    await msg(chatId, '❌ Xatolik: ' + e.message);
  }
}

// ─── /hisobot command ─────────────────────────────────────────
async function sendReport(chatId) {
  try {
    const now = new Date();
    const monthStr = ('0' + (now.getMonth() + 1)).slice(-2) + '.' + now.getFullYear();
    const logs = await getMonthLogs(monthStr);

    if (!logs.length) { await msg(chatId, '📋 Bu oy hali qayd yo\'q.'); return; }

    const attendance = logs.filter(l => l.parsed && l.parsed.action === 'attendance');
    const avans = logs.filter(l => l.parsed && l.parsed.action === 'avans');
    const kelmadi = attendance.filter(l => l.parsed.present === false);

    let text = '📊 *' + monthStr + ' — Oylik hisobot*\n\n';

    if (kelmadi.length) {
      text += '❌ *Ishga kelmagan kunlar:*\n';
      const byWorker = {};
      kelmadi.forEach(l => {
        const w = l.parsed.worker;
        if (!byWorker[w]) byWorker[w] = [];
        byWorker[w].push(l.date);
      });
      for (const [worker, dates] of Object.entries(byWorker)) {
        text += `  • ${worker}: ${dates.join(', ')}\n`;
      }
      text += '\n';
    }

    if (avans.length) {
      text += '💵 *Avanslar:*\n';
      avans.forEach(l => {
        const amt = l.parsed.amount ? l.parsed.amount + ' ' + (l.parsed.currency || '') : '';
        text += `  • ${l.date} — ${l.parsed.worker}: ${amt}\n`;
      });
      const totalUSD = avans.filter(l => l.parsed.currency === 'USD').reduce((s, l) => s + (l.parsed.amount || 0), 0);
      if (totalUSD) text += `  Jami: $${totalUSD}\n`;
    }

    await api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch (e) { await msg(chatId, '❌ Hisobot xato: ' + e.message); }
}

// ─── Main update handler ──────────────────────────────────────
async function handle(upd) {
  try {
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const c = cq.message.chat.id;
      await acb(cq.id);
      if (cq.data === 'til_uz') {
        state[c] = { lang: 'uz', step: 'ask_file' };
        await btn(c, 'Sizda tayyor loyiha yoki xona rasmi bormi?', [
          [{ text: 'Ha, bor', callback_data: 'file_ha' }],
          [{ text: "Yo'q", callback_data: 'file_yoq' }]
        ]);
      } else if (cq.data === 'til_ru') {
        state[c] = { lang: 'ru', step: 'ask_file' };
        await btn(c, 'U vas est gotoviy proekt ili foto komnaty?', [
          [{ text: 'Da, est', callback_data: 'file_ha' }],
          [{ text: 'Net', callback_data: 'file_yoq' }]
        ]);
      } else if (cq.data === 'file_ha') {
        const l = (state[c] || {}).lang || 'uz';
        state[c] = { lang: l, step: 'waiting_file' };
        await msg(c, l === 'uz' ? 'Iltimos, fayl yoki rasmni yuboring:' : 'Pozhaluysta, otpravte fayl ili foto:');
      } else if (cq.data === 'file_yoq') {
        const l = (state[c] || {}).lang || 'uz';
        state[c] = { lang: l, step: 'done' };
        await anketa(c, l);
      }
      return;
    }

    if (!upd.message) return;
    const c = upd.message.chat.id;
    const ism = upd.message.from.first_name || 'Mijoz';
    const un = upd.message.from.username ? '@' + upd.message.from.username : '-';
    const t = upd.message.text || '';

    // Admin voice → AI
    if (upd.message.voice && String(c) === String(ADMIN)) {
      await handleVoice(c, upd.message.voice);
      return;
    }

    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g, '')] = c;

    if (t === '/start') {
      state[c] = {};
      await btn(c, 'MEBEL BY IBROHIM\n\nIltimos tilni tanlang / Pozhaluysta viberite yazyk:', [
        [{ text: "O'zbek tili", callback_data: 'til_uz' }],
        [{ text: 'Russkiy yazyk', callback_data: 'til_ru' }]
      ]);
      return;
    }

    if (t === '/hisobot' && String(c) === String(ADMIN)) {
      await sendReport(c);
      return;
    }

    if (upd.message.photo || upd.message.document) {
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

    if (!(state[c] || {}).lang) {
      await btn(c, 'MEBEL BY IBROHIM\n\nTilni tanlang:', [
        [{ text: "O'zbek tili", callback_data: 'til_uz' }],
        [{ text: 'Russkiy yazyk', callback_data: 'til_ru' }]
      ]);
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
          const uzMsg = 'Tabriklaymiz, ' + name + '!\n\nArizangiz muvaffaqiyatli yuborildi.\n\nKo\'nib chiqib, tez orada siz bilan aloqaga chiqamiz!\n\n+998 91 135 44 66';
          const ruMsg = 'Pozdavlyaem, ' + name + '!\n\nVasha zayavka uspeshno otpravlena.\n\nMy rassmotrim ee i svyazhemsya s vami!\n\n+998 91 135 44 66';
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
