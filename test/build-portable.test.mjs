import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { readWebPort } from '../src/app/launcher.mjs';
import { buildPortable, collectRuntimeFiles, createPortableZip, windowsImports } from '../scripts/build-portable.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'flower portable 中文 '));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function allFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await allFiles(root, path));
    else files.push(path);
  }
  return files.sort();
}

function launcher(env, args = ['--no-open']) {
  const child = spawn(process.execPath, [join(root, 'src', 'app', 'launcher.mjs'), ...args], {
    cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { output += part; });
  const finished = new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveDone({ code, signal, output }));
  });
  return { child, finished, output: () => output };
}

async function awaitStarted(process) {
  const timeout = Date.now() + 10000;
  while (Date.now() < timeout) {
    const match = process.output().match(/小花仙签到台已启动：(http:\/\/127\.0\.0\.1:\d+\/)/);
    if (match) return match[1];
    if (process.child.exitCode !== null) throw new Error(process.output());
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`启动等待超时：${process.output()}`);
}

test('发布入口只收集实际运行模块，包含定时功能，排除测试和本机数据', async () => {
  const files = await collectRuntimeFiles(root);
  for (const name of ['src/app/launcher.mjs', 'src/app/server.mjs', 'src/browser/login.mjs', 'src/schedule/daily-schedule.mjs', 'src/game/official-session.mjs', 'web/app.js', 'LICENSE', 'README.md', '启动签到台.cmd']) {
    assert.ok(files.includes(name), name);
  }
  assert.ok(files.every(file => !/\.test\.|(?:^|\/)\.local\/|(?:^|\/)\.git\/|^test\//.test(file)));
  assert.ok(!files.includes('scripts/capture-rewards.mjs'));
});

test('启动端口严格校验，并支持系统自动分配端口', () => {
  assert.equal(readWebPort(''), 4876);
  assert.equal(readWebPort('0'), 0);
  assert.equal(readWebPort('65535'), 65535);
  for (const value of ['-1', '65536', '12oops', '1.2', 'http://localhost', ' 4876']) {
    assert.throws(() => readWebPort(value), /端口/);
  }
});

test('打包生成可移动的运行目录，并且不会把同级私有文件和凭据放进去', { skip: process.platform !== 'win32' }, async t => {
  const area = await temporary(t), sourceRoot = join(area, '源码'), outputDir = join(area, '发布包');
  await mkdir(sourceRoot);
  const files = await collectRuntimeFiles(root);
  for (const file of files) {
    await mkdir(dirname(join(sourceRoot, file)), { recursive: true });
    await copyFile(join(root, file), join(sourceRoot, file));
  }
  await mkdir(join(sourceRoot, '.local'));
  await writeFile(join(sourceRoot, '.local', 'credentials.json'), 'TEST_PRIVATE_CREDENTIALS');
  await writeFile(join(sourceRoot, 'unrelated-secret.mjs'), 'TEST_PRIVATE_SOURCE');
  const nodeLicense = join(area, 'test-license.txt');
  const fixtureLicense = 'Node.js test license fixture; this is not a release license.\n'.repeat(30);
  await writeFile(nodeLicense, fixtureLicense);
  const result = await buildPortable({ sourceRoot, outputDir, nodeLicense, zip: false });
  assert.equal(result.runtime.version, process.version);
  const included = await allFiles(outputDir);
  assert.deepEqual(included, [...files, 'release.json', 'runtime/LICENSE.node.txt', 'runtime/node.exe', '使用说明.txt'].sort());
  for (const file of ['LICENSE', 'README.md']) {
    assert.deepEqual(await readFile(join(outputDir, file)), await readFile(join(sourceRoot, file)), `随包保留原始说明与许可：${file}`);
  }
  const instructions = await readFile(join(outputDir, '使用说明.txt'), 'utf8');
  assert.match(instructions, /仅供个人学习研究，禁止商业使用、收费分发或用于商业服务/);
  assert.match(instructions, /使用与再分发请遵守随包 LICENSE；游戏相关权利归原权利人/);
  assert.equal(await readFile(join(outputDir, 'runtime', 'LICENSE.node.txt'), 'utf8'), fixtureLicense);
  assert.equal((await readFile(join(outputDir, 'runtime', 'node.exe'))).length, (await readFile(process.execPath)).length);
  assert.ok(windowsImports(await readFile(process.execPath)).length > 0);
  const manifest = JSON.parse(await readFile(join(outputDir, 'release.json'), 'utf8'));
  assert.equal(manifest.runtime.platform, 'win32');
  assert.match(manifest.runtime.sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(manifest).includes(sourceRoot));
  const portableBrowser = join(outputDir, 'runtime', 'browser', 'chrome.exe');
  await mkdir(dirname(portableBrowser), { recursive: true });
  await writeFile(portableBrowser, 'portable browser discovery fixture');
  const { findBrowser } = await import(pathToFileURL(join(outputDir, 'src', 'browser', 'browser-runtime.mjs')).href);
  assert.equal(findBrowser({ env: {} }), portableBrowser, '浏览器路径从发布包根目录解析，不依赖源码位置');
  await assert.rejects(buildPortable({ sourceRoot, outputDir, nodeLicense, zip: false }), /已存在/);
});

test('纯 Node ZIP 保留中文路径和文件内容，且不会覆盖已有压缩包', async t => {
  const area = await temporary(t), source = join(area, '中文 发布目录'), zipFile = join(area, '发布 压缩包.zip');
  await mkdir(join(source, '子目录'), { recursive: true });
  const text = Buffer.from('小花仙签到台\n中文和空格路径可以解压。\n', 'utf8');
  const binary = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  await writeFile(join(source, '子目录', '使用 说明.txt'), text);
  await writeFile(join(source, 'runtime.bin'), binary);
  await writeFile(join(source, 'crc-check.txt'), '123456789');
  await createPortableZip(source, zipFile);
  const archive = await readFile(zipFile), extracted = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(archive.readUInt16LE(offset + 6), 0x0800, '标准 UTF-8 文件名标志');
    assert.equal(archive.readUInt16LE(offset + 8), 8, '原始 deflate 压缩');
    const packedSize = archive.readUInt32LE(offset + 18), size = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.toString('utf8', offset + 30, offset + 30 + nameLength);
    if (name.endsWith('/crc-check.txt')) assert.equal(archive.readUInt32LE(offset + 14), 0xcbf43926, 'CRC-32 标准校验向量');
    const start = offset + 30 + nameLength + extraLength;
    const data = inflateRawSync(archive.subarray(start, start + packedSize));
    assert.equal(data.length, size);
    extracted.set(name, data);
    offset = start + packedSize;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50, '存在中央目录');
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50, '标准 ZIP 结束记录');
  assert.equal(archive.readUInt16LE(end + 10), 3);
  assert.equal(archive.readUInt32LE(end + 16), offset);
  assert.deepEqual(extracted.get('中文 发布目录/子目录/使用 说明.txt'), text);
  assert.deepEqual(extracted.get('中文 发布目录/runtime.bin'), binary);
  await assert.rejects(createPortableZip(source, zipFile), /已存在/);
  assert.deepEqual(await readFile(zipFile), archive);
  assert.ok((await readdir(area)).every(file => !file.includes('.building-')));
});

