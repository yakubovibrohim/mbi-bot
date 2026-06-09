const https = require('https');
const http = require('http');
const FormData = require('form-data');

const BOT        = '8811277023:AAH_1iBPjb-dlmPDWc1vwMCPQEITzLuWDec';
const ADMIN      = '1487569442';
const GROQ_KEY   = process.env.GROQ_API_KEY;
const GH_TOKEN   = process.env.GITHUB_TOKEN;
const GH_REPO    = 'yakubovibrohim/mbi-bot';
const LOG_FILE   = 'hr-log.json';

const state = {};
const phoneToChat = {};

// ─── Telegram helpers ───────────────────────────────
function api(method, data) {
  return new Promise((res, rej) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT + '/' + method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}
function msg(c,t){ return api('sendMessage',{chat_id:c,text:t}); }
function btn(c,t,b){ return api('sendMessage',{chat_id:c,text:t,reply_markup:{inline_keyboard:b}}); }
function fwd(c,f,m){ return api('forwardMessage',{chat_id:c,from_chat_id:f,message_id:m}); }
function acb(i){ return api('answerCallbackQuery',{callback_query_id:i}); }
function anketa(c,l){
  const uz='Buyurtma berish uchun anketani toldiring:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa.html\n\nAnketani toldirgach ustamiz siz bilan boglanadi!';
  const ru='Dlya zakaza zapolnite anketu:\n\nhttps://yakubovibrohim.github.io/MBI_anketa/mebel_anketa_ru.html\n\nMaster svyazhetsya s vami!';
  return msg(c, l==='uz'?uz:ru);
}

// ─── GitHub log (hr-log.json) ────────────────────────
function ghGet(path) {
  return new Promise((res, rej) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/' + GH_REPO + '/contents/' + path,
      method: 'GET',
      headers: { 'Authorization':'token '+GH_TOKEN, 'User-Agent':'mbi-bot', 'Accept':'application/vnd.github.v3+json' }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); });
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
      headers: { 'Authorization':'token '+GH_TOKEN, 'User-Agent':'mbi-bot', 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) }
    }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>res(JSON.parse(d))); });
    req.on('error', rej); req.write(body); req.end();
  });
}

async function appendLog(entry) {
  try {
    let logs = [];
    let sha = null;
    try {
      const existing = await ghGet(LOG_FILE);
      sha = existing.sha;
      logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    } catch(e) { logs = []; }

    logs.push(entry);
    // Keep last 500 records
    if (logs.length > 500) logs = logs.slice(-500);

    await ghPut(LOG_FILE, JSON.stringify(logs, null, 2), sha, 'HR log: ' + entry.title);
    return true;
  } catch(e) {
    console.error('GitHub log error:', e.message);
    return false;
  }
}

async function getTodayLogs() {
  try {
    const existing = await ghGet(LOG_FILE);
    const logs = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8'));
    const today = new Date().toLocaleDateString('uz-UZ', { timeZone:'Asia/Tashkent', day:'2-digit', month:'2-digit', year:'numeric' });
    return logs.filter(l => l.date === today);
  } catch(e) { return []; }
}

