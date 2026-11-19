import { readSignTraffic } from '../game/sign-traffic.mjs';
// Attach a read-only listener to the official client’s existing game connection.
export async function watchOpenSockets(client, { origin, host, signCommand, heartbeatCommand, duration }) {
  const group = 'flower-existing-connection';
  const { result: prototype } = await client.send('Runtime.evaluate', {
    expression: `location.origin === ${JSON.stringify(origin)} ? WebSocket.prototype : null`, objectGroup: group,
  });
  if (!prototype.objectId) return null;
  async function release() {
    await client.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {});
  }
  try {
    const { objects } = await client.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId, objectGroup: group });
    const { result, exceptionDetails } = await client.send('Runtime.callFunctionOn', {
      objectId: objects.objectId, functionDeclaration: `function(...args) { return (${observe}).call(this, ${readSignTraffic}, ...args); }`,
      arguments: [host, signCommand, heartbeatCommand, duration].map(value => ({ value })), objectGroup: group,
    });
    if (exceptionDetails || !result.objectId) { await release(); return null; }
    return {
      async read() {
        const { result: snapshot } = await client.send('Runtime.callFunctionOn', {
          objectId: result.objectId, functionDeclaration: 'function () { return this.read(); }', returnByValue: true,
        });
        return snapshot.value;
      },
      async close() {
        await client.send('Runtime.callFunctionOn', {
          objectId: result.objectId, functionDeclaration: 'function () { this.stop(); }',
        }).catch(() => {});
        await release();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

function observe(decode, host, signCommand, heartbeatCommand, duration) {
  const sockets = this.filter(socket => socket.readyState === WebSocket.OPEN && new URL(socket.url).host === host);
  if (!sockets.length) return null;
  const controller = new AbortController();
  let heartbeat = false;
  let signResponse = false;
  let signDiagnostic = null;
  let todaySignReply = null;
  let days = null;
  let multiPacketSeen = false;
  const timer = duration == null ? null : setTimeout(() => controller.abort(), duration);
  async function onMessage({ data }) {
    const length = data instanceof Blob ? data.size : data.byteLength;
    if (!(length >= 17 && length <= 4194304)) return;
    const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
    if (!(buffer instanceof ArrayBuffer)) return;
    const frame = decode(new Uint8Array(buffer), signCommand, heartbeatCommand);
    if (frame.todaySignReply) todaySignReply = { ...frame.todaySignReply, time: Date.now(), sequence: (todaySignReply?.sequence ?? 0) + 1 };
    heartbeat ||= frame.heartbeat;
    signResponse ||= frame.signResponse;
    if (frame.signDiagnostic) signDiagnostic = { ...frame.signDiagnostic, time: Date.now() };
    multiPacketSeen ||= frame.packets > 1;
    if (frame.days !== null) days = frame.days;
  }
  for (const socket of sockets) socket.addEventListener('message', onMessage, { signal: controller.signal });
  return {
    read: () => ({ heartbeat, signResponse, days, multiPacketSeen, signDiagnostic, todaySignReply }),
    stop() { clearTimeout(timer); controller.abort(); },
  };
}
