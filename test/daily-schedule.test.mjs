import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDailyScheduler } from '../src/schedule/daily-schedule.mjs';

function fakeClock(at = '2026-11-18T00:00:00.000Z') {
  let current = Date.parse(at), sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    set(at) { current = Date.parse(at); },
    setTimer(callback, delay) {
      const id = { id: ++sequence, unref() {} };
      timers.set(id, { callback, delay, due: current + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    timers,
    next() { return [...timers.values()].sort((a, b) => a.due - b.due)[0]; },
    fire() {
      const [id, timer] = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      timers.delete(id);
      current = timer.due;
      return timer.callback();
    },
  };
}

async function fixture(t, { at, runBatch = async () => ({ total: 0, signed: 0, failed: 0 }) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flower-daily-schedule-'));
  const clock = fakeClock(at);
  const options = { root, runBatch, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer };
  const scheduler = await createDailyScheduler(options);
  t.after(async () => { scheduler.stop(); await rm(root, { recursive: true, force: true }); });
  return { root, clock, scheduler, options };
}

test('默认关闭，开启后按北京时间安排未来的每日时间，不立即签到', async t => {
  let calls = 0;
  const { scheduler, clock } = await fixture(t, { runBatch: async () => { calls++; } });
  assert.deepEqual(scheduler.getStatus(), {
    enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', running: false, nextRunAt: null, lastRun: null, lastError: null,
  });
  scheduler.start();
  assert.equal(clock.timers.size, 0);
  const result = await scheduler.update({ enabled: true, time: '09:00' });
  assert.equal(result.nextRunAt, '2026-11-18T01:00:00.000Z');
  assert.equal(clock.next().delay, 60 * 60 * 1000);
  assert.equal(calls, 0);
  scheduler.start();
  assert.equal(clock.timers.size, 1);
});

test('设定时间等于现在或已经过去时，安排明天且不补跑；午夜按北京时间计算', async t => {
  const { scheduler, clock } = await fixture(t, { at: '2026-11-18T01:00:00.000Z' });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-19T01:00:00.000Z');
  await scheduler.update({ enabled: true, time: '08:00' });
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-19T00:00:00.000Z');
  clock.set('2026-11-18T15:59:59.000Z');
  await scheduler.update({ enabled: true, time: '00:00' });
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-18T16:00:00.000Z');
  assert.equal(clock.next().delay, 1000);
});

test('到点只执行一次，保存批量结果并安排第二天；返回状态不会暴露可修改的内部对象', async t => {
  let calls = 0;
  const summary = { startedAt: 'start', finishedAt: 'end', total: 2, signed: 1, alreadySigned: 1, failed: 0, results: [{ account: 'main' }] };
  const { scheduler, clock, root } = await fixture(t, { runBatch: async () => { calls++; return summary; } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  await clock.fire();
  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus().running, false);
  assert.deepEqual(scheduler.getStatus().lastRun, summary);
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-19T01:00:00.000Z');
  assert.equal(clock.timers.size, 1);
  const status = scheduler.getStatus();
  status.lastRun.results[0].account = 'changed';
  assert.equal(scheduler.getStatus().lastRun.results[0].account, 'main');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'daily-sign-schedule.json'), 'utf8')).lastRun, summary);
});

