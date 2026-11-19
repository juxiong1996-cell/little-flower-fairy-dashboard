import { readSignTraffic } from '../game/sign-traffic.mjs';
import { watchOpenSockets } from './existing-sockets.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeLoginIdentity } from './login-identity.mjs';
import { registerGamePageHooks } from './browser-page-hooks.mjs';
import { applicationDataRoot, findBrowser } from './browser-runtime.mjs';

const GAME_URL = 'https://webgl-hua.61.com/';
const GAME_ORIGIN = new URL(GAME_URL).origin;
const APP_ROOT = applicationDataRoot();
const PROFILE_ROOT = join(APP_ROOT, 'profiles');
const accountIdentities = new Map();

class DevTools {
  #sequence = 0;
  #pending = new Map();

  constructor(socket, onEvent) {
    this.socket = socket;
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method) onEvent?.(message.method, message.params);
      else this.#pending.get(message.id)?.(message);
    });
    socket.addEventListener('close', () => {
      for (const finish of this.#pending.values()) finish({ error: true });
    });
  }

  static async connect(address, onEvent) {
    const socket = new WebSocket(address);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('连接浏览器超时。'));
      }, 5_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('无法连接浏览器。'));
      }, { once: true });
    });
    return new DevTools(socket, onEvent);
  }

  send(method, params = {}, timeout = 8_000) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const finish = response => {
        clearTimeout(timer);
        this.#pending.delete(id);
        if (response.error) reject(new Error(`${method} 调用失败。${response.error.message ?? ""}`));
        else resolve(response.result);
      };
      const timer = setTimeout(() => finish({ error: true }), timeout);
      this.#pending.set(id, finish);
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        finish({ error: true });
      }
    });
  }
}

// Attach only to the dedicated account browser, verified against its current browser ID.
async function attachGame(portFile, onEvent) {
  const saved = await readFile(portFile, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const [port, browserPath] = saved.trim().split(/\r?\n/);
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535 || !/^\/devtools\/browser\/[\da-f-]+$/i.test(browserPath)) return null;
  const base = 'http://127.0.0.1:' + port;
  const options = { redirect: 'error', signal: AbortSignal.timeout(2500) };
  const info = await fetch(base + '/json/version', options).then(r => r.json()).catch(() => null);
  if (info?.webSocketDebuggerUrl !== 'ws://127.0.0.1:' + port + browserPath) return null;
  const tabs = await fetch(base + '/json/list', options).then(r => r.json());
  const games = tabs.filter(t => t.type === 'page' && URL.canParse(t.url) && new URL(t.url).origin === GAME_ORIGIN);
  if (games.length !== 1) throw new Error('这个账号的浏览器中需要恰好有一个官方游戏标签页。');
  const endpoint = new URL(games[0].webSocketDebuggerUrl);
  if (endpoint.origin !== 'ws://127.0.0.1:' + port || !endpoint.pathname.startsWith('/devtools/page/')) throw new Error('无法核对游戏标签页。');
  const client = await DevTools.connect(endpoint.href, onEvent);
  try {
    await registerGamePageHooks(client, GAME_ORIGIN);
    if (onEvent) await client.send('Network.enable', { maxPostDataSize: 0 });
    const exit = new Promise(resolve => client.socket.addEventListener('close', resolve, { once: true }));
    return { client, close: async () => client.socket.close(), exit, isOpen: () => client.socket.readyState === WebSocket.OPEN,
      attached: true, headless: /HeadlessChrome/.test(info['User-Agent'] ?? '') };
  } catch (error) {
    client.socket.close();
    throw error;
  }
}

