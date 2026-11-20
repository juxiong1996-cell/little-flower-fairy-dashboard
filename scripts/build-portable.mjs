import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';

const exec = promisify(execFile);
const deflate = promisify(deflateRaw);
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entryFiles = ['src/app/launcher.mjs', 'src/app/server.mjs', 'package.json', 'LICENSE', 'README.md', '启动签到台.cmd', 'web/index.html', 'web/app.js', 'web/style.css'];
const systemLibraries = new Set(['advapi32.dll', 'bcrypt.dll', 'crypt32.dll', 'dbghelp.dll', 'gdi32.dll', 'iphlpapi.dll',
  'kernel32.dll', 'ncrypt.dll', 'ntasn1.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'psapi.dll', 'rpcrt4.dll',
  'secur32.dll', 'shell32.dll', 'shlwapi.dll', 'ucrtbase.dll', 'user32.dll', 'userenv.dll', 'version.dll', 'winmm.dll',
  'ws2_32.dll', 'wtsapi32.dll']);

function within(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}

async function zipFiles(root, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`压缩目录不能包含符号链接：${path}`);
    if (entry.isDirectory()) files.push(...await zipFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`压缩目录包含特殊文件：${path}`);
  }
  return files.sort();
}

// Standard UTF-8 ZIP records, using only Node.js. No PowerShell modules or .NET.
// The complete archive is written to an exclusive temporary file and published
// with a no-overwrite hard link, so an existing ZIP is never replaced.
export async function createPortableZip(sourceDir, zipFile, { rootName = basename(resolve(sourceDir)) } = {}) {
  sourceDir = resolve(sourceDir); zipFile = resolve(zipFile);
  if (!rootName || /[\\/:]/.test(rootName) || rootName === '.' || rootName === '..') throw new Error('压缩包根目录名称无效。');
  if (sourceDir === zipFile || within(sourceDir, zipFile)) throw new Error('压缩包不能写入被压缩目录。');
  if (await stat(zipFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error(`压缩包已存在：${zipFile}`);
  const files = await zipFiles(sourceDir);
  if (files.length > 65535) throw new Error('发布文件过多，超过标准 ZIP 限制。');
  await mkdir(dirname(zipFile), { recursive: true });
  const temporary = `${zipFile}.building-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    let offset = 0;
    const directory = [];
    async function write(bytes) {
      let at = 0;
      while (at < bytes.length) {
        const result = await handle.write(bytes, at, bytes.length - at);
        if (!result.bytesWritten) throw new Error('压缩包写入中断。');
        at += result.bytesWritten; offset += result.bytesWritten;
      }
      if (offset > 0xffffffff) throw new Error('发布包超过标准 ZIP 的 4GB 限制。');
    }
    for (const file of files) {
      const path = join(sourceDir, file), info = await stat(path);
      if (info.size > 0xffffffff) throw new Error(`文件超过标准 ZIP 限制：${file}`);
      const name = Buffer.from(`${rootName}/${file}`, 'utf8');
      if (name.length > 65535) throw new Error(`文件路径过长：${file}`);
      const data = await readFile(path), packed = await deflate(data, { level: 6 });
      const crc = crc32(data), date = info.mtime;
      const time = date.getHours() << 11 | date.getMinutes() << 5 | date.getSeconds() >>> 1;
      const day = Math.max(0, Math.min(127, date.getFullYear() - 1980)) << 9 | date.getMonth() + 1 << 5 | date.getDate();
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(day, 14);
      central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
      directory.push(central, name);
      await write(local); await write(name); await write(packed);
    }
    const start = offset;
    for (const item of directory) await write(item);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16);
    await write(end);
    await handle.close(); handle = null;
    await link(temporary, zipFile);
    return { zipFile, files: files.length, bytes: offset };
  } finally {
    await handle?.close();
    if (dirname(temporary) === dirname(zipFile) && basename(temporary).startsWith(`${basename(zipFile)}.building-`)) await rm(temporary, { force: true });
  }
}

export async function collectRuntimeFiles(sourceRoot = projectRoot) {
  const pending = [...entryFiles], found = new Set();
  while (pending.length) {
    const file = pending.shift().replaceAll('\\', '/');
    if (found.has(file)) continue;
    const path = resolve(sourceRoot, file);
    if (!within(sourceRoot, path)) throw new Error(`运行文件超出项目目录：${file}`);
    if (!(await stat(path)).isFile()) throw new Error(`运行文件不存在：${file}`);
    found.add(file);
    if (!file.endsWith('.mjs')) continue;
    const source = await readFile(path, 'utf8');
    const imports = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(imports)) {
      const name = match[1] ?? match[2];
      if (name.startsWith('node:')) continue;
      if (!name.startsWith('./') && !name.startsWith('../')) throw new Error(`发布包不支持未打包的第三方模块：${name}`);
      pending.push(relative(sourceRoot, resolve(dirname(path), name)));
    }
  }
  return [...found].sort();
}

export function windowsImports(buffer) {
  if (buffer.toString('ascii', 0, 2) !== 'MZ') throw new Error('运行环境必须是 Windows 版 node.exe。');
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('ascii', pe, pe + 4) !== 'PE\u0000\u0000') throw new Error('node.exe 格式无效。');
  const optional = pe + 24, count = buffer.readUInt16LE(pe + 6), size = buffer.readUInt16LE(pe + 20);
  const directory = optional + (buffer.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const importedRva = buffer.readUInt32LE(directory + 8);
  if (!importedRva) return [];
  function offset(rva) {
    for (let index = 0; index < count; index++) {
      const section = optional + size + index * 40, address = buffer.readUInt32LE(section + 12);
      const length = Math.max(buffer.readUInt32LE(section + 8), buffer.readUInt32LE(section + 16));
      if (rva >= address && rva < address + length) return buffer.readUInt32LE(section + 20) + rva - address;
    }
    throw new Error('node.exe 导入表无效。');
  }
  const imports = [];
  for (let descriptor = offset(importedRva); buffer.readUInt32LE(descriptor) || buffer.readUInt32LE(descriptor + 12); descriptor += 20) {
    const name = offset(buffer.readUInt32LE(descriptor + 12));
    imports.push(buffer.toString('ascii', name, buffer.indexOf(0, name)));
  }
  return imports;
}

async function licenseText(nodeExecutable, explicit) {
  const roots = [dirname(nodeExecutable), dirname(dirname(nodeExecutable))];
  const candidates = explicit ? [resolve(explicit)] : roots.flatMap(root => ['LICENSE', 'LICENSE.txt', 'LICENSE.node', 'LICENSE.node.txt'].map(name => join(root, name)));
  for (const file of candidates) {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (text === null) continue;
    if (text.length < 1000 || !/Node\.js|Node contributors/.test(text)) throw new Error(`请提供 Node.js 官方完整 LICENSE：${file}`);
    return text;
  }
  throw new Error('没有找到 Node.js 的 LICENSE。请用 --node-license 指定与运行时版本对应的官方完整 LICENSE 文件。');
}

export async function buildPortable({ sourceRoot = projectRoot, outputDir = join(projectRoot, 'dist', '小花仙签到台'),
  nodeExecutable = process.execPath, nodeLicense, zip = true } = {}) {
  sourceRoot = resolve(sourceRoot); outputDir = resolve(outputDir); nodeExecutable = resolve(nodeExecutable);
  if (sourceRoot === outputDir || within(outputDir, sourceRoot)) throw new Error('发布目录不能是项目目录或其上级目录。');
  if (await stat(outputDir).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error(`发布目录已存在，请指定一个新的目录：${outputDir}`);
  }
  const zipFile = outputDir + '.zip';
  if (zip && await stat(zipFile).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error(`压缩包已存在，请指定一个新的目录：${zipFile}`);
  }
  const { stdout } = await exec(nodeExecutable, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,websocket:typeof WebSocket})'], { windowsHide: true, timeout: 10000 });
  const runtime = JSON.parse(stdout.trim());
  if (runtime.platform !== 'win32' || !['x64', 'arm64'].includes(runtime.arch) || Number(runtime.version.match(/^v(\d+)/)?.[1]) < 22 || runtime.websocket !== 'function') {
    throw new Error('请选择支持原生 WebSocket 的 Windows 64 位 Node.js 22 或更新版本。');
  }
  const binary = await readFile(nodeExecutable);
  const imports = windowsImports(binary);
  const external = imports.filter(name => !systemLibraries.has(name.toLowerCase()) && !/^(?:api|ext)-ms-win-/i.test(name));
  if (external.length) throw new Error(`所选 Node.js 还依赖额外 DLL（${external.join('、')}），请使用静态链接的官方 Windows Node.js 运行时。`);
  const license = await licenseText(nodeExecutable, nodeLicense);
  const files = await collectRuntimeFiles(sourceRoot);
  const staging = join(dirname(outputDir), `${basename(outputDir)}.building-${randomUUID()}`);
  const stagedZip = `${zipFile}.building-${randomUUID()}`;
  const releaseId = randomUUID();
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(staging);
  let published = false, completed = false;
  try {
    for (const file of files) {
      const target = join(staging, file);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(sourceRoot, file), target);
    }
    await mkdir(join(staging, 'runtime'));
    await copyFile(nodeExecutable, join(staging, 'runtime', 'node.exe'));
    await writeFile(join(staging, 'runtime', 'LICENSE.node.txt'), license);
    const instructions = [
      '小花仙签到台', '', '1. 将整个压缩包解压到一个文件夹，不要在压缩包里面直接运行。',
      '2. 双击“启动签到台.cmd”，签到台会自动在浏览器打开。',
      '3. 添加账号，点击“进入游戏”，在官方游戏窗口自行登录。', '',
      '请保留启动窗口。网页可以关闭；关闭启动窗口或关机后，定时签到停止。',
      '查询、签到和领奖结束后会自动关闭对应游戏并释放内存；签到和领奖会先复查结果，失败时也会清理，已打开的游戏窗口也会关闭。',
      '再次双击启动文件可以重新打开正在运行的签到台。', '',
      `适用系统：Windows 10/11，${runtime.arch === 'x64' ? '64 位 Intel/AMD' : 'ARM64'}。`,
      '程序自带 Node.js，无需安装 Node.js、npm、Python、.NET 或中文文字识别组件。',
      '游戏需要联网，并使用电脑已有的 Microsoft Edge 或 Google Chrome。',
      '账号登录资料和设置只保存在本机：%LOCALAPPDATA%\\LittleFlowerFairyLogin。',
      '本发布包不包含制作者的账号、密码或登录状态。', '',
      '仅供个人学习研究，禁止商业使用、收费分发或用于商业服务。',
      '使用与再分发请遵守随包 LICENSE；游戏相关权利归原权利人。', '',
    ].join('\r\n');
    await writeFile(join(staging, '使用说明.txt'), '\ufeff' + instructions);
    const manifest = { app: 'little-flower-fairy-dashboard', releaseId, runtime: { ...runtime, imports, sha256: createHash('sha256').update(binary).digest('hex') }, files };
    await writeFile(join(staging, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (zip) await createPortableZip(staging, stagedZip, { rootName: basename(outputDir) });
    await rename(staging, outputDir); published = true;
    if (zip) await link(stagedZip, zipFile);
    completed = true;
    return { outputDir, zipFile: zip ? zipFile : null, runtime: { version: runtime.version, arch: runtime.arch }, files };
  } finally {
    if (!completed && published) {
      const ownManifest = await readFile(join(outputDir, 'release.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (ownManifest?.releaseId === releaseId && dirname(outputDir) === dirname(staging)) {
        await rm(outputDir, { recursive: true, force: true });
      }
    }
    if (!published && dirname(staging) === dirname(outputDir) && basename(staging).startsWith(`${basename(outputDir)}.building-`)) {
      await rm(staging, { recursive: true, force: true });
    }
    if (dirname(stagedZip) === dirname(zipFile) && basename(stagedZip).startsWith(`${basename(zipFile)}.building-`)) await rm(stagedZip, { force: true });
  }
}

function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--no-zip') { parsed.zip = false; continue; }
    const key = { '--out': 'outputDir', '--node': 'nodeExecutable', '--node-license': 'nodeLicense' }[flag];
    if (!key || !argv[index + 1]) throw new Error('用法：node scripts/build-portable.mjs [--out 发布目录] [--node node.exe] [--node-license LICENSE] [--no-zip]');
    parsed[key] = argv[++index];
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPortable(options(process.argv.slice(2))).then(result => {
    console.log(`便携文件夹：${result.outputDir}`);
    if (result.zipFile) console.log(`可发送压缩包：${result.zipFile}`);
    console.log(`已附带 Node.js ${result.runtime.version}（${result.runtime.arch}），共 ${result.files.length} 个程序文件。`);
  }).catch(error => { console.error(`打包失败：${error.message}`); process.exitCode = 1; });
}
