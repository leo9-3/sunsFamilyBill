'use strict';
// sunsFamilyBill —— 家庭记账服务端（零依赖，Node >= 22，自带 node:sqlite）
// 数据只存本机：data/family.db（SQLite 单文件）
// 入口有三个：
//   1) 微信服务号回调  GET/POST /wechat   —— 家人在服务号里发消息记账（不需要口令）
//   2) 网页账本        GET /              —— 手机/电脑浏览器看账、补录（需要管理口令登录）
//   3) JSON API        /api/bills 等      —— 给网页和后续程序用（需要管理口令登录）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseMessage, fmtDate } = require('./lib/parse');

const PORT = Number(process.env.PORT || 4180);
const WECHAT_TOKEN = process.env.WECHAT_TOKEN || 'sunsfamilybill'; // 必须与服务号后台填的 Token 一致
// 家庭成员：环境变量 FAMILY_MEMBERS="openid1=爸爸,openid2=妈妈"；网页改名（members 表）优先于它，都没有时用 openid 后4位称呼
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
  // v0.2 新增：预算（key = YYYY-MM 月预算 / YYYY 年预算）、成员改名、设置（管理口令）
  db.exec('CREATE TABLE IF NOT EXISTS budgets(key TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS members(openid TEXT PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES('admin_pass','mermaid888')").run();
} catch (e) {
  console.error('SQLite 不可用，服务无法启动：', e.message); process.exit(1);
}

const yuan = cents => (cents / 100).toFixed(2);

// ---------- 成员 ----------
function memberName(openid) {
  if (!openid) return '网页';
  const row = db.prepare('SELECT name FROM members WHERE openid=?').get(openid);
  if (row && row.name) return row.name;
  return MEMBER_MAP[openid] || ('家人' + openid.slice(-4));
}
// 账单对外展示：成员名按当前 members 表解析（改名后老账单也显示新名）
function presentBill(b) { return { ...b, member: b.openid ? memberName(b.openid) : (b.member || '网页') }; }

// ---------- 设置 / 管理口令 ----------
function getSetting(key) { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? r.value : null; }
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
function getAdminPass() { return getSetting('admin_pass') || 'mermaid888'; }

const ADMIN_COOKIE = 'sfb_admin';
const SESSION_MS = 30 * 24 * 3600 * 1000; // 登录 cookie 有效期 30 天
function signSession(pass) {
  const ts = String(Date.now());
  const mac = crypto.createHmac('sha256', pass).update('sfb:' + ts).digest('hex');
  return `${ts}.${mac}`;
}
function checkSession(cookieHeader) {
  if (!cookieHeader) return false;
  const m = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`));
  if (!m) return false;
  let val; try { val = decodeURIComponent(m[1]); } catch { return false; }
  const dot = val.lastIndexOf('.'); if (dot <= 0) return false;
  const ts = val.slice(0, dot), mac = val.slice(dot + 1);
  if (!/^\d+$/.test(ts) || Date.now() - Number(ts) > SESSION_MS) return false;
  const expect = crypto.createHmac('sha256', getAdminPass()).update('sfb:' + ts).digest('hex');
  return mac.length === expect.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect));
}
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sunsFamilyBill · 登录</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f7f9;margin:0}
.box{max-width:340px;margin:18vh auto;background:#fff;border-radius:10px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08);text-align:center}
h1{font-size:19px;margin:0 0 16px}input,button{font-size:16px;padding:10px;border-radius:6px;width:100%;box-sizing:border-box}
input{border:1px solid #ccc;margin-bottom:10px}button{background:linear-gradient(160deg,#4353e8,#8b6cf0);color:#fff;border:none;cursor:pointer}
.err{color:#c0392b;font-size:14px;min-height:20px}</style></head>
<body><div class="box"><h1>🏠 家庭账本 · 管理登录</h1>
<input id="pw" type="password" placeholder="管理口令" autocomplete="current-password">
<div class="err" id="err"></div><button id="go">进入账本</button></div>
<script>
async function login(){ const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:document.getElementById('pw').value})});
  if(r.ok) location.reload(); else document.getElementById('err').textContent='口令不对，再试试'; }
document.getElementById('go').onclick=login;
document.getElementById('pw').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;

// ---------- 账单 / 汇总 ----------
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
function yearExpense(year) {
  const row = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) AS exp FROM bills WHERE kind='expense' AND substr(date,1,4)=?`).get(year);
  return row.exp;
}
function yearSummary(year) {
  const rows = db.prepare(`SELECT substr(date,1,7) AS m,
    COALESCE(SUM(CASE WHEN kind='expense' THEN amount_cents END),0) AS exp,
    COALESCE(SUM(CASE WHEN kind='income' THEN amount_cents END),0) AS inc,
    COUNT(*) AS n FROM bills WHERE substr(date,1,4)=? GROUP BY m`).all(year);
  const byMonth = {}; for (const r of rows) byMonth[r.m] = r;
  const months = [];
  for (let i = 1; i <= 12; i++) {
    const key = `${year}-${String(i).padStart(2, '0')}`;
    const r = byMonth[key] || { exp: 0, inc: 0, n: 0 };
    months.push({ month: key, exp: r.exp, inc: r.inc, n: r.n, budget: getBudget(key) });
  }
  const totals = months.reduce((a, m) => ({ exp: a.exp + m.exp, inc: a.inc + m.inc, n: a.n + m.n }), { exp: 0, inc: 0, n: 0 });
  const yb = getBudget(year);
  return {
    year, months, totals,
    yearBudget: yb,
    yearBudgetUsed: totals.exp,
    yearBudgetRemaining: yb == null ? null : yb - totals.exp,
  };
}
function listBills({ month, date, limit = 200 }) {
  if (date) return db.prepare('SELECT * FROM bills WHERE date=? ORDER BY id DESC LIMIT ?').all(date, limit);
  return db.prepare('SELECT * FROM bills WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC LIMIT ?').all(month, limit);
}

