// Tiny preview socket for the sim params browser tests. Speaks one text frame
// per message so an open /neural-dance/sim/ tab can apply a push without a deploy.
import {createHash} from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function encodeServerText(text) {
  const payload = Buffer.from(String(text));
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x81, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function createSimPreviewHub() {
  let overrides = {};
  let revision = 0;
  let version = 'aaaa1111';
  const sockets = new Set();

  function snapshot() {
    return {ok: true, live: true, revision, overrides: copy(overrides)};
  }

  function message(reset) {
    return {type: 'params', ok: true, live: true, revision, overrides: copy(overrides), reset: reset === true};
  }

  function broadcast(reset) {
    const frame = encodeServerText(JSON.stringify(message(reset)));
    for (const socket of sockets) {
      try { socket.write(frame); } catch { sockets.delete(socket); }
    }
  }

  function send(socket, payload) {
    try { socket.write(encodeServerText(JSON.stringify(payload))); } catch { sockets.delete(socket); }
  }

  return {
    snapshot,
    version() { return version; },
    setVersion(next) { version = String(next); },
    clients() { return sockets.size; },
    push(partial) {
      const rest = {...(partial || {})};
      const masses = rest.masses;
      delete rest.masses;
      overrides = {...overrides, ...rest};
      if (masses && typeof masses === 'object') overrides.masses = {...(overrides.masses || {}), ...masses};
      revision += 1;
      broadcast(false);
      return snapshot();
    },
    reset() {
      overrides = {};
      revision += 1;
      broadcast(true);
      return snapshot();
    },
    handleUpgrade(req, socket) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.replace(/\/+$/, '') !== '/api/neural-dance/sim/params/ws') {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) { socket.destroy(); return; }
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => sockets.delete(socket));
      send(socket, message(false));
    }
  };
}

function copy(value) {
  const out = {};
  for (const key of Object.keys(value || {})) {
    if (key === 'masses' && value.masses && typeof value.masses === 'object') out.masses = {...value.masses};
    else out[key] = value[key];
  }
  return out;
}
