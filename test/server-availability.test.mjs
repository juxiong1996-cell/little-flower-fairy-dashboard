import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installServerAvailability } from '../src/browser/server-availability.mjs';

const origin = 'https://webgl-hua.61.com';
class Socket extends EventTarget {
  static OPEN = 1;
  constructor(url) { super(); this.url = url; this.readyState = Socket.OPEN; }
  send() { assert.fail('维护观察器不能发送任何请求'); }
  receive(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event); }
}
function frame(value, { command = 120, status = 0, bodyLength = 4 } = {}) {
  const data = new Uint8Array(17 + bodyLength), view = new DataView(data.buffer);
  view.setUint32(0, data.length); view.setUint32(5, command); view.setInt32(13, status);
  if (bodyLength >= 4) view.setUint32(17, value);
  return data;
}
function page({ pageOrigin = origin, child = false } = {}) {
  const context = vm.createContext({ URL, ArrayBuffer, Uint8Array, DataView, Blob, WeakSet, Proxy, Reflect, WebSocket: Socket, location: { origin: pageOrigin } });
  vm.runInContext('window = globalThis; top = window;', context);
  if (child) context.top = {};
  const install = () => vm.runInContext(`(${installServerAvailability.toString()})(${JSON.stringify(origin)})`, context);
  install();
  return { context, install, socket: () => new context.WebSocket('wss://ws-hua.61.com/'), state: () => context.__flowerServerAvailability.read() };
}

test('只按官方命令120成功回复判定维护，开放状态清除旧维护提示', () => {
  for (const value of [0, 1, 2]) {
    const p = page(), socket = p.socket();
    assert.equal(p.state().maintenance, false, '未收到明确回复时不能猜测维护');
    socket.receive(frame(value));
    assert.equal(p.state().maintenance, true);
    socket.receive(frame(3));
    assert.equal(p.state().maintenance, false);
    socket.receive(frame(0xffffffff));
    assert.equal(p.state().maintenance, false);
  }
});

test('无关主机、其他命令、失败回复、短包和破损包都不能误报维护', () => {
  const p = page(), socket = p.socket();
  new p.context.WebSocket('wss://example.com/').receive(frame(1));
  for (const packet of [frame(1, { command: 9191 }), frame(1, { status: 2 }), frame(1, { bodyLength: 3 }), new Uint8Array(4), new Uint8Array(21)]) socket.receive(packet);
  socket.receive('ignore this message');
  assert.equal(p.state().maintenance, false);
});

test('支持合并包、带偏移的视图与Blob，不修改原始数据', async () => {
  const p = page(), socket = p.socket();
  const first = frame(99, { command: 118 }), second = frame(2);
  const combined = new Uint8Array(first.length + second.length + 8);
  combined.set(first, 4); combined.set(second, 4 + first.length);
  const before = combined.slice();
  socket.receive(combined.subarray(4, -4));
  assert.equal(p.state().maintenance, true);
  assert.deepEqual(combined, before);
  socket.receive(new Blob([frame(3)]));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.state().maintenance, false);
});

test('可补充观察已有socket，重复安装和监听不会替换构造器或复制状态', () => {
  const p = page(), socket = new Socket('wss://ws-hua.61.com/');
  p.context.__flowerServerAvailability.watch([socket]);
  p.context.__flowerServerAvailability.watch([socket]);
  socket.receive(frame(2));
  assert.equal(p.state().maintenance, true);
  const constructor = p.context.WebSocket, observer = p.context.__flowerServerAvailability;
  p.install();
  assert.equal(p.context.WebSocket, constructor);
  assert.equal(p.context.__flowerServerAvailability, observer);
  assert.equal(p.context.WebSocket.OPEN, Socket.OPEN);
  assert.ok(p.socket() instanceof Socket);
  socket.readyState = 3;
  assert.equal(p.state().maintenance, false, '不能把已断开连接的旧状态带入新连接');
});

test('其他来源页面和子框架不能安装维护观察器', () => {
  for (const options of [{ pageOrigin: 'https://example.com' }, { child: true }]) {
    const p = page(options);
    assert.equal(p.context.__flowerServerAvailability, undefined);
    assert.equal(p.context.WebSocket, Socket);
  }
});
