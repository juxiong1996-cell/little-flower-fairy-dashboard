import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBatchController, DEFAULT_MAX_CONCURRENT, validateMaxConcurrent } from '../src/batch/batch-controller.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-batch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, controller: await createBatchController({ root }) };
}

test('默认同时处理 5 个账号，返回的设置不能修改内部值', async t => {
  const { controller } = await fixture(t);
  assert.equal(DEFAULT_MAX_CONCURRENT, 5);
  assert.deepEqual(controller.getSettings(), { maxConcurrent: 5 });
  controller.getSettings().maxConcurrent = 99;
  assert.equal(controller.getSettings().maxConcurrent, 5);
  const held = gate();
  const entered = [];
  const tasks = Array.from({ length: 8 }, (_, i) => controller.run(async () => {
    entered.push(i);
    await held.promise;
    return i;
  }));
  await tick();
  assert.deepEqual(entered, [0, 1, 2, 3, 4]);
  held.resolve();
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(entered, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('按提交顺序保存设置，重启恢复，并清理临时文件', async t => {
  const { root, controller } = await fixture(t);
  const first = { maxConcurrent: 2 };
  const saving = controller.update(first);
  first.maxConcurrent = 100;
  assert.deepEqual(await Promise.all([saving, controller.update({ maxConcurrent: 3 }), controller.update({ maxConcurrent: 1 })]),
    [{ maxConcurrent: 2 }, { maxConcurrent: 3 }, { maxConcurrent: 1 }]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'batch-settings.json'), 'utf8')), { maxConcurrent: 1 });
  assert.deepEqual((await createBatchController({ root })).getSettings(), { maxConcurrent: 1 });
  assert.deepEqual(await readdir(root), ['batch-settings.json']);
});

test('拒绝无效并发数并保留已保存设置', async t => {
  const { root, controller } = await fixture(t);
  await controller.update({ maxConcurrent: 2 });
  for (const value of [null, undefined, true, '5', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateMaxConcurrent(value), error => error.status === 400);
    await assert.rejects(controller.update({ maxConcurrent: value }), error => error.status === 400);
  }
  for (const value of [null, undefined, [], 5, '5', {}]) {
    await assert.rejects(controller.update(value), error => error.status === 400);
  }
  assert.deepEqual(controller.getSettings(), { maxConcurrent: 2 });
  assert.deepEqual(JSON.parse(await readFile(join(root, 'batch-settings.json'), 'utf8')), { maxConcurrent: 2 });
  assert.equal(validateMaxConcurrent(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
});

test('损坏或无效设置提示默认上限，队列仍能使用，重新保存后修复', async t => {
  const { root } = await fixture(t);
  const file = join(root, 'batch-settings.json');
  for (const content of ['{bad json', 'null', '[]', '{}', '{"maxConcurrent":0}']) {
    await writeFile(file, content);
    const controller = await createBatchController({ root });
    const settings = controller.getSettings();
    assert.equal(settings.maxConcurrent, 5);
    assert.match(settings.lastError, /并行设置读取失败，已使用默认 5 个账号，请重新保存：/);
    assert.equal(await readFile(file, 'utf8'), content);
    assert.equal(await controller.run(() => '仍可操作'), '仍可操作');
    assert.deepEqual(await controller.update({ maxConcurrent: 3 }), { maxConcurrent: 3 });
    assert.deepEqual(controller.getSettings(), { maxConcurrent: 3 });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { maxConcurrent: 3 });
    assert.deepEqual((await createBatchController({ root })).getSettings(), { maxConcurrent: 3 });
  }
});

test('单个账号失败或同步抛错都会释放槽位，后续账号继续且只执行一次', async t => {
  const { controller } = await fixture(t);
  await controller.update({ maxConcurrent: 1 });
  const held = gate();
  const entered = [];
  const first = controller.run(async () => { entered.push('first'); await held.promise; throw new Error('登录过期'); });
  const firstFailure = assert.rejects(first, /登录过期/);
  const second = controller.run(() => { entered.push('second'); throw new Error('同步失败'); });
  const secondFailure = assert.rejects(second, /同步失败/);
  const third = controller.run(() => { entered.push('third'); return 'done'; });
  await tick();
  assert.deepEqual(entered, ['first']);
  held.resolve();
  await Promise.all([firstFailure, secondFailure]);
  assert.equal(await third, 'done');
  assert.deepEqual(entered, ['first', 'second', 'third']);
});

test('提高上限立即增加正在处理的账号，保存设置不等待已有操作结束', async t => {
  const { controller } = await fixture(t);
  await controller.update({ maxConcurrent: 1 });
  const held = gate();
  let active = 0, maximum = 0;
  const entered = [];
  const tasks = Array.from({ length: 6 }, (_, i) => controller.run(async () => {
    entered.push(i);
    active++;
    maximum = Math.max(maximum, active);
    await held.promise;
    active--;
  }));
  await tick();
  assert.deepEqual(entered, [0]);
  await controller.update({ maxConcurrent: 3 });
  await tick();
  assert.deepEqual(entered, [0, 1, 2]);
  assert.equal(active, 3);
  held.resolve();
  await Promise.all(tasks);
  assert.equal(maximum, 3);
  assert.deepEqual(entered, [0, 1, 2, 3, 4, 5]);
});

test('降低上限保留正在处理的账号，等待空出足够槽位再继续', async t => {
  const { controller } = await fixture(t);
  await controller.update({ maxConcurrent: 3 });
  const gates = Array.from({ length: 6 }, gate);
  const entered = [];
  const tasks = gates.map((held, i) => controller.run(async () => { entered.push(i); await held.promise; }));
  await tick();
  assert.deepEqual(entered, [0, 1, 2]);
  await controller.update({ maxConcurrent: 1 });
  gates[0].resolve();
  gates[1].resolve();
  await tick();
  assert.deepEqual(entered, [0, 1, 2]);
  gates[2].resolve();
  await tick();
  assert.deepEqual(entered, [0, 1, 2, 3]);
  gates[3].resolve();
  await tick();
  assert.deepEqual(entered, [0, 1, 2, 3, 4]);
  gates[4].resolve();
  await tick();
  assert.deepEqual(entered, [0, 1, 2, 3, 4, 5]);
  gates[5].resolve();
  await Promise.all(tasks);
});

test('保存失败保留原上限，修复存储后可以再次保存', async t => {
  const { root, controller } = await fixture(t);
  await controller.update({ maxConcurrent: 2 });
  const file = join(root, 'batch-settings.json');
  await rm(file);
  await mkdir(file);
  await assert.rejects(controller.update({ maxConcurrent: 8 }));
  assert.deepEqual(controller.getSettings(), { maxConcurrent: 2 });
  await rm(file, { recursive: true, force: true });
  await controller.update({ maxConcurrent: 4 });
  assert.deepEqual(controller.getSettings(), { maxConcurrent: 4 });
  assert.deepEqual(await readdir(root), ['batch-settings.json']);
});
