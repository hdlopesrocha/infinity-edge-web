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

## Game channel (`server/`, `src/game/netgame.ts`, `src/game/protocol.ts`)

A second, independent channel on the same frame format. Here an **authoritative
C++ server** (`server/`) owns the game logic and every model position; the web
client becomes a renderer that draws the poses it receives and streams the
player's input back. Payloads are **binary** (never JSON) and gzip-compressed
with the asset-channel rule, except that the threshold is **64 bytes**
(`GZIP_THRESHOLD` in `server/src/proto.h`).

The server also serves the built client over HTTP, so the usual deployment is a
single origin reached with `?game=/game`:

```sh
cmake -S server -B build/server && cmake --build build/server -j
npm run build
build/server/ie-server --port 8091 --root dist         # http://127.0.0.1:8091/game (ws)
# open http://127.0.0.1:8091/?game=/game#/menu
```

`?game=` accepts `/game` (same origin), `host:port`, a full `ws(s)://` URL, or
`1` (meaning `ws://<page host>:8091/game`). `VITE_IE_GAME_WS` and
`window.__IE_GAME_WS` work as fallbacks. **With none configured — or when the
join fails or times out (15 s) — the page falls back to the local offline
`GameInstance`, so the original single-player game stays playable.** On an
`https:` page a bare path becomes `wss://`; because the C++ server only speaks
plain `ws://`, the Vite dev server proxies `/game` to it
(`IE_GAME_PROXY`, default `ws://127.0.0.1:8091`), which is how the HTTPS dev
page avoids mixed-content blocking.

Quantisation (the wire is lossy, deliberately): positions are `i16` over
`±mapSize/2` (2048 → 0.03 u), rotations are `i16` over `±1`, scale is `u16`
×256. `0xFFFF` (`NO_INDEX`) means "no model" / "no team".

### Message types

| Value | Name | Direction | Payload |
|---|---|---|---|
| 100 | `Scene` | server → client | level metadata, model/team tables, decor, sun/region |
| 101 | `Snapshot` | server → client | spawns, dynamic poses, removals (**every 30 Hz tick**) |
| 102 | `Events` | server → client | sounds, voices, explosions (visual/audio only) |
| 103 | `Hud` | server → client | match clock, team stats, player ship status |
| 104 | `Result` | server → client | match finished: won, reward, message |
| 105 | `Pong` | server → client | `u32 id` + `u32 serverMs` |
| 110 | `Join` | client → server | level choice + client options |
| 111 | `Input` | client → server | stick, throttle, buttons |
| 112 | `Leave` | client → server | empty |
| 113 | `Ping` | client → server | `u32 id` |
| 65535 | `Error` | server → client | `str message` |

`str` is `u16 byte length` + UTF-8 (as in the asset channel). "3×f32" style
repeats are written back to back, little-endian.

### Client → server frames

| Frame | Layout |
|---|---|
| `Join` | `str levelKey`, `u8 flags` (bit 0 = smart AI), `f32 cameraDistance`, `u8 axisX`, `u8 axisY` |
| `Input` | `f32 stickX`, `f32 stickY`, `f32 throttle`, `u8 bits` (1 fire, 2 homing, 4 nitro) |
| `Ping` | `u32 id` |
| `Leave` | — |

`Input` is sent every rendered frame while the match runs, and a neutral input
is sent at least every 250 ms even when idle, so a backgrounded tab or a
paused client never leaves the server flying on a stale stick.

### `Scene` (once, at join)

| Field | Notes |
|---|---|
| `u8 gameType` | 0 CTF, 1 TT, 2 BACK, 3 KOTS, 4 SURV |
| `str levelKey`, `str title`, `str text` | briefing metadata |
| `f32 mapSize`, `str sky`, `f32 matchTimeMs` | arena |
| `u32 playerId` | the id the player's ship will spawn with |
| `u16 modelCount` + `str alias` each | model table, sorted; used by every `modelIdx` |
| `u8 teamCount` + (`str name`, 3×`f32` color, `u8 enemyMask`) each | `enemyMask` bit *i* = team *i* (same list) is an enemy |
| `u16 decorCount` + (`f32` pos ×3, `f32` scale) each | miniStar billboards: scenery the client recreates |
| `u8 hasSun` (+ 3×`f32` pos, `f32` radius) | KOTS sun |
| `u8 hasRegion` (+ 3×`f32` pos, `f32` radius) | KOTS scoring region |

