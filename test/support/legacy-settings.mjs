import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Fixtures for checking that unrelated account changes preserve old settings.
export async function writeLegacyMakeupSetting(root, account) {
  const folder = join(root, 'settings');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `account-${account}.json`), '{"freeMakeup":true}\n');
}

export async function readLegacyMakeupSetting(root, account) {
  const text = await readFile(join(root, 'settings', `account-${account}.json`), 'utf8');
  return JSON.parse(text).freeMakeup;
}
