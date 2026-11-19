// Development-only passive observer. It never sends game commands, clicks the
// game, reads page content, or injects scripts into the page.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOfficialGame, validAccount } from '../src/browser/login.mjs';
import { createProtocol } from '../src/game/official-protocol.mjs';

const codec = createProtocol();
const HEADER = 17;
const MAX_FRAME = 4 * 1024 * 1024;
const FRAME_EVENTS = new Set(['Network.webSocketFrameSent', 'Network.webSocketFrameReceived']);

export function createRewardObserver(write = entry => console.log(JSON.stringify(entry))) {
  // Never print account identifiers from packet headers or the partner field in
  // a 9191 response. Scrub identifiers already observed from subsequent bodies.
  const identifiers = new Set();
  return function observe(message) {
    if (!FRAME_EVENTS.has(message?.method) || message.params?.response?.opcode !== 2) return;
    const payload = message.params.response.payloadData;
    if (typeof payload !== 'string' || payload.length > Math.ceil(MAX_FRAME / 3) * 4) return;
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length < HEADER || bytes.length > MAX_FRAME) return;
    const direction = message.method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
    const time = new Date().toISOString();
    for (let at = 0; at + HEADER <= bytes.length;) {
      const length = bytes.readUInt32BE(at);
      if (length < HEADER || length > MAX_FRAME || at + length > bytes.length) break;
      const command = bytes.readUInt32BE(at + 5);
      if (command === 2916 || command >= 9191 && command <= 9199) {
        const role = bytes.readUInt32BE(at + 9);
        if (role > 0) identifiers.add(role);
        try {
          const packet = bytes.subarray(at, at + length);
          const frame = direction === 'received' ? codec.decodeResponse(packet) : null;
          const body = frame ? frame.body : length === HEADER ? new Uint8Array() : codec.decryptBody(packet.subarray(HEADER));
          if (body.length % 4 !== 0) throw new Error('unaligned-body');
          const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
          const words = Array.from({ length: body.length / 4 }, (_, i) => view.getUint32(i * 4));
          if (direction === 'received' && command === 9191 && words.length) {
            if (words[0] > 0) identifiers.add(words[0]);
            words[0] = '[redacted-id]';
          }
          write({ time, direction, command, status: frame?.status ?? null,
            words: words.map(value => identifiers.has(value) ? '[redacted-id]' : value) });
        } catch {
          // Structural diagnostics contain no body bytes or exception strings.
          write({ time, direction, command,
            status: direction === 'received' ? bytes.readInt32BE(at + 13) : null,
            error: 'body-decode-failed' });
        }
      }
      at += length;
    }
  };
}

export async function captureRewards(account, durationSeconds) {
  if (typeof account !== 'string' || !validAccount.test(account)) throw new Error('请指定有效的账号别名。');
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 3600) {
    throw new Error('监听时长用 1–3600 之间的整数，单位是秒。');
  }
  const game = await openOfficialGame(account.toLowerCase());
  const observe = createRewardObserver();
  const onMessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    observe(message);
  };
  // Listen directly to frames, including frames on a socket that was created
  // before this debugger attached. No webSocketCreated event is required.
  game.client.socket.addEventListener('message', onMessage);
  let timer;
  let stop;
  const finished = new Promise(resolve => { stop = resolve; });
  const onClose = () => stop('connection-closed');
  const onSignal = () => stop('interrupted');
  game.client.socket.addEventListener('close', onClose, { once: true });
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await game.client.send('Network.enable', { maxPostDataSize: 0 });
    console.error(`正在只读监听双生签到请求，${durationSeconds} 秒后结束。请在游戏里手动操作领奖。`);
    timer = setTimeout(() => stop('duration-ended'), durationSeconds * 1000);
    await finished;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    game.client.socket.removeEventListener('message', onMessage);
    game.client.socket.removeEventListener('close', onClose);
    // openOfficialGame.close detaches this debugger and leaves the game open.
    await game.close();
    console.error('只读监听已结束，游戏窗口保持打开。');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('用法：node scripts/capture-rewards.mjs 账号别名 监听秒数');
    console.log('例如：node scripts/capture-rewards.mjs main 90');
    return;
  }
  if (args.length !== 2) throw new Error('用法：node scripts/capture-rewards.mjs 账号别名 监听秒数');
  await captureRewards(args[0], Number(args[1]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