### `Snapshot` (30 Hz)

`u32 tick`, `u16 spawnCount` + spawns, `u16 poseCount` + poses,
`u16 removeCount` + `u32 id` each.

* **Spawn** (26 B): `u32 id`, `u8 kind`, `u8 state`, `u16 modelIdx`,
  `u16 teamIdx`, transform. Kinds: 0 ship, 1 asteroid, 2 addon, 3 base,
  4 flag, 5 bullet, 6 missile, 7 ark, 8 billboard (sun/region travel in
  `Scene`). `state` means: ship — bit 0 = the ship respawns (SS1R);
  addon — 0 homing, 1 life, 2 nitro, 3 shield; flag — 0 at base,
  1 carried, 2 free. Static entities (asteroid, addon, base, decor) spawn
  **once**; dynamics are spawned whenever the live set grows.
* **Transform** (16 B): `u16 scale` ×256, `i16 x,y,z`, `i16 rx,ry,rz,rw`.
* **Pose** (20 B): `u32 id` + transform — sent for ships, flags, arks,
  bullets and missiles every tick.
* **Removals**: ids that left the live set. A destroyed respawning ship is
  removed and **re-spawned later with the same id**; the client keeps the
  render object and hides it in between.

### `Events` (visual/audio only)

`u16 count`, then each record: `u8 type`. Type 0 `Sound`: `u8 sfxId`,
`u8 volume` (0–255), `i8 pan` (−127–127). Type 1 `Voice`: `u8 voiceId`.
Type 2 `Explosion`: `i16` pos ×3, `f32 scale`, `u16 life` ms, `u8 smoke`,
`u8 debris`, `u16 modelIdx`, `u32 seed`.

`sfxId` indexes `SFX` and `voiceId` indexes `VOICES` (`src/game/config.ts`);
the client plays the sample / shows the notification text. Explosions carry a
per-event **seed**: the client replays the burst with the same RNG sequence it
would have used locally (fireball, debris fragments, smoke), so every client
sees the identical explosion without perturbing its own RNG.

### `Hud` (30 Hz)

`u32 tick`, `f32 matchLeft` (−1: no clock), `u8 countdownSec`, `str deathCause`,
`u8 poolCount` + (`f32 value`, `f32 max`) each (the player's life pools — three
for Life3, one otherwise), `u8 outside` (+ 2×`f32` left/total),
`u8 respawn` (+ 2×`f32` left/total), `f32 speed`,
`u8 missileWarn`, `u8 lockOn`, `u8 homings`, `u8 nitroPct`,
`u8 teamCount` + (`str name`, `f32 points`, `f32 kills`, `f32 hillMs`,
`f32 timeMs`) each, `u8 shipCount` + (`u32 id`, `u8 lifePct`) each,
`u32 selectedId`, `u8 finished`.

`speed` is the selected ship's velocity magnitude; the client pins its drawn
velocity to it so the HUD readout and the zoom blur match the server exactly.

### Client behaviour (`src/game/netgame.ts`)

* `NetGame extends GameInstance` and is **render-only**: it applies
  Scene/Snapshot/Events/Hud and never steps the simulation.
* **Interpolation gutter**: each new snapshot restarts a 33 ms segment from
  wherever the object is currently drawn towards the new pose, so 30 Hz
  snapshots look smooth at any frame rate.
* Positions on `NetGame` are the drawn ones; `vel` is derived from the segment
  being interpolated (and pinned to the Hud `speed` for the player's ship) so
  engine smoke, the HUD and the zoom blur behave as in the local game.
* The wire never names a flag carrier: the client re-derives it geometrically
  each frame (nearest active ship within 4 u, else the team base within 4 u).
* Ship smoke, camera, HUD projection/pointers, aim reticle and notifications
  are all local; the server only sends the state they are drawn from.

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
