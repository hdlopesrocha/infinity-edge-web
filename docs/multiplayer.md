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
   King of the System / Survival), the level, the room size and an optional
   **password** (leave it empty for an open room), then **CREATE ROOM**. The
   room is signed with your key and published, and you land in its **room
   menu** — the match does not start yet.
4. Other players see the room and press **JOIN**; a locked room asks for its
   password first. They land in the *same room menu*: the roster, the team
   picker, the chat and the **MIC** toggle are shared. The host can also open
   the room menu alone and wait.
5. When everyone is in, the host presses **PLAY**; the match starts for all
   pilots at once. Guests fly the team chosen for them in the room menu: on
   team levels they take over an AI ship of that team (the AI resumes when they
   leave) or a wingman is spawned on it; the host may move itself to another
   team too. Up to `room size` players can be connected at once.
6. **Leaving the room menu does not close the room.** Going back from the room
   menu (or the lobby) keeps the hosted room alive — the host keeps its roster,
   chat and peer connections, and the lobby shows **RETURN TO ROOM** to re-open
   it. A guest that leaves can join the room again from the lobby. A room is
   closed only by its explicit **CLOSE ROOM** action (or the **DELETE** button
   on your own room), by creating a fresh room, or by expiry. Rooms expire on
   the relays 30 minutes after the last heartbeat, so a crashed host does not
   leave a room listed forever.

Dedicated-server rooms skip the room menu (there is nobody to press PLAY):
they carry `srv: true` in the room content and a JOIN goes straight into the
match.

Rooms from other clients are visible to everyone: the relay is a public
database, and the WebRTC candidates are public too (see below).

## What goes over Nostr

Two custom event kinds (all payloads are JSON in `content`):

| Kind | NIP class | Purpose |
|---|---|---|
| `30333` | addressable (30000–39999) | A room (a "post"): `d` = room id, `p` = the room-board profile (below), `t` = game type, `expiration` = NIP-40 TTL. Content: `{v, game, type, title, host, players, max, ice, created, cert, sid, pw?, salt?, srv?}` (`srv: true` = dedicated server, join starts immediately; `pw: true` + `salt` = password protected, the password itself is never published; `sid` = the current signalling session id). Replaced by the host on heartbeats/player changes; only the author's key can replace or delete it. |
| `1` | regular (stored) | A room **comment**: the host's SDP offer, posted under the room. `a` = the room coordinate (`30333:<host>:<roomId>`), `e` = the room event it comments, `p` = the host. Content: the same signal JSON. Stored, so a guest that joins late still finds the offer; deleted (NIP-09 `e`) once claimed or replaced. |
| `25050` | ephemeral (20000–29999) | Signalling: `d` = room id, `p` = recipient pubkey. Content: `{v, room, to, kind: offer\|answer\|ice\|bye\|join, sdp?, candidates?[], name?, sig?, offerId?, sid?, enc?}`. Relays forward these without storing them. Browser-hosted offers are comments (kind 1); this kind carries the guest's `join` and the host's ICE/bye. |
| `5` | NIP-09 | Room deletion: an `a` tag `30333:<hostPubkey>:<roomId>`, `p` = the room-board profile. Offer comments are deleted by `e` tag. Only an event signed by the author deletes it. |

**The lobby is a profile.** There is no global room tag/key: a room is just a
post that tags the board profile
`npub1g3lwkzwzz0h644spdsj52t8j7j8vwhg6299e57hhexvh0vfxnzesyvxla7`
(`src/game/nostr/event.ts`, `ROOM_BOARD_PUBKEY`), so the lobby subscribes to
`{kinds:[30333,5], '#p':[<board>]}`. Closing a room is deleting your own post.

The client verifies every signalling event's NIP-01 id and BIP-340 signature
before acting on it (`src/game/nostr/event.ts`, hand-rolled crypto in
`src/game/nostr/crypto.ts`); the room list trusts the relay's own signature
validation and re-verifies a room event when joining it.

### Connection setup

The **host is the offerer** for browser-hosted rooms (dedicated-server rooms
keep the guest-offer flow the C++ server implements). When the host enters the
room it **comments on the room post** with its SDP offer (a stored kind-1 event
tagged `a` = the room coordinate); the guest answers that comment with a
**NIP-04 DM** to the host, and the host starts the data channel when it receives
the answer. `offerId` ties the answer and the ICE candidates back to the right
guest slot.

