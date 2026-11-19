import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const writes = new Map();
const invalidCharacters = /[\p{Cc}\p{Cf}]/u;

function fail(message) { throw Object.assign(new Error(message), { status: 400 }); }
function location(root, account) {
  if (typeof account !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(account)) fail('账号标识无效');
  return resolve(join(root, 'account-names', `account-${account}.json`));
}
function customName(value) {
  if (typeof value !== 'string') fail('请输入账号名称');
  const name = value.trim();
  if (Array.from(name).length > 32 || invalidCharacters.test(name)) fail('账号名称最多 32 个字，不能包含换行或控制字符');
  return name;
}
export { customName as validateAccountName };
function safeAccountName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || Array.from(name).length > 32 || invalidCharacters.test(name)) return '';
  // Some login providers put the mobile number in the account-name field.
  return name.replace(/(?<!\d)(?:\+?86[ -]?)?(1[3-9]\d{9})(?!\d)/g,
    (_, phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`);
}
function safePhone(value) {
  if (typeof value !== 'string') return '';
  const phone = value.trim().replace(/[ ()-]/g, '');
  if (/^\+?\d{7,15}$/.test(phone)) {
    const digits = phone.replace(/^\+/, '');
    const local = /^(?:86)?1[3-9]\d{9}$/.test(digits) ? digits.slice(-11) : digits;
    return local.length >= 11 ? `${local.slice(0, 3)}****${local.slice(-4)}` : `${local.slice(0, 2)}****${local.slice(-2)}`;
  }
  // Only retain a partially hidden number; arbitrary provider text is discarded.
  return /^\+?\d{1,5}\*{3,10}\d{1,4}$/.test(phone) ? phone : '';
}
function storedRecord(data) {
  return {
    customName: typeof data?.customName === 'string' ? customName(data.customName) : '',
    accountName: safeAccountName(data?.accountName),
    maskedPhone: safePhone(data?.maskedPhone),
  };
}
function view(account, record) {
  const nameSource = record.customName ? 'custom' : record.accountName ? 'account' : record.maskedPhone ? 'phone' : 'fallback';
  const displayName = record.customName || record.accountName || record.maskedPhone || account;
  return { displayName, ...record, nameSource };
}
async function readRecord(file) {
  try { return storedRecord(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (error.code === 'ENOENT') return storedRecord(null);
    throw error;
  }
}
async function writeRecord(file, record) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function mutate(file, account, change) {
  const previous = writes.get(file) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const current = await readRecord(file);
    const next = change(current);
    if (JSON.stringify(current) !== JSON.stringify(next)) await writeRecord(file, next);
    return view(account, next);
  });
  writes.set(file, operation);
  try { return await operation; }
  finally { if (writes.get(file) === operation) writes.delete(file); }
}

export async function readAccountName(root, account) {
  const file = location(root, account);
  await writes.get(file)?.catch(() => {});
  return view(account, await readRecord(file));
}

export async function setAccountName(root, account, displayName) {
  const file = location(root, account);
  const name = customName(displayName);
  return mutate(file, account, current => ({ ...current, customName: name }));
}

export async function rememberAccountIdentity(root, account, identity) {
  const file = location(root, account);
  const accountName = safeAccountName(identity?.accountName);
  const maskedPhone = safePhone(identity?.maskedPhone);
  // A successful observation describes one login identity. Replacing both fields
  // avoids combining a new phone-only login with a previous user's account name.
  return mutate(file, account, current => accountName || maskedPhone
    ? { ...current, accountName, maskedPhone }
    : current);
}
