// The current official SDK returns { uid, token, loginType, type }.
// Only its account ID leaves the game page; token is deliberately never copied.
export function sanitizeLoginIdentity(result) {
  if (result?.type !== 'success') return {};
  const uid = typeof result.uid === 'number' && Number.isSafeInteger(result.uid)
    ? String(result.uid) : typeof result.uid === 'string' ? result.uid.trim() : '';
  if (!/^[1-9]\d{0,19}$/.test(uid)) return {};
  // Some providers use a phone number as the account ID. Mask it in the page.
  if (/^1[3-9]\d{9}$/.test(uid)) return { maskedPhone: uid.slice(0, 3) + '****' + uid.slice(-4) };
  return { accountName: '米米号 ' + uid };
}

// Serialized into the official page before its SDK loads.
export function observeLogin(gameOrigin, sanitizeIdentity, keepSession) {
  'use strict';
  if (window.top !== window || location.origin !== gameOrigin) return;

  let currentStatus = 'loading';
  let currentIdentity = {};
  let currentInstance;
  let implementation;
  let nextCheck = 0;
  let lastApplied = 0;
  function recordResult(result, check, instance) {
    if (check < lastApplied || !['success', 'needLogin'].includes(result?.type)) return;
    lastApplied = check;
    currentInstance = instance;
    currentStatus = result.type === 'success' ? 'signed_in' : 'needs_login';
    currentIdentity = sanitizeIdentity(result);
  }

  function readStatus() {
    // The SDK can invalidate a token internally, without a public logout callback.
    // Check only its presence inside the page; never copy the token into our state.
    const app = currentInstance?.currentApp;
    if (currentStatus === 'signed_in' && app?._tokenManager) {
      if (app._loading) return 'loading';
      if (!app._tokenManager.token) return 'needs_login';
    }
    return currentStatus;
  }

  Object.defineProperty(window, '__flowerLoginStatus', { get: readStatus });
  Object.defineProperty(window, '__flowerLoginIdentity', {
    get: () => readStatus() === 'signed_in' ? { ...currentIdentity } : {},
  });
  Object.defineProperty(window, 'TaomeeSDK', {
    configurable: true,
    get: () => implementation,
    set(SDK) {
      if (typeof SDK !== 'function') {
        implementation = SDK;
        return;
      }
      implementation = new Proxy(SDK, {
        construct(target, args, receiver) {
          const instance = Reflect.construct(target, args, receiver);
          for (const [method, index] of [['login', 2], ['loginWith', 3], ['checkIsLogin', 1], ['logout', 1]]) {
            const original = instance[method];
            if (typeof original !== 'function') continue;
            instance[method] = function (...inputs) {
              const check = ++nextCheck;
              const owner = this;
              const callback = inputs[index];
              if (method === 'logout') recordResult({ type: 'needLogin' }, check, owner);
              inputs[index] = function (result, ...rest) {
                recordResult(method === 'logout' ? { type: 'needLogin' } : result, check, owner);
                // Supplying our observer makes the SDK skip its default callback.
                // Preserve that fallback, including options changed while waiting.
                const effective = callback || (['login', 'loginWith'].includes(method) ? owner.options?.loginCallback : null);
                if (effective) return effective.call(this, result, ...rest);
              };
              return original.apply(this, inputs);
            };
          }
          keepSession?.(instance);
          // Let the official SDK consume an authorization redirect only once.
          if (!new URLSearchParams(location.search).has('code') && typeof instance.checkIsLogin === 'function') {
            instance.checkIsLogin('flower-login-status', () => {});
          }
          return instance;
        },
      });
    },
  });
}