```
guest                                   host (room creator)
  │ subscribe to the room's comments (a) + signals addressed to us
  │                                        enter the room, create RTCPeerConnection + "game"
  │                                        createOffer, sign the SDP (room certificate)
  │ ◀────── comment {kind:"offer", offerId, sdp, sig} on the room post
  │ setRemoteDescription, verify the certificate signature
  │ createAnswer
  │ send {kind:"answer", offerId, sdp, name} as a NIP-04 DM ───▶
  │                                        setRemoteDescription (completes that peer)
  │                                        delete the claimed comment, post the next offer
  │ ◀──────────────────── DM {kind:"ice", offerId, candidates}
  │ DM {kind:"ice", offerId, candidates} ──────────────────────▶
  │ ◀═══════════ RTCDataChannel "game" open (binary) ═══════════▶
  │ send {kind:"auth-request", nonce} (channel challenge) ─────▶
  │ ◀────────────────────── {kind:"auth-ok", sig}
```

The host keeps one offer comment per free guest slot (`hostOffers`); because the
comments are stored, a guest that joins later still finds one (no timer or
`join`-triggered refresh is needed). Every guest gets its own
`RTCPeerConnection` and data channel (the host creates the channel because it
is the offerer), so one host serves several players concurrently. ICE servers
default to
`stun:stun.l.google.com:19302` and are carried in the room event, so guests use
whatever the host configured. Host candidates + STUN connect on ordinary home
networks; a restrictive (symmetric) NAT needs a TURN server — pass one with
`?mpIce=turn:host:3478…` (username/credential TURN URLs are not supported by
the `?mpIce=` shorthand; use `window.__IE_MP_ICE` objects if you need them).

### Password-protected rooms

A room created with a password publishes **only a flag and a random salt**
(`pw: true`, `salt`) — never the password. Both ends derive the same AES-GCM
key from `password + salt` with **PBKDF2-SHA256** (150 000 rounds) and use it
to seal the sensitive part of every signalling message: the SDP (which carries
the DTLS fingerprint), the ICE candidates, the nickname and the certificate
signature. The routing fields (`kind`, `room`, `to`, `offerId`, `sid`) stay
readable; the sealed payload travels as `enc` (base64 `iv || ciphertext`).

- The implementation is dependency-free WebCrypto (`src/game/mp/crypto.ts`):
  `deriveKey`, `encryptJson`/`decryptJson`, and the `sealSignal`/`openSignal`
  wrappers the manager uses.
- A wrong password shows up as an offer the guest cannot decrypt; the join
  fails with "wrong room password" and never negotiates.
- Unprotected rooms keep plaintext signalling byte-for-byte as before.
- The salt is public and per room; the password is entered in the lobby's
  CREATE ROOM field or in the JOIN prompt for a locked room.

### Reconnect cleanup

Each host session has a random session id (`sid`): it is published in the room
event and stamped on every offer/answer/ICE message. When the host re-enters a
room after its signalling subscription was lost, it **rotates the session id**,
deletes the previous session's offers (NIP-09 by event id) and republishes the
room and fresh offers. Receivers ignore any signal whose `sid` does not match
the current session (and, on the host, anything older than the session start),
so stale offers/answers/ICE are never reused. Room heartbeat/replace semantics
are unchanged: the addressable room event is rewritten on each heartbeat and
only the author's key can replace or delete it.

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

## Waiting room (browser-hosted rooms)

`CREATE ROOM` opens `#/room` (`src/views/RoomView.vue` and
`src/game/mp/roomui.ts`, painted into the WebGL frame like the lobby); no HTML
is rendered there either. The host owns the room state; the guests mirror it.

- **Host → guests** (`Room` frame, message id `122`, JSON in the payload):
  `{t:'state', level, title, max, phase, teams, you, players:[{name, pubkey,
  team, mic, host}]}` after every change, `{t:'chat', from, text, system}`,
  `{t:'start', level}` and `{t:'closed', reason}`.
- **Guest → host**: `{t:'hello', name}`, `{t:'team', team}`,
  `{t:'chat', text}`, `{t:'mic', on}`. The host checks the team against the
  level's combatant teams and re-broadcasts the roster, so a guest cannot spoof
  another pilot's team, name or microphone state.
- **Chat** is a trimmed text line (200 characters max) relayed by the host;
  every pilot sees the same log, and joins/leaves are system lines.
- **Voice**: the **MIC** button captures the microphone (`getUserMedia`),
  resamples to 16 kHz mono PCM and sends `Voice` frames (message id `121`:
  `[u8 speaker][int16 little-endian samples]`). The host plays each guest's
  chunks locally and relays them to the other guests with the guest's roster
  index, so the star topology needs no extra peer connections.
  `src/game/mp/voice.ts` owns capture, resampling and the bounded playback
  queue (latency stays bounded by dropping audio older than 250 ms); the wire
  format is frozen and covered by `tests/voice.test.ts`.
- **Teams**: the picker offers the level's combatant teams (`team1`, `team2`,
  …) or `auto` (the level default); the host may change any pilot's team, a
  guest may change its own. On PLAY the picks are applied in the match: the
  host's ship moves to its chosen team (team bookkeeping and base), and each
  guest's Join adopts an AI ship of its team or spawns a wingman on it.
