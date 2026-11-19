'use strict';
// 消息解析：把微信里发来的一句话拆成 {日期, 事项, 金额, 收/支}
// 支持的写法（日期可省略，省略=今天；金额带不带“元”都行）：
//   2026-11-17 打车 35
//   2026/11/17 打车 35元
//   11月17日 菜市场买菜 86.5
//   11-17 午饭 28
//   今天 打车 35 / 昨天 停车费 10 / 前天 加油 200
//   打车 35
//   收入 2026-11-15 工资 12000   （带“收入/工资/到账”等词记为收入，默认是花销）

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function shiftDays(base, days) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
  return fmtDate(d);
}

// 从文本头部剥离日期，返回 {date, rest}；剥不到返回 null date
function extractDate(text, now) {
  let m;
  // 相对日期
  if (/^前天/.test(text)) return { date: shiftDays(now, -2), rest: text.slice(2) };
  if (/^昨天/.test(text)) return { date: shiftDays(now, -1), rest: text.slice(2) };
  if (/^今天/.test(text)) return { date: fmtDate(now), rest: text.slice(2) };
  // 完整日期 2026-11-17 / 2026/11/17 / 2026年11月17日
  m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})日?/);
  if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, rest: text.slice(m[0].length) };
  m = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (m) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, rest: text.slice(m[0].length) };
  // 月日 11月17日 / 11-17 / 11/17（年份用今年）
  m = text.match(/^(\d{1,2})月(\d{1,2})日?/);
  if (m) return { date: `${now.getFullYear()}-${pad(m[1])}-${pad(m[2])}`, rest: text.slice(m[0].length) };
  m = text.match(/^(\d{1,2})[-/](\d{1,2})(?=[\s\u4e00-\u9fff]|$)/);
  if (m) return { date: `${now.getFullYear()}-${pad(m[1])}-${pad(m[2])}`, rest: text.slice(m[0].length) };
  return { date: null, rest: text };
}

const COMMANDS = [
  { re: /^(帮助|help|\?|？|菜单)$/i, name: 'help' },
  { re: /^(本月|本月汇总|本月账单)$/, name: 'month_summary' },
  { re: /^(今天|今日|今天账单)$/, name: 'today_list' },
  { re: /^(删除上一笔|撤销|删掉上一笔)$/, name: 'undo_last' },
  { re: /^查\s*(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/, name: 'query' },
  { re: /^汇总\s*(\d{4})[-/](\d{1,2})$/, name: 'query' },
  // 预算类（v0.2）：金额在捕获组 1 里
  { re: /^全年预算\s*(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块)?$/, name: 'set_year_budget', amount: true },
  { re: /^预算\s*(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块)?$/, name: 'set_budget', amount: true },
  { re: /^(查预算|预算查询|预算)$/, name: 'budget_query' },
];

function parseMessage(rawText, now = new Date()) {
  const text = String(rawText || '').trim().replace(/\s+/g, ' ');
  if (!text) return { type: 'unknown', reason: 'empty' };

  for (const c of COMMANDS) {
    const m = text.match(c.re);
    if (m) {
      const out = { type: 'command', command: c.name, text };
      if (c.name === 'query') {
        out.month = `${m[1]}-${pad(m[2])}`;
        if (m[3]) out.date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
      }
      if (c.amount) { out.amount = Number(m[1]); out.amountCents = Math.round(out.amount * 100); }
      return out;
    }
  }

  // 记账：先剥开头的“收入”标记，再剥日期，最后找金额
  let kind = 'expense';
  let src = text;
  if (/^(收入|进账|到账)/.test(src)) { kind = 'income'; src = src.replace(/^(收入|进账|到账)\s*/, ''); }
  const { date, rest } = extractDate(src, now);
  let body = rest.trim();
  if (/^(收入|进账|到账)/.test(body)) { kind = 'income'; body = body.replace(/^(收入|进账|到账)\s*/, ''); }

  const amountMatch = body.match(/(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块)?\s*$/)
    || body.match(/^(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(?:元|块钱|块)?\s+/);
  if (!amountMatch) return { type: 'unknown', reason: 'no_amount', text };
  const amount = Number(amountMatch[1]);
  if (!(amount > 0)) return { type: 'unknown', reason: 'bad_amount', text };

  let item = (amountMatch.index === 0)
    ? body.slice(amountMatch[0].length).trim()
    : body.slice(0, amountMatch.index).trim();
  item = item.replace(/[，,：:、]+$/g, '').trim();
  if (!item) return { type: 'unknown', reason: 'no_item', text };
  if (kind === 'expense' && /(工资|收入|到账|进账)/.test(item)) kind = 'income';

  return {
    type: 'bill',
    date: date || fmtDate(now),
    item,
    amount,
    amountCents: Math.round(amount * 100),
    kind,
    raw: text,
  };
}

module.exports = { parseMessage, fmtDate };