test('批量抛错仍记录原因并安排下一天，之后成功会清除错误', async t => {
  let fail = true;
  const { scheduler, clock } = await fixture(t, { runBatch: async () => {
    if (fail) throw new Error('游戏暂时离线');
    return { total: 1, signed: 1, failed: 0 };
  } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  await clock.fire();
  assert.equal(scheduler.getStatus().lastError, '游戏暂时离线');
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-19T01:00:00.000Z');
  fail = false;
  await clock.fire();
  assert.equal(scheduler.getStatus().lastError, null);
  assert.equal(scheduler.getStatus().lastRun.signed, 1);
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-20T01:00:00.000Z');
});

test('重启读取已保存时间和上次结果，错过的时间不补跑', async t => {
  let calls = 0;
  const { scheduler, clock, options } = await fixture(t, { runBatch: async () => { calls++; return { total: 1, signed: 1 }; } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  await clock.fire();
  scheduler.stop();
  clock.set('2026-11-21T02:00:00.000Z');
  const restarted = await createDailyScheduler(options);
  t.after(() => restarted.stop());
  assert.equal(restarted.getStatus().nextRunAt, null);
  assert.equal(restarted.getStatus().lastRun.signed, 1);
  restarted.start();
  assert.equal(restarted.getStatus().nextRunAt, '2026-11-22T01:00:00.000Z');
  assert.equal(calls, 1);
});

test('运行中的批量不会重入，修改时间后仅在批量完成时安排新时间', async t => {
  let release, calls = 0;
  const batch = new Promise(resolve => { release = resolve; });
  const { scheduler, clock } = await fixture(t, { runBatch: async () => { calls++; await batch; return { total: 1 }; } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  const oldCallback = clock.next().callback;
  const active = clock.fire();
  assert.equal(scheduler.getStatus().running, true);
  await oldCallback();
  assert.equal(calls, 1);
  await scheduler.update({ enabled: true, time: '10:30' });
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.getStatus().nextRunAt, null);
  release();
  await active;
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-18T02:30:00.000Z');
  assert.equal(clock.timers.size, 1);
});

test('批量中关闭或停止会让本次完成，但不会再安排任务', async t => {
  for (const mode of ['disable', 'stop']) {
    let release;
    const batch = new Promise(resolve => { release = resolve; });
    const { scheduler, clock } = await fixture(t, { runBatch: async () => { await batch; return { total: 1 }; } });
    scheduler.start();
    await scheduler.update({ enabled: true, time: '09:00' });
    const active = clock.fire();
    if (mode === 'disable') await scheduler.update({ enabled: false, time: '09:00' });
    else scheduler.stop();
    assert.equal(scheduler.getStatus().running, true);
    release();
    await active;
    assert.equal(scheduler.getStatus().running, false);
    assert.equal(scheduler.getStatus().nextRunAt, null);
    assert.equal(clock.timers.size, 0);
    assert.equal(scheduler.getStatus().lastRun.total, 1);
  }
});

test('停止会取消旧回调，保存中的更新也不会重新启动；重新启动才安排任务', async t => {
  let calls = 0;
  const { scheduler, clock } = await fixture(t, { runBatch: async () => { calls++; } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  const oldCallback = clock.next().callback;
  const changing = scheduler.update({ enabled: true, time: '10:00' });
  scheduler.stop();
  await changing;
  await oldCallback();
  assert.equal(calls, 0);
  assert.equal(clock.timers.size, 0);
  assert.equal(scheduler.getStatus().nextRunAt, null);
  scheduler.start();
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-18T02:00:00.000Z');
});

test('无效输入保留原设置和计划；并发更新按提交顺序保存', async t => {
  const { scheduler, clock, root } = await fixture(t);
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  const original = scheduler.getStatus();
  for (const input of [null, [], 42, '09:00', {}, { enabled: 'true', time: '09:00' }, { enabled: true, time: '9:00' },
    { enabled: true, time: '24:00' }, { enabled: true, time: '12:60' }, { enabled: true, time: '12:00\n' }]) {
    await assert.rejects(scheduler.update(input), error => error.status === 400);
    assert.deepEqual(scheduler.getStatus(), original);
  }
  assert.equal(clock.timers.size, 1);
  await Promise.all([
    scheduler.update({ enabled: true, time: '10:00' }),
    scheduler.update({ enabled: false, time: '11:00' }),
  ]);
  assert.equal(scheduler.getStatus().time, '11:00');
  assert.equal(scheduler.getStatus().enabled, false);
  assert.equal(clock.timers.size, 0);
  const saved = JSON.parse(await readFile(join(root, 'daily-sign-schedule.json'), 'utf8'));
  assert.equal(saved.time, '11:00');
  assert.equal(saved.enabled, false);
});

test('电脑唤醒后只执行一次，下一次设在未来，不连续补跑错过的天数', async t => {
  let calls = 0;
  const { scheduler, clock } = await fixture(t, { runBatch: async () => { calls++; return { total: 1 }; } });
  scheduler.start();
  await scheduler.update({ enabled: true, time: '09:00' });
  const callback = clock.next().callback;
  clock.timers.clear();
  clock.set('2026-11-20T03:00:00.000Z');
  await callback();
  assert.equal(calls, 1);
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-21T01:00:00.000Z');
  assert.equal(clock.timers.size, 1);
});

test('损坏的设置会关闭定时并显示原因，仍可重新保存修复', async t => {
  const { root, clock, options } = await fixture(t);
  await writeFile(join(root, 'daily-sign-schedule.json'), '{broken json');
  const scheduler = await createDailyScheduler(options);
  t.after(() => scheduler.stop());
  scheduler.start();
  assert.equal(scheduler.getStatus().enabled, false);
  assert.equal(clock.timers.size, 0);
  assert.match(scheduler.getStatus().lastError, /设置读取失败.*已关闭/);
  await scheduler.update({ enabled: true, time: '09:30' });
  assert.equal(scheduler.getStatus().nextRunAt, '2026-11-18T01:30:00.000Z');
  assert.equal(scheduler.getStatus().lastError, null);
  assert.equal(JSON.parse(await readFile(join(root, 'daily-sign-schedule.json'), 'utf8')).time, '09:30');
});
