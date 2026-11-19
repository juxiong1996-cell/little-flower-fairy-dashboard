import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/app/server.mjs';
import { readLegacyMakeupSetting, writeLegacyMakeupSetting } from './support/legacy-settings.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-account-server-'));
  const calls = [];
  let enteredProgress, releaseProgress;
  const entered = new Promise(resolve => { enteredProgress = resolve; });
  const released = new Promise(resolve => { releaseProgress = resolve; });
  let server, origin;

  async function stop() {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  t.after(async () => {
    releaseProgress();
    await stop();
    await rm(root, { recursive: true, force: true });
  });

  async function start() {
    server = createDashboardServer({
      appRoot: root, profileRoot: join(root, 'profiles'),
      activity: {
        async getProgress(account) {
          calls.push(account);
          if (account === 'slow') { enteredProgress(); await released; }
          return { account, role: 'fixture-role', season: 11, today: 6, totalDays: 56, signedDays: [6] };
        },
      },
      checkLogin: async () => 'fixture logged in',
      showGame: async () => { throw new Error('测试不应打开真实游戏窗口'); },
      readIdentity: async () => null,
      readCalendar: async () => ({ current: null }),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
  }

  async function request(path, body, headers = {}) {
    const response = await fetch(`${origin}/api/${path}`, body === undefined ? {} : {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  await start();
  return { root, entered, releaseProgress, calls, request, stop, start };
}

test('HTTP 移除持久保存，刷新和重启不恢复；重新添加保留原资料和旧设置', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('add', { account: 'main' })).status, 200);
  assert.equal((await app.request('add', { account: 'alt2', displayName: '备用账号' })).status, 200);
  await writeLegacyMakeupSetting(app.root, 'alt2');
  for (const route of ['makeup', 'activity/makeup']) {
    assert.equal((await app.request(route, { account: 'alt2', enabled: true })).status, 404);
  }
  assert.equal(Object.hasOwn((await app.request('activity')).body.capabilities, 'makeup'), false);
  assert.equal((await app.request('check', { account: 'alt2' })).status, 200);
  const profileFile = join(app.root, 'profiles', 'account-alt2', 'login-data');
  await writeFile(profileFile, 'fixture login');

  const removed = await app.request('remove', { account: 'ALT2' });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.account, 'alt2');
  assert.deepEqual((await app.request('accounts')).body.map(row => row.account), ['main']);
  await app.stop();
  await app.start();
  assert.deepEqual((await app.request('accounts')).body.map(row => row.account), ['main']);
  assert.equal((await app.request('activity/progress', { account: 'alt2' })).status, 404);
  assert.equal((await app.request('makeup', { account: 'alt2', enabled: false })).status, 404);
  const restored = await app.request('add', { account: 'ALT2' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.account, 'alt2');
  assert.equal(Object.hasOwn(restored.body, 'enabled'), false);
  assert.equal(restored.body.displayName, '备用账号');
  assert.equal(await readFile(profileFile, 'utf8'), 'fixture login');
  const rows = (await app.request('accounts')).body;
  assert.deepEqual(rows.map(row => row.account), ['main', 'alt2']);
  assert.ok(rows.every(row => !Object.hasOwn(row, 'enabled')));
  assert.equal(await readLegacyMakeupSetting(app.root, 'alt2'), true);
  assert.deepEqual(app.calls, []);
});

test('移除接口校验别名、存在性、来源和内容类型，不误移除其他账号', async t => {
  const app = await fixture(t);
  await app.request('add', { account: 'main' });
  assert.equal((await app.request('remove', { account: '../main' })).status, 400);
  assert.equal((await app.request('remove', null)).status, 400);
  assert.equal((await app.request('remove', { account: 'missing' })).status, 404);
  assert.equal((await app.request('remove', { account: 'main' }, { Origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal((await app.request('remove', { account: 'main' }, { 'Content-Type': 'text/plain' })).status, 403);
  assert.deepEqual((await app.request('accounts')).body.map(row => row.account), ['main']);
  assert.equal((await app.request('remove', { account: 'main' })).status, 200);
  assert.deepEqual((await app.request('accounts')).body, []);
  assert.equal((await app.request('remove', { account: 'main' })).status, 404);
  assert.deepEqual(app.calls, []);
});

test('查询期间禁止移除、重新添加和修改同一账号，其他账号仍可移除', { timeout: 10000 }, async t => {
  const app = await fixture(t);
  await app.request('add', { account: 'slow' });
  await app.request('add', { account: 'alt2' });
  const querying = app.request('activity/progress', { account: 'slow' });
  try {
    await app.entered;
    for (const [path, body] of [
      ['remove', { account: 'slow' }], ['add', { account: 'SLOW' }], ['name', { account: 'slow', displayName: '新名称' }],
    ]) {
      const result = await app.request(path, body);
      assert.equal(result.status, 409);
      assert.match(result.body.error, /正在操作/);
    }
    assert.equal((await app.request('remove', { account: 'alt2' })).status, 200);
  } finally {
    app.releaseProgress();
    const result = await querying;
    assert.equal(result.status, 200);
    assert.equal(result.body.source, 'live');
  }
  assert.equal((await app.request('remove', { account: 'slow' })).status, 200);
  assert.deepEqual((await app.request('accounts')).body, []);
  assert.deepEqual(app.calls, ['slow']);
});
