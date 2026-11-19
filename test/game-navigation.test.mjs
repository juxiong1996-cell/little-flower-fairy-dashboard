import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { enterGameForApi, installGameNavigation } from '../src/browser/game-navigation.mjs';

const origin = 'https://webgl-hua.61.com';

function page({ status = 'signed_in', loaded = true, pageOrigin = origin, childFrame = false } = {}) {
  let now = 1000;
  const listeners = [];
  const presses = [];
  const canvas = {};
  const loading = { style: { display: loaded ? 'none' : 'block' } };
  const context = vm.createContext({
    URL, Promise, Reflect, WeakMap,
    Date: { now: () => now },
    location: { origin: pageOrigin, href: pageOrigin + '/' },
    document: {
      getElementById: id => id === 'unity-canvas' ? canvas : id === 'unity-loading-bar' ? loading : null,
      addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
    },
  });
  vm.runInContext('window = globalThis; window.top = window;', context);
  if (childFrame) context.top = {};
  context.__flowerLoginStatus = status;
  const install = () => vm.runInContext(`(${installGameNavigation.toString()})(${JSON.stringify(origin)})`, context);
  const state = () => JSON.parse(JSON.stringify(context.__flowerGameNavigation.enter()));
  const clientCalls = [];
  const client = {
    async send(method, params) {
      clientCalls.push({ method, params });
      if (method === 'Runtime.evaluate') return { result: { value: JSON.parse(JSON.stringify(vm.runInContext(params.expression, context))) } };
      return {};
    },
  };
  async function loadUnity({ sameCanvas = true, ready = true, fail = false, scriptOrigin = origin, heap } = {}) {
    const instance = {
      Module: { canvas: sameCanvas ? canvas : {}, HEAPU8: heap, ...(ready ? { SendMessage() {} } : {}) },
      SendMessage(...args) { if (fail) throw new Error('native failure'); presses.push(args); },
    };
    // Like the official loader, a function declaration replaces the global
    // before the script's load event and the page's onload calls it.
    context.createUnityInstance = function () { return Promise.resolve(instance); };
    for (const item of listeners) item.listener({ target: { tagName: 'SCRIPT', src: scriptOrigin + '/Build/WebGL.loader.js?v=1' } });
    await context.createUnityInstance(canvas, {});
    return instance;
  }
  return { context, listeners, presses, install, state, loadUnity, client, clientCalls, loading, advance: ms => { now += ms; } };
}

test('loader load capture preserves Unity result and dispatches only the official Button.Press with no argument', async () => {
  const p = page();
  p.install();
  assert.equal(p.listeners[0].type, 'load');
  assert.equal(p.listeners[0].capture, true);
  const instance = await p.loadUnity();
  assert.equal(await p.context.createUnityInstance(), instance);
  assert.deepEqual(await enterGameForApi(p.client), { status: 'pressed' });
  assert.deepEqual(p.presses, [['m_Btn_EnterGame', 'Press']]);
  assert.deepEqual(p.clientCalls.map(call => call.method), ['Runtime.evaluate']);
});

test('loading or expired login never dispatches navigation and expired login keeps the 401 response', async () => {
  for (const status of ['loading', undefined, 'needs_login']) {
    const p = page({ status });
    p.context.__flowerLoginStatus = status;
    p.install();
    await p.loadUnity();
    if (status === 'needs_login') {
      await assert.rejects(enterGameForApi(p.client), error => error.status === 401 && /重新登录/.test(error.message));
    } else assert.deepEqual(await enterGameForApi(p.client), { status: 'waiting' });
    assert.deepEqual(p.presses, []);
    assert.equal(p.clientCalls.some(call => call.method === 'Page.reload'), false);
  }
});

test('Unity loading bar and runtime readiness each prevent early button dispatch', async () => {
  const loading = page({ loaded: false });
  loading.install();
  await loading.loadUnity();
  assert.deepEqual(loading.state(), { status: 'waiting' });
  loading.loading.style.display = 'none';
  assert.deepEqual(loading.state(), { status: 'pressed' });

  const runtime = page();
  runtime.install();
  await runtime.loadUnity({ ready: false });
  assert.deepEqual(runtime.state(), { status: 'waiting' });
  assert.deepEqual(runtime.presses, []);
});

