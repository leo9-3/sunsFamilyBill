'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseMessage } = require('../lib/parse');
const NOW = new Date(2026, 10, 17, 12, 0, 0); // 2026-11-17

test('完整日期 事项 金额', () => {
  const p = parseMessage('2026-11-17 打车 35', NOW);
  assert.equal(p.type, 'bill'); assert.equal(p.date, '2026-11-17');
  assert.equal(p.item, '打车'); assert.equal(p.amountCents, 3500); assert.equal(p.kind, 'expense');
});
test('年月日中文 + 小数 + 元', () => {
  const p = parseMessage('2026年11月16日 菜市场买菜 86.5元', NOW);
  assert.equal(p.date, '2026-11-16'); assert.equal(p.item, '菜市场买菜'); assert.equal(p.amountCents, 8650);
});
test('只有月日，年份补今年', () => {
  const p = parseMessage('11月17日 午饭 28', NOW);
  assert.equal(p.date, '2026-11-17'); assert.equal(p.item, '午饭'); assert.equal(p.amountCents, 2800);
});
test('相对日期：昨天', () => {
  const p = parseMessage('昨天 停车费 10', NOW);
  assert.equal(p.date, '2026-11-16'); assert.equal(p.item, '停车费');
});
test('省略日期默认今天', () => {
  const p = parseMessage('加油 200', NOW);
  assert.equal(p.date, '2026-11-17'); assert.equal(p.item, '加油'); assert.equal(p.amountCents, 20000);
});
test('收入识别', () => {
  const p = parseMessage('收入 2026-11-15 工资 12000', NOW);
  assert.equal(p.type, 'bill'); assert.equal(p.kind, 'income');
  assert.equal(p.date, '2026-11-15'); assert.equal(p.item, '工资'); assert.equal(p.amountCents, 1200000);
  const q = parseMessage('2026-11-15 工资 12000', NOW);
  assert.equal(q.kind, 'income'); assert.equal(q.amountCents, 1200000);
});
test('命令：本月 / 删除上一笔 / 查月份', () => {
  assert.equal(parseMessage('本月', NOW).command, 'month_summary');
  assert.equal(parseMessage('删除上一笔', NOW).command, 'undo_last');
  const q = parseMessage('查 2026-10', NOW);
  assert.equal(q.command, 'query'); assert.equal(q.month, '2026-10');
});
test('没有金额 -> unknown', () => {
  assert.equal(parseMessage('今天天气不错', NOW).type, 'unknown');
});