// ---------- 预算 ----------
function getBudget(key) {
  const r = db.prepare('SELECT amount_cents FROM budgets WHERE key=?').get(key);
  return r ? r.amount_cents : null;
}
function setBudget(key, cents) {
  db.prepare('INSERT INTO budgets(key,amount_cents) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET amount_cents=excluded.amount_cents').run(key, cents);
}
// 记账成功后附带的预算提示：月预算优先，没设月预算时用全年预算
function budgetNote(month) {
  const mb = getBudget(month);
  if (mb != null) {
    const s = monthSummary(month);
    const rem = mb - s.exp;
    return rem >= 0
      ? `\n本月预算剩余：¥${yuan(rem)}（预算 ¥${yuan(mb)}）`
      : `\n⚠️ 本月已超支 ¥${yuan(-rem)}（预算 ¥${yuan(mb)}，已花 ¥${yuan(s.exp)}）`;
  }
  const year = month.slice(0, 4);
  const yb = getBudget(year);
  if (yb != null) {
    const used = yearExpense(year);
    const rem = yb - used;
    return rem >= 0
      ? `\n今年预算剩余：¥${yuan(rem)}（全年预算 ¥${yuan(yb)}）`
      : `\n⚠️ 今年已超支 ¥${yuan(-rem)}（全年预算 ¥${yuan(yb)}，已花 ¥${yuan(used)}）`;
  }
  return '';
}
function budgetStatusText() {
  const now = new Date();
  const month = fmtDate(now).slice(0, 7), year = month.slice(0, 4);
  const s = monthSummary(month);
  let out;
  const mb = getBudget(month);
  if (mb != null) {
    const rem = mb - s.exp;
    out = `本月（${month}）预算 ¥${yuan(mb)}，已花 ¥${yuan(s.exp)}，${rem >= 0 ? '剩余 ¥' + yuan(rem) : '已超支 ¥' + yuan(-rem)}`;
  } else {
    out = `本月（${month}）还没设预算，已花 ¥${yuan(s.exp)}。发「预算 3000」就能设本月预算`;
  }
  const yb = getBudget(year);
  if (yb != null) {
    const used = yearExpense(year);
    const rem = yb - used;
    out += `\n全年预算 ¥${yuan(yb)}，已花 ¥${yuan(used)}，${rem >= 0 ? '剩余 ¥' + yuan(rem) : '已超支 ¥' + yuan(-rem)}`;
  }
  return out;
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
const HELP = '发一句话就能记账，格式：\n日期 事项 金额\n例：2026-11-17 打车 35\n日期可省略（默认今天），也可写：11月17日 午饭 28、昨天 停车 10\n收入例：收入 工资 12000\n命令：本月 / 今天 / 查 2026-11 / 删除上一笔 / 帮助\n预算：预算 3000（设本月预算）/ 全年预算 50000 / 查预算';

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
    if (p.command === 'set_budget') {
      if (!(p.amountCents > 0)) return '预算金额要大于 0，例如：预算 3000';
      const month = fmtDate(new Date()).slice(0, 7);
      setBudget(month, p.amountCents);
      const s = monthSummary(month);
      const rem = p.amountCents - s.exp;
      return `✅ 已设置本月（${month}）预算：¥${yuan(p.amountCents)}\n本月已花 ¥${yuan(s.exp)}，${rem >= 0 ? '剩余 ¥' + yuan(rem) : '已超支 ¥' + yuan(-rem)}`;
    }
    if (p.command === 'set_year_budget') {
      if (!(p.amountCents > 0)) return '预算金额要大于 0，例如：全年预算 50000';
      const year = fmtDate(new Date()).slice(0, 4);
      setBudget(year, p.amountCents);
      const used = yearExpense(year);
      const rem = p.amountCents - used;
      return `✅ 已设置全年（${year}）预算：¥${yuan(p.amountCents)}\n今年已花 ¥${yuan(used)}，${rem >= 0 ? '剩余 ¥' + yuan(rem) : '已超支 ¥' + yuan(-rem)}`;
    }
    if (p.command === 'budget_query') return budgetStatusText();
  }
  if (p.type === 'bill') {
    addBill({ ...p, member, openid });
    const s = monthSummary(p.date.slice(0, 7));
    let out = `✅ 已记账（${member}）\n日期：${p.date}\n事项：${p.item}\n${p.kind === 'income' ? '收入' : '花销'}：¥${yuan(p.amountCents)}\n${p.date.slice(0, 7)} 累计花销：¥${yuan(s.exp)}（${s.n} 笔）`;
    if (p.kind === 'expense') out += budgetNote(p.date.slice(0, 7));
    return out;
  }
  return '没看懂这笔账。\n' + HELP;
}

