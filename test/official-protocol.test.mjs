import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createProtocol, encodeRequest, decodeResponse, nextSequence, encryptBody, decryptBody, parseProgress, parseSign, parseReward, parseMedals } from '../src/game/official-protocol.mjs';

const raw = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = value => Buffer.from(value).toString('hex');
function words(...values) {
  const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value));
  return result;
}
function response(command, cipher, status = 0) {
  const body = raw(cipher), result = new Uint8Array(17 + body.length), data = new DataView(result.buffer);
  data.setUint32(0, result.length); data.setUint8(4, 1); data.setUint32(5, command);
  data.setUint32(9, 123); data.setInt32(13, status); result.set(body, 17);
  return result;
}

// These encrypted bodies were captured from the official client in the prior
// session. Headers are synthetic to exclude player IDs and connection state.
test('requests match captured official query and day-six sign bodies', () => {
  const query = encodeRequest({ command: 9191, channel: 1, role: 123, previous: 1000, body: words(11) });
  const sign = encodeRequest({ command: 9192, channel: 1, role: 123, previous: 1000, body: words(11, 6) });
  assert.equal(query.length, 22); assert.equal(hex(query.subarray(17)), 'c36e240707');
  assert.equal(sign.length, 26); assert.equal(hex(sign.subarray(17)), 'c36e2407872e0c660d');
  const q = new DataView(query.buffer), s = new DataView(sign.buffer);
  assert.equal(q.getUint32(0), 22); assert.equal(q.getUint32(5), 9191); assert.equal(q.getUint32(9), 123);
  assert.equal(q.getInt32(13), 1016); assert.equal(s.getInt32(13), 1023);
});

test('decrypts captured progress before and after signing', () => {
  const before = decodeResponse(response(9191, 'c36e2467862e0ca6adac6cc58c0de6aa08'));
  const after = decodeResponse(response(9191, 'c36e2467862e0ca6adac6ce58c0de66a488e0c860e'));
  assert.equal(before.status, 0); assert.equal(before.command, 9191); assert.equal(before.role, 123);
  assert.deepEqual(parseProgress(before.body), { otherId: 0, lastId: 0, signedDays: [], otherSignedDays: [] });
  assert.deepEqual(parseProgress(after.body), { otherId: 0, lastId: 0, signedDays: [6], otherSignedDays: [] });
});

test('decrypts captured successful sign and awarded items', () => {
  const result = decodeResponse(response(9192, 'c36e2447862e0c86ad2c0c17920de60a08'));
  assert.deepEqual(parseSign(result.body), { success: true, rewards: [{ id: 300022, count: 5 }] });
  assert.deepEqual(parseSign(words(0, 0)), { success: false, rewards: [] });
});

test('encodes cumulative reward command 9195 with season and reward index only', () => {
  const body = words(11, 2);
  const packet = encodeRequest({ command: 9195, channel: 1, role: 123, previous: 1000, body });
  const view = new DataView(packet.buffer);
  assert.equal(packet.length, 26);
  assert.equal(view.getUint32(5), 9195);
  assert.equal(view.getInt32(13), nextSequence(1000, 9195, body));
  assert.deepEqual(decryptBody(packet.subarray(17)), body);
  for (const bad of [words(11), words(11, 2, 3)]) {
    assert.throws(() => encodeRequest({ command: 9195, channel: 1, role: 123, previous: 1000, body: bad }), /请求长度/);
  }
});

test('parses cumulative reward count and item pairs without a success field', () => {
  const body = words(2, 300022, 5, 300023, 9);
  const decoded = decodeResponse(response(9195, hex(encryptBody(body))));
  assert.deepEqual(parseReward(decoded.body), { rewards: [{ id: 300022, count: 5 }, { id: 300023, count: 9 }] });
  assert.deepEqual(parseReward(words(0)), { rewards: [] });
  assert.equal('success' in parseReward(body), false);
});

test('rejects truncated or surplus cumulative reward data and implausible item counts', () => {
  for (const bad of [new Uint8Array(), new Uint8Array(3), words(1), words(1, 300022), words(0, 99), words(4097)]) {
    assert.throws(() => parseReward(bad), /长度/);
  }
  assert.throws(() => parseReward(words(1, 300022, 5, 99)), /列表/);
});