// ─── Groq Whisper ───────────────────────────────────
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
    form.append('language', 'uz');
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + GROQ_KEY, ...form.getHeaders() }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data).text || ''); } catch(e) { reject(new Error('Whisper error: '+data)); } });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// ─── Groq LLama parser ──────────────────────────────
function parseWithGroq(text) {
  return new Promise((resolve, reject) => {
    const system = `Sen MBI Mebel zavodining AI assistentisan.
Xo'jayin Ibrohim audio xabar yuboradi, sen uni tahlil qilib FAQAT quyidagi JSON formatda javob berasan (boshqa hech narsa yozma, markdown ham yozma):
{"action":"attendance"|"avans"|"oylik"|"xarajat"|"boshqa","worker":"Diyor"|"Sherzod"|"noma'lum","present":true|false|null,"amount":number|null,"currency":"USD"|"UZS"|null,"note":"qisqa o'zbekcha izoh"}
Misollar:
- "bugun Sherzod ishga kelmadi" → {"action":"attendance","worker":"Sherzod","present":false,"amount":null,"currency":null,"note":"Sherzod bugun kelmadi"}
- "Diyor 100 dollar avans oldi" → {"action":"avans","worker":"Diyor","present":null,"amount":100,"currency":"USD","note":"Diyor $100 avans oldi"}
- "Sherzod bugun keldi" → {"action":"attendance","worker":"Sherzod","present":true,"amount":null,"currency":null,"note":"Sherzod bugun keldi"}`;

    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile', max_tokens: 300,
      messages: [{ role:'system', content:system }, { role:'user', content:text }]
    });
    const req = https.request({
      hostname: 'api.groq.com', path: '/openai/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+GROQ_KEY, 'Content-Length':Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(JSON.parse(data).choices[0].message.content.trim())); }
        catch(e) { resolve({ action:'boshqa', worker:"noma'lum", amount:null, currency:null, note:text }); }
      });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

// ─── Voice handler ──────────────────────────────────
async function handleVoice(chatId, voice) {
  try {
    await msg(chatId, '⏳ Tahlil qilinmoqda...');
    const fileInfo = await api('getFile', { file_id: voice.file_id });
    const fileUrl  = 'https://api.telegram.org/file/bot' + BOT + '/' + fileInfo.result.file_path;
    const audio    = await downloadBuffer(fileUrl);
    const transcript = await transcribeAudio(audio);
    const parsed   = await parseWithGroq(transcript);

    const today = new Date().toLocaleDateString('uz-UZ', { timeZone:'Asia/Tashkent', day:'2-digit', month:'2-digit', year:'numeric' });
    let title = '', icon = '';

    if (parsed.action === 'attendance') {
      icon  = parsed.present ? '✅' : '❌';
      title = `${icon} ${today} | ${parsed.worker} | ${parsed.present ? 'Ishga KELDI' : 'Ishga KELMADI'}`;
    } else if (parsed.action === 'avans') {
      const amt = parsed.amount ? `${parsed.amount} ${parsed.currency||''}` : '';
      icon  = '💵'; title = `💵 ${today} | ${parsed.worker} | Avans: ${amt}`;
    } else if (parsed.action === 'oylik') {
      const amt = parsed.amount ? `${parsed.amount} ${parsed.currency||''}` : '';
      icon  = '💰'; title = `💰 ${today} | ${parsed.worker} | Oylik: ${amt}`;
    } else if (parsed.action === 'xarajat') {
      const amt = parsed.amount ? `${parsed.amount} ${parsed.currency||''}` : '';
      icon  = '🧾'; title = `🧾 ${today} | Xarajat: ${amt} | ${parsed.note||''}`;
    } else {
      icon  = '📝'; title = `📝 ${today} | ${parsed.note || transcript}`;
    }

    const logEntry = { date: today, title, transcript, parsed, ts: new Date().toISOString() };
    const saved = await appendLog(logEntry);

    await api('sendMessage', {
      chat_id: chatId,
      text: (saved ? '✅ Saqlandi!\n\n' : '⚠️ Saqlashda xato, lekin qabul qilindi!\n\n') +
            '📋 ' + title + '\n\n🎤 "' + transcript + '"',
      parse_mode: 'Markdown'
    });
  } catch(e) {
    console.error('Voice error:', e);
    await msg(chatId, '❌ Xatolik: ' + e.message);
  }
}

// ─── /hisobot command ───────────────────────────────
async function sendReport(chatId) {
  try {
    const logs = await getTodayLogs();
    if (!logs.length) { await msg(chatId, '📋 Bugun hali qayd yo\'q.'); return; }
    const text = '📋 *Bugungi hisobot:*\n\n' + logs.map(l => l.title).join('\n');
    await api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch(e) { await msg(chatId, '❌ Hisobot olishda xato: ' + e.message); }
}

// ─── Main handler ────────────────────────────────────
async function handle(upd) {
  try {
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const c  = cq.message.chat.id;
      await acb(cq.id);
      if (cq.data === 'til_uz') {
        state[c] = { lang:'uz', step:'ask_file' };
        await btn(c, 'Sizda tayyor loyiha yoki xona rasmi bormi?', [
          [{ text:'Ha, bor', callback_data:'file_ha' }],
          [{ text:"Yo'q", callback_data:'file_yoq' }]
        ]);
      } else if (cq.data === 'til_ru') {
        state[c] = { lang:'ru', step:'ask_file' };
        await btn(c, 'U vas est gotoviy proekt ili foto komnaty?', [
          [{ text:'Da, est', callback_data:'file_ha' }],
          [{ text:'Net', callback_data:'file_yoq' }]
        ]);
      } else if (cq.data === 'file_ha') {
        const l = (state[c]||{}).lang||'uz';
        state[c] = { lang:l, step:'waiting_file' };
        await msg(c, l==='uz' ? 'Iltimos, fayl yoki rasmni yuboring:' : 'Pozhaluysta, otpravte fayl ili foto:');
      } else if (cq.data === 'file_yoq') {
        const l = (state[c]||{}).lang||'uz';
        state[c] = { lang:l, step:'done' };
        await anketa(c, l);
      }
      return;
    }

    if (!upd.message) return;
    const c   = upd.message.chat.id;
    const ism = upd.message.from.first_name || 'Mijoz';
    const un  = upd.message.from.username ? '@'+upd.message.from.username : '-';
    const t   = upd.message.text || '';

    // Admin voice → AI assistant
    if (upd.message.voice && String(c) === String(ADMIN)) {
      await handleVoice(c, upd.message.voice);
      return;
    }

    const phoneMatch = t.match(/(\+998|998)\d{9}/);
    if (phoneMatch) phoneToChat[phoneMatch[0].replace(/\D/g,'')] = c;

    if (t === '/start') {
      state[c] = {};
      await btn(c, 'MEBEL BY IBROHIM\n\nIltimos tilni tanlang / Pozhaluysta viberite yazyk:', [
        [{ text:"O'zbek tili", callback_data:'til_uz' }],
        [{ text:'Russkiy yazyk', callback_data:'til_ru' }]
      ]);
      return;
    }

    if (t === '/hisobot' && String(c) === String(ADMIN)) {
      await sendReport(c);
      return;
    }

    if (upd.message.photo || upd.message.document) {
      await msg(ADMIN, 'Yangi fayl! '+ism+' ('+un+') '+c);
      await fwd(ADMIN, c, upd.message.message_id);
      const s = state[c]||{};
      if (s.step === 'waiting_file') {
        state[c] = { lang:s.lang, step:'done' };
        await msg(c, s.lang==='uz' ? 'Fayl muvaffaqiyatli yuklandi!' : 'Fayl uspeshno zagruzhen!');
        await anketa(c, s.lang);
      }
      return;
    }

    if (!(state[c]||{}).lang) {
      await btn(c, 'MEBEL BY IBROHIM\n\nTilni tanlang:', [
        [{ text:"O'zbek tili", callback_data:'til_uz' }],
        [{ text:'Russkiy yazyk', callback_data:'til_ru' }]
      ]);
    }
  } catch(e) { console.error(e); }
}

// ─── HTTP Server ─────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try { await handle(JSON.parse(b)); } catch(e) {}
      res.writeHead(200); res.end('OK');
    });
  } else if (req.method === 'POST' && req.url === '/notify') {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(b);
        const phone = (data.phone||'').replace(/\D/g,'');
        const lang  = data.lang||'uz';
        const name  = data.name||'Mijoz';
        const chatId = phoneToChat[phone]||null;
        if (chatId) {
          const uzMsg = 'Tabriklaymiz, '+name+'!\n\nArizangiz muvaffaqiyatli yuborildi.\n\nKo\'nib chiqib, tez orada siz bilan aloqaga chiqamiz!\n\n+998 91 135 44 66';
          const ruMsg = 'Pozdavlyaem, '+name+'!\n\nVasha zayavka uspeshno otpravlena.\n\nMy rassmotrim ee i svyazhemsya s vami!\n\n+998 91 135 44 66';
          await msg(chatId, lang==='uz'?uzMsg:ruMsg);
        }
      } catch(e) { console.error('notify error:', e); }
      res.writeHead(200, {'Access-Control-Allow-Origin':'*'}); res.end('OK');
    });
  } else if (req.method === 'OPTIONS') {
    res.writeHead(200, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type'});
    res.end();
  } else {
    res.writeHead(200); res.end('MBI Bot running!');
  }
}).listen(PORT, () => console.log('Bot running on port ' + PORT));
