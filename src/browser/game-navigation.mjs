const GAME_ORIGIN = 'https://webgl-hua.61.com';

// Installed before the official loader starts. Keep the Unity instance inside
// the page: only navigation states, never SDK data, are returned to Node.
export function installGameNavigation(gameOrigin) {
  if (window.top !== window || location.origin !== gameOrigin) return;
  if (window.__flowerGameNavigation?.version === 2) return;

  let unity;
  let lastPress = -Infinity;
  const wrappers = new WeakMap();
  function capture(instance) {
    const canvas = document.getElementById('unity-canvas');
    if (canvas && instance?.Module?.canvas === canvas && typeof instance.SendMessage === 'function') unity = instance;
    return instance;
  }
  function wrapLoader() {
    const original = window.createUnityInstance;
    if (typeof original !== 'function' || wrappers.has(original)) return;
    function wrapped(...args) {
      return Promise.resolve(Reflect.apply(original, this, args)).then(capture);
    }
    wrappers.set(original, wrapped);
    wrappers.set(wrapped, wrapped);
    window.createUnityInstance = wrapped;
  }
  // A global function declaration can replace an accessor. Capture-phase load
  // runs after the official loader defines it and before its onload starts it.
  document.addEventListener('load', event => {
    const script = event.target;
    if (script?.tagName !== 'SCRIPT' || !script.src) return;
    let url;
    try { url = new URL(script.src, location.href); } catch { return; }
    if (url.origin === gameOrigin && /^\/Build\/[^/]+\.loader\.js$/.test(url.pathname)) wrapLoader();
  }, true);
  wrapLoader();

  Object.defineProperty(window, '__flowerGameNavigation', {
    configurable: true,
    value: Object.freeze({
      version: 2,
      // The current native logout bridge passes its string pointer without
      // decoding it. Only recognize the exact public SDK state "tm\0" inside
      // the captured official runtime; no memory content leaves this page.
      isOfficialSdkState(pointer) {
        if (window.top !== window || location.origin !== gameOrigin ||
            !Number.isSafeInteger(pointer) || pointer <= 0 || pointer > 0xffffffff) return false;
        const heap = unity?.Module?.HEAPU8;
        return ArrayBuffer.isView(heap) && heap.BYTES_PER_ELEMENT === 1 && pointer + 2 < heap.length &&
          heap[pointer] === 116 && heap[pointer + 1] === 109 && heap[pointer + 2] === 0;
      },
      enter() {
        if (window.top !== window || location.origin !== gameOrigin) return { status: 'waiting' };
        if (window.__flowerLoginStatus === 'needs_login') return { status: 'needs_login' };
        if (window.__flowerLoginStatus !== 'signed_in') return { status: 'waiting' };
        const loadingBar = document.getElementById('unity-loading-bar');
        if (!loadingBar || loadingBar.style.display !== 'none') return { status: 'waiting' };
        if (!unity) return { status: 'reload_required' };
        if (typeof unity.Module?.SendMessage !== 'function') return { status: 'waiting' };
        const now = Date.now();
        if (now - lastPress < 4000) return { status: 'throttled' };
        lastPress = now;
        try {
          // The official LoginPanel binds this Button to OnClickEnterGame.
          // Unity Button.Press checks IsActive and IsInteractable, then invokes
          // the same onClick listeners as a normal click. Inactive buttons do nothing.
          unity.SendMessage('m_Btn_EnterGame', 'Press');
          return { status: 'pressed' };
        } catch {
          return { status: 'dispatch_failed' };
        }
      },
    }),
  });
}

const reloads = new WeakSet();
const source = `(${installGameNavigation.toString()})(${JSON.stringify(GAME_ORIGIN)})`;

// Login navigation only. Activity queries and writes use the official socket API.
export async function enterGameForApi(client) {
  const response = await client.send('Runtime.evaluate', {
    expression: `(() => {
      if (location.origin !== ${JSON.stringify(GAME_ORIGIN)}) return {status: 'waiting'};
      ${source};
      return window.__flowerGameNavigation?.enter() ?? {status: 'waiting'};
    })()`,
    returnByValue: true,
  });
  if (response.exceptionDetails || !response.result?.value) throw new Error('无法读取官方游戏的启动状态');
  const state = response.result.value;
  if (state.status === 'needs_login') {
    throw Object.assign(new Error('登录已失效，请点“进入游戏”重新登录这个账号'), { status: 401 });
  }
  if (state.status === 'dispatch_failed') throw new Error('无法触发官方进入游戏按钮，请重新打开游戏窗口');
  if (state.status === 'reload_required') {
    if (reloads.has(client)) throw new Error('官方游戏启动接口未准备好，请重新打开游戏窗口');
    reloads.add(client);
    await client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    await client.send('Page.reload');
    return { status: 'reloading' };
  }
  return state;
}

