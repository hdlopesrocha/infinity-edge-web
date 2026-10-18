# Multiplayer (WebRTC + Nostr)

Infinity Edge can be played with friends: one player **creates a room** in the
browser, the room is announced on public [Nostr](https://github.com/nostr-protocol/nips)
relays, and every other player connects straight to the creator's browser over
**WebRTC data channels**. There is no game server of ours in the path — the
browser that created the room runs the authoritative simulation (the same local
simulation the single-player game uses) and streams the match to its guests
with the binary protocol the C++ server also speaks (`docs/protocol.md`,
"Game channel").

The whole lobby is **painted into the WebGL frame** (`src/game/mp/lobbyui.ts`
through `renderer.uiOverlay`): the multiplayer route renders no HTML at all.

## Playing

1. **Main menu → MULTIPLAYER**.
2. The list shows every room published on the relays that is younger than the
   selected filter (default **6 hours**; the `age · younger than …` dropdown
   offers 1, 3, 6, 12 and 24 hours and is remembered).
3. **CREATE A ROOM**: pick the game type (Capture the Flag / Time Trial /
   King of the System / Survival), the level and the room size, then
   **CREATE ROOM**. The room is signed with your key and published, and the
   match starts in your browser.
4. Other players see the room and press **JOIN**. They land in your match.
   Guests fly **with the host**: on team levels they take over an AI ship of the
   host's team (the AI resumes when they leave); on time trials a wingman ship
   is spawned for them. Up to `room size` players can be connected at once.
5. A room can be closed by its creator only (the **DELETE** button on your own
   rooms, or simply leaving the match). Rooms also expire on the relays 30
   minutes after the last heartbeat, so a crashed host does not leave a room
   listed forever.

Rooms from other clients are visible to everyone: the relay is a public
database, and the WebRTC candidates are public too (see below).

## What goes over Nostr

Two custom event kinds (all payloads are JSON in `content`):

| Kind | NIP class | Purpose |
|---|---|---|
| `30333` | addressable (30000–39999) | A room: `d` = room id, `t` = `ie3d-mp-room` + game type, `expiration` = NIP-40 TTL. Content: `{v, game, type, title, host, players, max, ice, created}`. Replaced by the host on heartbeats/player changes; only the author's key can replace or delete it. |
| `25050` | ephemeral (20000–29999) | Signalling: `d` = room id, `p` = recipient pubkey. Content: `{v, room, to, kind: offer\|answer\|ice\|bye, sdp?, candidates?[], name?}`. Relays forward these without storing them. |
| `5` | NIP-09 | Room deletion: an `a` tag `30333:<hostPubkey>:<roomId>`. Only an event signed by the room's author deletes it. |

The client verifies every signalling event's NIP-01 id and BIP-340 signature
before acting on it (`src/game/nostr/event.ts`, hand-rolled crypto in
`src/game/nostr/crypto.ts`); the room list trusts the relay's own signature
validation and re-verifies a room event when joining it.

### Connection setup

The guest initiates; all messages travel through the room's `d` tag and the
recipient's `p` tag:

```
guest                                   host (room creator)
  │ create RTCPeerConnection + data channel "game"
  │ publish {kind:"offer", sdp, name}  ──────────────────────────▶
  │                                        setRemoteDescription
  │                                        createAnswer
  │ ◀────────────────────── publish {kind:"answer", sdp}
  │ ◀────────────────────── publish {kind:"ice", candidates} (batched, 250 ms)
  │ publish {kind:"ice", candidates} ──────────────────────────▶
  │ ◀═══════════ RTCDataChannel "game" open (binary) ═══════════▶
```

Every guest gets its own `RTCPeerConnection` and its own data channel, so one
host serves several players concurrently. ICE servers default to
`stun:stun.l.google.com:19302` and are carried in the room event, so guests use
whatever the host configured. Host candidates + STUN connect on ordinary home
networks; a restrictive (symmetric) NAT needs a TURN server — pass one with
`?mpIce=turn:host:3478…` (username/credential TURN URLs are not supported by
the `?mpIce=` shorthand; use `window.__IE_MP_ICE` objects if you need them).

## Match channel

The host streams the same frames the C++ server sends (`server/src/session.cpp`
is the reference, `src/game/mp/host.ts` the browser implementation):

- on Join: `Scene` (level, model table, teams + enemy masks, decor, sun/region,
  **this guest's ship id**), then the first `Snapshot` (every live object), `Hud`.
- every 30 Hz wire tick (the browser sim runs at the display rate): `Snapshot`
  (spawns/poses/removals), `Events` (voices, sfx, explosions), `Hud` (personal:
  life pools, timers, speed, lock state, team table, per-ship life percentages).
- when the match ends: `Result`, then the room closes.

Guest input (`Input` frames: stick, throttle, fire, homing, nitro) steers the
guest's ship through the regular `HILocal` intelligence with a remote control
shim, so remote ships fly exactly like the local player's. Explosions replay on
every client from the event's seed; sounds are evaluated per viewpoint (each
guest hears distance/pan from its own ship).

## Dedicated server (no player, all computation on the server)

The C++ server can host a room itself: it publishes the room on Nostr, answers
the guests' WebRTC offers and runs the authoritative match. It has **no player
of its own** — every ship belongs to a guest, and all physics, collision
detection, AI and goals run on the server. Clients only send input and render
the frames they receive.

The server needs OpenSSL and libusrsctp development headers
(`libssl-dev`, `libusrsctp-dev`); the first CMake configure also fetches
libdatachannel (MIT) and libjuice/plog, then keeps them in the build directory.

```sh
npm run server:build          # first configure fetches libdatachannel
npm run build                 # the server also serves the client from dist/
npm run mp:server             # or: build/server/ie-server --room ctf-easy ...

# a local relay instead of the public ones:
node tools/relay.mjs --port 7777 &
build/server/ie-server --port 8097 --root dist --room ctf-easy \
  --nostr-relay ws://127.0.0.1:7777
# open http://127.0.0.1:8097/?mp=ws://127.0.0.1:7777#/multiplayer
```

| flag | meaning |
|---|---|
| `--room <level>` | host this level (`ctf-easy`, `tt-easy-01`, `kots-solo-easy`, …) |
| `--room-name <s>` | host name shown in the lobby (default "Infinity Edge Server") |
| `--room-max <n>` | maximum guests (2–32, default 8) |
| `--nostr-relay <urls>` | comma-separated relays (default `wss://nos.lol,wss://relay.snort.social`) |
| `--nostr-key-file <path>` | room identity key, persisted (default `ie-server-nostr.key`) |
| `--nostr-key <hex>` | fixed identity key instead of the file |
| `--stun <urls>` | ICE servers advertised in the room (default Google STUN) |

The server keeps the same room id across rounds: when the match ends it sends
`Result`, closes the guest channels after 1.5 s, and starts a fresh round 8 s
later (the room stays listed). `/mp/status` returns the room id, level, guest
count, relay count and the server's public key as JSON — handy for monitoring
and used by the e2e. SIGINT/SIGTERM close the room politely (NIP-09 deletion).

Guest ships use the same rule as the browser host: the first guest takes over
the level's player ship, further guests take free AI ships of the same team,
and if none is left a wingman is spawned next to it (the AI brain resumes when
a guest leaves). Each guest gets its own `RTCPeerConnection`, data channel,
Scene/Snapshot/Events/Hud stream and personal HUD (life pools, respawn timer,
speed, lock warning).

The end-to-end test runs the real server against the local relay and two
browser tabs (join, authoritative HUD, throttle moving the ship on the server,
`/mp/status` player count, and the result/restart round trip):

```sh
npm run mp:server-e2e                      # 2 guests, PASS/FAIL
npm run mp:server-e2e -- --level ctf-easy --guests 2
npm run mp:server-e2e -- --server /path/to/ie-server --app-port 8097
```

Testing hooks: `POST /mp/finish` ends the current round immediately (used by
the e2e); `--auto-finish <seconds>` does the same on a timer. Both are safe to
leave unused in production.

## Configuration

- Relays: `?mp=wss://relay.example` (comma separated), then
  `window.__IE_MP_RELAYS`, then `VITE_IE_MP_RELAYS`, then
  `wss://nos.lol,wss://relay.snort.social`. Persisted in
  `localStorage["ie.mp.config"]`.
- ICE servers: `?mpIce=stun:…`, `window.__IE_MP_ICE`, `VITE_IE_MP_ICE`.
- Identity: a random secret key generated on first use and stored in
  `localStorage["ie.mp.identity"]` (`?mpKey=<hex>` overrides it for tests and
  for several players sharing one browser profile).
- Identity is *yours*: it signs your rooms, so only you can delete them.

## Testing

```sh
npm run mp:relay        # minimal local relay on ws://127.0.0.1:7777
npm run build
npm run server:run      # serves dist/ on http://127.0.0.1:8091
npm run mp:e2e          # host + one guest, real browser, PASS/FAIL
npm run mp:e2e -- --guests 2            # several data channels at once
npm run mp:e2e -- --level ctf-easy --type CTF --level-idx 0
```

`tools/mp-e2e.mjs` drives two or more headless Chrome tabs through the actual
lobby UI: room publishing, listing, joining, the RTC handshake, Scene/Hud
delivery, and guest throttle reaching the host simulation (it fails if the
guest's HUD speed does not rise). Screenshots of the lobby and of the guest's
match are written to `/tmp/opencode/shots` (override with `MP_E2E_SHOTS`).

The Nostr layer has its own tests: `tests/nostr.test.ts` runs the official
BIP-340 vectors plus nostr-tools cross-check fixtures; `tests/mp-rooms.test.ts`
runs the room lifecycle against the local relay; `tests/mp-host.test.ts`
decodes the host's frames with the client codec. A live relay test is opt-in:

```sh
IE_NOSTR_TEST=1 npx vitest run tests/relay.integration.test.ts
```
