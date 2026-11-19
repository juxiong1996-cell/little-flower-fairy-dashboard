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
    this.value = '';
    this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector(selector) { return selector === 'button' ? find(this, el => el.tagName === 'button') : null; }
  focus() {}
  reset() {}
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

async function fixture(initial = {}) {
  let serverRow = {
    account: 'main', enabled: false, status: '待检查', displayName: 'main',
    customName: '', accountName: '', maskedPhone: '', nameSource: 'fallback', ...initial,
  };
  const ids = new Map([
    'rows', 'count', 'batch', 'batchRun', 'batchQuery', 'batchSign', 'message',
    'add', 'alias', 'season-title', 'dates', 'milestones', 'activityState',
    'scheduleForm', 'scheduleTime', 'scheduleEnabled', 'saveSchedule', 'scheduleStatus', 'scheduleState', 'scheduleResults',
  ].map(id => [id, new Element()]));
  const requests = [];
  let readAccounts = async () => [serverRow];
  let saveName = async ({ displayName }) => {
    const customName = displayName.trim();
    serverRow = { ...serverRow, customName,
      displayName: customName || serverRow.accountName || serverRow.maskedPhone || serverRow.account,
      nameSource: customName ? 'custom' : serverRow.accountName ? 'account' : serverRow.maskedPhone ? 'phone' : 'fallback',
    };
    return serverRow;
  };
  const sandbox = {
    document: {
      querySelector: selector => ids.get(selector.slice(1)) || find(ids.get('rows'), el => el.id === selector.slice(1)),
      createElement: tag => new Element(tag), addEventListener() {},
    },
    window: { confirm: () => false, addEventListener() {} },
    setInterval() {},
    fetch: async (url, options = {}) => {
      const data = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, data });
      let result;
      if (url === '/api/calendar') result = null;
      else if (url === '/api/schedule') result = { enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', running: false, nextRunAt: null, lastRun: null, lastError: '' };
      else if (url === '/api/activity') result = { available: false, capabilities: {} };
      else if (url === '/api/accounts') result = await readAccounts();
      else if (url === '/api/name') result = await saveName(data);
      else throw new Error('Unexpected request: ' + url);
      return { ok: !result?.error, json: async () => structuredClone(result) };
    },
  };
  vm.createContext(sandbox);
  await new vm.Script('(async () => {\n' + source + `
    globalThis.ui = { accounts: () => accounts, refreshNames };
  })()`).runInContext(sandbox);
  const get = predicate => find(ids.get('rows'), predicate);
  return {
    ids, ui: sandbox.ui,
    edit: () => get(el => el.className === 'edit-name').onclick(),
    editor: () => get(el => el.className === 'name-editor'),
    input: () => get(el => el.id === 'edit-name'),
    button: text => get(el => el.tagName === 'button' && el.textContent === text),
    nameRequests: () => requests.filter(request => request.url === '/api/name'),
    setSaveName: fn => { saveName = fn; },
    setReadAccounts: fn => { readAccounts = fn; },
    async submit(text) {
      const input = get(el => el.id === 'edit-name');
      input.value = text;
      input.oninput();
      get(el => el.className === 'name-editor').onsubmit({ preventDefault() {} });
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('编辑并保存中文显示名，实际请求始终使用原账号编号', async () => {
  const f = await fixture();
  f.edit();
  await f.submit('花花的主号');
  assert.deepEqual(f.nameRequests().map(request => request.data), [{ account: 'main', displayName: '花花的主号' }]);
  assert.equal(f.ui.accounts()[0].account, 'main');
  assert.equal(f.ui.accounts()[0].displayName, '花花的主号');
  assert.equal(f.editor(), null);
  assert.match(f.ids.get('message').textContent, /花花的主号/);
});

test('使用自动名称发送空名称，并显示服务器返回的登录账号名称', async () => {
  const f = await fixture({ displayName: '我的大号', customName: '我的大号', accountName: '淘米花仙', nameSource: 'custom' });
  f.edit();
  await f.button('使用自动名称').onclick();
  assert.deepEqual(f.nameRequests()[0].data, { account: 'main', displayName: '' });
  assert.equal(f.ui.accounts()[0].customName, '');
  assert.equal(f.ui.accounts()[0].displayName, '淘米花仙');
  assert.equal(f.ui.accounts()[0].nameSource, 'account');
  assert.equal(f.editor(), null);
});

test('名称校验失败时保留编辑草稿和原显示名，便于直接修改重试', async () => {
  const f = await fixture({ displayName: '原来的名称', customName: '原来的名称', nameSource: 'custom' });
  f.setSaveName(async () => ({ error: '名称不能包含控制字符' }));
  f.edit();
  const draft = '花\u202e仙';
  await f.submit(draft);
  assert.equal(f.input().value, draft);
  assert.equal(f.input().disabled, false);
  assert.equal(f.ui.accounts()[0].displayName, '原来的名称');
  assert.equal(f.ids.get('message').textContent, '名称不能包含控制字符');
});

test('保存前发出的自动刷新即使稍后返回，也不会覆盖刚保存的自定义名称', async () => {
  const f = await fixture({ displayName: '旧的自动名称', accountName: '旧的自动名称', nameSource: 'account' });
  let finishRefresh;
  f.setReadAccounts(() => new Promise(resolve => { finishRefresh = resolve; }));
  const refreshing = f.ui.refreshNames();
  f.edit();
  await f.submit('刚保存的主号');
  finishRefresh([{ account: 'main', displayName: '旧的自动名称', customName: '', accountName: '旧的自动名称', maskedPhone: '', nameSource: 'account' }]);
  await refreshing;
  assert.equal(f.ui.accounts()[0].displayName, '刚保存的主号');
  assert.equal(f.ui.accounts()[0].customName, '刚保存的主号');
  assert.equal(f.ui.accounts()[0].nameSource, 'custom');
});
