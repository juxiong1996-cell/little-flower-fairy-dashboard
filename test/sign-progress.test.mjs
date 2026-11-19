import test from 'node:test';
import assert from 'node:assert/strict';
import { queryLiveSignedDays } from '../src/game/sign-progress.mjs';

test('每次查询都读取服务的新进度，真实零天与未知有区别', async () => {
  let calls = 0;
  const adapter = {
    async getProgress(account) {
      return { account, role: 'a', season: 11, signedDays: calls++ === 0 ? [] : [6], today: 6, totalDays: 56 };
    },
  };
  const first = await queryLiveSignedDays(adapter, 'unit');
  assert.equal(first.source, 'live');
  assert.equal(first.signedCount, 0);
  const second = await queryLiveSignedDays(adapter, 'unit');
  assert.equal(second.source, 'live');
  assert.equal(second.signedCount, 1);
  assert.equal(second.todaySigned, true);
  assert.equal(calls, 2);
});

test('没有实时接口时直接报错，不返回本机记录', async () => {
  await assert.rejects(queryLiveSignedDays(null, 'unit'), { status: 503 });
});

test('再次查询失败时不回退到上次成功的结果', async () => {
  let calls = 0;
  const adapter = {
    async getProgress(account) {
      if (calls++ > 0) throw new Error('连接失败');
      return { account, role: 'a', season: 11, signedDays: [6], today: 6, totalDays: 56 };
    },
  };
  assert.equal((await queryLiveSignedDays(adapter, 'unit')).signedCount, 1);
  await assert.rejects(queryLiveSignedDays(adapter, 'unit'), /连接失败/);
});
