import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_MAX_CONCURRENT = 5;

export function validateMaxConcurrent(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw Object.assign(new Error('最多同时处理的账号数必须是大于或等于 1 的整数'), { status: 400 });
  }
  return value;
}

function validate(value) {
  const maximum = value && typeof value === 'object' && !Array.isArray(value) ? value.maxConcurrent : undefined;
  return { maxConcurrent: validateMaxConcurrent(maximum) };
}

export async function createBatchController({ root }) {
  const file = join(root, 'batch-settings.json');
  let config = { maxConcurrent: DEFAULT_MAX_CONCURRENT };
  let lastError = null;
  try { config = validate(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      lastError = `并行设置读取失败，已使用默认 ${DEFAULT_MAX_CONCURRENT} 个账号，请重新保存：${error.message}`;
    }
  }

  let active = 0;
  let updates = Promise.resolve();
  const queue = [];
  const getSettings = () => ({ ...config, ...(lastError ? { lastError } : {}) });

  function drain() {
    while (active < config.maxConcurrent && queue.length) {
      const { action, resolve, reject } = queue.shift();
      active++;
      // Each account keeps its slot until the complete operation settles.
      Promise.resolve().then(action).then(value => {
        active--;
        drain();
        resolve(value);
      }, error => {
        active--;
        drain();
        reject(error);
      });
    }
  }

  async function save(next) {
    await mkdir(root, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  return {
    getSettings,
    update(value) {
      let next;
      try { next = validate(value); }
      catch (error) { return Promise.reject(error); }
      const operation = updates.catch(() => {}).then(async () => {
        await save(next);
        config = next;
        lastError = null;
        drain();
        return getSettings();
      });
      updates = operation;
      return operation;
    },
    run(action) {
      if (typeof action !== 'function') return Promise.reject(new TypeError('缺少账号操作'));
      return new Promise((resolve, reject) => {
        queue.push({ action, resolve, reject });
        drain();
      });
    },
  };
}
