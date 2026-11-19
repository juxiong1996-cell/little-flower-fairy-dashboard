import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/app/server.mjs';

function fakeClock() {
  let current = Date.parse('2026-11-19T00:59:00.000Z'), sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: current + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    fireNext() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      current = timer.at;
      return timer.callback();
    },
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-batch-api-'));
  const clock = fakeClock();
  const calls = [], waiting = [], holds = new Map(), identityReads = new Set(), pendingRequests = new Set();
  const signed = new Set(['already']);
  let active = 0, maxActive = 0, server, origin;

  function hold(account) {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    holds.set(account, { promise, release });
  }
  function release(account) { holds.get(account)?.release(); }
  function releaseAll() { for (const held of holds.values()) held.release(); }
  function waitForStarted(count) {
    if (calls.length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const alarm = setTimeout(() => reject(new Error(`等待 ${count} 个账号开始操作超时，实际 ${calls.length} 个`)), 3000);
      waiting.push({ count, resolve() { clearTimeout(alarm); resolve(); } });
    });
  }
  async function operate(account, kind, action) {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push({ account, kind });
    for (const waiter of waiting.filter(waiter => calls.length >= waiter.count)) waiter.resolve();
    try {
      await holds.get(account)?.promise;
      return await action();
    } finally { active--; }
  }
  const activity = {
    withAccount: (account, action) => operate(account, 'activity', action),
    async getProgress(account) {
      if (account === 'bad') throw new Error('登录已过期，请重新登录');
      return { account, role: 'fixture-role', season: 11, today: 6, totalDays: 56,
        signedDays: signed.has(account) ? [6] : [], rewards: [] };
    },
    async signToday({ account }) { signed.add(account); },
    async claimReward() { throw new Error('测试没有可领取礼盒'); },
  };
  function request(route, body, headers = {}) {
    const operation = (async () => {
      const response = await fetch(origin + '/api/' + route, body === undefined ? {} : {
        method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    })();
    pendingRequests.add(operation);
    operation.then(() => pendingRequests.delete(operation), () => pendingRequests.delete(operation));
    return operation;
  }
  async function start() {
    server = createDashboardServer({ appRoot: root, profileRoot: join(root, 'profiles'), activity,
      scheduleClock: clock, readCalendar: async () => ({ current: null }),
      readIdentity: async account => { identityReads.add(account); return null; },
      checkLogin: account => operate(account, 'check', async () => '已登录'),
      showGame: account => operate(account, 'open', async () => {}),
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    await request('batch-settings');
    await request('schedule');
  }
  async function stop() {
    if (!server?.listening) return;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
    await new Promise(resolve => setImmediate(resolve));
  }
  async function add(...accounts) {
    for (const account of accounts) assert.equal((await request('add', { account })).status, 200);
  }
  async function waitForBusy(account) {
    // Listing skips identity reads for reserved accounts, including queued ones.
    // This waits for the HTTP action to reserve its account without relying on a sleep.
    for (let attempt = 0; attempt < 100; attempt++) {
      identityReads.clear();
      await request('accounts');
      if (!identityReads.has(account)) return;
    }
    assert.fail(`${account} 尚未进入操作队列`);
  }
  t.after(async () => {
    releaseAll();
    await Promise.allSettled([...pendingRequests]);
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  await start();
  return { root, clock, calls, signed, request, start, stop, add, hold, release, releaseAll, waitForStarted, waitForBusy,
    active: () => active, maxActive: () => maxActive };
}

test('默认同时处理 5 个账号，第 6 个排队并在空出名额后开始', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('batch-settings')).value, { maxConcurrent: 5 });
  const accounts = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'];
  await f.add(...accounts);
  accounts.forEach(f.hold);
  const requests = accounts.slice(0, 5).map(account => f.request('activity/progress', { account }));
  try {
    await f.waitForStarted(5);
    requests.push(f.request('activity/progress', { account: 'a5' }));
    await f.waitForBusy('a5');
    assert.equal(f.calls.length, 5);
    assert.equal(f.active(), 5);
    f.release('a2');
    await f.waitForStarted(6);
    assert.equal(f.calls[5].account, 'a5');
    assert.equal(f.active(), 5);
  } finally { f.releaseAll(); await Promise.all(requests); }
  assert.equal(f.maxActive(), 5);
  assert.deepEqual((await Promise.all(requests)).map(result => result.status), [200, 200, 200, 200, 200, 200]);
  assert.equal(new Set(f.calls.map(call => call.account)).size, 6);
});

test('查询、签到、签到领奖、登录检查和打开游戏共用设置的并发上限', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('batch-settings', { maxConcurrent: 2 })).status, 200);
  const actions = [['read', 'activity/progress'], ['write', 'activity/sign'], ['reward', 'activity/run'], ['login', 'check'], ['game', 'open']];
  await f.add(...actions.map(([account]) => account));
  actions.forEach(([account]) => f.hold(account));
  const requests = actions.slice(0, 2).map(([account, route]) => f.request(route, { account }));
  try {
    await f.waitForStarted(2);
    for (const [account, route] of actions.slice(2)) {
      requests.push(f.request(route, { account }));
      await f.waitForBusy(account);
    }
    assert.equal(f.calls.length, 2);
    assert.equal(f.active(), 2);
    f.release('read');
    await f.waitForStarted(3);
    assert.ok(['reward', 'login', 'game'].includes(f.calls[2].account));
    assert.equal(f.active(), 2);
  } finally { f.releaseAll(); await Promise.all(requests); }
  assert.equal(f.maxActive(), 2);
  assert.ok((await Promise.all(requests)).every(result => result.status === 200));
  assert.deepEqual(new Set(f.calls.map(call => call.kind)), new Set(['activity', 'check', 'open']));
  assert.equal(f.signed.has('write'), true);
  assert.equal(f.signed.has('reward'), true);
  assert.equal(f.calls.length, 5);
});

