import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const emptySchedule = {
  enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', running: false,
  nextRunAt: null, lastRun: null, lastError: '',
};

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
function allText(element) {
  return typeof element === 'string' ? element : element.textContent + ' ' + element.children.map(allText).join(' ');
}

async function fixture({ accounts = [{ account: 'main', status: '待检查' }], sign = true, initial = {} } = {}) {
  const ids = new Map([
    'rows', 'count', 'batch', 'batchRun', 'batchQuery', 'batchSign', 'message',
    'add', 'alias', 'season-title', 'dates', 'milestones', 'activityState',
    'scheduleForm', 'scheduleTime', 'scheduleEnabled', 'saveSchedule', 'scheduleStatus', 'scheduleState', 'scheduleResults',
  ].map(id => [id, new Element()]));
  ids.get('scheduleTime').value = '09:00';
  const requests = [], intervals = [];
  let state = { ...emptySchedule, ...initial };
  let readSchedule = async () => state;
  let respond = async data => {
    state = { ...state, ...data, nextRunAt: data.enabled ? '2026-11-19T01:00:00.000Z' : null };
    return state;
  };
  const sandbox = {
    document: {
      querySelector: selector => ids.get(selector.slice(1)),
      createElement: tag => new Element(tag), addEventListener() {},
    },
    window: { addEventListener() {} },
    setInterval(callback, delay) { intervals.push({ callback, delay }); },
    fetch: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, data });
      let result;
      if (url === '/api/calendar') result = null;
      else if (url === '/api/activity') result = { available: false, capabilities: { progress: true, sign } };
      else if (url === '/api/accounts') result = accounts;
      else if (url === '/api/schedule') result = data ? await respond(data) : await readSchedule();
      else throw new Error('Unexpected request: ' + url);
      return { ok: !result?.error, json: async () => structuredClone(result) };
    },
  };
  vm.createContext(sandbox);
  await new vm.Script('(async () => {\n' + source + `
    globalThis.ui = { refreshSchedule };
  })()`).runInContext(sandbox);
  return {
    ids, intervals, ui: sandbox.ui,
    setRespond: value => { respond = value; },
    setRead: value => { readSchedule = value; },
    setState: value => { state = { ...state, ...value }; },
    saveRequests: () => requests.filter(request => request.url === '/api/schedule' && request.data),
    change({ time, enabled }) {
      if (time !== undefined) { ids.get('scheduleTime').value = time; ids.get('scheduleTime').oninput(); }
      if (enabled !== undefined) { ids.get('scheduleEnabled').checked = enabled; ids.get('scheduleEnabled').onchange(); }
    },
    async submit() { return ids.get('scheduleForm').onsubmit({ preventDefault() {} }); },
  };
}

test('读取已保存设置，选择每天时间并开启后保存，展示北京时间和下次执行', async () => {
  const f = await fixture({ initial: { enabled: true, time: '08:15', nextRunAt: '2026-11-18T00:15:00.000Z' } });
  assert.equal(f.ids.get('scheduleTime').value, '08:15');
  assert.equal(f.ids.get('scheduleEnabled').checked, true);
  assert.match(f.ids.get('scheduleState').textContent, /每天 08:15（北京时间）.*下次执行/);
  f.change({ time: '23:45', enabled: true });
  assert.match(f.ids.get('scheduleStatus').textContent, /尚未保存/);
  assert.match(f.ids.get('scheduleState').textContent, /每天 08:15/);
  await f.submit();
  assert.deepEqual(f.saveRequests().map(request => request.data), [{ enabled: true, time: '23:45' }]);
  assert.match(f.ids.get('scheduleState').textContent, /每天 23:45（北京时间）/);
  assert.match(f.ids.get('scheduleStatus').textContent, /设置已保存.*到点.*保持项目运行/);
  assert.equal(f.ids.get('saveSchedule').disabled, false);
  assert.equal(f.ids.get('scheduleTime').disabled, false);
});

test('保存期间阻止重复提交，完成后恢复表单', async () => {
  const f = await fixture();
  let finish;
  f.setRespond(() => new Promise(resolve => { finish = resolve; }));
  f.change({ enabled: true, time: '06:30' });
  const saving = f.submit();
  assert.equal(f.ids.get('saveSchedule').disabled, true);
  assert.equal(f.ids.get('scheduleTime').disabled, true);
  assert.equal(f.ids.get('scheduleEnabled').disabled, true);
  assert.equal(f.ids.get('scheduleForm').attributes['aria-busy'], 'true');
  await f.submit();
  assert.equal(f.saveRequests().length, 1);
  finish({ ...emptySchedule, enabled: true, time: '06:30' });
  await saving;
  assert.equal(f.ids.get('saveSchedule').disabled, false);
  assert.equal(f.ids.get('scheduleForm').attributes['aria-busy'], 'false');
});

