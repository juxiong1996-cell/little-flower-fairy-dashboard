import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfficialGame } from '../src/browser/login.mjs';

async function fixture(t, { existing = true, headless = false, closeError } = {}) {
  const profileRoot = await mkdtemp(join(tmpdir(), 'flower-game-lifecycle-'));
  t.after(() => rm(profileRoot, { recursive: true, force: true }));
  const profile = join(profileRoot, 'account-unit');
  await mkdir(profile);
  const calls = [];
  const client = {
    async send(...args) {
      calls.push(['send', ...args]);
      if (closeError) throw closeError;
    },
  };
  const attached = {
    client, attached: true, headless,
    close: async () => { calls.push(['disconnect']); },
  };
  const launched = {
    client,
    close: async () => { calls.push(['close-process']); },
    detach: () => { calls.push(['detach-process']); },
  };
  const options = {
    profileRoot,
    async attach(portFile) {
      assert.equal(portFile, join(profile, 'DevToolsActivePort'));
      calls.push(['attach']);
      return existing ? attached : null;
    },
    async launch(receivedProfile, interactive) {
      assert.equal(receivedProfile, profile);
      assert.equal(interactive, false);
      calls.push(['launch']);
      return launched;
    },
  };
  return { calls, options, client, attached, launched };
}

for (const headless of [false, true]) {
  test(`${headless ? '已有后台游戏' : '已有可见游戏窗口'}完成后真正关闭浏览器，再断开控制连接`, async t => {
    const { calls, options, client } = await fixture(t, { headless });
    const game = await openOfficialGame('unit', { ...options, closeOnFinish: true });
    assert.equal(game.client, client);
    assert.equal(game.attached, true);
    assert.equal(game.headless, headless);
    assert.deepEqual(calls, [['attach']], '完成操作前不能提前关闭游戏');
    await game.close();
    assert.deepEqual(calls, [
      ['attach'],
      ['send', 'Browser.close', {}, 2_000],
      ['disconnect'],
    ]);
  });
}

test('新启动的后台游戏完成后使用真正的进程退出逻辑', async t => {
  const { calls, options, client } = await fixture(t, { existing: false });
  const game = await openOfficialGame('unit', { ...options, closeOnFinish: true });
  assert.equal(game.client, client);
  assert.deepEqual(calls, [['attach'], ['launch']]);
  await game.close();
  assert.deepEqual(calls, [['attach'], ['launch'], ['close-process']]);
});

test('只读监听默认保留已有游戏窗口，仅断开控制连接', async t => {
  const { calls, options, attached } = await fixture(t);
  const game = await openOfficialGame('unit', options);
  assert.equal(game, attached);
  await game.close();
  assert.deepEqual(calls, [['attach'], ['disconnect']]);
});

test('只读监听默认保留新启动的游戏，仅解除进程引用', async t => {
  const { calls, options } = await fixture(t, { existing: false });
  const game = await openOfficialGame('unit', options);
  await game.close();
  assert.deepEqual(calls, [['attach'], ['launch'], ['detach-process']]);
});

test('浏览器关闭命令失败时仍断开控制连接', async t => {
  const closeError = new Error('浏览器已断开');
  const { calls, options } = await fixture(t, { closeError });
  const game = await openOfficialGame('unit', { ...options, closeOnFinish: true });
  await game.close();
  assert.deepEqual(calls, [
    ['attach'],
    ['send', 'Browser.close', {}, 2_000],
    ['disconnect'],
  ]);
});
