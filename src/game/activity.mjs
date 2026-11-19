import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { liveProgress } from './progress-view.mjs';

// A deployment may supply a local adapter for its authorized activity service.
// All writes must enforce the supplied role, season, day and zero-cost bound on the service side.
export async function loadActivityAdapter(file) {
  if (!file) return null;
  const { default: adapter } = await import(pathToFileURL(resolve(file)).href);
  if (typeof adapter?.getProgress !== 'function') throw new Error('活动接入模块缺少 getProgress');
  return adapter;
}

function guard(condition, message) {
  if (!condition) throw new Error(message);
}
function key(value) {
  return (typeof value === 'string' && value.trim().length > 0) || Number.isSafeInteger(value);
}
export function activityCapabilities(adapter) {
  const progress = typeof adapter?.getProgress === 'function';
  const sign = progress && typeof adapter.signToday === 'function';
  const rewards = progress && typeof adapter.claimReward === 'function';
  return { progress, sign, rewards, all: sign && rewards };
}

function validDays(days, max) {
  return Array.isArray(days) && days.every(d => Number.isInteger(d) && d >= 1 && d <= max) && new Set(days).size === days.length;
}

export function readProgress(p, account, operation = 'progress') {
  guard(p?.account === account && key(p.role) && key(p.season), '无法核对账号、角色或期数');
  guard(Number.isInteger(p.totalDays) && p.totalDays > 0 && p.totalDays <= 366 &&
    Number.isInteger(p.today) && p.today >= 1 && p.today <= p.totalDays, '活动日期无效');
  guard(validDays(p.signedDays, p.today), '签到日期数据无效');
  if (operation === 'all') {
    guard(Array.isArray(p.rewards) && p.rewards.every(r => key(r?.id) && ['locked','available','claimed'].includes(r.state)) &&
      new Set(p.rewards.map(r => r.id)).size === p.rewards.length, '礼盒领取状态未知');
  }
  return p;
}

export async function runActivity(adapter, account, operation = 'all') {
  guard(['all', 'sign'].includes(operation), '未知签到操作');
  const capabilities = activityCapabilities(adapter);
  if (!capabilities[operation]) throw Object.assign(new Error('等待接入双生签到游戏服务'), { status: 503 });
  const progress = async () => readProgress(await adapter.getProgress(account), account, operation);
  let state = await progress();
  const context = { account, role: state.role, season: state.season, today: state.today, maxCost: 0 };
  const verified = [];
  const attempted = new Set();
  let pending = '';
  try {
    for (;;) {
      const reward = operation === 'all' && state.rewards.find(r => r.state === 'available');
      let method, target, description, confirmed;
      if (!state.signedDays.includes(state.today)) {
        method = 'signToday'; target = state.today; description = `第 ${target} 天签到`;
        confirmed = next => next.signedDays.includes(target);
      } else if (reward) {
        method = 'claimReward'; target = reward.id; description = `领取礼盒 ${target}`;
        confirmed = next => next.rewards.some(r => r.id === target && r.state === 'claimed');
      } else {
        return { verified, alreadySigned: operation === 'sign' && verified.length === 0,
          signedCount: state.signedDays.length, totalDays: state.totalDays,
          progress: liveProgress(state, account) };
      }
      const identity = JSON.stringify([method, target]);
      guard(!attempted.has(identity), '游戏返回了重复的待办操作');
      attempted.add(identity);
      pending = description;
      await adapter[method]({ ...context, target, idempotencyKey: JSON.stringify([account, context.role, context.season, method, target]) });
      const next = await progress();
      guard(next.role === context.role && next.season === context.season && next.today === context.today && next.totalDays === state.totalDays, '复查时角色或活动日期已变化');
      guard(confirmed(next), '游戏进度尚未确认这次操作');
      verified.push(description);
      pending = '';
      state = next;
    }
  } catch (error) {
    const message = [verified.length && `已确认 ${verified.join('、')}`, pending && `待核实 ${pending}`, error.message].filter(Boolean).join('。');
    throw Object.assign(new Error(message), { status: 502 });
  }
}
