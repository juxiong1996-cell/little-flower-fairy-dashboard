import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountStore } from '../src/accounts/account-store.mjs';
import { readLegacyMakeupSetting, writeLegacyMakeupSetting } from './support/legacy-settings.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-account-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createAccountStore(root) };
}

test('现有账号无需迁移，忽略无效目录并优先显示 main', async t => {
  const { root, store } = await fixture(t);
  for (const name of ['account-alt2', 'account-main', 'account-alt1', 'account-bad.name', 'other']) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
  }
  await writeFile(join(root, 'profiles', 'account-file'), '');
  assert.deepEqual(await store.list(), ['main', 'alt1', 'alt2']);
});

test('移除永久隐藏账号，保留登录资料和补签设置；重新添加恢复原设置', async t => {
  const { root, store } = await fixture(t);
  await store.add('main');
  await store.add('ALT2');
  const profileFile = join(root, 'profiles', 'account-alt2', 'login-data');
  await writeFile(profileFile, 'saved login');
  await writeLegacyMakeupSetting(root, 'alt2');

  assert.equal(await store.remove('ALT2'), 'alt2');
  assert.deepEqual(await store.list(), ['main']);
  assert.deepEqual(await createAccountStore(root).list(), ['main']);
  assert.equal(await readFile(profileFile, 'utf8'), 'saved login');
  assert.equal(await readLegacyMakeupSetting(root, 'alt2'), true);

  assert.equal(await createAccountStore(root).add('ALT2'), 'alt2');
  assert.deepEqual(await store.list(), ['main', 'alt2']);
  assert.equal(await readFile(profileFile, 'utf8'), 'saved login');
  assert.equal(await readLegacyMakeupSetting(root, 'alt2'), true);
  await assert.rejects(stat(join(root, 'removed-accounts', 'account-alt2')), { code: 'ENOENT' });
});

test('重复添加与不存在的账号返回明确错误，最后一个账号也能移除', async t => {
  const { store } = await fixture(t);
  await store.add('main');
  await assert.rejects(store.add('MAIN'), { status: 409 });
  await assert.rejects(store.remove('missing'), { status: 404 });
  await store.remove('main');
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.remove('main'), { status: 404 });
});

test('无效别名不能访问账号目录以外的路径', async t => {
  const { store } = await fixture(t);
  for (const name of [undefined, null, 1, '', '../main', 'a/b', 'a\\b', '-main', 'a'.repeat(33)]) {
    await assert.rejects(store.add(name), { status: 400 });
    await assert.rejects(store.remove(name), { status: 400 });
  }
  assert.deepEqual(await store.list(), []);
});

test('自定义浏览器目录也使用相同的持久移除记录', async t => {
  const { root } = await fixture(t);
  const profiles = join(root, 'browser-profiles');
  const store = createAccountStore(root, profiles);
  await store.add('alt2');
  assert.equal((await stat(join(profiles, 'account-alt2'))).isDirectory(), true);
  await store.remove('alt2');
  assert.deepEqual(await createAccountStore(root, profiles).list(), []);
  await store.add('alt2');
  assert.deepEqual(await store.list(), ['alt2']);
});
