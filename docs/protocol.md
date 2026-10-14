# WebSocket binary protocol

The original InfinityEdge3D is an offline Windows Phone game: it has no server
and no networking code. This channel therefore **replaces the device's local
content store**, not an existing network protocol. It carries exactly the same
converted assets the HTTP path serves (`Level.xml` → JSON, `modelN.xnb` → JSON
+ `.bin`), and it is **optional**: with no URL configured the application
behaves like the original and reads everything over HTTP.

Enable it by pointing the client at `tools/asset-server.mjs`:

```sh
npm run asset-server                       # ws://127.0.0.1:8090/assets (+ static HTTP on the same port)
npm run dev                                # app on http://127.0.0.1:5173
# open http://127.0.0.1:5173/?ws=ws://127.0.0.1:8090/assets#/menu
```

The URL also comes from `VITE_IE_WS` (build time) or `window.__IE_WS_URL`
(embedding); `?ws=` wins. Without any of them the channel stays `disabled` and
no socket is opened.

## Frame format

Every WebSocket message is one frame: an 8-byte little-endian header followed
by the payload.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 1 | `version` | protocol version, currently `1`; a different value is rejected |
| 1 | 1 | `flags` | bit 0 = `GZIP`, bits 1–7 reserved (must be 0) |
| 2 | 2 | `type` | message type (table below) |
| 4 | 4 | `payloadLength` | payload bytes **as transmitted** (after compression) |
| 8 | n | `payload` | see the per-type layout |

The compression flag makes the two cases unambiguous: a receiver never has to
guess whether a payload is gzip or not, and never tries to decompress a raw
payload (or vice versa).

### Compression rules (both directions)

* Payloads **below 256 bytes** are always sent raw (`GZIP_THRESHOLD`). The
  gzip header/trailer would cost more than the payload saves.
* Payloads **at or above 256 bytes** are gzip-compressed **only if the result is
  strictly smaller** than the original; otherwise the raw bytes are sent and the
  flag stays clear. (Vertex data and already-compressed textures therefore stay
  raw; JSON metadata compresses 60–90 %.);
* The flag is the only signal. There is no "auto" negotiation: the sender
  decides per message and records the decision in bit 0.

### Message types

| Value | Name | Direction | Payload |
|---|---|---|---|
| 1 | `Hello` | client → server | JSON `{client, version, capabilities}` |
| 2 | `LevelRequest` | client → server | JSON `{id, file}` — e.g. `assets/levels/tt-easy-01` |
| 3 | `LevelData` | server → client | JSON `{id, file, data:<LevelJson>}` |
| 4 | `ModelRequest` | client → server | JSON `{id, file}` — e.g. `assets/models/Fighter3.json` |
| 5 | `ModelData` | server → client | JSON `{id, file, data:<ModelJson>}` |
| 6 | `ScoresSync` | both | JSON `{id, scores:[...]}` (reserved; scores live in localStorage) |
| 7 | `Ping` | both | JSON `{id?}` |
| 8 | `Pong` | both | JSON `{id?, t}` |
| 9 | `GhostData` | both | framed ghost run bytes (`src/game/ghost.ts`) |
| 10 | `BinaryRequest` | client → server | JSON `{id, file}` — e.g. `assets/models/Fighter3.bin` |
| 11 | `BinaryData` | server → client | `u32 metaLength` + JSON `{id, file, byteLength}` + `byteLength` raw bytes |
| 65535 | `Error` | server → client | JSON `{id?, message}` |

`BinaryData` is the only type whose payload is not pure JSON: the correlation
id lives in the small JSON header so the vertex bytes can be forwarded
untouched (no re-encoding, no copy into a JSON string).

All file paths are relative to the site base and must start with `assets/`;
the server resolves them under its root and refuses anything else.

## Client behaviour (`src/game/netclient.ts`, `src/game/assetfetch.ts`)

* The socket is opened on first use, idempotently; failures schedule a
  **reconnect with exponential backoff** (1 s → 15 s).
* Requests are **correlated by `id`** and time out after 8 s. A timeout, an
  `Error` frame, a malformed frame or a closed socket **falls back to HTTP** for
  that asset, so scene loading never stalls on the channel.
* Malformed input is never thrown at a caller: truncated headers, wrong
  versions, decompression failures and malformed JSON are logged, counted in
  `channel.status().errors`, and after 3 malformed messages the socket is
  recycled.
* Payload size is validated against the declared `byteLength`; a mismatch is
  treated as a malformed response.
* Everything is asynchronous and off the render path: asset requests resolve
  during level/instance construction, never inside `beginFrame`/`draw`.
* `window.__ieNet.status()` exposes `{state, url, attempts, sent, received,
  errors}` for debugging; `?ws=` off means `state: "disabled"`.

## Server (`tools/asset-server.mjs`)

Node + `ws`, no other dependencies. It serves the `public/` tree over HTTP
(same content as `vite preview`) and implements the channel on `/assets`:

* `noServer` upgrade routing — `/assets` (with or without a trailing slash)
  becomes a WebSocket, any other path stays HTTP and is answered with 404.
* Validates `version`, the gzip flag, JSON bodies and asset existence; every
  failure becomes an `Error` frame instead of a dropped connection.
* Logs each transfer with its payload and wire size, plus a periodic summary,
  which is what the numbers in `MIGRATION.md` are taken from
  (e.g. CTF Easy: 108 frames, 2 127 303 B payload → 811 495 B on the wire).
