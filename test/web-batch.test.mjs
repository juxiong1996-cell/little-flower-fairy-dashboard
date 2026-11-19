import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

async function fixture({ maxConcurrent = 5, count = 8, settingsError = '', settingsWarning = '' } = {}) {
  const ids = new Map([
    'rows', 'count', 'batch', 'batchRun', 'batchQuery', 'batchSign', 'message',
    'add', 'alias', 'season-title', 'dates', 'milestones', 'activityState',
    'batchSettingsForm', 'maxConcurrent', 'saveBatchSettings', 'batchSettingsStatus',
    'scheduleForm', 'scheduleTime', 'scheduleEnabled', 'saveSchedule', 'scheduleStatus', 'scheduleState', 'scheduleResults',
  ].map(id => [id, new Element()]));
  const accounts = Array.from({ length: count }, (_, index) => ({ account: 'a' + index, status: '待检查' }));
  const actions = [], settingsRequests = [];
  let active = 0, peak = 0;
  let respondSettings = async data => ({ maxConcurrent: data.maxConcurrent });
  const sandbox = {
    document: {
      querySelector: selector => ids.get(selector.slice(1)),
      createElement: tag => new Element(tag), addEventListener() {},
    },
    window: { addEventListener() {} }, setInterval() {},
    fetch: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : undefined;
      let result;
      if (url === '/api/calendar') result = null;
      else if (url === '/api/schedule') result = { enabled: false, time: '09:00', running: false, lastRun: null };
      else if (url === '/api/activity') result = { available: true, capabilities: { progress: true, sign: true } };
      else if (url === '/api/accounts') result = accounts;
      else if (url === '/api/batch-settings') {
        if (data) { settingsRequests.push(data); result = await respondSettings(data); }
        else result = settingsError ? { error: settingsError } : { maxConcurrent, lastError: settingsWarning };
      } else {
        active++;
        peak = Math.max(peak, active);
        result = await new Promise(resolve => {
          actions.push({ url, account: data.account, finish: value => { active--; resolve(value); } });
        });
      }
      return { ok: !result?.error, json: async () => structuredClone(result) };
    },
  };
  vm.createContext(sandbox);
  await new vm.Script('(async () => {\n' + source + `
    globalThis.ui = { accounts: () => accounts, pending, isBatch: () => Boolean(batch) };
  })()`).runInContext(sandbox);
  const progress = { source: 'live', signedCount: 6, totalDays: 56, todaySigned: true, at: '2026-11-19T01:00:00Z' };
  return {
    ids, actions, settingsRequests, ui: sandbox.ui, peak: () => peak,
    setRespondSettings: value => { respondSettings = value; },
    change(value) { ids.get('maxConcurrent').value = value; ids.get('maxConcurrent').oninput(); },
    submit: () => ids.get('batchSettingsForm').onsubmit({ preventDefault() {} }),
    start: id => ids.get(id).onclick(),
    finish(index, overrides = {}) {
      const action = actions[index];
      action.finish(action.url === '/api/activity/progress' ? { ...progress, ...overrides }
        : action.url === '/api/check' ? { status: '已登录', ...overrides }
          : { verified: ['第 6 天签到'], signedCount: 6, totalDays: 56, progress, ...overrides });
    },
    async finishAll() {
      for (let index = 0; index < actions.length; index++) { this.finish(index); await flush(); }
    },
  };
}

test('四种批量操作默认同时处理 5 个账号，空位补入并保证每个账号只处理一次', async () => {
  for (const [button, route] of [['batchQuery', 'activity/progress'], ['batchSign', 'activity/sign'], ['batch', 'check'], ['batchRun', 'activity/run']]) {
    const f = await fixture();
    assert.equal(f.ids.get('maxConcurrent').value, 5);
    const running = f.start(button);
    assert.equal(f.actions.length, 5);
    assert.equal(f.peak(), 5);
    assert.equal(f.ids.get('maxConcurrent').disabled, true);
    assert.equal(f.ids.get('saveBatchSettings').disabled, true);
    assert.match(f.ids.get('message').textContent, /已完成 0\/8，正在处理 5 个，等待 3 个/);
    await f.start(button);
    assert.equal(f.actions.length, 5);
    f.finish(2);
    await flush();
    assert.equal(f.actions.length, 6);
    assert.match(f.ids.get(button).textContent, /1\/8/);
    assert.match(f.ids.get('message').textContent, /已完成 1\/8，正在处理 5 个，等待 2 个/);
    for (const index of [0, 1, 3, 4, 5]) { f.finish(index); await flush(); }
    f.finish(6); f.finish(7);
    await running;
    assert.equal(f.actions.length, 8);
    assert.equal(new Set(f.actions.map(action => action.account)).size, 8);
    assert.ok(f.actions.every(action => action.url === '/api/' + route));
    assert.equal(f.peak(), 5);
    assert.equal(f.ui.pending.size, 0);
    assert.equal(f.ui.isBatch(), false);
    assert.equal(f.ids.get(button).disabled, false);
    assert.equal(f.ids.get('maxConcurrent').disabled, false);
    assert.equal(f.ids.get('rows').attributes['aria-busy'], 'false');
    assert.match(f.ids.get('message').textContent, /完成.*失败 0 个/);
  }
});

