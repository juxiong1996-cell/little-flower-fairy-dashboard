import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applicationDataRoot, findBrowser } from '../src/browser/browser-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'flower-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    env: { ProgramFiles: join(root, 'programs'), LOCALAPPDATA: join(root, 'local') },
    async file(...parts) {
      const path = join(root, ...parts);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'browser test fixture');
      return path;
    },
  };
}

test('配置浏览器路径优先，配置失效时明确报错而不启动别的浏览器', async t => {
  const app = await fixture(t);
  const selected = await app.file('custom', '浏览器.exe');
  await app.file('runtime', 'browser', 'chrome.exe');
  assert.equal(findBrowser({ projectRoot: app.root, env: { ...app.env, FLOWER_BROWSER_PATH: selected } }), selected);
  for (const invalid of ['chrome.exe', join(app.root, 'missing.exe'), await app.file('custom', 'not-browser.txt')]) {
    assert.throws(() => findBrowser({ projectRoot: app.root, env: { ...app.env, FLOWER_BROWSER_PATH: invalid } }), /FLOWER_BROWSER_PATH/);
  }
});

test('便携浏览器优先于电脑上的浏览器，并支持 Chrome for Testing 的目录结构', async t => {
  const app = await fixture(t);
  await app.file('programs', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const portable = await app.file('runtime', 'browser', 'chrome-win64', 'chrome.exe');
  assert.equal(findBrowser({ projectRoot: app.root, env: app.env }), portable);
});

test('保留原有 Chrome 选择，只有 Edge 的电脑也能找到浏览器', async t => {
  const app = await fixture(t);
  const edge = await app.file('local', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(findBrowser({ projectRoot: app.root, env: app.env }), edge);
  const chrome = await app.file('programs', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(findBrowser({ projectRoot: app.root, env: app.env }), chrome);
});

test('默认系统安装路径全部缺失时给出可操作的提示，不能把文件夹当作浏览器', async t => {
  const app = await fixture(t);
  await mkdir(join(app.root, 'runtime', 'browser', 'chrome.exe'), { recursive: true });
  assert.throws(() => findBrowser({ projectRoot: app.root, env: app.env }), /Chrome 或 Edge/);
  assert.throws(() => findBrowser({ projectRoot: app.root, env: {} }), /Chrome 或 Edge/);
});

test('本机数据默认路径保持不变，允许使用独立目录但不接受相对路径', async t => {
  const app = await fixture(t);
  assert.equal(applicationDataRoot(app.env), join(app.env.LOCALAPPDATA, 'LittleFlowerFairyLogin'));
  const separate = join(app.root, 'isolated-data');
  assert.equal(applicationDataRoot({ ...app.env, FLOWER_DATA_DIR: separate }), separate);
  assert.throws(() => applicationDataRoot({ ...app.env, FLOWER_DATA_DIR: 'data' }), /FLOWER_DATA_DIR/);
  assert.throws(() => applicationDataRoot({}), /FLOWER_DATA_DIR/);
});