async function identityFromGame(client) {
  const { result } = await client.send('Runtime.evaluate', {
    expression: `location.origin === ${JSON.stringify(GAME_ORIGIN)} ? ({
      status: window.__flowerLoginStatus, identity: window.__flowerLoginIdentity
    }) : null`, returnByValue: true,
  }, 1500);
  if (result.value?.identity !== undefined || result.value?.status === 'needs_login') return result.value;

  // Windows opened before identity support have the old login hook. Read only
  // the existing SDK instance's login data, sanitizing it inside that page.
  const group = 'flower-account-identity';
  try {
    const { result: prototype } = await client.send('Runtime.evaluate', {
      expression: `location.origin === ${JSON.stringify(GAME_ORIGIN)} && typeof window.TaomeeSDK === 'function' ? window.TaomeeSDK.prototype : null`,
      objectGroup: group,
    }, 1500);
    if (!prototype.objectId) return result.value ?? {};
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group }, 1500);
    const response = await client.send('Runtime.callFunctionOn', {
      objectId: objects.objectId, objectGroup: group, returnByValue: true,
      functionDeclaration: `function() {
        const instances = this.filter(sdk => sdk.currentApp && typeof sdk.currentApp.formatLoginData === 'function');
        if (instances.length !== 1) return {};
        const app = instances[0].currentApp;
        if (app._loading) return {status: 'loading'};
        if (!app._tokenManager?.token) return {status: 'needs_login', identity: {}};
        return {status: 'signed_in', identity: (${sanitizeLoginIdentity.toString()})(app.formatLoginData())};
      }`,
    }, 1500);
    return response.result.value ?? {};
  } finally {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: group }, 1000).catch(() => {});
  }
}

// A name lookup never opens or reloads a game window or sends game commands.
export async function readAccountIdentity(account) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(account)) throw new Error('账号别名无效');
  account = account.toLowerCase();
  let browser;
  try {
    browser = await attachGame(join(PROFILE_ROOT, 'account-' + account, 'DevToolsActivePort'));
    if (!browser) return { ...(accountIdentities.get(account) ?? {}) };
    const state = await identityFromGame(browser.client);
    if (state.status === 'needs_login') accountIdentities.delete(account);
    else if (state.status === 'signed_in' && state.identity) accountIdentities.set(account, state.identity);
    return { ...(accountIdentities.get(account) ?? {}) };
  } catch {
    return { ...(accountIdentities.get(account) ?? {}) };
  } finally {
    await browser?.close();
  }
}

// Reuse this account's authenticated official game connection whenever possible.
export async function openOfficialGame(account) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(account)) throw new Error('账号别名无效');
  const profile = join(PROFILE_ROOT, 'account-' + account);
  if (!(await stat(profile)).isDirectory()) throw new Error('账号配置不存在');
  const existing = await attachGame(join(profile, 'DevToolsActivePort'));
  if (existing) return existing;
  const game = await openGame(profile, false);
  return { ...game, close: async () => game.detach() };
}

async function openGame(profile, interactive, onNetworkEvent, reuse = false) {
  await mkdir(profile, { recursive: true });
  const portFile = join(profile, 'DevToolsActivePort');
  if (reuse) {
    const existing = await attachGame(portFile, onNetworkEvent);
    if (existing) return existing;
  }
  const previousPort = await stat(portFile).then(file => file.mtimeMs, () => 0);
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', '--disable-background-mode',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-features=PasswordManagerOnboarding', '--window-size=1280,800',
    ...(interactive ? [] : ['--headless=new', '--mute-audio', '--enable-unsafe-swiftshader']),
    'about:blank',
  ];
  const browser = spawn(findBrowser(), args, { stdio: 'ignore', windowsHide: !interactive });
  let exited = false;
  const exit = new Promise(resolve => {
    const onExit = () => { exited = true; resolve(); };
    browser.once('exit', onExit);
    browser.once('error', onExit);
  });

  let client;
  const close = async () => {
    if (client) {
      await client.send('Browser.close', {}, 2_000).catch(() => {});
      client.socket.close();
    }
    await Promise.race([exit, delay(2_000, undefined, { ref: false })]);
    if (!exited) browser.kill();
  };

  try {
    let browserPort;
    const expires = Date.now() + 9_000;
    while (!browserPort && !exited && Date.now() < expires) {
      const file = await stat(portFile).catch(() => null);
      if (file && file.mtimeMs > previousPort) {
        const endpoint = await readFile(portFile, 'utf8').catch(() => '');
        browserPort = Number(endpoint.split(/\r?\n/, 1)[0]);
      }
      if (!browserPort) await delay(150);
    }
    if (!browserPort) throw new Error('浏览器启动失败，或这个账号的窗口仍打开着。');

    const response = await fetch(`http://127.0.0.1:${browserPort}/json/list`, {
      signal: AbortSignal.timeout(5_000),
    });
    const targets = await response.json();
    const blankTab = targets.find(tab => tab.type === 'page' && tab.url === 'about:blank');
    if (!blankTab) throw new Error('浏览器没有打开登录标签页。');
    client = await DevTools.connect(blankTab.webSocketDebuggerUrl, onNetworkEvent);
    await registerGamePageHooks(client, GAME_ORIGIN);
    if (onNetworkEvent) await client.send('Network.enable', { maxPostDataSize: 0 });
    const navigation = await client.send('Page.navigate', { url: GAME_URL });
    if (navigation.errorText) throw new Error('无法打开官方游戏网页。');
    if (onNetworkEvent && interactive) await client.send('Page.bringToFront');
    return { client, close, exit, isOpen: () => !exited,
      detach: () => { client.socket.close(); browser.unref(); } };
  } catch (error) {
    await close();
    throw error;
  }
}

