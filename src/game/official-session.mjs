import { setTimeout as delay } from 'node:timers/promises';
import { openOfficialGame } from '../browser/login.mjs';
import { enterGameForApi } from '../browser/game-navigation.mjs';
import { createProtocol } from './official-protocol.mjs';
import { installServerAvailability } from '../browser/server-availability.mjs';

// This bridge stays with the official socket so its rolling header remains in sync
// after an API request. It never exposes login cookies, tokens or unrelated frames.
export function installBridge(codec) {
  const sockets = this.filter(s => s.readyState === WebSocket.OPEN && new URL(s.url).hostname === 'ws-hua.61.com');
  if (sockets.length !== 1) return null;
  const socket = sockets[0];
  if (socket.__flowerActivityBridge) {
    if (socket.__flowerActivityBridge.version === 5) return socket.__flowerActivityBridge;
    return { ready: () => false, status: () => ({ closed: false, dirty: true }) };
  }
  const nativeSend = socket.send;
  const activityCommands = [2916, 9191, 9192, 9195];
  const officialPending = new Map();
  let unityPrevious = null, wirePrevious = null, role = null, channel = null, pending = null, dirty = false;
  const rolling = n => n - Math.trunc(n / 7);
  function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  socket.send = function(data) {
    const bytes = bytesOf(data);
    if (!bytes || bytes.byteLength < 17) return nativeSend.call(this, data);
    const copy = bytes.slice();
    const view = new DataView(copy.buffer);
    let changed = false;
    for (let at = 0; at + 17 <= copy.length;) {
      const length = view.getUint32(at);
      if (length < 17 || at + length > copy.length) break;
      const command = view.getUint32(at + 5);
      if (pending && command === pending.command) {
        dirty = true;
        clearTimeout(pending.timer);
        pending.reject(new Error('官方窗口也在操作此活动，请稍后重试'));
        pending = null;
      }
      if (activityCommands.includes(command)) officialPending.set(command, (officialPending.get(command) ?? 0) + 1);
      if (command >= 1000) {
        const original = view.getInt32(at + 13);
        const next = unityPrevious === null ? original : (original - rolling(unityPrevious) + rolling(wirePrevious)) | 0;
        if (next !== original) { view.setInt32(at + 13, next); changed = true; }
        unityPrevious = original;
        wirePrevious = next;
        role = view.getUint32(at + 9);
        channel = view.getUint8(at + 4);
      }
      at += length;
    }
    return nativeSend.call(this, changed ? copy : data);
  };
  async function receive(event) {
    const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
    const bytes = bytesOf(data);
    if (!bytes) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 17 <= bytes.length;) {
      const length = view.getUint32(at);
      if (length < 17 || at + length > bytes.length) break;
      // The server does not echo the request userID in response header +9.
      const command = view.getUint32(at + 5);
      const waiting = officialPending.get(command) ?? 0;
      if (waiting > 0) {
        if (waiting === 1) officialPending.delete(command);
        else officialPending.set(command, waiting - 1);
      } else if (pending && command === pending.command) {
        const job = pending;
        pending = null;
        clearTimeout(job.timer);
        job.resolve({ role: job.role, packet: Array.from(bytes.subarray(at, at + length)), at: new Date().toISOString() });
      }
      at += length;
    }
  }
  socket.addEventListener('message', receive);
  socket.addEventListener('close', () => {
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('官方游戏连接已断开，请重试')); pending = null; }
  });
  const bridge = {
    version: 5,
    ready: () => !dirty && officialPending.size === 0 && socket.readyState === WebSocket.OPEN && wirePrevious !== null && role > 0,
    status: () => ({ closed: socket.readyState !== WebSocket.OPEN, dirty }),
    async request(command, body, expectedRole) {
      if (!activityCommands.includes(command)) throw new Error('不支持的活动请求');
      if (!bridge.ready()) throw new Error('官方游戏连接尚未就绪');
      if (pending) throw new Error('该账号正在请求官方服务器');
      if (expectedRole !== undefined && expectedRole !== role) throw new Error('账号角色已变化，请重新查询后再操作');
      const payload = new Uint8Array(body);
      const packet = codec.encodeRequest({ command, role, channel, previous: wirePrevious, body: payload });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null; dirty = true;
          const message = command === 9195 ? '领奖回复超时，请先查询确认领取结果后再试'
            : command === 9192 ? '签到回复超时，请先查询确认结果后再试'
            : command === 2916 ? '官方领奖状态查询超时，请重试' : '官方签到查询超时，请重试';
          reject(new Error(message));
        }, 12000);
        pending = { command, role, resolve, reject, timer };
        try { nativeSend.call(socket, packet); wirePrevious = codec.nextSequence(wirePrevious, command, payload); }
        catch (error) { clearTimeout(timer); pending = null; reject(error); }
      });
    },
  };
  Object.defineProperty(socket, '__flowerActivityBridge', { value: bridge });
  return bridge;
}

