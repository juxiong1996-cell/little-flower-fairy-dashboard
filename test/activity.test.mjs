import test from 'node:test';
import assert from 'node:assert/strict';
import { activityCapabilities, runActivity } from '../src/game/activity.mjs';

function fixture() {
  const state = { account: 'unit', role: 'role-a', season: 11, today: 4, totalDays: 56,
    signedDays: [1], rewards: [{ id: 'gift', state: 'locked' }] };
  const calls = [];
  function write(op, request) {
    assert.equal(request.account, state.account);
    assert.equal(request.maxCost, 0);
    assert.equal(request.role, state.role);
    calls.push([op, request.target]);
  }
  const adapter = {
    async getProgress() { return structuredClone(state); },
    async signToday(request) { write('sign', request); state.signedDays.push(request.target); },
    async claimReward(request) { write('claim', request); state.rewards[0].state = 'claimed'; },
  };
  return { state, adapter, calls };
}

test('先签当天，再领刚解锁的礼盒；重复运行无操作', async () => {
  const { adapter, state, calls } = fixture();
  const signToday = adapter.signToday;
  adapter.signToday = async request => {
    await signToday(request);
    state.rewards[0].state = 'available';
  };
  const result = await runActivity(adapter, 'unit');
  assert.deepEqual(calls, [['sign', 4], ['claim', 'gift']]);
  assert.deepEqual(result.verified, ['第 4 天签到', '领取礼盒 gift']);
  assert.equal(result.signedCount, 2);
  assert.deepEqual((await runActivity(adapter, 'unit')).verified, []);
});

test('当天已签时仍领取已解锁礼盒', async () => {
  const { adapter, state, calls } = fixture();
  state.signedDays.push(4);
  state.rewards[0].state = 'available';
  await runActivity(adapter, 'unit');
  assert.deepEqual(calls, [['claim', 'gift']]);
});

test('无法确认签到时停止后续操作', async () => {
  const { adapter, state, calls } = fixture();
  state.rewards[0].state = 'available';
  adapter.signToday = () => calls.push(['sign', 4]);
  await assert.rejects(runActivity(adapter, 'unit'), /待核实.*签到/);
  assert.deepEqual(calls, [['sign', 4]]);
});

test('角色在签到后切换时停止', async () => {
  const { adapter, state, calls } = fixture();
  const realSign = adapter.signToday;
  adapter.signToday = async req => { await realSign(req); state.role = 'role-b'; };
  await assert.rejects(runActivity(adapter, 'unit'), /角色或活动日期已变化/);
  assert.equal(calls.length, 1);
});

test('缺少服务连接时返回未接入', async () => {
  await assert.rejects(runActivity(null, 'unit'), { status: 503 });
});

test('只签当天，无需礼盒服务，并能重复执行', async () => {
  const { adapter, state, calls } = fixture();
  delete state.rewards;
  delete adapter.claimReward;
  assert.equal((await runActivity(adapter, 'unit', 'sign')).signedCount, 2);
  const repeated = await runActivity(adapter, 'unit', 'sign');
  assert.deepEqual(repeated.verified, []);
  assert.equal(repeated.alreadySigned, true);
  assert.deepEqual(calls, [['sign', 4]]);
});

test('能力只包括查询、今日签到和领奖', () => {
  const { adapter } = fixture();
  assert.deepEqual(activityCapabilities(adapter), { progress: true, sign: true, rewards: true, all: true });
  delete adapter.claimReward;
  assert.equal(activityCapabilities(adapter).all, false);
  assert.equal(activityCapabilities(adapter).rewards, false);
});

test('旧适配器即使带补签方法也不会被调用', async () => {
  const { adapter, state, calls } = fixture();
  adapter.makeUpFree = () => { throw new Error('不能调用已移除的补签功能'); };
  state.rewards[0].state = 'available';
  await runActivity(adapter, 'unit');
  await runActivity(adapter, 'unit', 'sign');
  assert.deepEqual(calls, [['sign', 4], ['claim', 'gift']]);
  assert.deepEqual(state.signedDays, [1, 4]);
  await assert.rejects(runActivity(adapter, 'unit', 'makeup'), /未知签到操作/);
});

test('领奖回复后没有查到已领取状态时停止，避免重复领取', async () => {
  const { adapter, state, calls } = fixture();
  state.signedDays.push(4);
  state.rewards[0].state = 'available';
  adapter.claimReward = async request => { calls.push(['claim', request.target]); };
  await assert.rejects(runActivity(adapter, 'unit'), /待核实 领取礼盒 gift.*尚未确认/);
  assert.deepEqual(calls, [['claim', 'gift']]);
});

test('礼盒状态未知时不发签到或领奖请求', async () => {
  const { adapter, state, calls } = fixture();
  delete state.rewards;
  await assert.rejects(runActivity(adapter, 'unit'), /礼盒领取状态未知/);
  assert.deepEqual(calls, []);
});