- **PLAY** is host-only (guests see "waiting for the host"). Leaving the room
  menu keeps a hosted room alive — the host re-opens it from the lobby with
  **RETURN TO ROOM** (its roster and chat survive) and a guest says `bye` and
  can join again from the lobby. Chat and voice frames keep flowing on the
  same data channels during the match (the client has no in-match chat UI yet).

The room menu renders no DOM: the roster (players plus the level's read-only
bots, narrowed by the shared team filter, which starts on Team 1), team
dropdowns, chat log/input, the mic meter, PLAY and the corner buttons are all
part of the WebGL overlay.

## Dedicated server (no player, all computation on the server)

The C++ server can host a room itself: it publishes the room on Nostr, answers
the guests' WebRTC offers and runs the authoritative match. It has **no player
of its own** — every ship belongs to a guest, and all physics, collision
detection, AI and goals run on the server. Clients only send input and render
the frames they receive.

Its room events carry `srv: true`, so browser clients joining one skip the
waiting room and go straight into the running match (there is no host UI to
press PLAY in); the server starts the match itself.

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

## Host identity and channel authentication

A room is signed by its creator's Nostr key, so relays cannot forge or alter
it. On top of that the client enforces two bindings before it even sends a
`Join`:

1. **Room certificate.** When creating a room the host generates an ephemeral
   **P-256** key pair and publishes a certificate with the room: the SPKI
   public key, `created`/`expires`, and a **BIP-340 signature by the room's
   Nostr key** over `ie3d-mp-cert-v1|room|host|created|expires|key`. The host
   signs every **SDP it produces** (which carries the DTLS fingerprint) with
   the certificate key: `ie3d-mp-answer-v1|room|from|to|sha256(sdp)` — the
   host's **offer comment** for a browser-hosted room (with an empty `to`,
   since it is unaddressed), or the **answer** the C++ server sends to a
   guest's offer. A
   guest refuses to negotiate with an SDP whose certificate signature does not
   verify — another client or a relay cannot substitute its own WebRTC
   endpoint. This is implemented identically in the browser host
   (`src/game/mp/cert.ts`) and in the C++ server (`server/src/nostr_crypto.*`,
   `server/src/dedicated.cpp`), so the same guest checks work against both.
2. **Channel challenge.** Immediately after the data channel opens, the guest
   sends a random 16-byte nonce (`GameMsg.Auth`). Only a peer holding the
   room's Nostr secret key can answer with a valid signature over
   `ie3d-mp-auth-v1|room|hostPubkey|guestPubkey|nonce`. The guest verifies it
   with the room author's public key; on failure the transport is closed and
   the lobby shows "host authentication failed". Game traffic (Join, Input)
   is refused until this succeeds, and the host binds the challenge to the
   pubkey that sent the signed offer.

Together: the room key authenticates the *control plane* (rooms, signalling)
and the certificate authenticates the *media endpoint* (the SDP/DTLS
fingerprint), while the challenge proves the peer actually holds the room key.
A client that does not know the host's key cannot answer the challenge or
produce a room certificate — attempts are rejected in `verifyHostCert`,
`verifyAnswer` and `verifyAuth` (see `tests/mp-cert.test.ts`, including forged
certificates, a swapped DTLS fingerprint and a rogue-key auth signature).

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
npm run room:e2e        # waiting room: chat, voice, teams, PLAY (real input)
```

`tools/mp-e2e.mjs` drives two or more headless Chrome tabs through the actual
lobby UI: room publishing, listing, joining, the waiting room, the host's PLAY,
the RTC handshake, Scene/Hud delivery, and guest throttle reaching the host
simulation (it fails if the guest's HUD speed does not rise). Screenshots of
the lobby and of the guest's match are written to `/tmp/opencode/shots`
(override with `MP_E2E_SHOTS`).

`tools/room-e2e.mjs` focuses on the waiting room and uses **real input** only
(CDP mouse/key events): the host creates a CTF room and does not start the
match, the guest joins the same room menu, chat text and mic PCM travel over
WebRTC (a synthetic microphone is enabled in the headless profile), the host
assigns both teams through the dropdowns, PLAY starts the match for both, and
the guest flies the assigned team while the host's own ship moved to its own
pick. It also checks that chat keeps relaying during the match.

The Nostr layer has its own tests: `tests/nostr.test.ts` runs the official
BIP-340 vectors plus nostr-tools cross-check fixtures; `tests/mp-rooms.test.ts`
runs the room lifecycle against the local relay (persistence/re-join, password
rooms, host-published offers, session rotation); `tests/mp-crypto.test.ts`
covers the PBKDF2 + AES-GCM round trip and the seal/open wrappers;
`tests/mp-host.test.ts` decodes the host's frames with the client codec. A
live relay test is opt-in:

```sh
IE_NOSTR_TEST=1 npx vitest run tests/relay.integration.test.ts
```
