import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

function validate(value) {
  const { enabled, time } = value ?? {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof enabled !== 'boolean' ||
      typeof time !== 'string' || time.length !== 5 || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw Object.assign(new Error('请选择是否开启定时签到，并设置有效的每日时间（00:00–23:59）'), { status: 400 });
  }
  return { enabled, time };
}

function nextDailyTime(current, time) {
  const [hours, minutes] = time.split(':').map(Number);
  const shifted = new Date(current + BEIJING_OFFSET);
  const today = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), hours, minutes) - BEIJING_OFFSET;
  return today > current ? today : today + DAY;
}

export async function createDailyScheduler({ root, runBatch, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof runBatch !== 'function') throw new Error('定时签到缺少批量签到操作');
  const file = join(root, 'daily-sign-schedule.json');
  let config = { enabled: false, time: '09:00' };
  let lastRun = null, lastError = null, settingsReadError = false;
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    config = validate(saved);
    lastRun = saved.lastRun ?? null;
    lastError = typeof saved.lastError === 'string' ? saved.lastError : null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      settingsReadError = true;
      lastError = `定时签到设置读取失败，已关闭定时签到，请重新保存：${error.message}`;
    }
  }

  let started = false, running = false, timer = null, nextRunAt = null;
  let generation = 0;
  let updates = Promise.resolve();

  function getStatus() {
    return { ...config, timeZone: 'Asia/Shanghai', running, nextRunAt,
      lastRun: lastRun === null ? null : structuredClone(lastRun), lastError };
  }
  function cancelTimer() {
    generation++;
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextRunAt = null;
  }
  async function save(nextConfig = config, nextRun = lastRun, nextError = lastError) {
    await mkdir(root, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ ...nextConfig, lastRun: nextRun, lastError: nextError }) + '\n', { flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  function enqueue(action) {
    const operation = updates.catch(() => {}).then(action);
    updates = operation;
    return operation;
  }
  function arm() {
    cancelTimer();
    if (!started || !config.enabled || running) return;
    const due = nextDailyTime(Number(now()), config.time);
    nextRunAt = new Date(due).toISOString();
    const expectedGeneration = generation;
    timer = setTimer(() => execute(expectedGeneration), Math.max(0, due - Number(now())));
    timer?.unref?.();
  }
  async function execute(expectedGeneration) {
    if (expectedGeneration !== generation || !started || !config.enabled || running) return;
    timer = null;
    nextRunAt = null;
    running = true;
    let result = null, failure = null;
    try { result = await runBatch(); }
    catch (error) { failure = error?.message || String(error); }
    try {
      await enqueue(async () => {
        if (!failure) lastRun = result ?? null;
        lastError = failure;
        await save();
      });
    } catch (error) {
      lastError = [failure, `定时签到记录保存失败：${error.message || String(error)}`].filter(Boolean).join('。');
    } finally {
      running = false;
      arm();
    }
  }
  return {
    start() { if (!started) { started = true; arm(); } return getStatus(); },
    stop() { started = false; cancelTimer(); return getStatus(); },
    getStatus,
    update(value) {
      let next;
      try { next = validate(value); }
      catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const nextError = settingsReadError ? null : lastError;
        await save(next, lastRun, nextError);
        config = next;
        lastError = nextError;
        settingsReadError = false;
        arm();
        return getStatus();
      });
    },
  };
}
