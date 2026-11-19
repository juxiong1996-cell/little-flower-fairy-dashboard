import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { keepOfficialLoginSession } from '../src/browser/login-session.mjs';

function setup({ token = true, loading = false, search = '', navigation } = {}) {
  const calls = [], microtasks = [];
  const callbackReceiver = {};
  const sdk = {
    currentApp: { _loading: loading, _tokenManager: { token: token ? 'synthetic-token' : null } },
    logout(...inputs) {
      calls.push({ method: 'logout', owner: this, inputs });
      this.currentApp._tokenManager.token = null;
      inputs[1]?.call(callbackReceiver, { state: inputs[0] });
      return 'logout-return';
    },
    login(...inputs) {
      calls.push({ method: 'login', owner: this, inputs, hadToken: !!this.currentApp._tokenManager.token });
      inputs[2]?.call(callbackReceiver, { type: this.currentApp._tokenManager.token ? 'success' : 'needLogin', state: inputs[1] });
      return 'login-return';
    },
    loginWith(...inputs) {
      calls.push({ method: 'loginWith', owner: this, inputs });
      return 'loginWith-return';
    },
  };
  const context = vm.createContext({ location: { search }, URLSearchParams, queueMicrotask: fn => microtasks.push(fn), sdk, __flowerGameNavigation: navigation });
  vm.runInContext(`(${keepOfficialLoginSession.toString()})(sdk)`, context);
  return {
    sdk, calls, context, callbackReceiver,
    flush() { while (microtasks.length) microtasks.shift()(); },
  };
}

test('the first restored startup pair preserves the session and runs the real login callback', () => {
  const f = setup();
  let received, receiver;
  assert.equal(f.sdk.logout('tm', () => assert.fail('a cancelled exit must not fabricate a completion')), undefined);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sdk.login('userinfo', 'tm', function (result) { received = result; receiver = this; }), 'login-return');
  assert.deepEqual(f.calls.map(x => x.method), ['login']);
  assert.equal(f.calls[0].hadToken, true);
  assert.equal(received.type, 'success');
  assert.equal(receiver, f.callbackReceiver);
  f.flush();
  assert.deepEqual(f.calls.map(x => x.method), ['login']);
});

test('an independent exit runs at the microtask boundary with its original arguments and callback', () => {
  const f = setup();
  let received, receiver;
  const callback = function (result) { received = result; receiver = this; };
  f.sdk.logout('tm', callback, 'extra');
  assert.equal(f.calls.length, 0);
  f.flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].owner, f.sdk);
  assert.deepEqual(f.calls[0].inputs, ['tm', callback, 'extra']);
  assert.deepEqual(received, { state: 'tm' });
  assert.equal(receiver, f.callbackReceiver);
  assert.equal(f.sdk.currentApp._tokenManager.token, null);
  assert.equal(f.sdk.logout('tm'), 'logout-return');
  assert.equal(f.calls.length, 2);
});

test('the second logout and later login always use normal SDK behavior', () => {
  const f = setup();
  f.sdk.logout('tm');
  f.sdk.login('userinfo', 'tm');
  assert.equal(f.sdk.logout('tm'), 'logout-return');
  f.sdk.login('userinfo', 'tm');
  f.flush();
  assert.deepEqual(f.calls.map(x => x.method), ['login', 'logout', 'login']);
  assert.equal(f.calls.at(-1).hadToken, false);

  const twice = setup();
  twice.sdk.logout('tm');
  assert.equal(twice.sdk.logout('tm'), 'logout-return');
  twice.flush();
  assert.deepEqual(twice.calls.map(x => x.method), ['logout', 'logout']);
});

test('missing token, unfinished refresh and authorization redirects never hold logout', () => {
  for (const options of [{ token: false }, { loading: true }, { search: '?code=synthetic-code' }]) {
    const f = setup(options);
    assert.equal(f.sdk.logout('tm'), 'logout-return');
    assert.deepEqual(f.calls.map(x => x.method), ['logout']);
    f.sdk.login('userinfo', 'tm');
    f.sdk.currentApp._loading = false;
    f.sdk.currentApp._tokenManager.token = 'later-synthetic-token';
    assert.equal(f.sdk.logout('tm'), 'logout-return');
    f.flush();
    assert.deepEqual(f.calls.map(x => x.method), ['logout', 'login', 'logout']);
  }
});

test('the first official login consumes the opportunity even without a preceding logout or token', () => {
  for (const token of [true, false]) {
    const f = setup({ token });
    f.sdk.login('userinfo', 'tm');
    f.sdk.currentApp._tokenManager.token = 'later-synthetic-token';
    assert.equal(f.sdk.logout('tm'), 'logout-return');
    f.sdk.login('userinfo', 'tm');
    assert.deepEqual(f.calls.map(x => x.method), ['login', 'logout', 'login']);
    assert.equal(f.calls.at(-1).hadToken, false);
  }
});