test('失败释放名额继续后续账号，排队中的账号也拒绝重复操作和移除', async t => {
  const f = await fixture(t);
  await f.request('batch-settings', { maxConcurrent: 1 });
  await f.add('bad', 'queued');
  f.hold('bad');
  f.hold('queued');
  const failing = f.request('activity/progress', { account: 'bad' });
  let queued;
  try {
    await f.waitForStarted(1);
    queued = f.request('activity/sign', { account: 'queued' });
    await f.waitForBusy('queued');
    for (const [route, body] of [
      ['check', { account: 'QUEUED' }], ['remove', { account: 'queued' }],
      ['name', { account: 'queued', displayName: '新名称' }], ['add', { account: 'queued' }],
    ]) {
      const result = await f.request(route, body);
      assert.equal(result.status, 409);
      assert.match(result.value.error, /正在操作/);
    }
    assert.equal(f.calls.length, 1);
    f.release('bad');
    await f.waitForStarted(2);
    assert.equal(f.calls[1].account, 'queued');
    assert.equal(f.active(), 1);
  } finally { f.releaseAll(); await Promise.all([failing, queued]); }
  assert.equal((await failing).status, 500);
  assert.match((await failing).value.error, /登录已过期/);
  assert.equal((await queued).status, 200);
  assert.equal((await queued).value.progress.todaySigned, true);
  assert.equal(f.maxActive(), 1);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.request('remove', { account: 'queued' })).status, 200);
});

