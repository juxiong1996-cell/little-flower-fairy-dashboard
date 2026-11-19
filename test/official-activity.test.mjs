import test from 'node:test';
import assert from 'node:assert/strict';
import { createOfficialActivity } from '../src/game/official-activity.mjs';
import { createProtocol } from '../src/game/official-protocol.mjs';
import { runActivity } from '../src/game/activity.mjs';
import { queryLiveSignedDays } from '../src/game/sign-progress.mjs';

const codec = createProtocol();
const words = values => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v, i * 4)); return b; };
function fixture({ days = [], update = true, status = 0, replyRole = 1234 } = {}) {
  const calls = [];
  let opened = 0, closed = 0;
  const adapter = createOfficialActivity({
    readCalendar: async () => ({ current: { id: 11, today: 6, totalDays: 56 } }),
    openSession: async () => {
      opened++;
      return {
        close: async () => { closed++; },
        async request(command, body) {
          const values = Array.from({ length: body.length / 4 }, (_, i) => new DataView(body.buffer).getUint32(i * 4));
          calls.push([command, values]);
          if (command === 9192 && update && !days.includes(values[1])) days.push(values[1]);
          const plain = words(command === 9191 ? [0, 0, days.length, ...days, 0] : [1, 1, 300022, 5]);
          const encoded = codec.encryptBody(plain);
          const packet = Buffer.alloc(17 + encoded.length);
          packet.writeUInt32BE(packet.length); packet.writeUInt32BE(command, 5);
          packet.writeUInt32BE(replyRole, 9); packet.writeInt32BE(status, 13); packet.set(encoded, 17);
          return { role: 1234, packet: [...packet], at: '2026-11-18T15:30:00.000Z' };
        },
      };
    },
  });
  return { adapter, calls, counts: () => [opened, closed] };
}

test('查询每次请求官方9191，显示零天和今日未签', async () => {
  const { adapter, calls, counts } = fixture();
  const result = await queryLiveSignedDays(adapter, 'unit');
  assert.deepEqual([result.source, result.basis, result.signedCount, result.todaySigned], ['live', 'official-api', 0, false]);
  await queryLiveSignedDays(adapter, 'unit');
  assert.deepEqual(calls, [[9191, [11]], [9191, [11]]]);
  assert.deepEqual(counts(), [2, 2]);
});
test('一次签到复用连接：查询、今日9192、重新查询确认；再次点击只查询', async () => {
  const { adapter, calls, counts } = fixture();
  const first = await adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'sign'));
  assert.deepEqual(first.verified, ['第 6 天签到']);
  assert.equal(first.progress.todaySigned, true);
  assert.equal(first.progress.signedCount, 1);
  const second = await adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'sign'));
  assert.equal(second.alreadySigned, true);
  assert.deepEqual(second.verified, []);
  assert.deepEqual(calls, [[9191, [11]], [9192, [11, 6]], [9191, [11]], [9191, [11]]]);
  assert.deepEqual(counts(), [2, 2]);
});
test('收到成功回复但复查没有今日日期，禁止报告签到成功', async () => {
  const { adapter, counts } = fixture({ update: false });
  await assert.rejects(adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'sign')), /待核实.*签到/);
  assert.deepEqual(counts(), [1, 1]);
});
test('非零官方状态和超出日期的回复均报错，关闭连接', async () => {
  const failed = fixture({ status: 7 });
  await assert.rejects(queryLiveSignedDays(failed.adapter, 'unit'), /状态码 7/);
  assert.deepEqual(failed.counts(), [1, 1]);
  const future = fixture({ days: [7] });
  await assert.rejects(queryLiveSignedDays(future.adapter, 'unit'), /超出本期范围/);
});
test('日期或账号上下文不匹配时不发出签到请求', async () => {
  const { adapter, calls } = fixture();
  await adapter.withAccount('unit', async () => {
    const state = await adapter.getProgress('unit');
    await assert.rejects(adapter.signToday({ account: 'unit', role: state.role + 1, season: 11, today: 6, target: 6, maxCost: 0 }), /账号或活动日期已变化/);
  });
  assert.deepEqual(calls, [[9191, [11]]]);
});

