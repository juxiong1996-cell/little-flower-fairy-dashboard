import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const validAccount = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function normalize(account) {
  if (typeof account !== 'string' || !validAccount.test(account)) fail(400, '账号别名格式无效');
  return account.toLowerCase();
}

export function createAccountStore(root, profiles = join(root, 'profiles')) {
  const removed = join(root, 'removed-accounts');
  const marker = account => join(removed, `account-${account}`);

  async function list() {
    await mkdir(profiles, { recursive: true });
    const dirs = await readdir(profiles, { withFileTypes: true });
    const hidden = new Set(await readdir(removed).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    }));
    return dirs.filter(dir => dir.isDirectory() && dir.name.startsWith('account-') && !hidden.has(dir.name))
      .map(dir => dir.name.slice(8)).filter(account => validAccount.test(account))
      .sort((a, b) => Number(b === 'main') - Number(a === 'main') || a.localeCompare(b));
  }

  async function add(name) {
    const account = normalize(name);
    if ((await list()).includes(account)) fail(409, '这个账号别名已经存在');
    await mkdir(join(profiles, `account-${account}`), { recursive: true });
    // Reusing an alias restores its existing login data and preferences.
    await unlink(marker(account)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    return account;
  }

  async function remove(name) {
    const account = normalize(name);
    if (!(await list()).includes(account)) fail(404, '账号不存在');
    await mkdir(removed, { recursive: true });
    // Keep the browser profile intact, including while its game window is open.
    await writeFile(marker(account), '', { flag: 'wx' });
    return account;
  }

  return { list, add, remove };
}
