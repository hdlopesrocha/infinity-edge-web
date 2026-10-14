// Dev asset/scene server: HTTP static host + WebSocket binary channel.
//
//   node tools/asset-server.mjs [--port 8090] [--root public] [--host 127.0.0.1]
//
// The HTTP side is the normal `vite preview` equivalent (so the app also works
// without the channel). The WebSocket side implements docs/protocol.md:
// 8-byte little-endian header (version, flags, u16 type, u32 payload length),
// gzip flag for payloads >= 256 bytes that actually shrink, JSON payloads with
// an `id` used for request/response correlation, and Error frames carrying a
// message. Level/model JSON is gzip-compressed on the wire; model vertex data
// travels as raw binary (BinaryData) and is compressed the same way.
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
};
const PORT = Number(arg('--port', '8090'));
const HOST = arg('--host', '127.0.0.1');
const ROOT = resolve(arg('--root', 'public'));

const PROTOCOL_VERSION = 1;
const FLAG_GZIP = 0x01;
const GZIP_THRESHOLD = 256;
const HEADER = 8;

const T = {
  Hello: 1, LevelRequest: 2, LevelData: 3, ModelRequest: 4, ModelData: 5,
  ScoresSync: 6, Ping: 7, Pong: 8, GhostData: 9, BinaryRequest: 10,
  BinaryData: 11, Error: 0xffff,
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// ---- framing --------------------------------------------------------------
function encodeFrame(type, payload, forceCompress = undefined) {
  let body = payload;
  let compressed = false;
  const allow = forceCompress ?? payload.length >= GZIP_THRESHOLD;
  if (allow && payload.length >= GZIP_THRESHOLD) {
    const gz = gzipSync(payload);
    if (gz.length < payload.length) {
      body = gz;
      compressed = true;
    }
  }
  const out = Buffer.alloc(HEADER + body.length);
  out.writeUInt8(PROTOCOL_VERSION, 0);
  out.writeUInt8(compressed ? FLAG_GZIP : 0, 1);
  out.writeUInt16LE(type, 2);
  out.writeUInt32LE(body.length, 4);
  body.copy(out, HEADER);
  return out;
}

function decodeFrame(buf) {
  if (buf.length < HEADER) throw new Error('truncated header');
  const version = buf.readUInt8(0);
  if (version !== PROTOCOL_VERSION) throw new Error('bad version ' + version);
  const flags = buf.readUInt8(1);
  const type = buf.readUInt16LE(2);
  const len = buf.readUInt32LE(4);
  if (buf.length < HEADER + len) throw new Error('truncated payload');
  let body = buf.subarray(HEADER, HEADER + len);
  if (flags & FLAG_GZIP) body = gunzipSync(body);
  return { type, flags, body };
}

const json = (o) => Buffer.from(JSON.stringify(o), 'utf8');

// ---- HTTP ----------------------------------------------------------------
function safeFile(urlPath) {
  const p = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const full = join(ROOT, p);
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return null;
  return full;
}

const server = createServer((req, res) => {
  let file = safeFile(req.url === '/' ? '/index.html' : req.url);
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file || !existsSync(file)) {
    // SPA fallback (hash routing needs no rewrites, but deep links to files do).
    const index = join(ROOT, 'index.html');
    if (existsSync(index)) {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
  });
  createReadStream(file).pipe(res);
});

// ---- WebSocket channel ---------------------------------------------------
// noServer: the upgrade is routed manually below so the channel path is
// explicit (`/assets`), while every other path stays HTTP.
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
const CHANNEL_PATH = '/assets';
let frames = 0;
let compressedBytes = 0;
let rawBytes = 0;

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

// `/assets` is the channel; anything else on the socket is refused so the
// endpoint is unambiguous (static files are served over HTTP by the same port).
server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
  if (path !== CHANNEL_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  log('channel open', req.socket.remoteAddress);
  const send = (type, payload, force) => {
    const frame = encodeFrame(type, payload, force);
    ws.send(frame);
    const flags = frame.readUInt8(1);
    rawBytes += payload.length;
    if (flags & FLAG_GZIP) compressedBytes += frame.length - HEADER;
    frames++;
  };
  const error = (id, message) => send(T.Error, json({ id, message }), false);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = decodeFrame(data);
    } catch (e) {
      log('malformed frame:', e.message);
      error(undefined, 'malformed frame: ' + e.message);
      return;
    }
    let body = {};
    if (msg.body.length) {
      try {
        body = JSON.parse(msg.body.toString('utf8'));
      } catch (e) {
        error(body.id, 'malformed JSON body: ' + e.message);
        return;
      }
    }
    const id = body.id;
    switch (msg.type) {
      case T.Hello:
        log('hello from', body.client ?? 'unknown', 'v' + (body.version ?? '?'));
        break;
      case T.Ping:
        send(T.Pong, json({ id, t: Date.now() }), false);
        break;
      case T.LevelRequest:
      case T.ModelRequest: {
        const file = String(body.file ?? '');
        const full = safeFile('/' + file);
        if (!full || !existsSync(full)) {
          error(id, 'asset not found: ' + file);
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(readFileSync(full, 'utf8'));
        } catch (e) {
          error(id, 'asset is not valid JSON: ' + file + ' (' + e.message + ')');
          return;
        }
        // JSON metadata: {id, file, data:<asset>}, gzipped when it pays off.
        const payload = json({ id, file, data: parsed });
        send(msg.type === T.LevelRequest ? T.LevelData : T.ModelData, payload, true);
        log('json  ', file, payload.length + 'B payload');
        break;
      }
      case T.BinaryRequest: {
        const file = String(body.file ?? '');
        const full = safeFile('/' + file);
        if (!full || !existsSync(full)) {
          error(id, 'asset not found: ' + file);
          return;
        }
        const bytes = readFileSync(full);
        // Raw data payload: [u32 metaLength][json {id,file,byteLength}][bytes]
        const meta = json({ id, file, byteLength: bytes.length });
        const head = Buffer.alloc(4);
        head.writeUInt32LE(meta.length, 0);
        const payload = Buffer.concat([head, meta, bytes]);
        send(T.BinaryData, payload, true);
        log('binary', file, bytes.length + 'B payload, ' + payload.length + 'B framed');
        break;
      }
      default:
        error(id, 'unknown message type ' + msg.type);
    }
  });
  ws.on('close', () => log('channel closed'));
  ws.on('error', (e) => log('channel error', e.message));
});

server.listen(PORT, HOST, () => {
  log(`asset server http://${HOST}:${PORT}  (root ${ROOT})`);
  log(`websocket ws://${HOST}:${PORT}/assets`);
  log('open the app with: ' + `http://${HOST}:${PORT}/?ws=ws://${HOST}:${PORT}/assets#/menu`);
});

setInterval(() => {
  if (frames) {
    log(`stats: frames=${frames} payload=${rawBytes}B wire=${compressedBytes}B`);
    frames = 0;
    compressedBytes = 0;
    rawBytes = 0;
  }
}, 15000).unref();
