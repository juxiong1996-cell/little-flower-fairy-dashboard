import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/app/server.mjs';

function fakeClock() {
  let current = Date.parse('2026-11-18T00:59:00.000Z'), sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: current + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    timers,
    async fireNext() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      current = timer.at;
      return timer.callback();
    },
  };
}

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flower-daily-api-'));
  const clock = fakeClock();
  const calls = [], signed = new Set(['already']);
  let active = 0, maxActive = 0;
  const activity = {
    async withAccount(account, action) {
      active++;
      maxActive = Math.max(maxActive, active);
      calls.push(account);
      try { return await action(); } finally { active--; }
    },
    async getProgress(account) {
      if (account === 'bad') throw new Error('登录已过期，请重新登录');
      return { account, role: 'test-role', season: 11, today: 6, totalDays: 56,
        signedDays: signed.has(account) ? [6] : [] };
    },
    async signToday({ account }) { signed.add(account); },
  };
  const options = { appRoot: root, profileRoot: join(root, 'profiles'), activity,
    readIdentity: async () => null, readCalendar: async () => ({ current: null }),
    checkLogin: async () => '已登录', showGame: async () => {}, scheduleClock: clock, ...overrides };
  let server, origin;
  async function start() {
    server = createDashboardServer(options);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
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
  async function request(route, body, headers = {}) {
    const response = await fetch(origin + '/api/' + route, body === undefined ? {} : {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  await start();
  return { root, clock, calls, signed, activity, request, start, stop, maxActive: () => maxActive };
}

test('设置每日时间后到点逐个签到，单个失败不影响后续账号，保存结果并安排明天', async t => {
  const f = await fixture(t);
  for (const account of ['main', 'already', 'bad', 'zlast']) {
    assert.equal((await f.request('add', { account, displayName: account === 'main' ? '我的主号' : '' })).status, 200);
  }
  const initial = (await f.request('schedule')).value;
  assert.equal(initial.enabled, false);
  assert.equal(initial.nextRunAt, null);
  assert.equal(f.clock.timers.size, 0);
  const enabled = await f.request('schedule', { enabled: true, time: '09:00' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.value.timeZone, 'Asia/Shanghai');
  assert.equal(enabled.value.nextRunAt, '2026-11-18T01:00:00.000Z');
  assert.deepEqual(f.calls, []);
  await f.clock.fireNext();
  const state = (await f.request('schedule')).value;
  assert.equal(state.running, false);
  assert.equal(state.nextRunAt, '2026-11-19T01:00:00.000Z');
  assert.equal(state.lastRun.total, 4);
  assert.equal(state.lastRun.signed, 2);
  assert.equal(state.lastRun.alreadySigned, 1);
  assert.equal(state.lastRun.failed, 1);
  assert.equal(state.lastRun.results[0].displayName, '我的主号');
  assert.match(state.lastRun.results.find(result => result.account === 'bad').error, /登录已过期/);
  assert.deepEqual(f.calls, ['main', 'already', 'bad', 'zlast']);
  assert.equal(f.maxActive(), 1);
  assert.equal(f.signed.has('zlast'), true);
  const saved = JSON.parse(await readFile(join(f.root, 'daily-sign-schedule.json'), 'utf8'));
  assert.deepEqual(saved.lastRun, state.lastRun);
});

test('每次到点读取当前账号列表，移除账号不会参与；关闭服务停止计时，重启恢复设置', async t => {
  const f = await fixture(t);
  await f.request('add', { account: 'old' });
  await f.request('schedule', { enabled: true, time: '09:00' });
  await f.request('remove', { account: 'old' });
  await f.request('add', { account: 'new' });
  await f.clock.fireNext();
  assert.deepEqual(f.calls, ['new']);
  await f.stop();
  assert.equal(f.clock.timers.size, 0);
  await f.start();
  const restored = (await f.request('schedule')).value;
  assert.equal(restored.enabled, true);
  assert.equal(restored.time, '09:00');
  assert.equal(restored.lastRun.total, 1);
  assert.equal(restored.nextRunAt, '2026-11-19T01:00:00.000Z');
  const stopped = await f.request('schedule', { enabled: false, time: '09:00' });
  assert.equal(stopped.value.nextRunAt, null);
  assert.equal(f.clock.timers.size, 0);
});

test('校验时间、开关和来源，空账号列表不能开启但可以关闭', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('schedule', { enabled: true, time: '09:00' })).status, 409);
  assert.equal((await f.request('schedule', { enabled: false, time: '09:00' })).status, 200);
  for (const body of [null, [], {}, { enabled: 'true', time: '09:00' }, { enabled: false, time: '24:00' }, { enabled: false, time: '9:00' }]) {
    assert.equal((await f.request('schedule', body)).status, 400);
  }
  assert.equal((await f.request('schedule', { enabled: false, time: '09:00' }, { origin: 'https://example.test' })).status, 403);
  assert.equal((await f.request('schedule', { enabled: false, time: '09:00' }, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await f.request('schedule')).value.enabled, false);
});

test('签到能力未接通时拒绝开启，关闭定时功能仍可用', async t => {
  const f = await fixture(t, { activity: {} });
  await f.request('add', { account: 'main' });
  assert.equal((await f.request('schedule', { enabled: true, time: '09:00' })).status, 503);
  assert.equal((await f.request('schedule', { enabled: false, time: '09:00' })).status, 200);
});

test('定时签到复用账号忙碌保护，执行期间手动操作不能挤入', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t);
  const getProgress = f.activity.getProgress;
  f.activity.getProgress = async account => { entered(); await held; return getProgress(account); };
  await f.request('add', { account: 'main' });
  await f.request('schedule', { enabled: true, time: '09:00' });
  const running = f.clock.fireNext();
  try {
    await started;
    assert.equal((await f.request('schedule')).value.running, true);
    assert.equal((await f.request('activity/sign', { account: 'main' })).status, 409);
    assert.equal((await f.request('remove', { account: 'main' })).status, 409);
  } finally { release(); await running; }
  assert.equal((await f.request('schedule')).value.lastRun.signed, 1);
});