test('repeated checks throttle presses and installing twice preserves the captured instance', async () => {
  const p = page();
  p.install();
  await p.loadUnity();
  p.install();
  assert.equal(p.listeners.length, 1);
  assert.deepEqual(p.state(), { status: 'pressed' });
  assert.deepEqual(p.state(), { status: 'throttled' });
  p.advance(3999);
  assert.deepEqual(p.state(), { status: 'throttled' });
  p.advance(1);
  assert.deepEqual(p.state(), { status: 'pressed' });
  assert.equal(p.presses.length, 2);
});

test('wrong origin, child frames and foreign loader scripts cannot install or dispatch the bridge', async () => {
  for (const options of [{ pageOrigin: 'https://example.com' }, { childFrame: true }]) {
    const p = page(options);
    p.install();
    assert.equal(p.context.__flowerGameNavigation, undefined);
    assert.equal(p.listeners.length, 0);
    assert.deepEqual(await enterGameForApi(p.client), { status: 'waiting' });
    assert.deepEqual(p.presses, []);
  }
  const p = page();
  p.install();
  await p.loadUnity({ scriptOrigin: 'https://example.com' });
  assert.deepEqual(p.state(), { status: 'reload_required' });
  assert.deepEqual(p.presses, []);
});

test('a Unity instance for another canvas cannot be used to press a game button', async () => {
  const p = page();
  p.install();
  await p.loadUnity({ sameCanvas: false });
  assert.deepEqual(p.state(), { status: 'reload_required' });
  assert.deepEqual(p.presses, []);
});

test('an already loaded pre-hook window registers the hook and reloads once, then stops on incompatible startup', async () => {
  const p = page();
  assert.deepEqual(await enterGameForApi(p.client), { status: 'reloading' });
  assert.deepEqual(p.clientCalls.map(call => call.method), ['Runtime.evaluate', 'Page.addScriptToEvaluateOnNewDocument', 'Page.reload']);
  assert.match(p.clientCalls[1].params.source, /installGameNavigation/);
  await assert.rejects(enterGameForApi(p.client), /启动接口未准备好/);
  assert.equal(p.clientCalls.filter(call => call.method === 'Page.reload').length, 1);
});

test('native dispatch failure and malformed runtime response fail clearly, while stale-context errors remain retryable upstream', async () => {
  const p = page();
  p.install();
  await p.loadUnity({ fail: true });
  await assert.rejects(enterGameForApi(p.client), /无法触发官方进入游戏按钮/);
  await assert.rejects(enterGameForApi({ async send() { return { exceptionDetails: { text: 'exception' } }; } }), /无法读取官方游戏的启动状态/);
  await assert.rejects(enterGameForApi({ async send() { return { result: {} }; } }), /无法读取官方游戏的启动状态/);
  const stale = new Error('Execution context was destroyed');
  await assert.rejects(enterGameForApi({ async send() { throw stale; } }), error => error === stale);
});

test('SDK state pointer recognition reads only the exact tm terminator in the captured official Unity heap', async () => {
  const p = page();
  p.install();
  assert.equal(p.context.__flowerGameNavigation.isOfficialSdkState(4), false);
  const heap = new Uint8Array(12);
  heap.set([116, 109, 0], 4);
  await p.loadUnity({heap});
  const matches = value => p.context.__flowerGameNavigation.isOfficialSdkState(value);
  assert.equal(matches(4), true);
  for (const value of [0, -1, 4.5, '4', 'tm', null, 3, 5, 10, 12, 0x100000000, Number.MAX_SAFE_INTEGER]) assert.equal(matches(value), false);
  heap[6] = 1;
  assert.equal(matches(4), false);
  heap[6] = 0;
  assert.equal(matches(4), true);
  p.context.location.origin = 'https://example.com';
  assert.equal(matches(4), false);
  const foreign = page();
  foreign.install();
  await foreign.loadUnity({sameCanvas:false,heap});
  assert.equal(foreign.context.__flowerGameNavigation.isOfficialSdkState(4), false);
});