// ---------- HTTP ----------
function sendJson(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let s = ''; req.on('data', c => s += c); req.on('end', () => r(s)); }); }
async function readJson(req) { try { return JSON.parse(await readBody(req)); } catch { return null; } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, time: new Date().toISOString() });

  // 微信回调：绝不能被管理口令拦截
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

  // 管理登录（登录接口本身不拦）
  if (url.pathname === '/login' && req.method === 'POST') {
    const raw = await readBody(req);
    let pass = '';
    try { const j = JSON.parse(raw); pass = j.pass ?? j.password ?? ''; }
    catch { pass = new URLSearchParams(raw).get('pass') || ''; }
    if (pass && String(pass) === getAdminPass()) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Set-Cookie': `${ADMIN_COOKIE}=${signSession(getAdminPass())}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}; SameSite=Lax`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return sendJson(res, 401, { error: '口令不对' });
  }
  if (url.pathname === '/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': `${ADMIN_COOKIE}=; HttpOnly; Path=/; Max-Age=0` });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 管理口令门禁：网页和 /api/* 都要先登录
  const isApi = url.pathname.startsWith('/api/');
  const isPage = url.pathname === '/' || url.pathname === '/index.html';
  if ((isApi || isPage) && !checkSession(req.headers.cookie)) {
    if (isApi) return sendJson(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML);
  }

  if (url.pathname === '/api/bills' && req.method === 'GET') {
    const month = q.month || fmtDate(new Date()).slice(0, 7);
    const bills = listBills({ month, date: q.date }).map(presentBill);
    return sendJson(res, 200, { month, summary: monthSummary(month), bills });
  }
  if (url.pathname === '/api/bills' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const p = body.text ? parseMessage(body.text, new Date()) : body;
      if (p.type && p.type !== 'bill') return sendJson(res, 400, { error: '无法解析这句话' });
      const amountCents = p.amountCents || Math.round(Number(p.amount) * 100);
      if (!p.date || !p.item || !(amountCents > 0)) return sendJson(res, 400, { error: '需要 date、item、amount' });
      const id = addBill({ date: p.date, item: p.item, amountCents, kind: p.kind || 'expense', member: body.member || '网页', openid: body.openid || '', raw: body.text || '' });
      return sendJson(res, 201, { id });
    } catch { return sendJson(res, 400, { error: 'bad json' }); }
  }
  const del = url.pathname.match(/^\/api\/bills\/(\d+)$/);
  if (del && req.method === 'DELETE') { db.prepare('DELETE FROM bills WHERE id=?').run(Number(del[1])); return sendJson(res, 200, { ok: true }); }

  // 全年总览
  if (url.pathname === '/api/year' && req.method === 'GET') {
    const year = /^\d{4}$/.test(q.year || '') ? q.year : fmtDate(new Date()).slice(0, 4);
    return sendJson(res, 200, yearSummary(year));
  }
  // 全局搜索：匹配 事项 / 原始消息 / 成员名
  if (url.pathname === '/api/search' && req.method === 'GET') {
    const kw = (q.q || '').trim().toLowerCase();
    if (!kw) return sendJson(res, 200, { q: '', summary: { exp: 0, inc: 0, n: 0 }, bills: [] });
    const all = db.prepare('SELECT * FROM bills ORDER BY date DESC, id DESC').all().map(presentBill);
    const hits = all.filter(b =>
      (b.item || '').toLowerCase().includes(kw) ||
      (b.raw || '').toLowerCase().includes(kw) ||
      (b.member || '').toLowerCase().includes(kw)).slice(0, 500);
    const summary = hits.reduce((a, b) => {
      if (b.kind === 'income') a.inc += b.amount_cents; else a.exp += b.amount_cents;
      a.n++; return a;
    }, { exp: 0, inc: 0, n: 0 });
    return sendJson(res, 200, { q: q.q, summary, bills: hits });
  }
  // 预算读写：key = YYYY-MM（月）或 YYYY（年），金额单位元
  if (url.pathname === '/api/budgets' && req.method === 'GET') {
    const rows = db.prepare('SELECT key, amount_cents FROM budgets ORDER BY key').all();
    const budgets = {}; for (const r of rows) budgets[r.key] = r.amount_cents;
    return sendJson(res, 200, { budgets });
  }
  if (url.pathname === '/api/budgets' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || !/^(\d{4}|\d{4}-\d{2})$/.test(body.key || '')) return sendJson(res, 400, { error: 'key 要是 YYYY 或 YYYY-MM' });
    const cents = body.amountCents != null ? Math.round(Number(body.amountCents)) : Math.round(Number(body.amount) * 100);
    if (!(cents > 0)) return sendJson(res, 400, { error: '金额要大于 0，清除预算请用 DELETE' });
    setBudget(body.key, cents);
    return sendJson(res, 200, { ok: true, key: body.key, amount_cents: cents });
  }
  const delBudget = url.pathname.match(/^\/api\/budgets\/(.+)$/);
  if (delBudget && req.method === 'DELETE') {
    db.prepare('DELETE FROM budgets WHERE key=?').run(decodeURIComponent(delBudget[1]));
    return sendJson(res, 200, { ok: true });
  }
  // 成员：列出出现过的成员 + 改名
  if (url.pathname === '/api/members' && req.method === 'GET') {
    const counts = {};
    for (const r of db.prepare("SELECT openid, COUNT(*) AS n FROM bills WHERE openid<>'' GROUP BY openid").all()) counts[r.openid] = r.n;
    const openids = new Set([...Object.keys(counts), ...db.prepare('SELECT openid FROM members').all().map(r => r.openid)]);
    const members = [...openids].map(openid => ({ openid, short: openid.slice(-4), name: memberName(openid), count: counts[openid] || 0 }));
    return sendJson(res, 200, { members });
  }
  if (url.pathname === '/api/members' && req.method === 'POST') {
    const body = await readJson(req);
    if (!body || !body.openid) return sendJson(res, 400, { error: '需要 openid' });
    const name = String(body.name || '').trim();
    if (name) db.prepare('INSERT INTO members(openid,name) VALUES(?,?) ON CONFLICT(openid) DO UPDATE SET name=excluded.name').run(body.openid, name);
    else db.prepare('DELETE FROM members WHERE openid=?').run(body.openid); // 清空 = 恢复默认名
    return sendJson(res, 200, { ok: true, openid: body.openid, name: memberName(body.openid) });
  }
  // 修改管理口令
  if (url.pathname === '/api/settings/password' && req.method === 'POST') {
    const body = await readJson(req);
    const next = String((body && (body.newPass ?? body.password)) || '');
    if (next.length < 4) return sendJson(res, 400, { error: '新口令至少 4 位' });
    setSetting('admin_pass', next);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${ADMIN_COOKIE}=${signSession(next)}; HttpOnly; Path=/; Max-Age=${SESSION_MS / 1000}; SameSite=Lax`,
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (isPage) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`sunsFamilyBill 已启动： http://localhost:${PORT}  微信回调： /wechat （Token=${WECHAT_TOKEN}）`));
