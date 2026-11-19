import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readAccountName, rememberAccountIdentity, setAccountName } from '../src/accounts/account-names.mjs';
import { readLegacyMakeupSetting, writeLegacyMakeupSetting } from './support/legacy-settings.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-account-names-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('中文名称可保存，刷新读取仍在，且不影响补签设置', async t => {
  const root = await fixture(t);
  assert.deepEqual(await readAccountName(root, 'main'), {
    displayName: 'main', customName: '', accountName: '', maskedPhone: '', nameSource: 'fallback',
  });
  await writeLegacyMakeupSetting(root, 'main');
  const saved = await setAccountName(root, 'main', '  我的主号 🌸  ');
  assert.equal(saved.displayName, '我的主号 🌸');
  assert.equal(saved.nameSource, 'custom');
  assert.deepEqual(await readAccountName(root, 'main'), saved);
  assert.equal(await readLegacyMakeupSetting(root, 'main'), true);
});

test('优先使用自定义名，清空后恢复官方名，再按脱敏手机号和内部标识回退', async t => {
  const root = await fixture(t);
  assert.equal((await rememberAccountIdentity(root, 'main', { maskedPhone: '13800138000' })).displayName, '138****8000');
  assert.equal((await readAccountName(root, 'main')).nameSource, 'phone');
  await setAccountName(root, 'main', '花花');
  assert.equal((await rememberAccountIdentity(root, 'main', { accountName: '淘米小花' })).displayName, '花花');
  const reset = await setAccountName(root, 'main', '  ');
  assert.equal(reset.displayName, '淘米小花');
  assert.equal(reset.nameSource, 'account');
  assert.equal((await rememberAccountIdentity(root, 'main', {})).displayName, '淘米小花');
  assert.equal((await setAccountName(root, 'alt1', '')).nameSource, 'fallback');
});

test('自动取得的手机号在名称字段中也脱敏，且只存允许的字段', async t => {
  const root = await fixture(t);
  await rememberAccountIdentity(root, 'main', {
    accountName: '手机 13800138000', maskedPhone: '+86 138-0013-8000', token: 'private-token',
  });
  const text = await readFile(join(root, 'account-names', 'account-main.json'), 'utf8');
  assert.ok(!text.includes('13800138000'));
  assert.ok(!text.includes('0013'));
  assert.ok(!text.includes('private-token'));
  const record = JSON.parse(text);
  assert.deepEqual(record, { customName: '', accountName: '手机 138****8000', maskedPhone: '138****8000' });
  assert.equal((await rememberAccountIdentity(root, 'main', { accountName: '\n', maskedPhone: 'not-a-phone' })).displayName,
    '手机 138****8000');
});

test('切换登录身份时整体替换自动名称，自定义名保留且清空后使用最新身份', async t => {
  const root = await fixture(t);
  await rememberAccountIdentity(root, 'main', { accountName: '米米号123' });
  await setAccountName(root, 'main', '我的花仙');
  const phoneLogin = await rememberAccountIdentity(root, 'main', { maskedPhone: '138****8000' });
  assert.equal(phoneLogin.accountName, '');
  assert.equal(phoneLogin.maskedPhone, '138****8000');
  assert.equal(phoneLogin.displayName, '我的花仙');
  const phoneDefault = await setAccountName(root, 'main', '');
  assert.equal(phoneDefault.displayName, '138****8000');
  assert.equal(phoneDefault.nameSource, 'phone');
  await setAccountName(root, 'main', '我的花仙');
  const accountLogin = await rememberAccountIdentity(root, 'main', { accountName: '米米号456' });
  assert.equal(accountLogin.maskedPhone, '');
  assert.equal(accountLogin.displayName, '我的花仙');
  assert.deepEqual(await rememberAccountIdentity(root, 'main', {}), accountLogin);
  const accountDefault = await setAccountName(root, 'main', '');
  assert.equal(accountDefault.displayName, '米米号456');
  assert.equal(accountDefault.nameSource, 'account');
});

test('并发身份和自定义名称更新保留最新身份与自定义名，多个账号互不覆盖', async t => {
  const root = await fixture(t);
  await Promise.all([
    setAccountName(root, 'main', '我的主号'),
    rememberAccountIdentity(root, 'main', { accountName: '淘米名字' }),
    rememberAccountIdentity(root, 'main', { maskedPhone: '13912345678' }),
    setAccountName(root, 'alt1', '小号'),
  ]);
  const main = await readAccountName(root, 'main');
  assert.equal(main.customName, '我的主号');
  assert.equal(main.accountName, '');
  assert.equal(main.maskedPhone, '139****5678');
  assert.equal(main.nameSource, 'custom');
  assert.equal((await readAccountName(root, 'alt1')).displayName, '小号');
});

test('名称按 Unicode 字符计数，拒绝超长、控制字符与路径穿越', async t => {
  const root = await fixture(t);
  assert.equal((await setAccountName(root, 'main', '🌸'.repeat(32))).displayName, '🌸'.repeat(32));
  for (const value of ['花'.repeat(33), '花\n花', '花\u202e花', null]) {
    await assert.rejects(setAccountName(root, 'main', value), { status: 400 });
  }
  await assert.rejects(setAccountName(root, '../outside', '名称'), { status: 400 });
  await assert.rejects(readAccountName(root, 'MAIN'), { status: 400 });
  assert.equal((await setAccountName(root, 'main', '之后仍能保存')).displayName, '之后仍能保存');
});
