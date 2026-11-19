import assert from 'node:assert/strict';
import test from 'node:test';
import { readSignTraffic } from '../src/game/sign-traffic.mjs';

function packet(command, size) {
  const data = Buffer.alloc(size);
  data.writeUInt32BE(size, 0);
  data.writeUInt32BE(command, 5);
  return data;
}

test('38 字节的签到回复只能确认收到消息，不能把它当成零天或一天', () => {
  // Only the header and length are known from the 21:15 observation. The synthetic body carries no player data.
  const data = Buffer.concat([packet(30002, 17), packet(9191, 38)]);
  const result = readSignTraffic(data);
  assert.equal(result.heartbeat, true);
  assert.equal(result.signResponse, true);
  assert.equal(result.days, null);
  assert.deepEqual(result.signDiagnostic, { length: 38, status: 0, reason: 'unaligned-body' });
});

test('已知格式的两份日期分别读取，只统计自己的日期', () => {
  const data = packet(9191, 41);
  [0, 0, 1, 5, 1, 2].forEach((value, i) => data.writeUInt32BE(value, 17 + i * 4));
  assert.deepEqual(readSignTraffic(data).days, [5]);
});

test('现有连接的合并帧能区分今日签到、补签和查询回复', () => {
  const sign = packet(9192, 17);
  sign.writeUInt32BE(7, 13);
  const bundle = Buffer.concat([packet(9193, 17), sign, packet(30002, 17)]);
  assert.deepEqual(readSignTraffic(bundle).todaySignReply, { length: 17, status: 7 });
  assert.equal(readSignTraffic(bundle).days, null);
  assert.equal(readSignTraffic(packet(9191, 38)).todaySignReply, null);
});
