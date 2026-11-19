import { statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function applicationDataRoot(env = process.env) {
  const override = env.FLOWER_DATA_DIR?.trim();
  if (override) {
    if (!isAbsolute(override)) throw new Error('FLOWER_DATA_DIR 必须是保存本机数据的文件夹完整路径。');
    return override;
  }
  if (!env.LOCALAPPDATA) throw new Error('无法确定本机数据目录，请设置 FLOWER_DATA_DIR 的完整路径。');
  return join(env.LOCALAPPDATA, 'LittleFlowerFairyLogin');
}

function executableFile(path) {
  if (extname(path).toLowerCase() !== '.exe') return false;
  try { return statSync(path).isFile(); }
  catch { return false; }
}

// Keep one dedicated profile per account, regardless of the Chromium browser.
// An explicit browser setting must work; silently falling back hides bad setups.
export function findBrowser({ env = process.env, projectRoot = PROJECT_ROOT } = {}) {
  const override = env.FLOWER_BROWSER_PATH?.trim();
  if (override) {
    if (!isAbsolute(override) || !executableFile(override)) {
      throw new Error('FLOWER_BROWSER_PATH 必须是已存在的浏览器 .exe 文件的完整路径。');
    }
    return override;
  }

  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const candidates = [
    join(projectRoot, 'runtime', 'browser', 'chrome.exe'),
    join(projectRoot, 'runtime', 'browser', 'chrome-win64', 'chrome.exe'),
    join(projectRoot, 'runtime', 'browser', 'msedge.exe'),
    ...bases.map(base => join(base, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...bases.map(base => join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
  const executable = candidates.find(executableFile);
  if (!executable) throw new Error('找不到 Chrome 或 Edge。请安装其中一个，或使用包含浏览器的便携包。');
  return executable;
}