test('启动器在空数据目录启动，重复双击只复用确认身份的实例', { timeout: 20000 }, async t => {
  const area = await temporary(t);
  const first = launcher({ FLOWER_DATA_DIR: area, FLOWER_WEB_PORT: '0' });
  t.after(async () => { first.child.kill(); await first.finished; });
  const url = await awaitStarted(first);
  assert.equal((await fetch(url)).status, 200);
  assert.deepEqual(await fetch(new URL('/api/accounts', url)).then(response => response.json()), []);
  const status = await fetch(new URL('/api/schedule', url)).then(response => response.json());
  assert.equal(status.enabled, false);
  assert.equal((await fetch(new URL('/_flower/instance', url))).status, 403);
  const second = launcher({ FLOWER_DATA_DIR: area, FLOWER_WEB_PORT: '0' });
  t.after(() => { if (second.child.exitCode === null) second.child.kill(); });
  const result = await second.finished;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /已经在运行/);
  assert.ok(!result.output.includes('已启动：'));
  assert.equal((await fetch(url)).status, 200);
  const explicit = launcher({ FLOWER_DATA_DIR: area, FLOWER_WEB_PORT: new URL(url).port });
  t.after(() => { if (explicit.child.exitCode === null) explicit.child.kill(); });
  const explicitResult = await explicit.finished;
  assert.equal(explicitResult.code, 0, explicitResult.output);
  assert.match(explicitResult.output, /已经在运行/);
});

test('自动端口不会复用身份回复不匹配的服务', { timeout: 15000 }, async t => {
  const area = await temporary(t), token = randomUUID();
  let checked = 0;
  const other = http.createServer((req, res) => {
    checked++;
    assert.equal(req.headers['x-flower-instance'], token);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ app: 'a-different-app', token }));
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolveClose => other.close(resolveClose)));
  const otherUrl = `http://127.0.0.1:${other.address().port}/`;
  await writeFile(join(area, 'launcher-instance.json'), JSON.stringify({ app: 'little-flower-fairy-dashboard', token, url: otherUrl }));
  const started = launcher({ FLOWER_DATA_DIR: area, FLOWER_WEB_PORT: '0' });
  t.after(async () => { started.child.kill(); await started.finished; });
  const url = await awaitStarted(started);
  assert.equal(checked, 1);
  assert.notEqual(url, otherUrl);
  assert.ok(!started.output().includes('已经在运行'));
});

test('便携启动仍加载 FLOWER_ACTIVITY_ADAPTER 指定的活动接入', { timeout: 15000 }, async t => {
  const area = await temporary(t), adapter = join(area, 'custom-adapter.mjs');
  await writeFile(adapter, 'export default { async getProgress() { throw new Error("test fixture must not run activity"); } };\n');
  const started = launcher({ FLOWER_DATA_DIR: join(area, 'data'), FLOWER_WEB_PORT: '0', FLOWER_ACTIVITY_ADAPTER: adapter });
  t.after(async () => { started.child.kill(); await started.finished; });
  const url = await awaitStarted(started);
  assert.deepEqual(await fetch(new URL('/api/activity', url)).then(response => response.json()), {
    available: false, capabilities: { progress: true, sign: false, rewards: false, all: false },
  });
});

test('其他程序占用端口时不会误开页面或停止对方进程', { timeout: 15000 }, async t => {
  const area = await temporary(t);
  const other = net.createServer();
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolveClose => other.close(resolveClose)));
  const attempted = launcher({ FLOWER_DATA_DIR: area, FLOWER_WEB_PORT: String(other.address().port) });
  t.after(() => { if (attempted.child.exitCode === null) attempted.child.kill(); });
  const result = await attempted.finished;
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /已被其他程序占用/);
  assert.ok(other.listening);
});
