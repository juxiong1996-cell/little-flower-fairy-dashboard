import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');

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
  querySelector(selector) { return selector === 'button' ? this.children.find(child => child.tagName === 'button') : null; }
  reset() { this.resetCalled = true; }
}

function find(element, predicate) {
  if (!element || typeof element === 'string') return null;
  if (predicate(element)) return element;
  for (const child of element.children) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

async function fixture(accounts, confirm = true) {
  const ids = new Map([
    'rows', 'count', 'batch', 'batchRun', 'batchQuery', 'batchSign', 'message',
    'add', 'alias', 'season-title', 'dates', 'milestones', 'activityState',
    'batchSettingsForm', 'maxConcurrent', 'saveBatchSettings', 'batchSettingsStatus',
    'scheduleForm', 'scheduleTime', 'scheduleEnabled', 'saveSchedule', 'scheduleStatus', 'scheduleState', 'scheduleResults',
  ].map(id => [id, new Element()]));
  const requests = [], confirmations = [];
  let remove = async ({ account }) => ({ account });
  const sandbox = {
    document: {
      querySelector: selector => ids.get(selector.slice(1)),
      createElement: tag => new Element(tag),
      addEventListener() {},
    },
    window: { confirm: message => { confirmations.push(message); return confirm; }, addEventListener() {} },
    setInterval() { return 0; },
    fetch: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, data });
      let result;
      if (url === '/api/calendar') result = null;
      else if (url === '/api/batch-settings') result = { maxConcurrent: 5 };
      else if (url === '/api/schedule') result = { enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', running: false, nextRunAt: null, lastRun: null, lastError: '' };
      else if (url === '/api/activity') result = { available: false, capabilities: { progress: true, sign: true } };
      else if (url === '/api/accounts') result = accounts;
      else if (url === '/api/remove') result = await remove(data);
      else throw new Error('Unexpected request: ' + url);
      return { ok: !result?.error, json: async () => result };
    },
  };
  vm.createContext(sandbox);
  await new vm.Script('(async () => {\n' + source + `
    globalThis.ui = {
      draw, pending, accounts: () => accounts,
      batch: value => { batch = value; draw(); },
    };
  })()`).runInContext(sandbox);
  return {
    ids, requests, confirmations, ui: sandbox.ui,
    setRemove: fn => { remove = fn; },
    removeButton: index => find(ids.get('rows').children[index], el => el.className === 'remove-account'),
    removeRequests: () => requests.filter(request => request.url === '/api/remove'),
  };
}
const row = account => ({ account, enabled: false, status: '待检查' });

test('取消移除不会发出请求，也不会改变列表', async () => {
  const f = await fixture([row('alt2')], false);
  await f.removeButton(0).onclick();
  assert.equal(f.ui.accounts().length, 1);
  assert.equal(f.removeRequests().length, 0);
  assert.match(f.confirmations[0], /alt2/);
  assert.match(f.confirmations[0], /不会注销游戏账号/);
});

test('等待服务器成功后才移除目标账号，并更新数量和批量按钮', async () => {
  const f = await fixture([row('main'), row('alt2')]);
  let finish;
  f.setRemove(() => new Promise(resolve => { finish = resolve; }));
  const action = f.removeButton(1).onclick();
  assert.equal(f.removeButton(1).disabled, true);
  assert.equal(f.ids.get('batch').disabled, true);
  assert.ok(find(f.ids.get('rows'), el => el.textContent === '正在移除账号…'));
  assert.equal(f.ui.accounts().length, 2);
  assert.equal(f.removeRequests()[0].data.account, 'alt2');
  finish({ account: 'alt2' });
  await action;
  assert.equal(f.ui.accounts().map(item => item.account).join(','), 'main');
  assert.equal(f.ids.get('count').textContent, '1 个');
  assert.equal(f.ids.get('batch').disabled, false);
  assert.match(f.ids.get('message').textContent, /已从签到台移除/);
});

test('移除最后一个账号后显示空列表并禁用批量操作', async () => {
  const f = await fixture([row('alt2')]);
  await f.removeButton(0).onclick();
  assert.equal(f.ids.get('count').textContent, '0 个');
  assert.equal(f.ids.get('batch').disabled, true);
  assert.match(f.ids.get('rows').children[0].textContent, /先添加一个账号/);
});

test('服务器拒绝移除时保留账号并恢复按钮', async () => {
  const f = await fixture([row('alt2')]);
  f.setRemove(async () => ({ error: '移除失败' }));
  await f.removeButton(0).onclick();
  assert.equal(f.ui.accounts().length, 1);
  assert.equal(f.removeButton(0).disabled, false);
  assert.equal(f.ids.get('message').textContent, '移除失败');
});

test('查询中或批量操作中不能触发移除', async () => {
  const f = await fixture([row('alt2')]);
  f.ui.pending.add('alt2');
  f.ui.draw();
  assert.equal(f.removeButton(0).disabled, true);
  await f.removeButton(0).onclick();
  f.ui.pending.clear();
  f.ui.batch({ route: 'check', label: '检查全部账号', completed: 0, total: 1 });
  assert.equal(f.removeButton(0).disabled, true);
  await f.removeButton(0).onclick();
  assert.equal(f.confirmations.length, 0);
  assert.equal(f.removeRequests().length, 0);
});

test('中文显示名用于确认和提示，移除请求仍使用稳定账号编号', async () => {
  const f = await fixture([{ ...row('alt2'), displayName: '花花的小号' }]);
  assert.equal(f.removeButton(0).attributes['aria-label'], '移除账号 花花的小号');
  await f.removeButton(0).onclick();
  assert.match(f.confirmations[0], /花花的小号/);
  assert.equal(f.removeRequests()[0].data.account, 'alt2');
  assert.match(f.ids.get('message').textContent, /花花的小号/);
});
