// Read only the player's date list and structural diagnostics. This function is also embedded in the browser listener.
export function readSignTraffic(data, signCommand = 9191, heartbeatCommand = 30002) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const result = { heartbeat: false, signResponse: false, days: null, packets: 0, signDiagnostic: null, todaySignReply: null };
  function readDates(offset, length) {
    const status = view.getUint32(offset + 13);
    const diagnostic = { length, status, reason: 'ok' };
    result.signDiagnostic = diagnostic;
    if (status !== 0) { diagnostic.reason = 'nonzero-status'; return; }
    if (length < 33) { diagnostic.reason = 'short-body'; return; }
    if ((length - 33) % 4 !== 0) { diagnostic.reason = 'unaligned-body'; return; }
    const count = view.getUint32(offset + 25);
    const end = offset + length;
    const otherOffset = offset + 29 + count * 4;
    if (count > 366 || otherOffset + 4 > end) { diagnostic.reason = 'first-list-length'; return; }
    const otherCount = view.getUint32(otherOffset);
    if (otherCount > 366 || otherOffset + 4 + otherCount * 4 !== end) { diagnostic.reason = 'second-list-length'; return; }
    const days = Array.from({ length: count }, (_, i) => view.getUint32(offset + 29 + i * 4));
    if (new Set(days).size !== days.length || days.some(d => d > 366)) { diagnostic.reason = 'invalid-days'; return; }
    result.days = days;
  }
  let offset = 0;
  while (offset + 17 <= view.byteLength) {
    const length = view.getUint32(offset);
    if (length < 17 || length > view.byteLength - offset) break;
    const command = view.getUint32(offset + 5);
    result.packets++;
    if (command === heartbeatCommand) result.heartbeat = true;
    if (command === 9192) result.todaySignReply = { length, status: view.getUint32(offset + 13) };
    if (command === signCommand) {
      result.signResponse = true;
      readDates(offset, length);
    }
    offset += length;
  }
  return result;
}
