// Observe only the public login server's 120 response. The maintenance text
// resource is a template that is also loaded when the game is available.
// Keep packets and socket URLs inside the official page; expose one boolean.
export function installServerAvailability(gameOrigin) {
  if (window.top !== window || location.origin !== gameOrigin || typeof window.WebSocket !== 'function') return;
  if (window.__flowerServerAvailability?.version === 1) return;
  const NativeSocket = window.WebSocket;
  const watched = new WeakSet();
  let latest;
  function watch(sockets) {
    for (const socket of sockets) {
      if (watched.has(socket) || !URL.canParse(socket.url) || new URL(socket.url).hostname !== 'ws-hua.61.com') continue;
      watched.add(socket);
      socket.addEventListener('message', async event => {
        const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (!bytes || bytes.length > 4 * 1024 * 1024) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let at = 0; at + 17 <= bytes.length;) {
          const length = view.getUint32(at);
          if (length < 17 || at + length > bytes.length) break;
          if (length >= 21 && view.getUint32(at + 5) === 120 && view.getInt32(at + 13) === 0) {
            latest = { socket, maintenance: view.getUint32(at + 17) <= 2 };
          }
          at += length;
        }
      });
    }
  }
  Object.defineProperty(window, '__flowerServerAvailability', {
    value: Object.freeze({
      version: 1, watch,
      read: () => ({
        known: latest?.socket.readyState === NativeSocket.OPEN,
        maintenance: latest?.socket.readyState === NativeSocket.OPEN && latest.maintenance === true,
      }),
    }),
  });
  window.WebSocket = new Proxy(NativeSocket, {
    construct(target, args, receiver) {
      const socket = Reflect.construct(target, args, receiver);
      watch([socket]);
      return socket;
    },
  });
}
