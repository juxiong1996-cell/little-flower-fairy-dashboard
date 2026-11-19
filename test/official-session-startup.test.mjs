import assert from 'node:assert/strict';
import test from 'node:test';
import { openActivitySession } from '../src/game/official-session.mjs';

function fixture({ ready = false, connected = ready, navigationError, waitStep, readyAfterNavigations, refreshStartup = false } = {}) {
  const state = { ready, connected, navigated: 0, navigatedAt: [], closed: 0, released: 0, requests: 0, now: 100000, commands: [] };
  const client = {
    socket: { readyState: WebSocket.OPEN },
    async send(method, params = {}) {
      state.commands.push(method);
      if (method === 'Runtime.evaluate') return params.expression.includes('refreshStartup')
        ? { result: { value: refreshStartup } } : { result: { objectId: 'prototype' } };
      if (method === 'Runtime.queryObjects') return { objects: { objectId: 'sockets' } };
      if (method === 'Runtime.releaseObjectGroup') { state.released++; return {}; }
      if (method === 'Runtime.callFunctionOn') {
        if (params.functionDeclaration.includes('this.status')) return { result: { value: { closed: false, dirty: false } } };
        if (params.functionDeclaration.includes('this.ready()')) return { result: { value: state.ready } };
        if (params.functionDeclaration.includes('this.request(')) {
          state.requests++;
          return { result: { value: { role: 42, packet: [1, 2, 3], at: '2026-11-19T00:00:00.000Z' } } };
        }
        return { result: state.connected ? { objectId: 'bridge' } : { value: null } };
      }
      return {};
    },
  };
  const options = {
    openGame: async account => {
      assert.equal(account, 'sample');
      return { client, attached: refreshStartup, close: async () => { state.closed++; } };
    },
    navigate: async received => {
      assert.equal(received, client);
      state.navigated++;
      state.navigatedAt.push(state.now);
      if (navigationError) throw navigationError;
      if (!waitStep || readyAfterNavigations && state.navigated >= readyAfterNavigations) { state.connected = true; state.ready = true; }
    },
    now: () => state.now,
    wait: async ms => { state.now += waitStep ?? ms; },
  };
  return { state, options };
}

test('现成官方连接等待初始请求结束后直接复用，无需进入游戏导航', async () => {
  const { state, options } = fixture({ ready: true });
  const session = await openActivitySession('sample', options);
  assert.equal(state.navigated, 0);
  assert.ok(state.now >= 101500);
  assert.equal(state.closed, 0);
  const result = await session.request(9191, new Uint8Array(4), { expectedRole: 42 });
  assert.equal(result.role, 42);
  assert.equal(state.requests, 1);
  await session.close();
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
});

test('连接未就绪时执行导航，再通过同一个官方连接发送请求', async () => {
  const { state, options } = fixture();
  const session = await openActivitySession('sample', options);
  assert.equal(state.navigated, 1);
  assert.equal(state.commands.some(method => method === 'Page.captureScreenshot'), false);
  assert.equal(state.requests, 0, '准备连接时不发送签到或领奖请求');
  await session.request(9191, new Uint8Array(4));
  assert.equal(state.requests, 1);
  await session.close();
  assert.equal(state.closed, 1);
});

test('登录面板提前打开官方 socket 时，仍执行进入游戏导航直到角色就绪', async () => {
  const { state, options } = fixture({ connected: true });
  const session = await openActivitySession('sample', options);
  assert.equal(state.navigated, 1);
  assert.equal(state.requests, 0, '未就绪时只导航，不发送活动请求');
  assert.ok(state.now - state.navigatedAt[0] >= 1500, '角色就绪后仍等待初始请求结束');
  await session.request(9191, new Uint8Array(4));
  assert.equal(state.requests, 1);
  await session.close();
  assert.equal(state.closed, 1);
});

test('已连接但角色未就绪时按四秒节流导航，就绪后的稳定等待期间停止导航', async () => {
  const { state, options } = fixture({ connected: true, waitStep: 400, readyAfterNavigations: 3 });
  const session = await openActivitySession('sample', options);
  assert.equal(state.navigated, 3);
  for (let i = 1; i < state.navigatedAt.length; i++) {
    assert.ok(state.navigatedAt[i] - state.navigatedAt[i - 1] >= 4000);
  }
  assert.ok(state.now - state.navigatedAt.at(-1) >= 1500);
  assert.equal(state.requests, 0);
  await session.close();
  assert.equal(state.closed, 1);
});

test('登录过期时保留明确提示，清理连接并且不重试业务操作', async () => {
  const error = Object.assign(new Error('登录已失效，请点“进入游戏”重新登录这个账号'), { status: 401 });
  const { state, options } = fixture({ navigationError: error });
  await assert.rejects(openActivitySession('sample', options), failure => failure === error);
  assert.equal(state.navigated, 1);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.requests, 0);
});

test('启动超时会关闭准备中的连接并返回可重试提示', async () => {
  const { state, options } = fixture({ waitStep: 50000 });
  await assert.rejects(openActivitySession('sample', options), error => error.status === 503 && /连接准备超时/.test(error.message));
  assert.equal(state.navigated, 3);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.requests, 0);
});

test('官方维护时立即清理连接，保留503提示且不发送签到或领奖', async () => {
  const error = Object.assign(new Error('官方服务器正在维护，请等维护结束后重试'), { status: 503 });
  const { state, options } = fixture({ navigationError: error });
  await assert.rejects(openActivitySession('sample', options), failure => failure === error);
  assert.equal(state.navigated, 1);
  assert.equal(state.closed, 1);
  assert.equal(state.released, 1);
  assert.equal(state.requests, 0);
});

test('旧窗口漏掉启动检查或保留维护状态时只重载一次，重试可恢复查询', async () => {
  const { state, options } = fixture({ ready: true, refreshStartup: true });
  const session = await openActivitySession('sample', options);
  assert.equal(state.commands.filter(command => command === 'Page.reload').length, 1);
  assert.equal(state.requests, 0, '重载只恢复官方启动检查，不重放签到或领奖');
  await session.request(9191, new Uint8Array(4));
  assert.equal(state.requests, 1);
  await session.close();
});
