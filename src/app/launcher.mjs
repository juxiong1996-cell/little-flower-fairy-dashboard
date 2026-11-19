import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const applicationId = 'little-flower-fairy-dashboard';
const instanceRoute = '/_flower/instance';

export function readWebPort(value = process.env.FLOWER_WEB_PORT) {
  if (value === undefined || value === '') return 4876;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error('网页端口需要是 0 到 65535 之间的整数。');
  return Number(value);
}

function openPage(url) {
  return new Promise((resolveOpen, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      windowsHide: true, detached: true, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveOpen(); });
  });
}

async function existingInstance(file, port) {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const url = new URL(saved.url);
    const actualPort = Number(url.port || 80);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash ||
        !Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65535 || port !== 0 && actualPort !== port || url.pathname !== '/' ||
        saved.app !== applicationId || typeof saved.token !== 'string' || !/^[\da-f-]{36}$/i.test(saved.token)) return null;
    const response = await fetch(new URL(instanceRoute, url), {
      headers: { 'X-Flower-Instance': saved.token }, redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return null;
    const identity = await response.json();
    return identity.app === applicationId && identity.token === saved.token ? saved.url : null;
  } catch { return null; }
}

function identifyInstance(server, token) {
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (req.url !== instanceRoute) {
      for (const handler of handlers) handler.call(server, req, res);
      return;
    }
    const port = server.address()?.port;
    if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${port}` || req.headers['x-flower-instance'] !== token) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: '请从本机启动程序访问。' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ app: applicationId, token }));
  });
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    const failed = error => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolveListen(); };
    server.once('error', failed);
    server.once('listening', ready);
    server.listen(port, '127.0.0.1');
  });
}

export async function launchDashboard({ port = readWebPort(), openBrowser = process.env.FLOWER_NO_OPEN !== '1', log = console.log } = {}) {
  const [{ createDashboardServer }, { APP_ROOT }, { loadActivityAdapter }] = await Promise.all([
    import('./server.mjs'), import('../browser/login.mjs'), import('../game/activity.mjs'),
  ]);
  const instanceFile = join(APP_ROOT, 'launcher-instance.json');
  const reuse = async previous => {
    log(`签到台已经在运行：${previous}`);
    if (openBrowser) await openPage(previous).catch(() => log(`请在浏览器手动打开：${previous}`));
    return { server: null, url: previous, reused: true };
  };
  // Port zero never collides, so check the saved instance before creating a
  // second server (and a second scheduler) even when the OS selects its port.
  const running = await existingInstance(instanceFile, port);
  if (running) return reuse(running);
  const activity = process.env.FLOWER_ACTIVITY_ADAPTER ? await loadActivityAdapter(process.env.FLOWER_ACTIVITY_ADAPTER) : undefined;
  const token = randomUUID();
  const server = createDashboardServer(activity ? { activity } : undefined);
  identifyInstance(server, token);
  try {
    await listen(server, port);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    // Another double-click can arrive while the first instance saves its marker.
    let previous;
    for (let attempt = 0; attempt < 5 && !previous; attempt++) {
      previous = await existingInstance(instanceFile, port);
      if (!previous) await delay(100);
    }
    if (!previous) throw new Error(`端口 ${port} 已被其他程序占用。请先关闭原来的签到台，或设置 FLOWER_WEB_PORT 后重试。`);
    return reuse(previous);
  }

  const url = `http://127.0.0.1:${server.address().port}/`;
  const temporary = `${instanceFile}.${token}.tmp`;
  try {
    await mkdir(APP_ROOT, { recursive: true });
    await writeFile(temporary, JSON.stringify({ app: applicationId, token, url, pid: process.pid }) + '\n', { flag: 'wx' });
    await rename(temporary, instanceFile);
  } catch (error) {
    await new Promise(resolveClose => server.close(resolveClose));
    throw new Error(`无法保存启动信息：${error.message}`);
  } finally { await rm(temporary, { force: true }); }

  server.once('close', () => {
    // Do not remove a marker written by a later process.
    readFile(instanceFile, 'utf8').then(JSON.parse).then(saved => {
      if (saved.token === token) return rm(instanceFile, { force: true });
    }).catch(() => {});
  });
  log(`小花仙签到台已启动：${url}`);
  log('请保留此窗口。网页可以关闭；关闭此窗口后，定时签到停止。');
  if (openBrowser) await openPage(url).catch(() => log(`未能自动打开浏览器，请手动打开：${url}`));
  return { server, url, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.find(arg => arg !== '--no-open');
  const launch = unknown ? Promise.reject(new Error(`不支持的启动参数：${unknown}`))
    : launchDashboard({ openBrowser: process.env.FLOWER_NO_OPEN !== '1' && !args.includes('--no-open') });
  launch.then(({ server }) => {
    if (!server) return;
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      server.close(() => process.exit(0));
      server.closeIdleConnections?.();
      setTimeout(() => process.exit(0), 1500).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
}