test('定时签到和手动查询共用名额，单个失败继续并保存正确汇总', async t => {
  const f = await fixture(t);
  await f.request('batch-settings', { maxConcurrent: 2 });
  const accounts = ['manual', 'newone', 'already', 'bad', 'zlast'];
  await f.add(...accounts);
  accounts.forEach(f.hold);
  const manual = f.request('activity/progress', { account: 'manual' });
  let scheduled;
  try {
    await f.waitForStarted(1);
    await f.request('schedule', { enabled: true, time: '09:00' });
    scheduled = f.clock.fireNext();
    await f.waitForStarted(2);
    for (const account of accounts.slice(1)) await f.waitForBusy(account);
    assert.equal(f.active(), 2);
    assert.equal(f.calls.length, 2);
    assert.equal((await f.request('schedule')).value.running, true);
    accounts.slice(1).forEach(f.release);
    await scheduled;
    assert.equal(f.active(), 1);
    const state = (await f.request('schedule')).value;
    assert.equal(state.running, false);
    assert.equal(state.lastRun.total, 5);
    assert.equal(state.lastRun.signed, 2);
    assert.equal(state.lastRun.alreadySigned, 1);
    assert.equal(state.lastRun.failed, 2);
    assert.match(state.lastRun.results.find(result => result.account === 'manual').error, /正在操作/);
    assert.match(state.lastRun.results.find(result => result.account === 'bad').error, /登录已过期/);
    assert.equal(state.lastRun.results.find(result => result.account === 'already').alreadySigned, true);
    assert.deepEqual(state.lastRun.results.map(result => result.account), [...accounts].sort());
    assert.equal(f.signed.has('newone'), true);
    assert.equal(f.signed.has('zlast'), true);
    assert.equal(state.nextRunAt, '2026-11-20T01:00:00.000Z');
    const saved = JSON.parse(await readFile(join(f.root, 'daily-sign-schedule.json'), 'utf8'));
    assert.deepEqual(saved.lastRun, state.lastRun);
  } finally { f.releaseAll(); await Promise.all([manual, scheduled]); }
  assert.equal((await manual).status, 200);
  assert.equal(f.maxActive(), 2);
  assert.equal(f.calls.length, 5);
});

test('并发设置保存到本机，服务重启后恢复', async t => {
  const f = await fixture(t);
  const changed = await f.request('batch-settings', { maxConcurrent: 3 });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.value, { maxConcurrent: 3 });
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'batch-settings.json'), 'utf8')), { maxConcurrent: 3 });
  await f.stop();
  await f.start();
  assert.deepEqual((await f.request('batch-settings')).value, { maxConcurrent: 3 });
  assert.equal((await f.request('batch-settings', { maxConcurrent: 1 })).status, 200);
});

test('损坏并行设置重启后显示告警，游戏操作仍可执行，重新保存修复', async t => {
  const f = await fixture(t);
  await f.add('main');
  await f.stop();
  const file = join(f.root, 'batch-settings.json');
  const broken = '{broken settings';
  await writeFile(file, broken);
  await f.start();
  const settings = await f.request('batch-settings');
  assert.equal(settings.status, 200);
  assert.equal(settings.value.maxConcurrent, 5);
  assert.match(settings.value.lastError, /并行设置读取失败，已使用默认 5 个账号，请重新保存：/);
  assert.equal(await readFile(file, 'utf8'), broken);
  assert.equal((await f.request('activity/progress', { account: 'main' })).status, 200);
  assert.deepEqual((await f.request('batch-settings', { maxConcurrent: 4 })).value, { maxConcurrent: 4 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { maxConcurrent: 4 });
  await f.stop();
  await f.start();
  assert.deepEqual((await f.request('batch-settings')).value, { maxConcurrent: 4 });
});

test('设置接口拒绝无效并发数、非本机来源和错误内容类型，并保留原设置', async t => {
  const f = await fixture(t);
  await f.request('batch-settings', { maxConcurrent: 2 });
  for (const body of [null, [], {}, 5, { maxConcurrent: '5' }, { maxConcurrent: true },
    { maxConcurrent: 0 }, { maxConcurrent: -1 }, { maxConcurrent: 1.5 }, { maxConcurrent: Number.MAX_SAFE_INTEGER + 1 }]) {
    const result = await f.request('batch-settings', body);
    assert.equal(result.status, 400);
    assert.match(result.value.error, /整数/);
  }
  assert.equal((await f.request('batch-settings', { maxConcurrent: 8 }, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.request('batch-settings', { maxConcurrent: 8 }, { 'content-type': 'text/plain' })).status, 403);
  assert.deepEqual((await f.request('batch-settings')).value, { maxConcurrent: 2 });
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'batch-settings.json'), 'utf8')), { maxConcurrent: 2 });
});
