import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { observeLogin, sanitizeLoginIdentity } from '../src/browser/login-identity.mjs';

const origin = 'https://webgl-hua.61.com';

function setup(search = '', pageOrigin = origin) {
  const calls = { check: [], login: [], logout: [], loginWith: [] };
  class SDK {
    checkIsLogin(state, callback) { calls.check.push(callback); }
    login(scope, state, callback) { calls.login.push(callback); return 'original-result'; }
    loginWith(uid, scope, state, callback) {
      calls.loginWithState = state;
      calls.loginWith.push(result => callback({ ...result, state }));
    }
    logout(state, callback) { calls.logout.push(callback); }
  }
  const context = vm.createContext({ location: { origin: pageOrigin, search }, URLSearchParams });
  vm.runInContext(`window = globalThis; window.top = window;
    (${observeLogin.toString()})(${JSON.stringify(origin)}, ${sanitizeLoginIdentity.toString()});`, context);
  context.TaomeeSDK = SDK;
  const sdk = new context.TaomeeSDK();
  return { context, sdk, calls, identity: () => JSON.parse(JSON.stringify(context.__flowerLoginIdentity)) };
}

test('官方 SDK 的 uid 生成米米号，token 和其他字段不会离开页面', () => {
  assert.deepEqual(sanitizeLoginIdentity({ type: 'success', uid: 12345678, token: 'secret', loginType: 1 }), { accountName: '米米号 12345678' });
  assert.deepEqual(sanitizeLoginIdentity({ type: 'success', uid: ' 12345678 ', phone: '13800138000', nickname: 'unconfirmed-field' }), { accountName: '米米号 12345678' });
  for (const uid of [null, {}, -1, 0, Number.MAX_SAFE_INTEGER + 1, 'hello', '123\n456', '1'.repeat(21)]) {
    assert.deepEqual(sanitizeLoginIdentity({ type: 'success', uid }), {});
  }
});

test('手机号格式的账号在浏览器内先脱敏，失败或未登录结果不返回名称', () => {
  assert.deepEqual(sanitizeLoginIdentity({ type: 'success', uid: '13800138000', token: 'secret' }), { maskedPhone: '138****8000' });
  assert.deepEqual(sanitizeLoginIdentity({ type: 'needLogin', uid: '13800138000' }), {});
  assert.deepEqual(sanitizeLoginIdentity({ type: 'error', uid: '12345678' }), {});
});

test('登录回调原样交给游戏，外部读取仅能拿到安全名称副本', () => {
  const { context, sdk, calls, identity } = setup();
  let received, receiver;
  const result = { type: 'success', uid: '12345678', token: 'secret' };
  assert.equal(sdk.login('', 'game-state', function (value) { received = value; receiver = this; }), 'original-result');
  calls.login[0].call(sdk, result);
  assert.equal(received, result);
  assert.equal(receiver, sdk);
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.deepEqual(identity(), { accountName: '米米号 12345678' });
  context.__flowerLoginIdentity.accountName = 'mutated';
  assert.deepEqual(identity(), { accountName: '米米号 12345678' });
});

test('较早的检查回复不能覆盖后来登录的账号', () => {
  const { context, sdk, calls, identity } = setup();
  sdk.login('', 'login', () => {});
  calls.login[0]({ type: 'success', uid: '23456789', token: 'secret' });
  calls.check[0]({ type: 'success', uid: '12345678', token: 'old-secret' });
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.deepEqual(identity(), { accountName: '米米号 23456789' });
});

test('退出时立即清空名称，旧登录回调不能恢复它', () => {
  const { context, sdk, calls, identity } = setup();
  sdk.login('', 'first-login', () => {});
  calls.login[0]({ type: 'success', uid: '12345678' });
  sdk.login('', 'late-login', () => {});
  sdk.logout('logout', () => {});
  assert.equal(context.__flowerLoginStatus, 'needs_login');
  assert.deepEqual(identity(), {});
  calls.login[1]({ type: 'success', uid: '23456789' });
  assert.equal(context.__flowerLoginStatus, 'needs_login');
  assert.deepEqual(identity(), {});
  calls.logout[0]({});
  assert.deepEqual(identity(), {});
});

test('切换账号后，旧退出回复不能清除新账号', () => {
  const { context, sdk, calls, identity } = setup();
  let received;
  sdk.logout('old-logout', () => {});
  sdk.loginWith('23456789', '', 'game-login-state', result => { received = result; });
  calls.loginWith[0]({ type: 'success', uid: '23456789' });
  calls.logout[0]({});
  assert.equal(calls.loginWithState, 'game-login-state');
  assert.equal(received.state, 'game-login-state');
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.deepEqual(identity(), { accountName: '米米号 23456789' });
});

test('授权回跳不额外消费 code，其他来源页面不安装观察器', () => {
  assert.equal(setup('?code=authorization-code').calls.check.length, 0);
  assert.equal(setup().calls.check.length, 1);
  const { context, calls } = setup('', 'https://example.com');
  assert.equal(context.__flowerLoginStatus, undefined);
  assert.equal(calls.check.length, 0);
});

