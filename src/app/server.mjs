import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, PROFILE_ROOT, checkAccount, showAccountGame, readAccountIdentity, validAccount } from '../browser/login.mjs';
import { readAccountName, setAccountName, rememberAccountIdentity, validateAccountName } from '../accounts/account-names.mjs';
import { createAccountStore } from '../accounts/account-store.mjs';
import { createBatchController } from '../batch/batch-controller.mjs';
import { createDailyScheduler } from '../schedule/daily-schedule.mjs';
import { readDoubleSignCalendar } from '../game/calendar.mjs';
import { queryLiveSignedDays } from '../game/sign-progress.mjs';
import { activityCapabilities, loadActivityAdapter, runActivity } from '../game/activity.mjs';
import officialActivity from '../game/official-activity.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);
function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) fail(413, '请求过长');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { fail(400, '请求格式无效'); }
}

export function createDashboardServer({
  appRoot = APP_ROOT, profileRoot = PROFILE_ROOT, activity = officialActivity,
  checkLogin = checkAccount, showGame = showAccountGame, readIdentity = readAccountIdentity,
  readCalendar = readDoubleSignCalendar, scheduleClock = {},
} = {}) {
  const statuses = new Map();
  const busy = new Set();
  const accountStore = createAccountStore(appRoot, profileRoot);
  const batchController = createBatchController({ root: appRoot });
  batchController.catch(() => {});
  const activityWrites = new Map([['/api/activity/sign', 'sign'], ['/api/activity/run', 'all']]);
  async function accountName(account) {
    // A closed game must never prevent renaming or listing accounts.
    const identity = busy.has(account) ? null : await readIdentity(account).catch(() => null);
    if (identity && (identity.accountName || identity.maskedPhone)) {
      return rememberAccountIdentity(appRoot, account, identity);
    }
    return readAccountName(appRoot, account);
  }
  async function accountAction(path, body) {
    const adding = path === '/api/add';
    const displayName = adding ? validateAccountName(body?.displayName ?? '') : undefined;
    // Login profiles retain a stable key when the user renames an account.
    const key = adding && body?.account === undefined ? 'a' + randomUUID().replaceAll('-', '').slice(0, 20) : body?.account;
    if (typeof key !== 'string' || !validAccount.test(key)) fail(400, '账号编号格式无效');
    const account = key.toLowerCase();
    if (busy.has(account)) fail(409, '该账号正在操作，请稍候');
    busy.add(account);
    let result;
    try {
      if (adding) {
        await accountStore.add(account);
        const name = body.displayName === undefined ? await readAccountName(appRoot, account) : await setAccountName(appRoot, account, displayName);
        return { account, ...name };
      }
      if (path === '/api/remove') {
        await accountStore.remove(account);
        statuses.delete(account);
        return { account };
      }
      if (!(await accountStore.list()).includes(account)) fail(404, '账号不存在');
      if (path === '/api/name') return { account, ...await setAccountName(appRoot, account, body.displayName) };
      // Reserve this account before waiting for a shared slot, so another page
      // or the daily scheduler cannot queue a duplicate action for it.
      result = await (await batchController).run(async () => {
        const inSession = action => activity.withAccount ? activity.withAccount(account, action) : action();
        if (path === '/api/activity/progress') return inSession(() => queryLiveSignedDays(activity, account));
        if (activityWrites.has(path)) return inSession(() => runActivity(activity, account, activityWrites.get(path)));
        if (path === '/api/open') {
          await showGame(account);
          return { message: '官方游戏窗口已打开' };
        }
        const status = await checkLogin(account);
        statuses.set(account, status);
        return { status };
      });
    } finally { busy.delete(account); }
    return { ...result, ...await accountName(account) };
  }
  const schedule = createDailyScheduler({
    root: appRoot, ...scheduleClock,
    async runBatch() {
      const timestamp = () => new Date(scheduleClock.now ? scheduleClock.now() : Date.now()).toISOString();
      const startedAt = timestamp();
      const targets = await accountStore.list();
      const results = await Promise.all(targets.map(async account => {
        const name = await readAccountName(appRoot, account).catch(() => ({ displayName: account }));
        try {
          const result = await accountAction('/api/activity/sign', { account });
          return { account, displayName: result.displayName || name.displayName, ok: true,
            alreadySigned: result.alreadySigned === true };
        } catch (error) {
          return { account, displayName: name.displayName, ok: false, error: error.message };
        }
      }));
      return { startedAt, finishedAt: timestamp(), total: results.length,
        signed: results.filter(result => result.ok && !result.alreadySigned).length,
        alreadySigned: results.filter(result => result.ok && result.alreadySigned).length,
        failed: results.filter(result => !result.ok).length, results };
    },
  });
  // Initialization can finish before listen(); keep a handled rejection until an
  // API request can report a configuration error to the page.
  schedule.catch(() => {});
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const origin = 'http://127.0.0.1:' + server.address()?.port;
      if (req.headers.host !== new URL(origin).host) fail(403, '请从本机页面访问');
      const path = req.url;
      if (req.method === 'GET') {
        if (files.has(path)) {
          const [name, type] = files.get(path);
          const content = await readFile(new URL('../../web/' + name, import.meta.url));
          res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
          return res.end(content);
        }
        if (path === '/api/activity') return json(200, { available: activityCapabilities(activity).all, capabilities: activityCapabilities(activity) });
        if (path === '/api/calendar') return json(200, (await readCalendar()).current);
        if (path === '/api/schedule') return json(200, (await schedule).getStatus());
        if (path === '/api/batch-settings') return json(200, (await batchController).getSettings());
        if (path === '/api/accounts') {
          const accounts = await accountStore.list();
          return json(200, await Promise.all(accounts.map(async account => ({
            account, status: statuses.get(account) ?? '待检查',
            ...await accountName(account),
          }))));
        }
      }
      if (req.method === 'POST' && ['/api/schedule', '/api/batch-settings', '/api/add', '/api/remove', '/api/name', '/api/open', '/api/check', '/api/activity/progress', ...activityWrites.keys()].includes(path)) {
        if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') fail(403, '请从本机页面操作');
        const body = await readBody(req);
        if (path === '/api/batch-settings') return json(200, await (await batchController).update(body));
        if (path === '/api/schedule') {
          if (body?.enabled === true) {
            if (!activityCapabilities(activity).sign) fail(503, '签到服务尚未接通');
            if (!(await accountStore.list()).length) fail(409, '请先添加并登录账号');
          }
          return json(200, await (await schedule).update(body));
        }
        return json(200, await accountAction(path, body));
      }
      fail(404, '页面不存在');
    } catch (error) { json(error.status || 500, { error: error.code === 'EEXIST' ? '账号已存在' : error.message }); }
  });
  server.on('listening', () => {
    schedule.then(scheduler => { if (server.listening) scheduler.start(); }).catch(error => console.error('定时签到启动失败：' + error.message));
  });
  server.on('close', () => { schedule.then(scheduler => scheduler.stop()).catch(() => {}); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const activity = process.env.FLOWER_ACTIVITY_ADAPTER ? await loadActivityAdapter(process.env.FLOWER_ACTIVITY_ADAPTER) : officialActivity;
  const port = Number(process.env.FLOWER_WEB_PORT || 4876);
  createDashboardServer({ activity }).listen(port, '127.0.0.1', () => console.log('小花仙签到台  http://127.0.0.1:' + port));
}
