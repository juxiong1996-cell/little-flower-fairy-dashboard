import assert from 'node:assert/strict';
import test from 'node:test';
import { createCalendarReader, parseDoubleSignCalendar } from '../src/game/calendar.mjs';

const int = value => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; };
const byte = value => Buffer.from([value]);
function text(value = '') {
  if (!value) return Buffer.alloc(2);
  const data = Buffer.from(value), length = [];
  for (let n = data.length; ; n >>>= 7) {
    length.push((n & 127) | (n >= 128 ? 128 : 0));
    if (n < 128) break;
  }
  return Buffer.concat([Buffer.from([1, 0]), Buffer.from(length), data]);
}
function table(suffix, rows) {
  const name = Buffer.from('DoubleSignin_DoubleSignin_Month' + suffix);
  const header = Buffer.concat([int(name.length), name]);
  const data = Buffer.concat([int(rows.length), ...rows]);
  const result = Buffer.concat([header, Buffer.alloc((4 - header.length % 4) % 4), int(data.length), data]);
  return Buffer.concat([result, Buffer.alloc((4 - result.length % 4) % 4)]);
}
const cat = (...parts) => Buffer.concat(parts);
const now = Date.parse('2026-11-18T15:30:00+08:00');
// The current official configuration uses table rows 57..63 and reward
// indexes 1..7. They must not be replaced with the day thresholds.
const capturedItems = [1, 3, 7, 13, 20, 28, 40].map((need, i) => ({ tableId: 57 + i, index: i + 1, need }));
function fixture({ items = capturedItems, group = 11 } = {}) {
  const start = '2026-11-13 00:00:00';
  const end = '2027-01-07 23:59:59';
  const dates = Array.from({ length: 56 }, (_, i) => {
    const date = new Date(Date.parse('2026-11-13T00:00:00Z') + i * 86400000).toISOString().slice(0, 10);
    return cat(int(100 + i), int(11), byte(i + 1), int(0), int(0), text(), text(), text(), text(), text(date + ' 00:00:00'), text());
  });
  return cat(
    table('', [cat(int(11), byte(11), text(start), text(end), text(), text(), Buffer.alloc(2))]),
    table('_Day', [cat(int(11), int(11), byte(5), int(3000132796))]),
    table('_Day_DayItem', dates),
    table('_AccumulateReward', [cat(int(group), int(11), int(3000132796), int(3000135243))]),
    table('_AccumulateReward_AccumulateRewardItem', items.map(item =>
      cat(int(item.tableId), int(11), byte(item.index), text('177158/1'), byte(item.need), text('领取累计登陆奖励'), text()))),
  );
}

test('保留官方累计奖励的表ID、档次、门槛和普通/VIP勋章配置', () => {
  const season = parseDoubleSignCalendar(fixture(), now);
  assert.equal(season.id, 11);
  assert.equal(season.today, 6);
  assert.equal(season.totalDays, 56);
  assert.deepEqual(season.milestones, [1, 3, 7, 13, 20, 28, 40]);
  assert.deepEqual(season.rewardConfig, { medal: 3000132796, vipMedal: 3000135243, items: capturedItems });
});

test('没有进行中的活动时返回null', () => {
  assert.equal(parseDoubleSignCalendar(fixture(), Date.parse('2026-11-12T23:59:59+08:00')), null);
  assert.equal(parseDoubleSignCalendar(fixture(), Date.parse('2027-01-08T00:00:00+08:00')), null);
});

test('奖励档次排序不会把领取序号替换为天数门槛', () => {
  const season = parseDoubleSignCalendar(fixture({ items: [...capturedItems].reverse() }), now);
  assert.deepEqual(season.rewardConfig.items, capturedItems);
  assert.equal(season.rewardConfig.items[1].index, 2);
  assert.equal(season.rewardConfig.items[1].need, 3);
});

test('重复档次或表ID、零门槛和超出活动天数的奖励配置不能进入领取流程', () => {
  for (const invalid of [
    { ...capturedItems[1], index: 1 },
    { ...capturedItems[1], tableId: 57 },
    { ...capturedItems[1], need: 0 },
    { ...capturedItems[1], need: 57 },
  ]) {
    const items = [capturedItems[0], invalid, ...capturedItems.slice(2)];
    assert.throws(() => parseDoubleSignCalendar(fixture({ items }), now), /累计奖励档次无效/);
  }
  assert.throws(() => parseDoubleSignCalendar(fixture({ group: 12 }), now), /累计奖励档次无效/);
});

test('并发查询共享官方资源下载，后续查询在五分钟内复用资源', async () => {
  let clock = now, downloads = 0, finish;
  const held = new Promise(resolve => { finish = resolve; });
  const read = createCalendarReader({
    now: () => clock,
    loadData: async () => { downloads++; await held; return { version: '2026-11-18-1', data: fixture() }; },
  });
  const first = read(), second = read();
  await Promise.resolve();
  assert.equal(downloads, 1);
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].version, '2026-11-18-1');
  assert.deepEqual(results[0], results[1]);
  clock += 299_999;
  await read();
  assert.equal(downloads, 1);
  clock++;
  await read();
  assert.equal(downloads, 2, '缓存到期重新读取官方配置');
});

test('缓存跨北京时间午夜时重新计算活动日期且返回值不能污染下次查询', async () => {
  let clock = Date.parse('2026-11-18T23:59:00+08:00'), downloads = 0;
  const read = createCalendarReader({
    now: () => clock,
    loadData: async () => { downloads++; return { version: '2026-11-18-1', data: fixture() }; },
  });
  const before = await read();
  assert.equal(before.current.today, 6);
  before.current.today = 99;
  before.current.rewardConfig.items[0].need = 99;
  clock = Date.parse('2026-11-19T00:01:00+08:00');
  const after = await read();
  assert.equal(after.current.today, 7);
  assert.equal(after.current.rewardConfig.items[0].need, 1);
  assert.equal((await read(Date.parse('2026-11-18T20:00:00+08:00'))).current.today, 6);
  assert.equal(downloads, 1);
});

test('资源下载失败后共享查询均失败，下次可重新下载', async () => {
  let downloads = 0;
  const failure = new Error('官方资源下载超时');
  const read = createCalendarReader({
    now: () => now,
    loadData: async () => { if (++downloads === 1) throw failure; return { version: '2026-11-18-1', data: fixture() }; },
  });
  const results = await Promise.allSettled([read(), read()]);
  assert.equal(downloads, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === failure));
  assert.equal((await read()).current.today, 6);
  assert.equal(downloads, 2);
});

test('官方表解析失败后也允许重新下载，不缓存损坏数据', async () => {
  let downloads = 0;
  const read = createCalendarReader({
    now: () => now,
    loadData: async () => ({ version: '2026-11-18-1', data: ++downloads === 1 ? fixture({ group: 12 }) : fixture() }),
  });
  await assert.rejects(read(), /累计奖励档次无效/);
  assert.equal((await read()).current.today, 6);
  assert.equal(downloads, 2);
});
