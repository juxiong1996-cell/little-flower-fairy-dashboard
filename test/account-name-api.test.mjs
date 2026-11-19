import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDashboardServer } from '../src/app/server.mjs';
import { readLegacyMakeupSetting, writeLegacyMakeupSetting } from './support/legacy-settings.mjs';

async function fixture(t, overrides = {}, accounts = ['main']) {
  const appRoot = await mkdtemp(join(tmpdir(), 'flower-dashboard-'));
  const profileRoot = join(appRoot, 'profiles');
  await mkdir(profileRoot);
  for (const account of accounts) await mkdir(join(profileRoot, 'account-' + account));
  const options = {
    appRoot, profileRoot, activity: {}, readIdentity: async () => ({}),
    checkLogin: async () => '淘米账号已登录', showGame: async () => {},
    readCalendar: async () => ({ current: null }), ...overrides,
  };
  let server, origin;
  async function close() {
    if (!server) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    server = null;
  }
  async function start() {
    server = createDashboardServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(async () => { await close(); await rm(appRoot, { recursive: true, force: true }); });
  await start();
  return {
    appRoot, profileRoot,
    async request(route, data, headers = {}) {
      const response = await fetch(origin + '/api/' + route, data === undefined ? { headers } : {
        method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers },
        body: JSON.stringify(data),
      });
      return { status: response.status, value: await response.json() };
    },
    async raw(route, body, headers = {}) {
      const response = await fetch(origin + '/api/' + route, {
        method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body,
      });
      return { status: response.status, value: await response.json() };
    },
    async restart() { await close(); await start(); },
  };
}

test('已有账号无需迁移即可显示，未取得登录名称时保留原编号', async t => {
  const app = await fixture(t, {}, ['alt1', 'main', 'not valid']);
  const result = await app.request('accounts');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.map(row => row.account), ['main', 'alt1']);
  for (const row of result.value) {
    assert.equal(row.displayName, row.account);
    assert.equal(row.nameSource, 'fallback');
    assert.equal(row.customName, '');
    assert.equal(Object.hasOwn(row, 'enabled'), false);
  }
});

