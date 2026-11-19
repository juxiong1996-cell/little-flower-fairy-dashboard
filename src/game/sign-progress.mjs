import { readProgress } from './activity.mjs';
import { liveProgress } from './progress-view.mjs';

export async function queryLiveSignedDays(adapter, account) {
  if (typeof adapter?.getProgress !== 'function') {
    throw Object.assign(new Error('实时查询尚未接通游戏服务器'), { status: 503 });
  }
  const state = readProgress(await adapter.getProgress(account), account);
  return liveProgress(state, account);
}

