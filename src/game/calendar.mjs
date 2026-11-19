const packageRoot = 'https://hua-mobile.61.com/taomee/WebGL/DefaultPackage/';
const tablePrefix = 'DoubleSignin_DoubleSignin_Month';
const timeZoneOffset = '+08:00';

async function fetchResource(file, maxBytes) {
  const response = await fetch(new URL(file, packageRoot), {
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`官方资源返回 HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('官方资源大小超出预期');
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxBytes) throw new Error('官方资源大小超出预期');
  return data;
}

function findDataBundle(manifest) {
  const name = 'defaultpackage_assets_res_datatable.b';
  const offset = manifest.indexOf(name);
  if (offset < 2 || manifest.readUInt16LE(offset - 2) !== name.length) {
    throw new Error('资源清单中找不到活动数据表');
  }
  const hashOffset = offset + name.length + 4;
  const hash = manifest.toString('ascii', hashOffset + 2, hashOffset + 10);
  if (manifest.readUInt16LE(hashOffset) !== 8 || !/^[a-f0-9]{8}$/.test(hash)) {
    throw new Error('活动数据表的文件名格式发生变化');
  }
  return `${name.slice(0, -2)}_${hash}.bundle`;
}

function decompressBlock(source, size, compression) {
  if (compression === 0 && source.length === size) return source;
  if (compression !== 2 && compression !== 3) throw new Error('不支持的资源压缩格式');
  const output = Buffer.alloc(size);
  let cursor = 0;
  let written = 0;
  function readLength(initial) {
    if (initial !== 15) return initial;
    let extension;
    do {
      if (cursor >= source.length) throw new Error('压缩数据长度无效');
      extension = source[cursor++];
      initial += extension;
    } while (extension === 255);
    return initial;
  }
  while (cursor < source.length) {
    const token = source[cursor++];
    const literals = readLength(token >>> 4);
    if (cursor + literals > source.length || written + literals > size) throw new Error('压缩数据无效');
    source.copy(output, written, cursor, cursor + literals);
    cursor += literals;
    written += literals;
    if (cursor === source.length) break;
    const distance = source.readUInt16LE(cursor);
    cursor += 2;
    const length = readLength(token & 15) + 4;
    if (distance === 0 || distance > written || written + length > size) throw new Error('压缩数据引用无效');
    for (let index = 0; index < length; index++, written++) output[written] = output[written - distance];
  }
  if (written !== size) throw new Error('资源解压长度不匹配');
  return output;
}

function unpackDataBundle(file) {
  let cursor = 0;
  const readTerminated = () => {
    const end = file.indexOf(0, cursor);
    if (end < 0) throw new Error('资源文件头无效');
    const value = file.toString('ascii', cursor, end);
    cursor = end + 1;
    return value;
  };
  const readUint32 = () => {
    const value = file.readUInt32BE(cursor);
    cursor += 4;
    return value;
  };
  if (readTerminated() !== 'UnityFS') throw new Error('资源包格式发生变化');
  const version = readUint32();
  readTerminated(); // Player version.
  readTerminated(); // Engine version.
  const size = Number(file.readBigUInt64BE(cursor));
  cursor += 8;
  const packedSize = readUint32();
  const infoSize = readUint32();
  const flags = readUint32();
  if (size !== file.length || infoSize > 4_000_000) throw new Error('资源包大小无效');
  if (version >= 7) cursor = Math.ceil(cursor / 16) * 16;
  const infoOffset = flags & 0x80 ? size - packedSize : cursor;
  if (infoOffset < cursor || infoOffset + packedSize > size) throw new Error('资源包索引无效');
  const info = decompressBlock(file.subarray(infoOffset, infoOffset + packedSize), infoSize, flags & 63);
  if (!(flags & 0x80)) cursor += packedSize;
  if (flags & 0x200) cursor = Math.ceil(cursor / 16) * 16;
  const blockCount = info.readUInt32BE(16);
  if (20 + blockCount * 10 > info.length) throw new Error('资源包数据块数量无效');
  const blocks = [];
  let expanded = 0;
  for (let index = 0; index < blockCount; index++) {
    const offset = 20 + index * 10;
    const blockSize = info.readUInt32BE(offset);
    const compressedSize = info.readUInt32BE(offset + 4);
    const compression = info.readUInt16BE(offset + 8) & 63;
    expanded += blockSize;
    if (expanded > 90_000_000 || cursor + compressedSize > size) throw new Error('资源包数据块大小无效');
    blocks.push(decompressBlock(file.subarray(cursor, cursor + compressedSize), blockSize, compression));
    cursor += compressedSize;
  }
  return Buffer.concat(blocks);
}

// Each table is stored as a Unity TextAsset with a length-prefixed name and data.
function extractTable(data, suffix) {
  const name = tablePrefix + suffix;
  for (let offset = data.indexOf(name); offset >= 0; offset = data.indexOf(name, offset + name.length)) {
    if (offset < 4 || data.readUInt32LE(offset - 4) !== name.length) continue;
    const lengthOffset = Math.ceil((offset + name.length) / 4) * 4;
    const length = data.readUInt32LE(lengthOffset);
    if (length < 4 || length > 2_000_000 || lengthOffset + 4 + length > data.length) continue;
    return data.subarray(lengthOffset + 4, lengthOffset + 4 + length);
  }
  throw new Error(`找不到双生签到数据表 ${suffix || 'Month'}`);
}

function readRows(data, suffix, readRow) {
  const table = extractTable(data, suffix);
  let offset = 0;
  const reader = {
    byte() { return table.readUInt8(offset++); },
    short() { const value = table.readUInt16LE(offset); offset += 2; return value; },
    int() { const value = table.readUInt32LE(offset); offset += 4; return value; },
    text() {
      if (!this.short()) return '';
      let length = 0;
      for (let shift = 0; shift <= 21; shift += 7) {
        const byte = this.byte();
        length += (byte & 127) << shift;
        if (byte & 128) continue;
        if (offset + length > table.length) break;
        const value = table.toString('utf8', offset, offset + length);
        offset += length;
        return value;
      }
      throw new Error('签到数据表文字长度无效');
    },
  };
  const count = reader.int();
  if (count > 10_000) throw new Error('签到数据表行数无效');
  const rows = Array.from({ length: count }, () => readRow(reader));
  if (offset !== table.length) throw new Error('签到数据表结构发生变化');
  return rows;
}

function timestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) throw new Error('签到活动日期格式无效');
  const result = Date.parse(value.replace(' ', 'T') + timeZoneOffset);
  if (!Number.isFinite(result)) throw new Error('签到活动日期无效');
  return result;
}

async function loadCalendarData() {
  const version = (await fetchResource('PackageManifest_DefaultPackage.version', 200)).toString('utf8').trim();
  if (!/^\d{4}-\d{2}-\d{2}-\d{1,10}$/.test(version)) throw new Error('官方资源版本号格式发生变化');
  const manifest = await fetchResource(`PackageManifest_DefaultPackage_${version}.bytes`, 20_000_000);
  const data = unpackDataBundle(await fetchResource(findDataBundle(manifest), 40_000_000));
  return { version, data };
}

// Share only the official configuration bytes. Each call computes today's
// activity day again, including when a cached table spans Beijing midnight.
export function createCalendarReader({ loadData = loadCalendarData, now = Date.now, cacheMs = 300_000 } = {}) {
  let cached;
  let downloading;
  return async function readCalendar(at) {
    let resource = cached;
    if (!resource || now() >= resource.expiresAt) {
      downloading ??= Promise.resolve().then(loadData).then(value => {
        cached = { ...value, expiresAt: now() + cacheMs };
        return cached;
      }).finally(() => { downloading = undefined; });
      resource = await downloading;
    }
    try {
      return { version: resource.version, current: parseDoubleSignCalendar(resource.data, at ?? now()) };
    } catch (error) {
      // A changed or damaged table must be retried rather than retained until
      // the cache expires. Network failures also clear the shared promise.
      if (cached === resource) cached = undefined;
      throw error;
    }
  };
}

export const readDoubleSignCalendar = createCalendarReader();

// Parse the official table data separately so the reward IDs can be checked
// without a live account or a network request. These are configuration fields,
// not proof that a player has claimed a reward.
export function parseDoubleSignCalendar(data, now = Date.now()) {
  const seasons = readRows(data, '', reader => {
    const season = { tableId: reader.int(), id: reader.byte(), start: reader.text(), end: reader.text() };
    reader.text();
    reader.text();
    reader.short();
    return season;
  });
  const season = seasons.filter(row => timestamp(row.start) <= now && now <= timestamp(row.end))
    .sort((a, b) => b.id - a.id)[0];
  if (!season) return null;

  const dayConfig = readRows(data, '_Day', reader => ({
    id: reader.int(), tableId: reader.int(), freeMakeupLimit: reader.byte(), medal: reader.int(),
  })).find(row => row.tableId === season.tableId);
  if (!dayConfig) throw new Error('找不到本期签到日历');
  const days = readRows(data, '_Day_DayItem', reader => {
    reader.int();
    const row = { group: reader.int(), day: reader.byte() };
    reader.int();
    reader.int();
    for (let index = 0; index < 4; index++) reader.text();
    row.start = reader.text();
    reader.text();
    return row;
  }).filter(row => row.group === dayConfig.id).sort((a, b) => a.day - b.day);
  if (!days.length || new Set(days.map(row => row.day)).size !== days.length) throw new Error('本期签到日期无效');
  const eligibleDay = days.findLast(row => timestamp(row.start) <= now);
  const milestoneGroup = readRows(data, '_AccumulateReward', reader => ({
    id: reader.int(), tableId: reader.int(), medal: reader.int(), vipMedal: reader.int(),
  })).find(row => row.tableId === season.tableId);
  if (!milestoneGroup || !milestoneGroup.medal) throw new Error('找不到本期累计奖励配置');
  const items = readRows(data, '_AccumulateReward_AccumulateRewardItem', reader => {
    const tableId = reader.int();
    const group = reader.int();
    const index = reader.byte();
    reader.text();
    const need = reader.byte();
    reader.text();
    reader.text();
    return { tableId, group, index, need };
  }).filter(row => row.group === milestoneGroup.id)
    .map(({ tableId, index, need }) => ({ tableId, index, need }))
    .sort((a, b) => a.need - b.need || a.index - b.index);
  if (!items.length || items.some(row => row.tableId === 0 || row.index === 0 || row.need === 0 || row.need > days.length) ||
      new Set(items.map(row => row.tableId)).size !== items.length || new Set(items.map(row => row.index)).size !== items.length) {
    throw new Error('本期累计奖励档次无效');
  }
  const milestones = items.map(row => row.need);

  return {
      id: season.id,
      start: season.start,
      end: season.end,
      totalDays: days.length,
      today: eligibleDay?.day ?? null,
      freeMakeupLimit: dayConfig.freeMakeupLimit,
      milestones,
      rewardConfig: { medal: milestoneGroup.medal, vipMedal: milestoneGroup.vipMedal, items },
  };
}