export async function openActivitySession(account, {
  openGame = openOfficialGame, navigate = enterGameForApi,
  now = Date.now, wait = delay,
} = {}) {
  const game = await openGame(account, { closeOnFinish: true });
  const group = 'flower-activity-api';
  let bridge;
  try {
    await game.client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // Attach the read-only observer to existing sockets too. New windows have
    // the same hook preloaded before the official client opens its connection.
    const availability = await game.client.send('Runtime.evaluate', {
      expression: `(() => {
        const availability = window.__flowerServerAvailability?.read();
        const refreshStartup = location.origin === "https://webgl-hua.61.com" &&
          document.getElementById('unity-loading-bar')?.style.display === 'none' &&
          (!availability?.known || availability.maintenance);
        (${installServerAvailability.toString()})("https://webgl-hua.61.com");
        return refreshStartup;
      })()`, returnByValue: true,
    });
    // Replay the official startup check when an old window missed 120 or still
    // shows maintenance. This also lets a later retry detect that it has ended.
    if (game.attached && availability.result.value === true) await game.client.send('Page.reload');
    const expires = now() + 150000;
    let navigatedAt = 0;
    let readySince = 0;
    while (now() < expires) {
      try {
        if (!bridge) {
          const { result: prototype } = await game.client.send('Runtime.evaluate', {
            expression: 'location.origin === "https://webgl-hua.61.com" ? WebSocket.prototype : null', objectGroup: group,
          });
          if (prototype.objectId) {
            const { objects } = await game.client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group });
            const response = await game.client.send('Runtime.callFunctionOn', {
              objectId: objects.objectId, objectGroup: group,
              functionDeclaration: `function() { window.__flowerServerAvailability?.watch(this); return (${installBridge.toString()}).call(this, (${createProtocol.toString()})()); }`,
            });
            if (response.exceptionDetails) throw new Error('无法接入官方活动连接');
            if (response.result.objectId) bridge = response.result.objectId;
          }
        }
        if (bridge) {
          const { result: connection } = await game.client.send('Runtime.callFunctionOn', {
            objectId: bridge, functionDeclaration: 'function(){return this.status?.() ?? {closed:false,dirty:false}}', returnByValue: true,
          });
          if (connection.value.closed) { bridge = null; continue; }
          if (connection.value.dirty) {
            await game.client.send('Page.reload');
            bridge = null; navigatedAt = 0; readySince = 0;
            await wait(500);
            continue;
          }
          const { result } = await game.client.send('Runtime.callFunctionOn', {
            objectId: bridge, functionDeclaration: 'function(){return this.ready()}', returnByValue: true,
          });
          if (result.value) {
            // Let the client's initial activity queries finish before sending
            // our own, including replies to requests made during startup.
            readySince ||= now();
            if (now() - readySince < 1500) { await wait(300); continue; }
            return {
              async request(command, body, { expectedRole } = {}) {
                const { result, exceptionDetails } = await game.client.send('Runtime.callFunctionOn', {
                  objectId: bridge, functionDeclaration: 'function(command,body,expectedRole){return this.request(command,body,expectedRole)}',
                  arguments: [{ value: command }, { value: Array.from(body) }, { value: expectedRole }], awaitPromise: true, returnByValue: true,
                }, 15000);
                if (exceptionDetails) throw new Error((exceptionDetails.exception?.description ?? result.description)?.split('\n')[0]?.replace(/^Error: /, '') || '官方活动请求失败');
                return result.value;
              },
              close: async () => {
                await game.client.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
                await game.close();
              },
            };
          }
          readySince = 0;
        }
        // The official socket can open on the login panel before a role is
        // connected. Continue safe navigation until the bridge is ready.
        if (now() - navigatedAt > 4000) {
          await navigate(game.client);
          navigatedAt = now();
        }
      } catch (error) {
        // Reloading an older bridge can briefly remove the execution context or
        // stall Runtime calls. Only connection preparation is retried here;
        // business requests returned above are never replayed automatically.
        if (!/context|Could not find object|^Runtime\.(?:evaluate|queryObjects|callFunctionOn) 调用失败/i.test(error.message)) throw error;
        if (game.client.socket.readyState !== WebSocket.OPEN) throw new Error('官方游戏连接已断开，请重新打开游戏后再试');
        bridge = null;
        readySince = 0;
      }
      await wait(400);
    }
    throw Object.assign(new Error('官方游戏连接准备超时，请稍后重试；若仍失败，请点“进入游戏”检查登录'), { status: 503 });
  } catch (error) {
    await game.client.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
    await game.close();
    throw error;
  }
}