async function getLoginStatus(account, interactive, reuse = false) {
  const profile = join(PROFILE_ROOT, `account-${account.toLowerCase()}`);
  const browser = await openGame(profile, interactive, undefined, reuse);
  if (browser.attached) console.log(`${account}  正在读取已打开的游戏窗口。`);
  try {
    if (interactive) {
      await browser.client.send('Page.bringToFront');
      console.log(`请在浏览器窗口完成淘米登录。账号配置 ${account}`);
    }
    const end = interactive ? Infinity : Date.now() + 40_000;
    while (Date.now() < end && browser.isOpen()) {
      const response = await browser.client.send('Runtime.evaluate', {
        expression: '({status: window.__flowerLoginStatus, identity: window.__flowerLoginIdentity})',
        returnByValue: true,
      }, 4_000).catch(() => null);
      const { status, identity } = response?.result?.value ?? {};
      if (status === 'signed_in' && identity) accountIdentities.set(account.toLowerCase(), identity);
      if (status === 'needs_login') accountIdentities.delete(account.toLowerCase());
      if (status === 'signed_in') return status;
      if (status === 'needs_login' && !interactive) return status;
      await delay(450);
    }
    return browser.isOpen() ? 'timeout' : 'closed';
  } finally {
    await browser.close();
  }
}

const gameSocketHost = 'ws-hua.61.com';
const heartbeatCommand = 30002;
const signStatusCommand = 9191;
const headlessGameTimeout = 40_000;

