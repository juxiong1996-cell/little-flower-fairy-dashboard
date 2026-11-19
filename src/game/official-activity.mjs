import { readDoubleSignCalendar } from './calendar.mjs';
import { openActivitySession } from './official-session.mjs';
import { createProtocol } from './official-protocol.mjs';

function fail(message, status = 502) { throw Object.assign(new Error(message), { status }); }
function words(...values) {
  const data = new Uint8Array(values.length * 4);
  const view = new DataView(data.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return data;
}

export function createOfficialActivity({ openSession = openActivitySession, readCalendar = readDoubleSignCalendar } = {}) {
  const codec = createProtocol();
  const sessions = new Map();
  const latest = new Map();
  async function withAccount(account, action) {
    if (sessions.has(account)) throw new Error('该账号正在操作，请稍候');
    const session = await openSession(account);
    sessions.set(account, session);
    try { return await action(); }
    finally { sessions.delete(account); latest.delete(account); await session.close(); }
  }
  async function using(account, action) {
    if (sessions.has(account)) return action(sessions.get(account));
    return withAccount(account, () => action(sessions.get(account)));
  }
  async function calendar() {
    const { current } = await readCalendar();
    if (!current?.today) fail('当前没有进行中的双生签到活动', 409);
    return current;
  }
  function response(raw, command, role) {
    const frame = codec.decodeResponse(new Uint8Array(raw.packet));
    if (frame.command !== command || !raw.role || role !== undefined && raw.role !== role) fail('官方回复与本次账号请求不一致');
    if (frame.status !== 0) fail('官方' + (command === 9195 ? '领奖' : command === 9192 ? '签到' : '查询') + '返回状态码 ' + frame.status);
    return frame;
  }
  function rewardConfig(season) {
    const config = season.rewardConfig;
    if (!config || !Number.isInteger(config.medal) || config.medal <= 0 || config.medal > 0xffffffff ||
        !Array.isArray(config.items) || !config.items.length || config.items.some((item, position) =>
          !Number.isInteger(item.index) || item.index !== position + 1 || item.index > 32 ||
          !Number.isInteger(item.need) || item.need < 1 || item.need > season.totalDays) ||
        new Set(config.items.map(item => item.index)).size !== config.items.length) {
      fail('本期累计礼盒配置无效，请重新读取活动日历');
    }
    return config;
  }
  const adapter = {
    withAccount,
    async getProgress(account) {
      return using(account, async session => {
        const season = await calendar();
        const raw = await session.request(9191, words(season.id));
        const frame = response(raw, 9191);
        const progress = codec.parseProgress(frame.body);
        const signedDays = progress.signedDays;
        if (!Array.isArray(signedDays) || signedDays.some(day => day < 1 || day > season.today)) fail('官方签到日期超出本期范围');
        let rewards, rewardMedal, at = raw.at;
        if (season.rewardConfig) {
          const config = rewardConfig(season);
          const flagsRaw = await session.request(2916, words(1, config.medal), { expectedRole: raw.role });
          const flags = codec.parseMedals(response(flagsRaw, 2916, raw.role).body);
          if (flags.length !== 1 || flags[0].id !== config.medal) fail('官方礼盒领取标记与本期活动不一致');
          rewardMedal = config.medal;
          rewards = config.items.map(({ index, need }) => ({ id: index, need,
            state: (flags[0].value >>> (index - 1)) & 1 ? 'claimed' : signedDays.length >= need ? 'available' : 'locked' }));
          at = flagsRaw.at;
        }
        const state = { account, role: raw.role, season: season.id, today: season.today,
          totalDays: season.totalDays, signedDays, at, basis: 'official-api',
          ...(rewards ? { rewards, rewardMedal } : {}) };
        latest.set(account, state);
        return state;
      });
    },
    async signToday(context) {
      if (context.maxCost !== 0) fail('今日签到必须为免费操作', 400);
      return using(context.account, async session => {
        const season = await calendar();
        const before = latest.get(context.account);
        if (!before || before.role !== context.role || before.season !== context.season || before.today !== context.today ||
            season.id !== context.season || season.today !== context.target || context.target !== context.today) {
          fail('账号或活动日期已变化，请重新查询后再签到', 409);
        }
        if (before.signedDays.includes(context.today)) return;
        const raw = await session.request(9192, words(season.id, season.today), { expectedRole: context.role });
        const frame = response(raw, 9192, context.role);
        const sign = codec.parseSign(frame.body);
        if (!sign.success) fail('官方服务器未确认今日签到，请重新查询');
      });
    },
    async claimReward(context) {
      if (context.maxCost !== 0) fail('领取签到礼盒必须为免费操作', 400);
      return using(context.account, async session => {
        const season = await calendar();
        const config = rewardConfig(season);
        const before = latest.get(context.account);
        const item = config.items.find(item => item.index === context.target);
        const reward = before?.rewards?.find(reward => reward.id === context.target);
        if (!before || before.role !== context.role || before.season !== context.season || before.today !== context.today ||
            season.id !== context.season || season.today !== context.today || before.rewardMedal !== config.medal ||
            !item || !reward || item.need !== reward.need) {
          fail('账号或礼盒活动已变化，请重新查询后再领奖', 409);
        }
        if (reward.state === 'claimed') return;
        if (reward.state !== 'available' || before.signedDays.length < item.need) fail('尚未达到这个礼盒的签到天数', 409);
        const raw = await session.request(9195, words(season.id, item.index), { expectedRole: context.role });
        codec.parseReward(response(raw, 9195, context.role).body);
        // The award list alone is not proof of receipt. runActivity re-queries
        // 2916 and requires this reward's bit to be set before reporting success.
      });
    },
  };
  return adapter;
}

export default createOfficialActivity();
