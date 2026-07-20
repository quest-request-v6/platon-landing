const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 80;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const MAIL_TO = process.env.MAIL_TO || '';
const LEADS_FILE = process.env.LEADS_FILE || '/data/leads.jsonl';

const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

// простейшая защита от спама: не больше 10 заявок с одного адреса за 10 минут
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 10;
}

function fmtTime() {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Irkutsk', day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date()) + ' (Иркутск)';
}

function tgSend(text) {
  return new Promise((resolve) => {
    if (!TG_TOKEN || !TG_CHAT) return resolve(false);
    const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

async function mailSend(subject, text) {
  if (!mailer || !MAIL_TO) return false;
  try {
    await mailer.sendMail({ from: `"Автоплатон" <${process.env.SMTP_USER}>`, to: MAIL_TO, subject, text });
    return true;
  } catch (e) {
    console.error('mail error:', e.message);
    return false;
  }
}

function logLead(lead) {
  try {
    fs.mkdirSync(path.dirname(LEADS_FILE), { recursive: true });
    fs.appendFileSync(LEADS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...lead }) + '\n');
  } catch (e) {
    console.error('log error:', e.message);
  }
}

function esc(s) {
  return String(s).slice(0, 500).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handleLead(req, res, ip) {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
  req.on('end', async () => {
    try {
      if (rateLimited(ip)) { res.writeHead(429); return res.end('{"ok":false}'); }
      const lead = JSON.parse(raw);
      const phone = String(lead.phone || '').slice(0, 30);
      if (phone.replace(/\D/g, '').length < 10) { res.writeHead(400); return res.end('{"ok":false}'); }
      const name = String(lead.name || '').slice(0, 100);
      const source = String(lead.source || 'Лендинг').slice(0, 50);
      const details = Array.isArray(lead.details) ? lead.details.map(d => String(d).slice(0, 200)).slice(0, 12) : [];

      const tgText =
        `🚚 <b>Заявка с Автоплатона</b>\n` +
        `Источник: ${esc(source)}\n` +
        (name ? `Имя: ${esc(name)}\n` : '') +
        `Телефон: ${esc(phone)}\n` +
        (details.length ? details.map(esc).join('\n') + '\n' : '') +
        `⏰ ${fmtTime()} — перезвонить в течение 15 минут!`;
      const mailText =
        `Заявка с platon.qrq.ru\n\nИсточник: ${source}\n` +
        (name ? `Имя: ${name}\n` : '') + `Телефон: ${phone}\n` +
        (details.length ? '\n' + details.join('\n') + '\n' : '') + `\nВремя: ${fmtTime()}`;

      logLead({ ip, source, name, phone, details });
      const [tg, mail] = await Promise.all([tgSend(tgText), mailSend(`Заявка: ${phone} (${source})`, mailText)]);
      console.log(`lead from ${ip}: tg=${tg} mail=${mail} phone=${phone}`);
      if (!tg && !mail) { res.writeHead(502); return res.end('{"ok":false}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400); res.end('{"ok":false}');
    }
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/demo.webm': ['demo.webm', 'video/webm'],
};

http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res, ip);
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  const hit = STATIC[(req.url || '/').split('?')[0]];
  if (req.method === 'GET' && hit) {
    res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, hit[0])).pipe(res);
  }
  res.writeHead(302, { Location: '/' });
  res.end();
}).listen(PORT, () => console.log('platon-landing on :' + PORT));