test('添加中文名称使用稳定内部编号，也兼容旧添加接口和留空自动命名', async t => {
  const app = await fixture(t, {}, []);
  const added = await app.request('add', { displayName: '  我的主号 🌸  ' });
  assert.equal(added.status, 200);
  assert.match(added.value.account, /^a[0-9a-f]{20}$/);
  assert.equal(added.value.displayName, '我的主号 🌸');
  assert.equal(added.value.nameSource, 'custom');
  const automatic = await app.request('add', { displayName: '' });
  assert.equal(automatic.status, 200);
  assert.equal(automatic.value.displayName, automatic.value.account);
  assert.equal(automatic.value.nameSource, 'fallback');
  const legacy = await app.request('add', { account: 'Alt_2' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.value.account, 'alt_2');
  assert.equal(legacy.value.displayName, 'alt_2');
  assert.equal((await app.request('add', { account: 'alt_2' })).status, 409);
  assert.deepEqual((await readdir(app.profileRoot)).sort(), [added.value.account, automatic.value.account, 'alt_2'].map(key => 'account-' + key).sort());
});

test('改名持久保存且保留登录目录和旧设置，清空恢复最新自动名称', async t => {
  let identity = { accountName: '游戏原名', maskedPhone: '13800138000' };
  const app = await fixture(t, { readIdentity: async () => identity });
  const marker = join(app.profileRoot, 'account-main', 'session-marker');
  await writeFile(marker, 'keep-login-session');
  await writeLegacyMakeupSetting(app.appRoot, 'main');
  assert.equal((await app.request('accounts')).value[0].displayName, '游戏原名');
  const renamed = await app.request('name', { account: 'main', displayName: '我的大号' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.displayName, '我的大号');
  assert.equal(renamed.value.account, 'main');
  identity = { accountName: '游戏新名' };
  const checked = await app.request('check', { account: 'main' });
  assert.equal(checked.value.status, '淘米账号已登录');
  assert.equal(checked.value.displayName, '我的大号');
  assert.equal(checked.value.accountName, '游戏新名');
  await app.restart();
  const rows = (await app.request('accounts')).value;
  assert.equal(rows[0].displayName, '我的大号');
  assert.equal(Object.hasOwn(rows[0], 'enabled'), false);
  assert.equal(await readLegacyMakeupSetting(app.appRoot, 'main'), true);
  assert.equal(await readFile(marker, 'utf8'), 'keep-login-session');
  assert.deepEqual(await readdir(app.profileRoot), ['account-main']);
  const reset = await app.request('name', { account: 'MAIN', displayName: '' });
  assert.equal(reset.status, 200);
  assert.equal(reset.value.customName, '');
  assert.equal(reset.value.displayName, '游戏新名');
  assert.equal(reset.value.nameSource, 'account');
  await app.restart();
  assert.equal((await app.request('accounts')).value[0].displayName, '游戏新名');
});

test('登录名称优先于脱敏手机号，手机号和刷新返回的数据均不泄露原号码', async t => {
  const identities = {
    main: { accountName: '花仙玩家', maskedPhone: '13800138000' },
    alt1: { maskedPhone: '13912345678' },
    alt2: { accountName: '13712344321' },
  };
  const app = await fixture(t, { readIdentity: async key => identities[key] }, ['main', 'alt1', 'alt2']);
  const rows = (await app.request('accounts')).value;
  assert.equal(rows[0].displayName, '花仙玩家');
  assert.equal(rows[0].nameSource, 'account');
  assert.equal(rows[1].displayName, '139****5678');
  assert.equal(rows[1].nameSource, 'phone');
  assert.equal(rows[2].displayName, '137****4321');
  const body = JSON.stringify(rows);
  for (const phone of ['13800138000', '13912345678', '13712344321']) assert.ok(!body.includes(phone));
  identities.alt1 = {};
  await app.restart();
  assert.equal((await app.request('accounts')).value[1].displayName, '139****5678');
});

test('无效输入、未知账号和跨站请求均被拒绝，失败添加不会留下目录', async t => {
  const app = await fixture(t);
  for (const displayName of ['花'.repeat(33), '花\n花', 12]) {
    assert.equal((await app.request('name', { account: 'main', displayName })).status, 400);
  }
  assert.equal((await app.request('name', { account: 'missing', displayName: '名字' })).status, 404);
  assert.equal((await app.request('name', { account: '../escape', displayName: '名字' })).status, 400);
  assert.equal((await app.request('add', { displayName: '花'.repeat(33) })).status, 400);
  assert.deepEqual(await readdir(app.profileRoot), ['account-main']);
  assert.equal((await app.request('name', { account: 'main', displayName: '名字' }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await app.raw('name', '{')).status, 400);
  assert.equal((await app.raw('name', '{}', { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await app.raw('name', 'x'.repeat(1025))).status, 413);
  assert.equal((await app.request('missing')).status, 404);
});

test('游戏连接读取失败时仍可改名与查看账号，活动失败后也可继续修改', async t => {
  const app = await fixture(t, {
    readIdentity: async () => { throw new Error('游戏窗口未连接'); },
    activity: { getProgress: async () => { throw new Error('官方服务暂不可用'); } },
  });
  assert.equal((await app.request('accounts')).status, 200);
  const failed = await app.request('activity/progress', { account: 'main' });
  assert.equal(failed.status, 500);
  assert.match(failed.value.error, /官方服务/);
  assert.equal((await app.request('name', { account: 'main', displayName: '离线也能改名' })).status, 200);
  assert.equal((await app.request('accounts')).value[0].displayName, '离线也能改名');
});

test('活动查询期间仍可查看名称，查询完成后继续使用同一账号改名', async t => {
  let entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture(t, {
    activity: { getProgress: async account => {
      entered();
      await gate;
      return { account, role: 1, season: 11, today: 2, totalDays: 56, signedDays: [1], at: new Date().toISOString() };
    } },
  });
  const query = app.request('activity/progress', { account: 'main' });
  await waiting;
  try {
    const renamed = await app.request('name', { account: 'main', displayName: '正在查询的大号' });
    assert.equal(renamed.status, 409);
    assert.equal((await app.request('accounts')).value[0].displayName, 'main');
  } finally { release(); }
  const progress = await query;
  assert.equal(progress.status, 200);
  assert.equal(progress.value.account, 'main');
  assert.equal(progress.value.displayName, 'main');
  const renamed = await app.request('name', { account: 'main', displayName: '查询后仍能改名' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.value.account, 'main');
  assert.equal(renamed.value.displayName, '查询后仍能改名');
});