function setupOfficialCallbacks(defaultCallback) {
  // Match the official SDK's callback selection and token manager shape.
  class SDK {
    constructor(options) {
      this.options = options;
      this.currentApp = { _loading: false, _tokenManager: { token: null } };
      this.pending = [];
    }
    checkIsLogin(state, callback) { callback({ type: 'needLogin', state }); }
    enqueue(state, callback, returned) {
      this.pending.push(result => {
        result.state = state;
        const selected = callback || this.options.loginCallback;
        if (selected) return selected(result);
      });
      return returned;
    }
    login(scope, state, callback) { return this.enqueue(state, callback, 'login-result'); }
    loginWith(uid, scope, state, callback) { return this.enqueue(state, callback, 'loginWith-result'); }
  }
  const context = vm.createContext({ location: { origin, search: '' }, URLSearchParams });
  vm.runInContext(`window = globalThis; window.top = window;
    (${observeLogin.toString()})(${JSON.stringify(origin)}, ${sanitizeLoginIdentity.toString()});`, context);
  context.TaomeeSDK = SDK;
  const sdk = new context.TaomeeSDK({ loginCallback: defaultCallback });
  return { context, sdk, identity: () => JSON.parse(JSON.stringify(context.__flowerLoginIdentity)) };
}

test('login 和 loginWith 保留默认回调与每次回调的优先顺序、接收者和返回值', () => {
  for (const method of ['login', 'loginWith']) {
    const defaults = [], explicit = [];
    const { context, sdk, identity } = setupOfficialCallbacks(function (result) {
      defaults.push({ result, receiver: this });
    });
    const args = method === 'login' ? ['scope', 'game-state'] : ['12345678', 'scope', 'game-state'];
    for (const omitted of [undefined, null, false, 0, '']) {
      assert.equal(sdk[method](...args, omitted), `${method}-result`);
      const result = { type: 'success', uid: '12345678', token: 'synthetic-secret' };
      sdk.currentApp._tokenManager.token = 'synthetic-secret';
      sdk.pending.shift()(result);
      assert.equal(defaults.at(-1).result, result);
      assert.equal(defaults.at(-1).receiver, undefined);
      assert.equal(result.state, 'game-state');
    }
    assert.equal(defaults.length, 5);
    sdk[method](...args, function (result) { explicit.push({ result, receiver: this }); });
    const result = { type: 'success', uid: '23456789', token: 'another-synthetic-secret' };
    sdk.pending.shift()(result);
    assert.equal(defaults.length, 5);
    assert.equal(explicit.length, 1);
    assert.equal(explicit[0].result, result);
    assert.equal(explicit[0].receiver, undefined);
    assert.equal(context.__flowerLoginStatus, 'signed_in');
    assert.deepEqual(identity(), { accountName: '米米号 23456789' });
  }
});

test('默认登录回调在结果到达时读取，未配置回调时仍能观察结果', () => {
  const { context, sdk } = setupOfficialCallbacks(() => assert.fail('旧默认回调不应执行'));
  let received;
  sdk.login('', 'pending-login');
  sdk.options.loginCallback = result => { received = result; };
  const result = { type: 'success', uid: '12345678' };
  sdk.currentApp._tokenManager.token = 'synthetic-secret';
  sdk.pending.shift()(result);
  assert.equal(received, result);
  sdk.options.loginCallback = undefined;
  sdk.loginWith('12345678', '', 'no-callback');
  assert.doesNotThrow(() => sdk.pending.shift()({ type: 'success', uid: '12345678' }));
  assert.equal(context.__flowerLoginStatus, 'signed_in');
});

test('SDK 内部清除 token 后不再报告已登录，旧成功回复也不能伪造登录状态', () => {
  const { context, sdk, identity } = setupOfficialCallbacks();
  sdk.login('', 'first-login');
  sdk.currentApp._tokenManager.token = 'synthetic-secret';
  sdk.pending.shift()({ type: 'success', uid: '12345678', token: 'synthetic-secret' });
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.deepEqual(identity(), { accountName: '米米号 12345678' });

  sdk.currentApp._loading = true;
  assert.equal(context.__flowerLoginStatus, 'loading');
  assert.deepEqual(identity(), {});
  sdk.currentApp._loading = false;
  sdk.currentApp._tokenManager.token = null;
  assert.equal(context.__flowerLoginStatus, 'needs_login');
  assert.deepEqual(identity(), {});

  sdk.login('', 'stale-success');
  sdk.pending.shift()({ type: 'success', uid: '12345678', token: 'stale-secret' });
  assert.equal(context.__flowerLoginStatus, 'needs_login');
  assert.deepEqual(identity(), {});

  sdk.login('', 'new-login');
  sdk.currentApp._tokenManager.token = 'new-synthetic-secret';
  sdk.pending.shift()({ type: 'success', uid: '23456789', token: 'new-synthetic-secret' });
  assert.equal(context.__flowerLoginStatus, 'signed_in');
  assert.deepEqual(identity(), { accountName: '米米号 23456789' });
});
