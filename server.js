'use strict';
// sunsFamilyBill —— 家庭记账服务端（零依赖，Node >= 22，自带 node:sqlite）
// 数据只存本机：data/family.db（SQLite 单文件）
// 入口有三个：
//   1) 微信服务号回调  GET/POST /wechat   —— 家人在服务号里发消息记账
//   2) 网页账本        GET /              —— 手机/电脑浏览器看账、补录
//   3) JSON API        /api/bills 等      —— 给网页和后续程序用
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMessage, fmtDate } = require('./lib/parse');

const PORT = Number(process.env.PORT || 4180);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'sunsfamilybill'; // 必须与服务号后台填的 Token 一致
// 家庭成员：环境变量 FAMILY_MEMBERS="openid1=爸爸,openid2=妈妈"；不在表里的关注者默认用 openid 后6位称呼
const MEMBER_MAP = {};
for (const pair of (process.env.FAMILY_MEMBERS || '').split(',').filter(Boolean)) {
  const i = pair.indexOf('='); if (i > 0) MEMBER_MAP[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
}
// 白名单（可选）：设置 WECHAT_WHITELIST="openid1,openid2" 后，非家庭成员发消息不记账
const WHITELIST = (process.env.WECHAT_WHITELIST || '').split(',').map(s => s.trim()).filter(Boolean);

let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  db = new DatabaseSync(path.join(__dirname, 'data', 'family.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS bills(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL, item TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'expense',
    member TEXT DEFAULT '', openid TEXT DEFAULT '',
    raw TEXT DEFAULT '', created_at TEXT NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bills_date ON bills(date)');
} catch (e) {
  console.error('SQLite 不可用，服务无法启动：', e.message); process.exit(1);
}

const yuan = cents => (cents / 100).toFixed(2);
function memberName(openid) { return MEMBER_MAP[openid] || (openid ? '家人' + openid.slice(-4) : '网页'); }

function addBill(b) {
  const info = db.prepare('INSERT INTO bills(date,item,amount_cents,kind,member,openid,raw,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(b.date, b.item, b.amountCents, b.kind, b.member || '', b.openid || '', b.raw || '', new Date().toISOString());
  return Number(info.lastInsertRowid);
}
function monthSummary(month) {
  const row = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN kind='expense' THEN amount_cents END),0) AS exp,
    COALESCE(SUM(CASE WHEN kind='income' THEN amount_cents END),0) AS inc,
    COUNT(*) AS n FROM bills WHERE substr(date,1,7)=?`).get(month);
  return row;
}
function listBills({ month, date, limit = 200 }) {
  if (date) return db.prepare('SELECT * FROM bills WHERE date=? ORDER BY id DESC LIMIT ?').all(date, limit);
  return db.prepare('SELECT * FROM bills WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC LIMIT ?').all(month, limit);
}

// ---------- 微信服务号 ----------
function checkSignature(query) {
  const arr = [WECHAT_TOKEN, query.timestamp || '', query.nonce || ''].sort();
  const sha1 = crypto.createHash('sha1').update(arr.join('')).digest('hex');
  return sha1 === query.signature;
}
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
}
function replyText(to, from, content) {
  const safe = String(content).replace(/]]>/g, ']] >');
  return `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${safe}]]></Content></xml>`;
}
const HELP = '发一句话就能记账，格式：\n日期 事项 金额\n例：2026-11-17 打车 35\n日期可省略（默认今天），也可写：11月17日 午饭 28、昨天 停车 10\n收入例：收入 工资 12000\n命令：本月 / 今天 / 查 2026-11 / 删除上一笔 / 帮助';

function handleWechatText(openid, content) {
  if (WHITELIST.length && !WHITELIST.includes(openid)) return '这个服务号只给家里人记账，你的账号还没有加入家庭名单，请联系管理员把你的 openid 加进白名单。';
  const member = memberName(openid);
  const p = parseMessage(content, new Date());
  if (p.type === 'command') {
    if (p.command === 'help') return HELP;
    if (p.command === 'undo_last') {
      const last = db.prepare('SELECT * FROM bills WHERE openid=? ORDER BY id DESC LIMIT 1').get(openid)
        || db.prepare('SELECT * FROM bills ORDER BY id DESC LIMIT 1').get();
      if (!last) return '还没有任何账目，没什么可删的。';
      db.prepare('DELETE FROM bills WHERE id=?').run(last.id);
      return `已删除上一笔：${last.date} ${last.item} ¥${yuan(last.amount_cents)}`;
    }
    if (p.command === 'month_summary' || p.command === 'query') {
      const month = p.month || fmtDate(new Date()).slice(0, 7);
      const s = monthSummary(month);
      const bills = p.date ? listBills({ date: p.date }) : listBills({ month, limit: 10 });
      let out = `${month} 汇总\n花销 ¥${yuan(s.exp)}｜收入 ¥${yuan(s.inc)}｜共 ${s.n} 笔`;
      if (bills.length) out += '\n— 最近 —\n' + bills.map(b => `${b.date.slice(5)} ${b.item} ¥${yuan(b.amount_cents)}`).join('\n');
      return out;
    }
    if (p.command === 'today_list') {
      const today = fmtDate(new Date());
      const bills = listBills({ date: today });
      if (!bills.length) return `今天（${today}）还没有记账。`;
      const total = bills.filter(b => b.kind === 'expense').reduce((a, b) => a + b.amount_cents, 0);
      return `今天（${today}）共 ${bills.length} 笔，花销 ¥${yuan(total)}\n` + bills.map(b => `${b.item} ¥${yuan(b.amount_cents)}`).join('\n');
    }
  }
  if (p.type === 'bill') {
    addBill({ ...p, member, openid });
    const s = monthSummary(p.date.slice(0, 7));
    return `✅ 已记账（${member}）\n日期：${p.date}\n事项：${p.item}\n${p.kind === 'income' ? '收入' : '花销'}：¥${yuan(p.amountCents)}\n${p.date.slice(0, 7)} 累计花销：¥${yuan(s.exp)}（${s.n} 笔）`;
  }
  return '没看懂这笔账。\n' + HELP;
}

// ---------- HTTP ----------
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); }); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });

  if (url.pathname === '/wechat') {
    if (req.method === 'GET') { // 服务号后台的 URL 验证
      if (checkSignature(q)) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(q.echostr || ''); }
      res.writeHead(403); return res.end('signature mismatch');
    }
    if (req.method === 'POST') {
      if (!checkSignature(q)) { res.writeHead(403); return res.end('signature mismatch'); }
      const xml = await readBody(req);
      const msgType = xmlTag(xml, 'MsgType');
      const from = xmlTag(xml, 'FromUserName'), to = xmlTag(xml, 'ToUserName');
      let reply;
      if (msgType === 'text') reply = handleWechatText(from, xmlTag(xml, 'Content'));
      else if (msgType === 'event' && xmlTag(xml, 'Event') === 'subscribe') reply = '欢迎关注家里的小账本！\n' + HELP;
      else reply = '只认文字消息哦。\n' + HELP;
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(replyText(from, to, reply));
    }
  }

  if (url.pathname === '/api/bills' && req.method === 'GET') {
    const month = q.month || fmtDate(new Date()).slice(0, 7);
    return sendJson(res, 200, { month, summary: monthSummary(month), bills: listBills({ month, date: q.date }) });
  }
  if (url.pathname === '/api/bills' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const p = body.text ? parseMessage(body.text, new Date()) : body;
      if (p.type && p.type !== 'bill') return sendJson(res, 400, { error: '无法解析这句话' });
      const amountCents = p.amountCents || Math.round(Number(p.amount) * 100);
      if (!p.date || !p.item || !(amountCents > 0)) return sendJson(res, 400, { error: '需要 date、item、amount' });
      const id = addBill({ date: p.date, item: p.item, amountCents, kind: p.kind || 'expense', member: body.member || '网页', openid: '', raw: body.text || '' });
      return sendJson(res, 201, { id });
    } catch { return sendJson(res, 400, { error: 'bad json' }); }
  }
  const del = url.pathname.match(/^\/api\/bills\/(\d+)$/);
  if (del && req.method === 'DELETE') { db.prepare('DELETE FROM bills WHERE id=?').run(Number(del[1])); return sendJson(res, 200, { ok: true }); }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`sunsFamilyBill 已启动： http://localhost:${PORT}  微信回调： /wechat （Token=${WECHAT_TOKEN}）`));
