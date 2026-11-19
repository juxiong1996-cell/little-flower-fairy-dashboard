// Serialized into the official page. Keep the SDK's already validated startup
// session through the game's first startup Logout('tm') / Login sequence.
export function keepOfficialLoginSession(instance) {
  'use strict';
  if (!instance || typeof instance.logout !== 'function' || typeof instance.login !== 'function') return;
  const marker = Symbol.for('flower.keep-official-login-session');
  if (instance[marker]) return;
  Object.defineProperty(instance, marker, { value: true });

  const originalLogout = instance.logout;
  const originalLogin = instance.login;
  const originalLoginWith = instance.loginWith;
  let firstOfficialLoginSeen = false;
  let opportunityUsed = false;
  let pendingLogout = null;

  function hasRestoredSession() {
    const app = instance.currentApp;
    return !new URLSearchParams(location.search).has('code') &&
      app?._loading === false && !!app._tokenManager?.token;
  }

  function isOfficialState(value) {
    if (value === 'tm') return true;
    // Unity's logout bridge forwards its WASM string pointer unchanged. Only
    // the captured official instance may confirm that it points to "tm\0".
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) return false;
    try {
      return globalThis.__flowerGameNavigation?.isOfficialSdkState?.(value) === true;
    } catch {
      return false;
    }
  }

  function finishPendingLogout() {
    const pending = pendingLogout;
    if (!pending) return;
    pendingLogout = null;
    return Reflect.apply(originalLogout, pending.owner, pending.inputs);
  }

  instance.logout = function (...inputs) {
    // A second exit request is a real exit, even before the microtask runs.
    finishPendingLogout();
    if (this === instance && !firstOfficialLoginSeen && !opportunityUsed && hasRestoredSession() && isOfficialState(inputs[0])) {
      opportunityUsed = true;
      const pending = { owner: this, inputs };
      pendingLogout = pending;
      queueMicrotask(() => {
        if (pendingLogout === pending) finishPendingLogout();
      });
      // The official SDK's public logout method returns undefined.
      return;
    }
    opportunityUsed = true;
    return Reflect.apply(originalLogout, this, inputs);
  };

  instance.login = function (...inputs) {
    const official = this === instance && inputs[0] === 'userinfo' && inputs[1] === 'tm';
    const firstOfficialLogin = official && !firstOfficialLoginSeen;
    if (official) firstOfficialLoginSeen = true;
    if (pendingLogout) {
      if (firstOfficialLogin && hasRestoredSession()) {
        // The bootstrap logout callback only writes a debug message. Do not
        // fabricate a logout result when preserving the existing session.
        pendingLogout = null;
      } else finishPendingLogout();
    }
    // Any other login path also closes this startup-only opportunity.
    opportunityUsed = true;
    return Reflect.apply(originalLogin, this, inputs);
  };

  if (typeof originalLoginWith === 'function') {
    instance.loginWith = function (...inputs) {
      opportunityUsed = true;
      finishPendingLogout();
      return Reflect.apply(originalLoginWith, this, inputs);
    };
  }
}