// Only report connection states and frame metadata. Never record credentials or full frames.
async function inspectGameNetwork(account, interactive, listenOnly = false) {
  const sockets = new Map();
  const stats = new Map();
  let gameSocketSeen = false;
  let gameHeartbeatSeen = false;
  let signQuerySeen = false;
  let signReplySeen = false;
  let lastReceiptTime = null;
  let lastSignSequence = 0;
  let signedDays = null;
  let bundled = false;
  let authorization;
  let clientLoaded = false;
  const log = message => console.log(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${message}`);
  const record = frame => {
    const reply = frame.todaySignReply;
    if (listenOnly && reply && (reply.sequence === undefined || reply.sequence !== lastSignSequence)) {
      if (reply.sequence !== undefined) lastSignSequence = reply.sequence;
      log(`收到今日签到回复 9192 · 服务器状态码 ${reply.status} · ${reply.length} 字节`);
    }
    if ((frame.multiPacketSeen || frame.packets > 1) && !bundled) {
      bundled = true;
      log('已识别一条消息内的多个服务器数据包。');
    }
    if (Array.isArray(frame.days) && JSON.stringify(signedDays) !== JSON.stringify(frame.days)) {
      signedDays = frame.days;
      log(`签到回复 · ${account} 累计 ${signedDays.length} 天 · 日期索引 [${signedDays.join('、')}]`);
    }
    if (frame.signDiagnostic) {
      const { length, status, reason } = frame.signDiagnostic;
      const summary = `签到回复 ${length} 字节 · 状态 ${status} · 校验 ${reason}`;
      const time = frame.signDiagnostic.time ?? Date.now();
      if (time !== lastReceiptTime) {
        lastReceiptTime = time;
        log(summary);
      }
    }
    if (frame.signResponse && !signReplySeen) {
      signReplySeen = true;
      log('已观察到双生签到回复。');
    }
  };
  const hostOf = value => URL.canParse(value) ? new URL(value).host : null;
  const count = key => {
    if (!listenOnly) stats.set(key, (stats.get(key) ?? 0) + 1);
  };
  const report = () => {
    for (const [key, occurrences] of stats) log(`${key} ×${occurrences}`);
    stats.clear();
  };
  const onEvent = (method, params) => {
    if (method === 'Network.responseReceived' && ['XHR', 'Fetch'].includes(params.type)) {
      const host = hostOf(params.response.url);
      if (host) count(`${params.type} ${host} HTTP ${params.response.status}`);
    } else if (method === 'Network.webSocketCreated') {
      const host = hostOf(params.url);
      if (!host) return;
      sockets.set(params.requestId, { host, queried: false });
      if (host === gameSocketHost) {
        gameSocketSeen = true;
        log('游戏正在连接服务器。');
      }
    } else if (method === 'Network.webSocketClosed') {
      sockets.delete(params.requestId);
    } else if (method === 'Network.webSocketFrameSent' || method === 'Network.webSocketFrameReceived') {
      const socket = sockets.get(params.requestId);
      if (socket?.host !== gameSocketHost) return;
      const { host } = socket;
      const sent = method === 'Network.webSocketFrameSent';
      const direction = sent ? '发送' : '接收';
      const { opcode, payloadData } = params.response;
      if (opcode !== 2) {
        count(`${direction} ${host} 消息类型 ${opcode}`);
        return;
      }
      const size = Buffer.byteLength(payloadData, 'base64');
      if (!sent && size >= 17 && size <= 4194304) record(readSignTraffic(Buffer.from(payloadData, 'base64')));
      const prefix = Buffer.from(payloadData.slice(0, 12), 'base64');
      const hasKnownHeader = size >= 17 && prefix.length >= 9 && prefix.readUInt32BE(0) === size;
      const commandId = hasKnownHeader ? prefix.readUInt32BE(5) : null;
      if (commandId === heartbeatCommand) {
        if (!sent && !gameHeartbeatSeen) {
          gameHeartbeatSeen = true;
          log('已收到游戏服务器的心跳。');
        }
        return;
      }
      if (listenOnly && ((sent && commandId === 9192) || commandId === 9193)) {
        log(`${direction} ${commandId === 9192 ? '签到' : '补签'}消息 ${commandId} · ${size} 字节`);
      }
      if (commandId === signStatusCommand && sent) {
        if (listenOnly || !signQuerySeen) log('官方客户端已发出双生签到查询。');
        socket.queried = true;
        signQuerySeen = true;
      }
      if (commandId === signStatusCommand && !sent && socket.queried && !signReplySeen) {
        signReplySeen = true;
        log('已收到候选的双生签到查询回复，签到数据仍需校验。');
      }
      const descriptor = commandId === null ? '二进制消息' : `编号 ${commandId}`;
      count(`${direction} ${host} ${descriptor} ${size} 字节`);
    }
  };

  const profile = join(PROFILE_ROOT, `account-${account.toLowerCase()}`);
  const browser = listenOnly
    ? await attachGame(join(profile, 'DevToolsActivePort'), onEvent)
    : await openGame(profile, interactive, onEvent, true);
  if (!browser) throw new Error('请先打开该账号的游戏标签页。');
  const timer = interactive && !listenOnly ? setInterval(report, 3_000) : null;
  const end = interactive ? Infinity : Date.now() + headlessGameTimeout;
  const observed = `({
    authorization: window.__flowerLoginStatus,
    clientLoaded: !!document.getElementById('unity-canvas') &&
      document.getElementById('unity-loading-bar')?.style.display === 'none',
  })`;
  let existing;
  if (listenOnly) log(`${account} · 已连接游戏标签页，只读监听签到消息。`);
  else log(interactive
    ? `${account} · 官方游戏窗口已打开。进入角色后打开双生签到面板。`
    : `${account} · 开始读取游戏状态。`);
  try {
    if (browser.attached) {
      existing = await watchOpenSockets(browser.client, {
        origin: GAME_ORIGIN, host: gameSocketHost, signCommand: signStatusCommand,
        heartbeatCommand, duration: interactive ? null : Math.max(1, end - Date.now()),
      });
      if (existing) {
        gameSocketSeen = true;
        log('当前游戏连接已打开，正在观察签到回复。');
      }
    }
    while (Date.now() < end && browser.isOpen()) {
      const observation = await existing?.read().catch(() => null);
      if (observation?.heartbeat && !gameHeartbeatSeen) {
        gameHeartbeatSeen = true;
        log('现有游戏连接已收到心跳。');
      }
      if (observation) record(observation);
      if (listenOnly) {
        await delay(1000, undefined, { ref: false });
        continue;
      }
      const response = await browser.client.send('Runtime.evaluate', {
        expression: observed,
        returnByValue: true,
      }, 3_000).catch(() => null);
      const state = response?.result?.value;
      if (state?.clientLoaded && !clientLoaded) {
        clientLoaded = true;
        log('官方游戏客户端已加载。');
      }
      if (state?.authorization && state.authorization !== authorization) {
        authorization = state.authorization;
        if (authorization === 'signed_in' || authorization === 'needs_login') log(messages[authorization]);
      }
      if (!interactive && (signedDays !== null || (authorization === 'needs_login' && !gameSocketSeen))) break;
      await delay(1000, undefined, { ref: false });
    }
  } finally {
    clearInterval(timer);
    await existing?.close();
    if (interactive) report();
    await browser.close();
  }
  if (signedDays !== null) return 'sign_progress';
  if (signReplySeen) return 'sign_reply';
  if (signQuerySeen) return 'sign_query_only';
  if (gameHeartbeatSeen) return 'heartbeat_only';
  if (gameSocketSeen) return 'connected_only';
  if (authorization === 'signed_in') return browser.attached ? 'authorized_attached' : 'authorized_only';
  if (authorization === 'needs_login') return 'needs_login';
  return clientLoaded ? 'loaded_only' : 'timeout';
}

const [command, ...accounts] = process.argv.slice(2);
const validAccount = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const messages = {
  signed_in: '淘米账号已登录',
  needs_login: '需要在淘米窗口登录',
  timeout: '等待登录状态超时',
  closed: '浏览器已关闭',
  sign_progress: '已读到游戏服务器返回的签到日期',
  sign_reply: '观察到查询回复，待校验签到进度',
  sign_query_only: '已观察到签到查询，尚未收到对应回复',
  heartbeat_only: '已收到游戏心跳，尚未观察到签到查询',
  connected_only: '已尝试连接游戏服务器，尚未收到游戏心跳',
  authorized_attached: '淘米已授权，未能确认现有角色的签到进度',
  authorized_only: '仅完成淘米授权，尚未连接游戏服务器',
  loaded_only: '客户端已加载，尚未看到淘米授权结果',
};

export { APP_ROOT, PROFILE_ROOT, validAccount };

export async function checkAccount(account) {
  if (!validAccount.test(account)) throw new Error('账号别名格式无效');
  return messages[await getLoginStatus(account, false, true)];
}

export async function showAccountGame(account) {
  if (!validAccount.test(account)) throw new Error('账号别名格式无效');
  const profile = join(PROFILE_ROOT, 'account-' + account.toLowerCase());
  const background = await attachGame(join(profile, 'DevToolsActivePort'));
  if (background?.headless) {
    await background.client.send('Browser.close').catch(() => {});
    await background.close();
    await delay(500);
  } else if (background) await background.close();
  const browser = await openGame(profile, true, undefined, true);
  try {
    await browser.client.send('Page.bringToFront');
  } finally {
    browser.client.socket.close(); // Leave the official window open for the player.
  }
}

async function runCli() {
  if (!command || command === '--help') {
    console.log('node src/browser/login.mjs login main\nnode src/browser/login.mjs login main alt1\nnode src/browser/login.mjs status main alt1\nnode src/browser/login.mjs inspect main\nnode src/browser/login.mjs listen main\nnode src/browser/login.mjs game-status main alt1\nnode src/browser/login.mjs calendar');
    console.log('node src/browser/login.mjs days main （查询签到天数）\nnode src/browser/login.mjs sign main （今日签到）');
    console.log('node src/browser/login.mjs check main alt1 （批量检查签到条件）');
    console.log('配置名用字母、数字、下划线或连字符，例如 main 或 alt1。');
  } else if (['days', 'sign'].includes(command)) {
    try {
      if (accounts.length !== 1 || !validAccount.test(accounts[0])) throw new Error('请指定一个账号别名');
      const account = accounts[0].toLowerCase();
      const profile = join(PROFILE_ROOT, 'account-' + account);
      if (!await stat(profile).then(info => info.isDirectory(), () => false)) throw new Error('账号配置不存在');
      const { loadActivityAdapter, runActivity } = await import('../game/activity.mjs');
      const adapter = process.env.FLOWER_ACTIVITY_ADAPTER
        ? await loadActivityAdapter(process.env.FLOWER_ACTIVITY_ADAPTER)
        : (await import('../game/official-activity.mjs')).default;
      const inSession = action => adapter.withAccount ? adapter.withAccount(account, action) : action();
      if (command === 'days') {
        const { queryLiveSignedDays } = await import('../game/sign-progress.mjs');
        const result = await inSession(() => queryLiveSignedDays(adapter, account));
        console.log(JSON.stringify(result));
      } else {
        const result = await inSession(() => runActivity(adapter, account, 'sign'));
        console.log(JSON.stringify(result));
      }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  } else if (command === 'calendar' && accounts.length === 0) {
    try {
      const { readDoubleSignCalendar } = await import('../game/calendar.mjs');
      const { current } = await readDoubleSignCalendar();
      if (!current) {
        console.log('当前没有进行中的双生签到。');
      } else {
        console.log(`双生签到 第 ${current.id} 期 · 共 ${current.totalDays} 天`);
        console.log(`${current.start} 至 ${current.end}（UTC+8）`);
        if (current.today) console.log(`今天是第 ${current.today} 天。`);
        console.log(`累计奖励 ${current.milestones.join('、')} 天`);
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else if (!['login', 'status', 'inspect', 'listen', 'game-status', 'check'].includes(command) || !accounts.length ||
      (['inspect', 'listen'].includes(command) && accounts.length !== 1) ||
      accounts.some(account => !validAccount.test(account))) {
    console.error('参数不正确。运行 node src/browser/login.mjs --help 查看用法。');
    process.exitCode = 1;
  } else {
    const uniqueAccounts = new Set(accounts.map(name => name.toLowerCase()));
    let season;
    if (command === 'check') {
      try {
        const { readDoubleSignCalendar } = await import('../game/calendar.mjs');
        ({ current: season } = await readDoubleSignCalendar());
        console.log(season ? `双生签到第 ${season.id} 期（共 ${season.totalDays} 天）` : '当前没有进行中的双生签到。');
      } catch (error) {
        console.error(`活动日历读取失败 · ${error.message}`);
        process.exitCode = 1;
      }
    }
    for (const account of uniqueAccounts) {
      try {
        if (command === 'check') {
          const status = await getLoginStatus(account, false, true);
          const details = [account, messages[status]];
          if (status === 'signed_in' && season) details.push('角色签到进度未知');
          console.log(details.join('  ·  '));
          if ((status !== 'signed_in' || season) && !process.exitCode) process.exitCode = 2;
          continue;
        }
        if (['inspect', 'listen', 'game-status'].includes(command)) {
          const status = await inspectGameNetwork(account, command !== 'game-status', command === 'listen');
          console.log(`${account}  ${messages[status]}`);
          // A matching header confirms traffic for inspect, but does not establish account progress.
          const diagnosticComplete = status === 'sign_progress' || (command !== 'game-status' && status === 'sign_reply');
          if (!diagnosticComplete && !process.exitCode) process.exitCode = 2;
          continue;
        }
        const isBatchLogin = command === 'login' && accounts.length > 1;
        let status = await getLoginStatus(account, command === 'login' && !isBatchLogin, true);
        const openedLogin = command === 'login' && (!isBatchLogin || status === 'needs_login');
        if (isBatchLogin && openedLogin) status = await getLoginStatus(account, true, true);
        console.log(`${account}  ${messages[status]}`);

        if (openedLogin && status === 'signed_in') {
          status = await getLoginStatus(account, false, true);
          console.log(`${account}  登录状态复查 · ${messages[status]}`);
        }
        if (status !== 'signed_in' && !process.exitCode) process.exitCode = 2;
      } catch (error) {
        console.error(`${account}  ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