test('空时间或无效时间不发保存请求，边界时间可以保存', async () => {
  const f = await fixture();
  for (const time of ['', '9:00', '24:00', '12:60', '12:00:00', '09:00;evil']) {
    f.change({ time }); await f.submit();
    assert.equal(f.saveRequests().length, 0);
    assert.match(f.ids.get('scheduleStatus').textContent, /请选择每天的执行时间/);
  }
  for (const time of ['00:00', '23:59']) { f.change({ time }); await f.submit(); }
  assert.deepEqual(f.saveRequests().map(request => request.data.time), ['00:00', '23:59']);
});

test('没有账号或签到服务时不能开启，但仍可以关闭已有定时设置', async () => {
  for (const options of [{ accounts: [] }, { sign: false }]) {
    const f = await fixture({ ...options, initial: { enabled: true } });
    assert.equal(f.ids.get('saveSchedule').disabled, true);
    await f.submit();
    assert.equal(f.saveRequests().length, 0);
    f.change({ enabled: false });
    assert.equal(f.ids.get('saveSchedule').disabled, false);
    await f.submit();
    assert.deepEqual(f.saveRequests().map(request => request.data), [{ enabled: false, time: '09:00' }]);
    assert.match(f.ids.get('scheduleStatus').textContent, /已关闭定时签到/);
  }
});

test('轮询显示执行中、上次汇总与账号错误，同时保留尚未保存的时间和开关', async () => {
  const f = await fixture();
  f.change({ time: '22:10', enabled: true });
  f.setState({
    enabled: true, time: '09:00', running: true, nextRunAt: '2026-11-19T01:00:00.000Z',
    lastRun: { startedAt: '2026-11-18T01:00:00Z', finishedAt: '2026-11-18T01:00:15Z', total: 3,
      signed: 1, alreadySigned: 1, failed: 1,
      results: [{ account: 'main', displayName: '主号', ok: true, alreadySigned: false },
        { account: 'alt', displayName: '小号', ok: false, alreadySigned: false, error: '登录已过期，请重新登录' }],
    },
  });
  assert.ok(f.intervals.some(interval => interval.delay === 15000 && interval.callback === f.ui.refreshSchedule));
  await f.ui.refreshSchedule();
  assert.equal(f.ids.get('scheduleTime').value, '22:10');
  assert.equal(f.ids.get('scheduleEnabled').checked, true);
  assert.match(f.ids.get('scheduleStatus').textContent, /尚未保存/);
  assert.match(f.ids.get('scheduleState').textContent, /正在执行.*每天 09:00/);
  const text = allText(f.ids.get('scheduleResults'));
  assert.match(text, /新签到 1 个，今日已签 1 个，失败 1 个/);
  assert.match(text, /小号：登录已过期，请重新登录/);
  assert.doesNotMatch(text, /主号：/);
});

test('先前发出的轮询不能覆盖刚保存的设置', async () => {
  const f = await fixture();
  let finishRead;
  f.setRead(() => new Promise(resolve => { finishRead = resolve; }));
  const refreshing = f.ui.refreshSchedule();
  f.change({ time: '18:20', enabled: true });
  await f.submit();
  finishRead({ ...emptySchedule });
  await refreshing;
  assert.equal(f.ids.get('scheduleTime').value, '18:20');
  assert.equal(f.ids.get('scheduleEnabled').checked, true);
  assert.match(f.ids.get('scheduleState').textContent, /每天 18:20/);
});

test('保存失败时保留草稿与原设置，显示错误并可以重试', async () => {
  const f = await fixture();
  f.change({ time: '15:30', enabled: true });
  f.setRespond(async () => ({ error: '设置保存失败，请重试' }));
  await f.submit();
  assert.equal(f.ids.get('scheduleTime').value, '15:30');
  assert.equal(f.ids.get('scheduleEnabled').checked, true);
  assert.match(f.ids.get('scheduleState').textContent, /定时签到已关闭/);
  assert.equal(f.ids.get('scheduleStatus').textContent, '设置保存失败，请重试');
  assert.equal(f.ids.get('saveSchedule').disabled, false);
});
