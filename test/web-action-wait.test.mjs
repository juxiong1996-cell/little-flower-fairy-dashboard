import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const progress = { source: 'live', signedCount: 3, totalDays: 56, todaySigned: false, at: '2026-11-19T01:00:00.000Z' };
const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.textContent = '';
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
}
function find(element, predicate) {
  if (!element || typeof element === 'string') return null;
  if (predicate(element)) return element;
  for (const child of element.children) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
function text(element) {
  return typeof element === 'string' ? element : element.textContent + ' ' + element.children.map(text).join(' ');
}
async function fixture(accounts = [{ account: 'main', status: '已登录' }]) {
  const ids = new Map([
    'rows', 'count', 'batch', 'batchRun', 'batchQuery', 'batchSign', 'message',
    'add', 'alias', 'season-title', 'dates', 'milestones', 'activityState',
    'batchSettingsForm', 'maxConcurrent', 'saveBatchSettings', 'batchSettingsStatus',
    'scheduleForm', 'scheduleTime', 'scheduleEnabled', 'saveSchedule', 'scheduleStatus', 'scheduleState', 'scheduleResults',
  ].map(id => [id, new Element()]));
  const timers = new Map(), cleared = [], requests = [];
  let now = 10000, sequence = 0;
  let respond = async () => progress;
  class ClockDate extends Date { static now() { return now; } }
  const sandbox = {
    Date: ClockDate,
    document: {
      querySelector: selector => selector === '#edit-name'
        ? find(ids.get('rows'), item => item.id === 'edit-name') : ids.get(selector.slice(1)),
      createElement: tag => new Element(tag), addEventListener() {},
    },
    window: { addEventListener() {} },
    setInterval(callback, ms) { const id = ++sequence; timers.set(id, { callback, ms }); return id; },
    clearInterval(id) { cleared.push(id); timers.delete(id); },
    fetch: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, data });
      let value;
      if (url === '/api/calendar') value = null;
      else if (url === '/api/batch-settings') value = { maxConcurrent: 1 };
      else if (url === '/api/activity') value = { available: true, capabilities: { progress: true, sign: true } };
      else if (url === '/api/accounts') value = accounts;
      else if (url === '/api/schedule') value = { enabled: false, time: '09:00', running: false };
      else value = await respond(url, data);
      return { ok: !value?.error, json: async () => value };
    },
  };
  vm.createContext(sandbox);
  await new vm.Script('(async () => {\n' + source + '\n globalThis.ui = { run, runBatch, draw, pending, accounts: () => accounts };\n})()').runInContext(sandbox);
  return {
    ids, timers, cleared, requests, ui: sandbox.ui,
    setRespond(fn) { respond = fn; },
    advance(ms) {
      now += ms;
      for (const timer of [...timers.values()]) if (timer.ms === 1000) timer.callback();
    },
    actionTimers: () => [...timers.entries()].filter(([, timer]) => timer.ms === 1000),
  };
}

test('等待时只更新目标状态和耗时，不重绘正在编辑的另一个账号', async () => {
  const f = await fixture([{ account: 'main', status: '已登录' }, { account: 'alt', status: '已登录' }]);
  const held = gate();
  f.setRespond(() => held.promise);
  const running = f.ui.run(f.ui.accounts()[0], 'activity/progress');
  const edit = find(f.ids.get('rows').children[1], item => item.className === 'edit-name');
  edit.onclick();
  const editor = find(f.ids.get('rows'), item => item.id === 'edit-name');
  editor.value = '正在输入的名字';
  editor.oninput();
  const card = f.ids.get('rows').children[0];
  assert.match(text(card), /已等待 0 秒/);
  f.advance(31000);
  assert.equal(f.ids.get('rows').children[0], card);
  assert.equal(find(f.ids.get('rows'), item => item.id === 'edit-name'), editor);
  assert.equal(editor.value, '正在输入的名字');
  assert.match(text(card), /已等待 31 秒.*官方可能正在维护/);
  assert.equal(f.actionTimers().length, 1);
  held.resolve(progress);
  await running;
  assert.equal(f.actionTimers().length, 0);
  assert.equal(f.cleared.length, 1);
  assert.equal(f.ui.pending.size, 0);
  assert.equal(f.ids.get('batchQuery').disabled, false);
  assert.match(text(f.ids.get('rows')), /当前累计签到 3\/56 天/);
  assert.doesNotMatch(text(f.ids.get('rows')), /已等待/);
});

test('维护或连接失败后清理计时器、显示错误并恢复操作按钮', async () => {
  const f = await fixture();
  const held = gate();
  f.setRespond(() => held.promise);
  const running = f.ui.run(f.ui.accounts()[0], 'activity/progress');
  f.advance(4000);
  assert.equal(f.ids.get('batchQuery').disabled, true);
  held.resolve({ error: '官方游戏正在维护，请维护结束后重试' });
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(f.actionTimers().length, 0);
  assert.equal(f.cleared.length, 1);
  assert.equal(f.ids.get('batchQuery').disabled, false);
  assert.equal(f.ids.get('rows').attributes['aria-busy'], 'false');
  assert.match(f.ids.get('message').textContent, /官方游戏正在维护/);
  assert.match(text(f.ids.get('rows')), /官方游戏正在维护/);
});

test('批量中一个账号失败仍继续后续账号，每个等待计时器都清理', async () => {
  const f = await fixture([{ account: 'main', status: '已登录' }, { account: 'alt', status: '已登录' }]);
  const first = gate(), second = gate();
  f.setRespond((url, body) => body.account === 'main' ? first.promise : second.promise);
  const running = f.ui.runBatch('activity/progress', '批量查询');
  assert.equal(f.actionTimers().length, 1);
  first.resolve({ error: '连接失败' });
  await tick();
  assert.equal(f.requests.filter(request => request.url === '/api/activity/progress').length, 2);
  assert.equal(f.actionTimers().length, 1);
  f.advance(2000);
  assert.match(text(f.ids.get('rows').children[1]), /已等待 2 秒/);
  second.resolve(progress);
  await running;
  assert.equal(f.actionTimers().length, 0);
  assert.equal(f.cleared.length, 2);
  assert.equal(f.ui.pending.size, 0);
  assert.equal(f.ids.get('batchQuery').disabled, false);
  assert.equal(f.ids.get('message').textContent, '批量查询完成：成功 1 个，失败 1 个。');
});
