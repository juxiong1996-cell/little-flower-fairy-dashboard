// Packet layout, cipher and rolling checksum follow the official WebGL client's
// ByteArray and WebSocketEncryptImpl methods. This is a fixed protocol constant,
// not a player's login token. Keep the codec free of Node APIs for page use.
export function createProtocol() {
  const key = new TextEncoder().encode('v#93ta0mee+fl0WErd0t2eatMee&#$+@n0\0');
  const HEADER = 17;
  const LIMIT = 4 * 1024 * 1024;
  const require = (ok, message) => { if (!ok) throw new Error(message); };
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new Error('协议数据必须是字节数组');
  }
  function view(value) { return new DataView(value.buffer, value.byteOffset, value.byteLength); }
  function uint(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff; }
  function cryptKey(index) {
    // GetKeyNum resets without advancing at the wrap, repeating key[0].
    return index === key.length ? [key[0], 0] : [key[index], index + 1];
  }
  function encryptBody(value) {
    const input = bytes(value);
    const output = new Uint8Array(input.length + 1);
    let index = 0;
    for (let i = 0; i < input.length; i++) {
      const [part, next] = cryptKey(index);
      index = next;
      output[i] = input[i] ^ part;
    }
    for (let i = input.length - 1; i >= 0; i--) {
      output[i + 1] |= output[i] >>> 3;
      output[i] = (output[i] << 5) & 255;
    }
    output[0] |= 3;
    return output;
  }
  function decryptBody(value) {
    const input = bytes(value);
    require(input.length > 0 && (input[0] & 31) === 3 && (input[input.length - 1] & 224) === 0, '协议密文格式无效');
    const output = new Uint8Array(input.length - 1);
    let index = 0;
    for (let i = 0; i < output.length; i++) {
      const [part, next] = cryptKey(index);
      index = next;
      output[i] = ((input[i] >>> 5) | (input[i + 1] << 3)) ^ part;
    }
    return output;
  }
  function nextSequence(previous, command, body) {
    require(Number.isInteger(previous) && previous >= -0x80000000 && previous <= 0x7fffffff && uint(command), '协议序号无效');
    if (command < 1000) return previous;
    const input = bytes(body);
    let checksum = 0;
    for (const part of input) checksum ^= part;
    return (previous - Math.trunc(previous / 7) + 147 + ((input.length + HEADER) % 21) + command % 13 + checksum) | 0;
  }
  function encodeRequest({ command, role, channel, previous, body }) {
    require(command === 2916 || command === 9191 || command === 9192 || command === 9195, '仅支持签到查询、今日签到、累计领奖和领奖状态查询请求');
    require(uint(role) && role > 0 && Number.isInteger(channel) && channel >= 0 && channel <= 255, '协议角色或渠道无效');
    const input = bytes(body);
    require(input.length === (command === 9191 ? 4 : 8), '活动请求长度无效');
    if (command === 2916) {
      const data = view(input);
      require(data.getUint32(0) === 1 && data.getUint32(4) > 0, '领奖状态查询仅允许一个有效徽章编号');
    }
    const encoded = encryptBody(input);
    const output = new Uint8Array(HEADER + encoded.length);
    const data = view(output);
    data.setUint32(0, output.length);
    data.setUint8(4, channel);
    data.setUint32(5, command);
    data.setUint32(9, role);
    data.setInt32(13, nextSequence(previous, command, input));
    output.set(encoded, HEADER);
    return output;
  }
  function decodeResponse(value) {
    const input = bytes(value);
    require(input.length >= HEADER && input.length <= LIMIT, '服务器数据包长度无效');
    const data = view(input);
    const length = data.getUint32(0);
    require(length === input.length, '服务器数据包长度不匹配');
    const status = data.getInt32(13);
    return { length, channel: data.getUint8(4), command: data.getUint32(5), role: data.getUint32(9), status,
      body: input.length === HEADER || status !== 0 ? new Uint8Array(0) : decryptBody(input.subarray(HEADER)) };
  }
  function parseProgress(value) {
    const input = bytes(value);
    require(input.length >= 16 && input.length % 4 === 0, '签到查询数据长度无效');
    const data = view(input);
    let pos = 8;
    function readDays() {
      require(pos + 4 <= input.length, '签到日期列表缺失');
      const count = data.getUint32(pos); pos += 4;
      require(count <= 366 && pos + count * 4 <= input.length, '签到日期数量无效');
      const days = Array.from({ length: count }, () => { const day = data.getUint32(pos); pos += 4; return day; });
      require(new Set(days).size === days.length && days.every(day => day >= 1 && day <= 366), '签到日期列表无效');
      return days;
    }
    const signedDays = readDays(), otherSignedDays = readDays();
    require(pos === input.length, '签到查询数据含未知字段');
    return { otherId: data.getUint32(0), lastId: data.getUint32(4), signedDays, otherSignedDays };
  }
  function parseSign(value) {
    const input = bytes(value);
    require(input.length >= 8 && input.length % 4 === 0, '签到返回数据长度无效');
    const data = view(input), count = data.getUint32(4);
    require(count <= 4096 && input.length === 8 + count * 8, '签到奖励列表长度无效');
    return { success: data.getUint32(0) > 0,
      rewards: Array.from({ length: count }, (_, i) => ({ id: data.getUint32(8 + i * 8), count: data.getUint32(12 + i * 8) })) };
  }
  function parseReward(value) {
    const input = bytes(value);
    require(input.length >= 4 && input.length % 4 === 0, '累计领奖返回数据长度无效');
    const data = view(input), count = data.getUint32(0);
    require(count <= 4096 && input.length === 4 + count * 8, '累计领奖奖励列表长度无效');
    return { rewards: Array.from({ length: count }, (_, i) => ({ id: data.getUint32(4 + i * 8), count: data.getUint32(8 + i * 8) })) };
  }
  function parseMedals(value) {
    const input = bytes(value);
    require(input.length >= 4 && input.length % 4 === 0, '领奖状态返回数据长度无效');
    const data = view(input), count = data.getUint32(0);
    require(count <= 4096 && input.length === 4 + count * 16, '领奖状态列表长度无效');
    return Array.from({ length: count }, (_, i) => ({
      id: data.getUint32(4 + i * 16), value: data.getUint32(8 + i * 16),
      time: data.getUint32(12 + i * 16), flag: data.getUint32(16 + i * 16),
    }));
  }
  return { encodeRequest, decodeResponse, nextSequence, encryptBody, decryptBody, parseProgress, parseSign, parseReward, parseMedals };
}

export const { encodeRequest, decodeResponse, nextSequence, encryptBody, decryptBody, parseProgress, parseSign, parseReward, parseMedals } = createProtocol();