test('读取自定义上限为 2，某个账号失败后继续处理并保留正确签到汇总', async () => {
  const f = await fixture({ maxConcurrent: 2, count: 4 });
  const running = f.start('batchSign');
  assert.equal(f.actions.length, 2);
  f.finish(1, { error: '登录已过期' });
  await flush();
  assert.equal(f.actions.length, 3);
  assert.equal(f.ui.accounts()[1].activity, '登录已过期');
  f.finish(2, { alreadySigned: true, verified: [] });
  await flush();
  assert.equal(f.actions.length, 4);
  f.finish(0); f.finish(3);
  await running;
  assert.equal(f.peak(), 2);
  assert.match(f.ids.get('message').textContent, /新签到 2 个，今日已签 1 个，失败 1 个/);
  assert.equal(f.ids.get('saveBatchSettings').disabled, false);
});

test('保存并行设置后下一次批量使用新上限，保存期间禁止重复提交和启动批量', async () => {
  const f = await fixture({ count: 4 });
  let finish;
  f.setRespondSettings(() => new Promise(resolve => { finish = resolve; }));
  f.change('2');
  const saving = f.submit();
  assert.equal(f.ids.get('maxConcurrent').disabled, true);
  assert.equal(f.ids.get('saveBatchSettings').disabled, true);
  assert.equal(f.ids.get('batchSettingsForm').attributes['aria-busy'], 'true');
  await f.submit(); await f.start('batchQuery');
  assert.equal(f.settingsRequests.length, 1);
  assert.equal(f.actions.length, 0);
  finish({ maxConcurrent: 2 });
  await saving;
  assert.deepEqual(f.settingsRequests, [{ maxConcurrent: 2 }]);
  assert.match(f.ids.get('batchSettingsStatus').textContent, /已保存.*2 个账号.*定时签到/);
  const running = f.start('batchQuery');
  assert.equal(f.actions.length, 2);
  await f.finishAll();
  await running;
  assert.equal(f.peak(), 2);
});

test('无效并行数不提交，保存失败保留草稿和原上限', async () => {
  const f = await fixture({ maxConcurrent: 1, count: 3 });
  for (const value of ['', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    f.change(value); await f.submit();
    assert.equal(f.settingsRequests.length, 0);
    assert.match(f.ids.get('batchSettingsStatus').textContent, /必须是大于 0 的整数/);
  }
  f.setRespondSettings(async () => ({ error: '保存失败，请重试' }));
  f.change('2'); await f.submit();
  assert.equal(f.ids.get('maxConcurrent').value, '2');
  assert.equal(f.ids.get('saveBatchSettings').disabled, false);
  assert.equal(f.ids.get('batchSettingsStatus').textContent, '保存失败，请重试');
  const running = f.start('batchQuery');
  assert.equal(f.actions.length, 1);
  await f.finishAll(); await running;
  assert.equal(f.peak(), 1);
});

test('设置读取失败会提示并阻止保存，批量仍可按默认 5 个运行', async () => {
  const f = await fixture({ settingsError: '暂时无法读取', count: 6 });
  assert.match(f.ids.get('batchSettingsStatus').textContent, /读取失败.*刷新/);
  assert.equal(f.ids.get('maxConcurrent').disabled, true);
  assert.equal(f.ids.get('saveBatchSettings').disabled, true);
  await f.submit();
  assert.equal(f.settingsRequests.length, 0);
  const running = f.start('batchQuery');
  assert.equal(f.actions.length, 5);
  await f.finishAll(); await running;
});

test('损坏设置显示默认上限和修复提示，可以重新保存恢复', async () => {
  const warning = '并行设置读取失败，已使用默认 5 个账号，请重新保存';
  const f = await fixture({ settingsWarning: warning });
  assert.equal(f.ids.get('maxConcurrent').value, 5);
  assert.equal(f.ids.get('batchSettingsStatus').textContent, warning);
  assert.equal(f.ids.get('saveBatchSettings').disabled, false);
  f.change('2');
  await f.submit();
  assert.deepEqual(f.settingsRequests, [{ maxConcurrent: 2 }]);
  assert.match(f.ids.get('batchSettingsStatus').textContent, /已保存.*2 个账号/);
  assert.doesNotMatch(f.ids.get('batchSettingsStatus').textContent, /读取失败/);
});
