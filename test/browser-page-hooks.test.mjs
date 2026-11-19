import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { registerGamePageHooks } from '../src/browser/browser-page-hooks.mjs';

const origin = 'https://webgl-hua.61.com';

function session() {
  const scripts = [];
  const calls = [];
  return {
    scripts, calls,
    client: {
      async send(method, params) {
        calls.push({ method, params });
        if (method === 'Page.addScriptToEvaluateOnNewDocument') scripts.push(params.source);
        return {};
      },
    },
    detach() { scripts.length = 0; },
  };
}

function documentContext(scripts, pageOrigin = origin) {
  const canvas = {};
  const listeners = [];
  const context = vm.createContext({
    URL, URLSearchParams,
    queueMicrotask,
    location: { origin: pageOrigin, href: pageOrigin + '/', search: '' },
    document: {
      getElementById: name => name === 'unity-canvas' ? canvas : name === 'unity-loading-bar' ? { style: { display: 'none' } } : null,
      addEventListener(type, listener) { listeners.push({type, listener}); },
    },
  });
  vm.runInContext('window = globalThis; top = window;', context);
  for (const source of scripts) vm.runInContext(source, context);
  return { context, canvas, listeners };
}

test('a new attachment restores login and Unity hooks for a later reload after the original CDP session detached', async () => {
  const first = session();
  await registerGamePageHooks(first.client, origin);
  const originalPage = documentContext(first.scripts).context;
  assert.equal(originalPage.__flowerLoginStatus, 'loading');
  assert.equal(originalPage.__flowerGameNavigation.version, 2);
  first.detach();
  assert.equal(documentContext(first.scripts).context.__flowerLoginStatus, undefined);

  const reattached = session();
  await registerGamePageHooks(reattached.client, origin);
  const { context, canvas, listeners } = documentContext(reattached.scripts);
  const presses = [];
  const instance = {
    Module: { canvas, SendMessage() {} },
    SendMessage(...args) { presses.push(args); },
  };
  context.createUnityInstance = () => Promise.resolve(instance);
  for (const {type, listener} of listeners) {
    if (type === 'load') listener({target:{tagName:'SCRIPT',src:origin + '/Build/WebGL.loader.js?v=1'}});
  }
  await context.createUnityInstance();
  class SDK {
    checkIsLogin(state, callback) { callback({ type: 'success', uid: '12345678' }); }
  }
  context.TaomeeSDK = SDK;
  new context.TaomeeSDK();
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.equal(context.__flowerGameNavigation.enter().status, 'pressed');
  assert.deepEqual(presses, [['m_Btn_EnterGame', 'Press']]);
  assert.deepEqual(reattached.calls.map(call => call.method), ['Page.enable', 'Runtime.enable', 'Page.addScriptToEvaluateOnNewDocument']);
});

test('serialized production hooks preserve the real numeric logout and decoded login startup pair', async () => {
  const connection = session();
  await registerGamePageHooks(connection.client, origin);
  const { context, canvas, listeners } = documentContext(connection.scripts);
  const heap = new Uint8Array(64);
  const scopePointer = 4, statePointer = 24;
  heap.set(new TextEncoder().encode('userinfo\0'), scopePointer);
  heap.set([116, 109, 0], statePointer);
  const unity = { Module: { canvas, HEAPU8: heap, SendMessage() {} }, SendMessage() {} };
  context.createUnityInstance = () => Promise.resolve(unity);
  for (const { type, listener } of listeners) {
    if (type === 'load') listener({ target: { tagName: 'SCRIPT', src: origin + '/Build/WebGL.loader.js?v=1' } });
  }
  assert.equal(await context.createUnityInstance(), unity);
  assert.equal(context.__flowerGameNavigation.isOfficialSdkState(statePointer), true);
  const calls = [];
  class SDK {
    constructor() {
      this.options = {};
      this.currentApp = { _loading: false, _tokenManager: { token: 'synthetic-token' } };
    }
    checkIsLogin(state, callback) { callback({ type: 'success', uid: '12345678', state }); }
    logout(state, callback) {
      calls.push({ method: 'logout', state });
      this.currentApp._tokenManager.token = null;
      callback?.({ state });
    }
    login(scope, state, callback) {
      calls.push({ method: 'login', scope, state });
      const result = { type: this.currentApp._tokenManager.token ? 'success' : 'needLogin', uid: '12345678', state };
      (callback || this.options.loginCallback)?.(result);
    }
  }
  context.TaomeeSDK = SDK;
  const sdk = new context.TaomeeSDK();
  const decode = pointer => new TextDecoder().decode(heap.subarray(pointer, heap.indexOf(0, pointer)));
  // Match the official framework: logout forwards the WASM state pointer,
  // while login decodes both pointers with UTF8ToString before calling the SDK.
  const nativeLogout = (state, callback) => sdk.logout(state, callback);
  const nativeLogin = (scope, state, callback) => sdk.login(decode(scope), decode(state), callback);
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  nativeLogout(statePointer, () => assert.fail('bootstrap exit callback must not be fabricated'));
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  nativeLogin(scopePointer, statePointer);
  await Promise.resolve();
  assert.deepEqual(calls, [{ method: 'login', scope: 'userinfo', state: 'tm' }]);
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.equal(context.__flowerLoginIdentity.accountName, '米米号 12345678');
  nativeLogout(statePointer);
  assert.deepEqual(calls, [{ method: 'login', scope: 'userinfo', state: 'tm' }, { method: 'logout', state: statePointer }]);
  assert.equal(context.__flowerLoginStatus, 'needs_login');
  assert.deepEqual(JSON.parse(JSON.stringify(context.__flowerLoginIdentity)), {});
});

test('registration is shared within one CDP session and makes no changes to the current page', async () => {
  const connection = session();
  await Promise.all([
    registerGamePageHooks(connection.client, origin),
    registerGamePageHooks(connection.client, origin),
  ]);
  await registerGamePageHooks(connection.client, origin);
  assert.equal(connection.scripts.length, 1);
  assert.deepEqual(connection.calls.map(call => call.method), ['Page.enable', 'Runtime.enable', 'Page.addScriptToEvaluateOnNewDocument']);
});

test('overlapping session preloads preserve non-configurable login getters and the existing navigation bridge', async () => {
  const a = session(), b = session();
  await registerGamePageHooks(a.client, origin);
  await registerGamePageHooks(b.client, origin);
  const { context } = documentContext(a.scripts);
  const descriptor = Object.getOwnPropertyDescriptor(context, '__flowerLoginStatus');
  const navigation = context.__flowerGameNavigation;
  assert.equal(descriptor.configurable, false);
  assert.doesNotThrow(() => vm.runInContext(b.scripts[0], context));
  assert.equal(Object.getOwnPropertyDescriptor(context, '__flowerLoginStatus').get, descriptor.get);
  assert.equal(context.__flowerGameNavigation, navigation);
  const foreign = documentContext([...a.scripts, ...b.scripts], 'https://example.com').context;
  assert.equal(foreign.__flowerLoginStatus, undefined);
  assert.equal(foreign.__flowerGameNavigation, undefined);
});

test('failed preload registration is retried instead of caching a broken session', async () => {
  const connection = session();
  const original = connection.client.send;
  let fail = true;
  connection.client.send = async (method, params) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && fail) { fail = false; throw new Error('session temporarily unavailable'); }
    return original(method, params);
  };
  await assert.rejects(registerGamePageHooks(connection.client, origin), /temporarily unavailable/);
  await registerGamePageHooks(connection.client, origin);
  assert.equal(connection.scripts.length, 1);
});