test('encodes read-only medal query 2916 for exactly one positive medal id', () => {
  const body = words(1, 42001);
  const packet = encodeRequest({ command: 2916, channel: 1, role: 123, previous: 1000, body });
  const view = new DataView(packet.buffer);
  assert.equal(view.getUint32(5), 2916);
  assert.equal(view.getInt32(13), nextSequence(1000, 2916, body));
  assert.deepEqual(decryptBody(packet.subarray(17)), body);
  for (const bad of [words(0, 42001), words(2, 42001), words(1, 0), words(1), words(2, 42001, 42002)]) {
    assert.throws(() => encodeRequest({ command: 2916, channel: 1, role: 123, previous: 1000, body: bad }), /查询|长度/);
  }
});

test('parses medal entries in ID, Value, Time, Flag order as unsigned words', () => {
  const body = words(2, 42001, 0x80000000, 1795017600, 0xffffffff, 42002, 5, 0, 1);
  const decoded = decodeResponse(response(2916, hex(encryptBody(body))));
  assert.deepEqual(parseMedals(decoded.body), [
    { id: 42001, value: 0x80000000, time: 1795017600, flag: 0xffffffff },
    { id: 42002, value: 5, time: 0, flag: 1 },
  ]);
  assert.deepEqual(parseMedals(words(0)), []);
});

test('rejects incomplete, surplus and implausibly long medal lists', () => {
  for (const bad of [new Uint8Array(), new Uint8Array(3), words(1), words(1, 42001, 0, 0), words(0, 42001), words(4097)]) {
    assert.throws(() => parseMedals(bad), /长度/);
  }
  assert.throws(() => parseMedals(words(1, 42001, 0, 0, 0, 99)), /列表/);
});

test('preserves the client key wrap and supports longer date lists', () => {
  const clear = words(0, 0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0), encoded = encryptBody(clear);
  assert.deepEqual(decryptBody(encoded), clear);
  assert.deepEqual(parseProgress(decryptBody(encoded)).signedDays, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const zeroCipher = encryptBody(new Uint8Array(40));
  const keyAt = i => (zeroCipher[i] >>> 5) | ((zeroCipher[i + 1] << 3) & 255);
  assert.equal(keyAt(34), 0); // The constant includes its final NUL.
  assert.equal(keyAt(35), 118); assert.equal(keyAt(36), 118); assert.equal(keyAt(37), 35);
});

test('leaves rolling state unchanged for commands below 1000', () => {
  assert.equal(nextSequence(1000, 999, words(1)), 1000);
  assert.equal(nextSequence(-7, 9191, words(11)), 152);
});

test('rejects truncated, malformed, duplicate and impossible date data', () => {
  const packet = response(9191, 'c36e2467862e0ca6adac6cc58c0de6aa08');
  assert.throws(() => decodeResponse(packet.subarray(0, packet.length - 1)), /长度/);
  assert.throws(() => decodeResponse(raw('00112233')), /长度/);
  const bad = packet.slice(); bad[17] &= 224;
  assert.throws(() => decodeResponse(bad), /密文/);
  assert.throws(() => parseProgress(words(0, 0, 2, 6, 6, 0)), /列表/);
  assert.throws(() => parseProgress(words(0, 0, 1, 0, 0)), /列表/);
  assert.throws(() => parseProgress(words(0, 0, 1, 367, 0)), /列表/);
  assert.throws(() => parseProgress(words(0, 0, 3000, 0)), /数量/);
  assert.throws(() => parseProgress(words(0, 0, 0, 0, 0)), /未知/);
  assert.throws(() => parseSign(words(1, 2, 300022, 5)), /列表/);
  assert.throws(() => encodeRequest({ command: 9193, role: 123, channel: 1, previous: 0, body: words(11, 6) }), /仅支持/);
});

test('reports server error status without treating it as progress', () => {
  const result = decodeResponse(response(9191, '', 1001));
  assert.equal(result.status, 1001); assert.equal(result.body.length, 0);
  assert.throws(() => parseProgress(result.body), /长度/);
});

test('factory works when injected in a browser without Node APIs', () => {
  const codec = runInNewContext(`(${createProtocol.toString()})()`, { TextEncoder, Uint8Array, ArrayBuffer, DataView });
  assert.equal(hex(codec.encryptBody(words(11, 6))), 'c36e2407872e0c660d');
  assert.equal(codec.nextSequence(1000, 9191, words(11)), 1016);
  assert.equal(codec.parseReward(words(1, 300022, 5)).rewards[0].id, 300022);
  assert.equal(codec.parseMedals(words(1, 42001, 5, 0, 1))[0].value, 5);
});