function rewardFixture({ days = [], claimed = 0, update = true, medalId = 3000132796,
    medalRole = 1234, claimStatus = 0 } = {}) {
  const calls = [];
  const season = { id: 11, today: 6, totalDays: 56, rewardConfig: {
    medal: 3000132796, vipMedal: 3000135243,
    items: [{ tableId: 57, index: 1, need: 1 }, { tableId: 58, index: 2, need: 3 }, { tableId: 59, index: 3, need: 7 }],
  } };
  const adapter = createOfficialActivity({
    readCalendar: async () => ({ current: season }),
    openSession: async () => ({ close: async () => {}, async request(command, body, options) {
      const values = Array.from({ length: body.length / 4 }, (_, i) => new DataView(body.buffer, body.byteOffset).getUint32(i * 4));
      calls.push({ command, values, expectedRole: options?.expectedRole });
      let plain;
      if (command === 9191) plain = words([0, 0, days.length, ...days, 0]);
      else if (command === 2916) plain = words([1, medalId, claimed, 1731945600, 0]);
      else if (command === 9192) {
        if (!days.includes(values[1])) days.push(values[1]);
        plain = words([1, 1, 300022, 5]);
      } else if (command === 9195) {
        if (update && claimStatus === 0) claimed = (claimed | 1 << (values[1] - 1)) >>> 0;
        plain = words([1, 300022, 100]);
      } else throw new Error('unexpected command');
      const encoded = codec.encryptBody(plain), packet = Buffer.alloc(17 + encoded.length);
      packet.writeUInt32BE(packet.length); packet.writeUInt32BE(command, 5);
      packet.writeInt32BE(command === 9195 ? claimStatus : 0, 13); packet.set(encoded, 17);
      return { role: command === 2916 ? medalRole : 1234, packet: [...packet], at: '2026-11-18T15:40:00.000Z' };
    } }),
  });
  return { adapter, calls, season };
}

test('累计礼盒按2916第二个字段的位和签到天数判断，不使用表行ID或Flag', async () => {
  const { adapter, calls } = rewardFixture({ days: [6], claimed: 4 });
  const state = await adapter.getProgress('unit');
  assert.deepEqual(state.rewards, [
    { id: 1, need: 1, state: 'available' }, { id: 2, need: 3, state: 'locked' }, { id: 3, need: 7, state: 'claimed' },
  ]);
  assert.deepEqual(calls.map(c => [c.command, c.values]), [[9191, [11]], [2916, [1, 3000132796]]]);
  assert.equal(calls[1].expectedRole, 1234);
});

test('签到领奖先签到，再用9195领取档次，重查领取位；重复点击不会重复领', async () => {
  const { adapter, calls } = rewardFixture();
  const first = await adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'all'));
  assert.deepEqual(first.verified, ['第 6 天签到', '领取礼盒 1']);
  assert.equal(first.progress.todaySigned, true);
  assert.deepEqual(calls.map(c => c.command), [9191, 2916, 9192, 9191, 2916, 9195, 9191, 2916]);
  assert.deepEqual(calls.find(c => c.command === 9195), { command: 9195, values: [11, 1], expectedRole: 1234 });
  const second = await adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'all'));
  assert.deepEqual(second.verified, []);
  assert.equal(calls.filter(c => c.command === 9195).length, 1);
});

test('领奖返回物品但新查询的领取位未更新时停止，不报告成功或再次发送', async () => {
  const { adapter, calls } = rewardFixture({ days: [6], update: false });
  await assert.rejects(adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'all')), /待核实.*礼盒 1.*尚未确认/);
  assert.equal(calls.filter(c => c.command === 9195).length, 1);
});

test('礼盒标记缺失、期数不符或角色变化时不发送领奖', async () => {
  for (const config of [{ medalId: 3000132797 }, { medalRole: 5678 }]) {
    const { adapter, calls } = rewardFixture({ days: [6], ...config });
    await assert.rejects(adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'all')), /标记|账号请求/);
    assert.equal(calls.some(c => c.command === 9195 || c.command === 9192), false);
  }
});

test('拒绝错误档次、未解锁礼盒、付费上下文和活动变化', async () => {
  const { adapter, calls, season } = rewardFixture({ days: [6] });
  await adapter.withAccount('unit', async () => {
    const state = await adapter.getProgress('unit');
    const context = { account: 'unit', role: state.role, season: state.season, today: state.today, target: 1, maxCost: 0 };
    await assert.rejects(adapter.claimReward({ ...context, target: 57 }), /礼盒活动已变化/);
    await assert.rejects(adapter.claimReward({ ...context, target: 2 }), /尚未达到/);
    await assert.rejects(adapter.claimReward({ ...context, maxCost: 1 }), /必须为免费/);
    season.today++;
    await assert.rejects(adapter.claimReward(context), /礼盒活动已变化/);
  });
  assert.equal(calls.some(c => c.command === 9195), false);
});

test('官方领奖错误保留待核实说明，缺少礼盒配置时不先签到', async () => {
  const { adapter, calls } = rewardFixture({ days: [6], claimStatus: 7 });
  await assert.rejects(adapter.withAccount('unit', () => runActivity(adapter, 'unit', 'all')), /待核实.*官方领奖返回状态码 7/);
  assert.equal(calls.filter(c => c.command === 9195).length, 1);
  const missing = fixture();
  await assert.rejects(missing.adapter.withAccount('unit', () => runActivity(missing.adapter, 'unit', 'all')), /领取状态未知/);
  assert.deepEqual(missing.calls, [[9191, [11]]]);
});
