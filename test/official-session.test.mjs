import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { installBridge } from '../src/game/official-session.mjs';
import { createProtocol } from '../src/game/official-protocol.mjs';

const ROLE = 12345;
const CHANNEL = 7;
const codec = createProtocol();

class FakeSocket extends EventTarget {
  static OPEN = 1;

  constructor(url = 'wss://ws-hua.61.com/game') {
    super();
    this.url = url;
    this.readyState = FakeSocket.OPEN;
    this.sent = [];
  }

  send(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(bytes.slice());
  }

  receive(data) {
    const event = new Event('message');
    event.data = data;
    this.dispatchEvent(event);
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

function frame(command, sequence = 0, role = ROLE, body = new Uint8Array()) {
  const packet = new Uint8Array(17 + body.length);
  const view = new DataView(packet.buffer);
  view.setUint32(0, packet.length);
  view.setUint8(4, CHANNEL);
  view.setUint32(5, command);
  view.setUint32(9, role);
  view.setInt32(13, sequence);
  packet.set(body, 17);
  return packet;
}

function header(packet) {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return { command: view.getUint32(5), role: view.getUint32(9), channel: view.getUint8(4), sequence: view.getInt32(13) };
}

function queryBody(season = 17) {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint32(0, season);
  return body;
}

function rewardBody(season = 17, index = 2) {
  const body = new Uint8Array(8), view = new DataView(body.buffer);
  view.setUint32(0, season); view.setUint32(4, index);
  return body;
}

function setup(sockets = [new FakeSocket()], globals = {}) {
  const context = vm.createContext({ WebSocket: FakeSocket, URL, ArrayBuffer, Uint8Array, DataView, Blob, Date, setTimeout, clearTimeout, ...globals });
  const install = vm.runInContext(`(${installBridge.toString()})`, context);
  return { socket: sockets[0], bridge: install.call(sockets, codec), install };
}

test('桥接只选择一个已连接的官方连接，捕获官方发送包后才就绪', () => {
  const { socket, bridge } = setup();
  assert.equal(bridge.version, 5);
  assert.equal(bridge.ready(), false);
  socket.send(frame(500, 25));
  assert.equal(bridge.ready(), false);
  const official = frame(30002, 13579);
  socket.send(official.buffer);
  assert.equal(bridge.ready(), true);
  assert.deepEqual(socket.sent.at(-1), official);
  assert.equal(setup([new FakeSocket('wss://example.com/game')]).bridge, null);
  assert.equal(setup([new FakeSocket(), new FakeSocket()]).bridge, null);
});

test('旧版桥接保持 dirty，等待重建连接以更新领奖白名单', () => {
  for (const version of [2, 3, 4]) {
    const socket = new FakeSocket();
    const old = { version };
    Object.defineProperty(socket, '__flowerActivityBridge', { value: old });
    const originalSend = socket.send;
    const { bridge } = setup([socket]);
    assert.equal(bridge.ready(), false);
    assert.equal(bridge.status().dirty, true);
    assert.equal(socket.__flowerActivityBridge, old);
    assert.equal(socket.send, originalSend);
  }
});

test('等待官方窗口先前发出的活动查询全部结束，避免将旧回复误当作API回复', async () => {
  const { socket, bridge } = setup();
  socket.send(frame(30002, 13579));
  socket.send(frame(2916, 13600));
  socket.send(frame(9191, 13700));
  assert.equal(bridge.ready(), false);
  await assert.rejects(bridge.request(2916, new Uint8Array([0, 0, 0, 1, 0, 0, 0, 9])), /尚未就绪/);
  socket.receive(frame(2916));
  assert.equal(bridge.ready(), false, '另一条官方查询还没有结束');
  socket.receive(frame(9191));
  assert.equal(bridge.ready(), true);
  const requested = bridge.request(9191, queryBody());
  socket.receive(frame(9191));
  await requested;
  assert.equal(bridge.ready(), true);
});

test('9191 使用真实编码器发送并将官方回复关联到对应 Promise', async () => {
  const { socket, bridge } = setup();
  socket.send(frame(30002, 13579));
  const body = queryBody();
  const requested = bridge.request(9191, Array.from(body));
  const outgoing = socket.sent.at(-1);
  assert.deepEqual(outgoing, codec.encodeRequest({ command: 9191, role: ROLE, channel: CHANNEL, previous: 13579, body }));
  assert.deepEqual(codec.decryptBody(outgoing.subarray(17)), body);
  const responseBody = codec.encryptBody(new Uint8Array(16));
  const response = frame(9191, 0, ROLE, responseBody);
  socket.receive(response.buffer);
  const result = await requested;
  assert.deepEqual(Array.from(result.packet), Array.from(response));
  assert.ok(Number.isFinite(Date.parse(result.at)));
  assert.equal(codec.decodeResponse(new Uint8Array(result.packet)).command, 9191);
});

test('9195 领奖保护角色并正确发送，回复后继续维护官方滚动序号', async () => {
  const { socket, bridge } = setup();
  const previous = 13579, body = rewardBody();
  socket.send(frame(30002, previous));
  await assert.rejects(bridge.request(9195, body, ROLE + 1), /账号角色已变化/);
  assert.equal(socket.sent.length, 1);
  const requested = bridge.request(9195, body, ROLE);
  assert.deepEqual(socket.sent.at(-1), codec.encodeRequest({ command: 9195, role: ROLE, channel: CHANNEL, previous, body }));
  await assert.rejects(bridge.request(9192, new Uint8Array(8), ROLE), /正在请求/);
  const clear = new Uint8Array(12), view = new DataView(clear.buffer);
  view.setUint32(0, 1); view.setUint32(4, 300022); view.setUint32(8, 5);
  socket.receive(frame(9195, 0, 0, codec.encryptBody(clear)));
  const result = await requested;
  assert.equal(result.role, ROLE);
  assert.deepEqual(codec.parseReward(codec.decodeResponse(new Uint8Array(result.packet)).body), { rewards: [{ id: 300022, count: 5 }] });
  const empty = new Uint8Array(), next = codec.nextSequence(previous, 30002, empty);
  socket.send(frame(30002, next));
  assert.equal(header(socket.sent.at(-1)).sequence, codec.nextSequence(codec.nextSequence(previous, 9195, body), 30002, empty));
});

test('2916 只读查询一个徽章，核对角色并解析领取状态', async () => {
  const { socket, bridge } = setup();
  const body = rewardBody(1, 42001);
  socket.send(frame(30002, 13579));
  await assert.rejects(bridge.request(2916, body, ROLE + 1), /账号角色已变化/);
  await assert.rejects(bridge.request(2916, rewardBody(2, 42001), ROLE), /仅允许一个/);
  assert.equal(socket.sent.length, 1, '无效查询不能发包或推进序号');
  const requested = bridge.request(2916, body, ROLE);
  assert.deepEqual(socket.sent.at(-1), codec.encodeRequest({ command: 2916, role: ROLE, channel: CHANNEL, previous: 13579, body }));
  const clear = new Uint8Array(20), view = new DataView(clear.buffer);
  [1, 42001, 3, 1795017600, 1].forEach((word, i) => view.setUint32(i * 4, word));
  socket.receive(frame(2916, 0, 0, codec.encryptBody(clear)));
  const result = await requested;
  assert.equal(result.role, ROLE);
  assert.deepEqual(codec.parseMedals(codec.decodeResponse(new Uint8Array(result.packet)).body), [{ id: 42001, value: 3, time: 1795017600, flag: 1 }]);
  assert.equal(bridge.ready(), true);
});

test('注入后持续改写官方滚动序号，低于 1000 的命令不推进序号', async () => {
  const { socket, bridge } = setup();
  const empty = new Uint8Array();
  let unityPrevious = codec.nextSequence(15000, 30002, empty);
  socket.send(frame(30002, unityPrevious));
  let wirePrevious = unityPrevious;
  const body = queryBody();
  const requested = bridge.request(9191, body);
  wirePrevious = codec.nextSequence(wirePrevious, 9191, body);
  assert.equal(header(socket.sent.at(-1)).sequence, wirePrevious);
  socket.receive(frame(9191));
  await requested;

  for (const command of [30002, 2001, 30002]) {
    const low = frame(500, -987654);
    socket.send(low);
    assert.deepEqual(socket.sent.at(-1), low);
    unityPrevious = codec.nextSequence(unityPrevious, command, empty);
    wirePrevious = codec.nextSequence(wirePrevious, command, empty);
    const official = frame(command, unityPrevious);
    const before = official.slice();
    socket.send(official);
    assert.equal(header(socket.sent.at(-1)).sequence, wirePrevious);
    assert.deepEqual(official, before, '不能修改官方客户端持有的原始缓冲区');
  }
});

test('合并发送帧逐包维护滚动序号，保留低编号命令', async () => {
  const { socket, bridge } = setup();
  const body = queryBody();
  socket.send(frame(30002, 20000));
  const requested = bridge.request(9191, body);
  let wirePrevious = codec.nextSequence(20000, 9191, body);
  socket.receive(frame(9191));
  await requested;
  const empty = new Uint8Array();
  const unityNext = codec.nextSequence(20000, 30002, empty);
  const unityThird = codec.nextSequence(unityNext, 2001, empty);
  const packets = [frame(30002, unityNext), frame(500, -75), frame(2001, unityThird)];
  const combined = new Uint8Array(packets.reduce((sum, packet) => sum + packet.length, 0));
  packets.forEach((packet, index) => combined.set(packet, index * 17));
  socket.send(combined);
  const outgoing = socket.sent.at(-1);
  wirePrevious = codec.nextSequence(wirePrevious, 30002, empty);
  assert.equal(header(outgoing.subarray(0, 17)).sequence, wirePrevious);
  assert.deepEqual(outgoing.subarray(17, 34), packets[1]);
  wirePrevious = codec.nextSequence(wirePrevious, 2001, empty);
  assert.equal(header(outgoing.subarray(34)).sequence, wirePrevious);
});

test('按命令关联回复并保留请求角色，不依赖服务器回显角色；拒绝并发或未知请求', async () => {
  const { socket, bridge } = setup();
  await assert.rejects(bridge.request(9191, queryBody()), /尚未就绪/);
  socket.send(frame(30002, 13579));
  await assert.rejects(bridge.request(9193, new Uint8Array(8)), /不支持/);
  const requested = bridge.request(9191, queryBody());
  await assert.rejects(bridge.request(9191, queryBody()), /正在请求/);
  let finished = false;
  requested.then(() => { finished = true; });
  socket.receive(frame(9192));
  await Promise.resolve();
  assert.equal(finished, false);
  const correct = frame(9191, 0, ROLE + 1);
  socket.receive(correct);
  const result = await requested;
  assert.deepEqual(Array.from(result.packet), Array.from(correct));
  assert.equal(header(new Uint8Array(result.packet)).role, ROLE + 1, '保留服务器原始包头');
  assert.equal(result.role, ROLE, '业务核对使用本次请求的角色');
});

test('expectedRole 不匹配时不发送签到包，匹配时正常发送；角色变化后也拒绝旧角色', async () => {
  const { socket, bridge } = setup();
  const body = new Uint8Array(8);
  socket.send(frame(30002, 13579));
  await assert.rejects(bridge.request(9192, body, ROLE + 1), /账号角色已变化/);
  assert.equal(socket.sent.length, 1);
  assert.equal(bridge.ready(), true);
  assert.equal(bridge.status().dirty, false);

  const requested = bridge.request(9192, body, ROLE);
  assert.equal(socket.sent.length, 2);
  assert.equal(header(socket.sent.at(-1)).command, 9192);
  socket.receive(frame(9192, 0, 0));
  assert.equal((await requested).role, ROLE);

  socket.send(frame(30002, 15000, ROLE + 2));
  const before = socket.sent.length;
  await assert.rejects(bridge.request(9192, body, ROLE), /账号角色已变化/);
  assert.equal(socket.sent.length, before);
});

test('官方窗口同时发同命令时拒绝本次请求，避免把官方窗口回复当作 API 回复', async () => {
  const { socket, bridge, install } = setup();
  const body = queryBody();
  socket.send(frame(30002, 13579));
  const requested = bridge.request(9191, body);
  const rejected = assert.rejects(requested, /官方窗口也在操作此活动/);
  const official = codec.encodeRequest({ command: 9191, role: ROLE, channel: CHANNEL, previous: 13579, body });
  socket.send(official);
  await rejected;
  assert.equal(socket.sent.length, 3, '仍须发送官方窗口的原始操作');
  const injectedSequence = codec.nextSequence(13579, 9191, body);
  assert.equal(header(socket.sent.at(-1)).sequence, codec.nextSequence(injectedSequence, 9191, body));
  assert.equal(bridge.ready(), false);
  assert.equal(bridge.status().dirty, true);
  assert.equal(bridge.status().closed, false);
  socket.receive(frame(9191));
  socket.receive(frame(9191, 0, ROLE + 1));
  assert.equal(bridge.ready(), false, '迟到的旧响应不能恢复可用状态');
  assert.equal(install.call([socket], codec), bridge, '重新安装同一连接不能清除 dirty');
  await assert.rejects(bridge.request(9191, body), /尚未就绪/);
  assert.equal(socket.sent.length, 3, 'dirty 连接不能继续发送请求');
});

test('查询、签到或领奖超时后标记 dirty，领奖提示先查询核实且迟到回复不能恢复连接', async () => {
  for (const command of [2916, 9191, 9192, 9195]) {
    const timers = [];
    const { socket, bridge } = setup(undefined, {
      setTimeout(callback, ms) {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { timer.cleared = true; },
    });
    socket.send(frame(30002, 13579));
    const body = command === 2916 ? rewardBody(1, 42001) : new Uint8Array(command === 9191 ? 4 : 8);
    const requested = bridge.request(command, body);
    const rejected = assert.rejects(requested, command === 9195 ? /领奖回复超时，请先查询确认领取结果/ : command === 9192 ? /签到回复超时/ : /查询超时/);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 12000);
    timers[0].callback();
    await rejected;
    assert.equal(bridge.status().dirty, true);
    assert.equal(bridge.status().closed, false);
    assert.equal(bridge.ready(), false);
    socket.receive(frame(command));
    const before = socket.sent.length;
    await assert.rejects(bridge.request(command, body), /尚未就绪/);
    assert.equal(socket.sent.length, before);
  }
});

test('重复安装复用桥接与序号状态，连接关闭会拒绝等待中的请求', async () => {
  const { socket, bridge, install } = setup();
  const wrappedSend = socket.send;
  socket.send(frame(30002, 13579));
  assert.equal(install.call([socket], codec), bridge);
  assert.equal(socket.send, wrappedSend);
  assert.equal(bridge.ready(), true);
  const requested = bridge.request(9191, queryBody());
  const rejected = assert.rejects(requested, /连接已断开/);
  socket.close();
  await rejected;
  assert.equal(bridge.ready(), false);
  assert.equal(bridge.status().closed, true);
  assert.equal(bridge.status().dirty, false);
  await assert.rejects(bridge.request(9191, queryBody()), /尚未就绪/);
});