test('other login parameters and loginWith honor any pending exit before continuing', () => {
  for (const invoke of [sdk => sdk.login('other-scope', 'tm'), sdk => sdk.login('userinfo', 'other-state'), sdk => sdk.loginWith('other-account', 'userinfo', 'tm')]) {
    const f = setup();
    f.sdk.logout('tm');
    invoke(f.sdk);
    f.flush();
    assert.equal(f.calls[0].method, 'logout');
    assert.equal(f.calls.length, 2);
    assert.equal(f.sdk.logout('tm'), 'logout-return');
  }
});

test('explicit exit states, borrowed methods and a later task cannot match the startup pair', () => {
  const explicit = setup();
  assert.equal(explicit.sdk.logout('user-exit'), 'logout-return');
  explicit.sdk.currentApp._tokenManager.token = 'later-synthetic-token';
  assert.equal(explicit.sdk.logout('tm'), 'logout-return');

  const borrowed = setup();
  const other = { currentApp: { _tokenManager: { token: 'synthetic-token' } } };
  assert.equal(borrowed.sdk.logout.call(other, 'tm'), 'logout-return');
  assert.equal(borrowed.calls[0].owner, other);
  assert.equal(borrowed.sdk.logout('tm'), 'logout-return');

  const later = setup();
  later.sdk.logout('tm');
  later.flush();
  later.sdk.login('userinfo', 'tm');
  assert.deepEqual(later.calls.map(x => x.method), ['logout', 'login']);
  assert.equal(later.calls[1].hadToken, false);
});

test('a session invalidated between the pair is not preserved and repeated installation is harmless', () => {
  const f = setup();
  vm.runInContext(`(${keepOfficialLoginSession.toString()})(sdk)`, f.context);
  f.sdk.logout('tm');
  f.sdk.currentApp._tokenManager.token = null;
  f.sdk.login('userinfo', 'tm');
  f.flush();
  assert.deepEqual(f.calls.map(x => x.method), ['logout', 'login']);
  assert.equal(f.calls[1].hadToken, false);
});

test('a WASM logout pointer can match only when the captured official game confirms its state', () => {
  const inspected = [];
  const navigation = {
    isOfficialSdkState(value) {
      assert.equal(this, navigation);
      inspected.push(value);
      return value === 1024;
    },
  };
  const f = setup({ navigation });
  assert.equal(f.sdk.logout(1024, () => assert.fail('a preserved startup pair must not fabricate logout')), undefined);
  assert.equal(f.calls.length, 0);
  f.sdk.login('userinfo', 'tm');
  f.flush();
  assert.deepEqual(inspected, [1024]);
  assert.deepEqual(f.calls.map(x => x.method), ['login']);
  assert.equal(f.calls[0].hadToken, true);

  const independent = setup({ navigation });
  let received;
  independent.sdk.logout(1024, result => { received = result; });
  independent.flush();
  assert.equal(independent.calls[0].inputs[0], 1024);
  assert.deepEqual(received, { state: 1024 });
});

test('missing, rejecting or failing pointer verification always performs the original exit', () => {
  for (const navigation of [undefined, {}, { isOfficialSdkState: () => false }, { isOfficialSdkState: () => 1 }, { isOfficialSdkState: () => 'true' }, { isOfficialSdkState() { throw new Error('unavailable memory'); } }]) {
    const f = setup({ navigation });
    assert.equal(f.sdk.logout(1024), 'logout-return');
    assert.deepEqual(f.calls.map(x => x.method), ['logout']);
    f.sdk.login('userinfo', 'tm');
    f.flush();
    assert.equal(f.calls.at(-1).hadToken, false);
  }
});

test('other values cannot masquerade as a WASM pointer and unready sessions never inspect memory', () => {
  let inspections = 0;
  const navigation = { isOfficialSdkState() { inspections++; return true; } };
  for (const state of [0, -1, 1.5, NaN, Infinity, 0x100000000, Number.MAX_SAFE_INTEGER + 1, '1024', 'tm\0', ' tm', {}, null, undefined]) {
    const f = setup({ navigation });
    assert.equal(f.sdk.logout(state), 'logout-return');
    assert.equal(f.calls[0].inputs[0], state);
  }
  for (const options of [{ token: false }, { loading: true }, { search: '?code=synthetic-code' }]) {
    const f = setup({ ...options, navigation });
    assert.equal(f.sdk.logout(1024), 'logout-return');
  }
  assert.equal(inspections, 0);
});
