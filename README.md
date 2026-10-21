# Infinity Edge — Web Migration (from ../IE3D_37_T)

Browser recreation of **InfinityEdge3D 3.7** (XNA 4.0, WP7) using **Vue 3 +
TypeScript + raw WebGL2 + gl-matrix**. No game engine, no ported UI framework:
rendering, scene management, and the data-driven XML UI are implemented
directly for this application.

## Commands

```sh
npm install
npm run copy:assets     # textures + sounds + icons from ../IE3D_37_T (once)
npm run convert         # XNB -> JSON+bin models, Level.xml/Menu.xml -> JSON (once)
npm run dev             # http://localhost:5173/#/
npm run dev:https       # https://localhost:5173/#/ (self-signed cert, SAN: localhost, 127.0.0.1, LAN IP)
npm run build           # typecheck + production build (dist/)
npm run preview         # serve the build
npm run deploy          # build + publish to GitHub Pages (gh-pages)
npm run typecheck       # vue-tsc only
npm test                # unit tests (protocol+gzip, frustum/ocTree, models, physics)

# authoritative game server (C++17, CMake + zlib)
npm run server:build    # cmake configure + build -> build/server/ie-server
npm run server:test     # ctest (simulation unit tests)
npm run build && npm run server:run   # serves dist/ + ws://127.0.0.1:8091/game
# open http://127.0.0.1:8091/?game=/game#/menu

# multiplayer (WebRTC + Nostr rooms; see docs/multiplayer.md)
npm run mp:relay        # local Nostr relay on ws://127.0.0.1:7777
npm run mp:e2e          # browser host + guest tabs, PASS/FAIL
npm run mp:e2e -- --guests 2             # several data channels at once
npm run mp:e2e -- --level ctf-easy --type CTF --level-idx 0
npm run mp:server       # dedicated C++ room (server hosts, does not play)
npm run mp:server-e2e   # real server + two browser guests, PASS/FAIL
npm run room:e2e        # waiting room: chat, voice, team picks, PLAY (real input)
npm run boot:e2e        # boot screens reach the painted main menu on their own

# verification tooling (headless Chrome, no extra dependencies)
npm run ui:e2e          # real-mouse UI run: menus, options, lobby, pause chrome
npm run asset-server    # HTTP + WebSocket asset channel on :8090
npm run shots           # screenshots of every route -> tools/shots/
node tools/verify.mjs   # behavioural checks: routing, history, single GL context,
                        # navigation -> scene, audio, fps, frustum culling
node tools/probe.mjs <url> "<js>"      # evaluate an expression in the page
node tools/hangprobe.mjs <url> "<js>"  # poll an expression, detect main-thread stalls
node tools/context-probe.mjs           # step-by-step WebGL context loss/restore trace
```

The same entry points are wrapped in a `Makefile` (`make` prints the full
list): `make build`, `make serve`, `make relay`, `make mp-server`,
`make verify` (typecheck + unit tests + C++ tests), the five browser e2e
suites, and `make cloc`. `make cloc` counts **source code only** — TypeScript,
JavaScript, Vue components, C++/headers, CSS, HTML, Python and CMake — with
`node_modules`, `dist`, `build`, `public/` assets, JSON levels, Markdown and
lockfiles filtered out; `make cloc-files` prints the same filter per file.

Model conversion reads the **original compiled XNA content** (the 2013 build
output shipped with the game, reused byte-for-byte by the `../infinity-edge-mono`
port). A copy of every `modelN.xnb` / `colorN.xnb` is vendored under
`tools/xnb/Objects/`; the converter bakes `transforms[ParentBone] * vertex`
(XNA `Model.CopyAbsoluteBoneTransformsTo` + `Model3D.Draw`) and reproduces
`Model3D.GetBoundingSphere`. Each model is written as a single JSON file
(`<Name>.json`) with the vertex/index data embedded inline; GitHub Pages
already gzips the `.json` files, so a separate binary sidecar buys nothing.
Texture *file* names are resolved against
`../IE3D_37_T/InfinityEdge3D/InfinityEdge/InfinityEdgeContent` (auto-detects
the `IE3D_37_T/InfinityEdge/InfinityEdgeContent` layout too).
`node tools/convert-xnb.mjs --check` parses without writing. Every output is
recorded in `public/assets/models/MANIFEST.json`.

`tools/convert-fbx.mjs` (source-FBX path) is superseded: the FBX route missed
the XNA axis conversion, the per-file unit scale and the local·parent bone
composition; the compiled XNB is exact. It is kept only for reference.

## Routes (hash-based, no server config)

| URL | Original |
|---|---|
| `#/` → `#/engine` → `#/start` | EngineScreen (floating-gear wheel + "Floating Gear" wordmark, 3 s) → StartScreen ("Infinity Edge" wordmark, 3 s) → MainMenu. The wordmarks are text in the bundled **Airstrike** face (`public/assets/fonts/airstrike.ttf`, by Daniel Zadorozny / Iconian Fonts), preloaded from `index.html` and started before the asset preload; the wheel model is fetched before the rest. Both boot screens show the Floating-Gear loading bar while every model, texture and level is preloaded; the sequence only advances to the menu once that finishes |
| `#/menu` | MainMenu (SINGLE PLAYER / MULTIPLAYER / HANGAR / OPTIONS / ABOUT, one original icon each) |
| `#/multiplayer` | Public rooms on Nostr + "create a room" — the whole view is painted into the WebGL frame (`src/game/mp/lobbyui.ts`), no HTML |
| `#/room` | Browser-hosted waiting room: roster + per-pilot teams, chat, microphone toggle and the host's PLAY — painted into the same WebGL frame (`src/game/mp/roomui.ts`), no HTML |
| `?username=<name>` | sets and saves the pilot name (search string or hash query), e.g. `#/menu?username=Bob` |
| `#/single-player` | CTF / TIME TRIAL |
| `#/ctf`, `#/tt`, `#/tt/{easy,normal,hard}` | Difficulty menus; TT lists Track 01.. / Demo Track |
| `#/briefing/:level` | Level Menu.xml: scoreBoard (10 rows) + briefing textBox + "start" |
| `#/game/:level` | Level.xml game (TT race or CTF 10v9) |
| `#/options` (`#/settings`) | Options (ranges 128–512 / 4–0 / 0–1, player/enemy colour palettes, party mode, frame-time readout toggle, VR dwell 0.5–5 s, saves on "save") |
| `#/about` | Credits (verbatim) |
| `#/victory/:level`, `#/defeat/:level` | "Congratulations <user>!" + medal / defeat message |
| unknown | empty chrome, no invented text |

Back/forward and deep links work; the WebGL context persists across routes —
only the scene description swaps (menus share the Background.xml scene).

**Every menu screen is WebGL UI** (`src/game/ui/menuui.ts` + `screens.ts`): the
routes above render no DOM at all — panels, the original icon/button art,
sliders, checkboxes, text fields, score tables and a clickable breadcrumb path
are painted into the frame (the same overlay the multiplayer lobby uses), with a
`_menubtn`-plated list, watermarked track menus and the Floating-Gear boot
splash — whose "Floating Gear" and "Infinity Edge" wordmarks are text in the
Airstrike face now, not the old bitmap logos. The old oversized screen title is
gone: a small clickable **path** (`MAIN MENU › SINGLE PLAYER › …`) sits in a
navbar at the top of one maximised content rectangle (1120x720 px of the
1280x720 frame). Menus, settings, the pause screen, the lobby and the room all
use that same shell: one content rectangle, the same left-aligned navbar and
the same action column, with no nested panel frames (only their content
differs). Every menu reserves the **right eighth of the design width**
for an actions column (fullscreen toggle, primary action such as
save/start/create/play, context actions and back) and gives the remaining seven
eighths (to its left) to content; `src/game/ui/layout.ts` owns that split and is
shared by the menus, the lobby, the room and the in-match pause screen.

## WebSocket asset channel (optional)

`docs/protocol.md` documents the binary protocol: an 8-byte little-endian
header (version, flags, type, payload length), an explicit gzip flag for
payloads >= 256 bytes that actually shrink, request/response correlation by id,
and `Error` frames. It carries the converted levels and models — JSON metadata
plus `.bin` vertex data — and is enabled only when a URL is supplied (`?ws=`,
`VITE_IE_WS`, or `window.__IE_WS_URL`):

```sh
npm run asset-server    # ws://127.0.0.1:8090/assets (+ static HTTP on :8090)
# open http://127.0.0.1:5173/?ws=ws://127.0.0.1:8090/assets#/menu
```

With no URL configured the application reads the same files over HTTP like a
plain static host. The channel reconnects with exponential backoff, times out
after 8 s, validates framing/sizes, counts malformed input, and falls back to
HTTP per asset instead of stalling scene loading. Measured on CTF Easy: 108
frames, 2 127 303 B of payload -> 811 495 B on the wire.

## Multiplayer (WebRTC + Nostr)

A browser-hosted multiplayer mode: one player creates a room, the room is
published as a signed event on public **Nostr** relays, and other players
connect straight to the creator's browser over **WebRTC data channels** (one
per guest). The host runs the authoritative simulation — the same local
simulation the offline game uses — and streams it with the same binary frames
the C++ server sends, so guests run the same render-only `NetGame` client.

- `#/multiplayer` lists rooms younger than a configurable age (default **6 h**,
  dropdown 1/3/6/12/24 h, persisted), with JOIN buttons and DELETE on your own
  rooms (NIP-09: only the creator's key can delete).
- Creating a room uses dropdowns for game type, level and room size, publishes
  the room and opens its **room menu** (`#/room`); the match only starts when
  the host presses **PLAY**. Guests joining land in the same room menu, so the
  host can wait for everyone before starting.
- The room menu (also pure WebGL UI) carries a text **chat** over the data
  channels, a **microphone toggle** (16 kHz PCM voice frames relayed by the
  host, `src/game/mp/voice.ts`) and a **team picker per pilot** (the level's
  combatant teams: the host may set any pilot's team, guests their own). On
  PLAY the picks are applied: the host's ship moves to its team, and each guest
  takes over an AI ship of its team (the AI resumes when they leave) or gets a
  wingman spawned on it.
- Chat and voice keep flowing on the same channels during the match; room
  control is message `122`, voice is message `121` (documented in
  `docs/multiplayer.md`).
- Room events are addressable Nostr events (kind `30333`, 30-minute NIP-40
  expiry refreshed by heartbeats); SDP/ICE travel as public ephemeral events
  (kind `25050`), so the WebRTC candidates are visible on the relays exactly as
  the rooms are.
- The Nostr client (BIP-340 Schnorr signing, relay pool) is dependency-free:
  `src/game/nostr/`. The lobby UI and the in-game HUD are painted into the GL
  frame; the multiplayer view renders no DOM at all.
- **Dedicated server**: the C++ server can host a room itself
  (`ie-server --room ctf-easy`). It publishes the room with `srv: true` (so
  clients skip the waiting room and join the running match), accepts WebRTC guests
  and runs the whole match — physics, collision detection, AI, goals — with no
  player of its own; guests only send input and render the frames. libdatachannel
  is fetched at configure time; `/mp/status` reports the room, and the same
  guest client works against a browser host or the dedicated server.
- **Host identity**: a room certificate (ephemeral P-256 key signed by the
  room's Nostr key) signs every WebRTC answer SDP, and the data channel starts
  with a signed challenge-response — a guest refuses to negotiate or join a
  peer that cannot prove it holds the room key, so other clients cannot
  impersonate the host (browser and C++ server implement the same checks).
- Room/IPC/signalling details, configuration and the e2e tooling are documented
  in `docs/multiplayer.md`.

## Game server (authoritative, C++)

`server/` is a second, independent WebSocket service: a hand-rolled C++17
server (zlib only, no Boost) that **owns the game logic and every model
position**. The web client turns into a renderer — `src/game/netgame.ts`
applies Scene/Snapshot/Events/Hud frames and streams the player's input back —
while the local simulation stays as the offline fallback. The wire protocol
(binary payloads, gzipped with the same 8-byte framed header, 30 Hz snapshots,
one-tick interpolation gutter on the client) is documented in
`docs/protocol.md`, "Game channel"; `src/game/protocol.ts` is the client codec.

```sh
npm run server:build                     # CMake + build -> build/server/ie-server
npm run build
npm run server:run                       # static dist/ + ws://127.0.0.1:8091/game
# open http://127.0.0.1:8091/?game=/game#/menu

# dev server (https) instead: Vite proxies /game to the C++ server
npm run server:run                       # or: --port 8095, then IE_GAME_PROXY=ws://127.0.0.1:8095
npm run dev
# open https://localhost:5173/?game=/game#/menu
```

The URL comes from `?game=` (`/game`, `host:port`, a full `ws://`/`wss://` URL,
or `1` for the default port), then `VITE_IE_GAME_WS`, then
`window.__IE_GAME_WS`; with none of them — or when the server is down or the
join times out (15 s) — the page falls back to the original local
single-player simulation. `ie-server` also serves a directory over HTTP
(`--root`, default `public`), so a single port carries both the client and the
game channel. `npm run server:test` runs the simulation unit tests.

## Music and party mode

The soundtrack is decoded into an `AudioBuffer` and looped by an
`AudioBufferSourceNode`: every sound, including music, runs through WebAudio;
there is no `<audio>` element or media-element playback. Options → CONTROLS &
DATA → **Music File** opens a file picker (`*.mp3`, and audio files generally)
and the chosen track becomes the looping soundtrack; the pick is stored in
IndexedDB and survives reloads, and **Reset Music** returns to the shipped
`sound.mp3`. The default soundtrack starts immediately while the stored file
loads in the background.

**Party Mode** (Options → DISPLAY **Party Mode**, also in the pause menu's options)
analyses the music before the volume gain, detects **bass onsets** and rotates
the current player's hue further on every bass hit, with a brief
saturation/brightness flash scaled by the bass amplitude. The player hull is
tinted, every ship's engine smoke takes its **own team colour** (the player's
live/flashing colour in party mode, enemies their static colour), asteroids and
bullets rotate hue, and the sky gets a small ±10° hue sway plus a stronger
contrast lift. Enemy teams and addon colours are never changed by the music.

## Controls

Keyboard (Control.cs): arrows steer, Space fire, LeftControl throttle,
LeftAlt homing, LeftShift nitro (WASD/C/M/N aliases). Touch: left 2/3 stick
(recenter + deadzone), right throttle slider, fire / homing (count) / nitro (%)
buttons; Gamepad Back: Esc. Menu: browser back. A fullscreen toggle button
(web addition) sits in the top-right corner of every WebGL view — the boot,
engine and start screens, every menu, the lobby and the room menu — and in the
in-match HUD; it toggles the browser's fullscreen state.

The throttle slider is a **cruise control**: dragging it sets the speed and
releasing the finger keeps it (the original only zeroed it in the `#if WINDOWS`
branch; on the phone the value survives the frame), so the ship keeps moving
while you steer and fire. The keyboard is hold-to-thrust and falls back to the
value left on the slider.

No Ctrl/Alt modifiers are used (plain keys only), so browser shortcuts
(Ctrl+W etc.) never fire. The UI blocks `contextmenu`/`dragstart` and
image-saving everywhere.

## VR

Enterable from the **Settings** menu (the in-game pause menu opens the same options).
Two paths, in order:

- **Immersive WebXR** (`navigator.xr` immersive-vr): per-eye pose and
  projection rendered straight into the XR framebuffer, gyroscope look is
  dropped (the head pose carries the view). The chase base uses the
  **spaceship's up vector**, so the head and camera rotate with the ship -
  including its roll - instead of being stabilized against a world horizon.
  The head pose adds yaw, pitch and roll on top of that ship-relative base.
  The in-game HUD (score, clock, speed, life pools, missile/nitro items, aim
  reticle and target markers) is a
  **head-locked panel at 0.75 m, close to the camera, fitted to 86% of the eye's
  half-view so the 2 px frame and the blurred world veil remain visible around
  it**: it is painted once with the cyclops/head-centre view and drawn in each
  eye, so the score/time/items stay fixed to the head rotation. The panel
  matches that same head view at its distance, so projected aim/marker
  positions are exact inside it and are pinned to the panel's edge when they
  fall outside (they stick to the plane instead of the eye's screen). With the frame-time option
  enabled (Options or the pause menu's options), the smoothed WebGL frame interval
  is shown at the bottom centre of that plane. On the 2D page the HUD stays a
  screen-space overlay. The menus, lobby and room menu are the **same
  WebGL UI** as the 2D pages (including the in-game pause screen), not a
  second VR menu: the screen is painted once
  into a texture and drawn as a plane in the scene (16:9, at most 4 world units
  wide, 1.5 m in front of the base view, uniformly scaled down per eye so its
  projected rectangle stays 7% inside the viewport). Distance and world size are
  halved together versus the old 3 m/8-unit plane, so it sits closer for more
  comfortable stereo while the on-screen rectangle and the screen-space blur
  feather are unchanged. A crosshair with a dwell ring follows the headset's gaze ray on
  that plane; the controller trigger (session `select`) clicks the item under
  it, and dwelling selects without a controller (2 s by default, configurable
  as **VR Dwell Time** in Options). The dwell only restarts when the crosshair
  acquires a different clickable target, so head corrections inside the same
  button do not reset the timer. Hover/keyboard/click
  behaviour comes from the screens' own pointer handlers, so every menu and
  every future screen works in the headset with no VR-specific items.
- **Split-screen fallback** (no WebXR or refused): two eyes side by side
  (camera shifted ±0.125 world units along its right axis, own scissor and
  viewport per eye), with the gyroscope look (or a drag-to-look fallback
  when sensors are blocked) and the WebGL menus/HUD rendered per eye.

VR input: gyroscope (DeviceOrientationEvent, iOS permission requested when
present but never blocking) with a drag-to-look fallback on the scene. The
chase view uses the **spaceship's up vector**; the gyro yaw, pitch and roll
are applied relative to that ship-relative base, so the head rotates with the
ship and the camera looks at it with the ship's up vector. A reactive
diagnostic readout
(`sensor: N events · yaw … · pitch … · roll … · drag look`) proves the mode is
alive. Every controller trigger/hand tap re-centres the view, in menus and in
a match; in menus the click is applied first, so the item under the crosshair
still activates. Pausing keeps the immersive session alive: the WebGL pause
menu replaces the HUD and is drawn on the same world-space panel, and the HUD
returns only after RESUME. The immersive session stays alive across the result
screens too — they use the same world-space UI panel — and ends only on an
explicit VR toggle or when the headset ends the session.

## Navigation

LIFO back everywhere (`goBack` pops history; finished matches use
`router.replace()` so the game leaves the stack). Clickable path at the top
built from the navigation stack, persisted in `sessionStorage` with synthesised
ancestry for cold deep links. Reload rebuilds the stack.

## Layout

- `src/engine/` — GL context/loop, BasicEffect-exact GLSL (plain-BasicEffect
  light: direction Down → shader `(0,1,0)`, white diffuse, ambient 0.001,
  LightBlue specular 1024, white material diffuse), texture cache,
  converted-model loader with validation + LOD/fade, camera (chase follow +
  fixed menu pose),
  frustum, OcTree (frag > 32), draw primitives (billboards/quads drawn
  CullNone like `Draws.DrawBillBoard`, billboards gated on Special Effects),
  `post.ts` (six-stage pipeline: 1 sky / 2 models / 3 billboards / 4 blur /
  5 UI / 6 final, zoom blur + lens flare), `noise.ts` (tileable 3D Perlin
  field for smoke/plume + runtime Perlin cloud sprites for the level scenery),
  `hud3d.ts` (WebGL HUD overlay for stage 5),
  `vrpanel.ts` (the same ScreenUi on a world-space VR panel + gaze cursor).
- `src/game/` — math (GetH/GetV verbatim), life pools (Life1/Life3 quirks),
  physics presets + NextPosition + PreviewDirection, Team/Score/Reward/
  Conditions (Destroyed = !active, MorePoints = strictly above minimum),
  full 37_T object hierarchy (GetMatrix fresh, pos-centered spheres, ship
  homings=2, shield absorb + HUD /10), 13 AIs + XM_Actions factories, Map
  (stack timers, outsider root+box rule, first-hit bullets, walls), GameInstance
  (build/update/draw order, ghost record/playback, scores, victory/defeat),
  controls (touch + keyboard + gamepad), resources (Options XML, LOD/color caches),
  audio (SFX/voices + music), net (framed binary + gzip), ghost (framed+gzip
  persistence), store (options/scores/nav→scene map), level catalogue.
- `src/game/hud.ts` — shared HUD snapshot (frame loop and WebXR session).
- `src/game/xr.ts` — WebXR immersive session driver (per eye, HUD, menu panel
  and gaze pointer).
- `src/game/vr.ts` — VR state, gyro + drag-look fallback, calibration.
- `src/components/`, `src/views/`, `src/router/` — canvas host, the in-match
  HUD (scoreboard, aim, pointers, life bar, touch controls), the WebGL menu
  host (`MenuView.vue`), the multiplayer lobby view, and the hash router.
- `src/ui/scene-xml.ts` — the original scene-XML parser (background/body/
  buttonSkin/font/scoreBoard/… trees). The menus are WebGL UI now
  (`src/game/ui/`), so it is kept as the reference parser for the converted
  37_T XML rather than driving the rendered screens.
- `src/game/net.ts`, `src/game/netclient.ts`, `src/game/assetfetch.ts` — binary
  framing + gzip, the optional WebSocket channel (reconnect/timeout/fallback),
  and the asset fetch front-end used by the level and model loaders.
- `src/game/protocol.ts`, `src/game/netgame.ts` — the game-channel codec and the
  server-driven `NetGame` renderer (Scene/Snapshot/Events/Hud + input).
- `src/game/nostr/` — hand-rolled Nostr: BIP-340 Schnorr + SHA-256 + NIP-19
  (`crypto.ts`, `bech32.ts`), events (`event.ts`), relay pool (`relay.ts`).
- `src/game/mp/` — rooms/signalling/WebRTC (`manager.ts`), the browser match
  host (`host.ts`, the wire mirror of `server/src/session.cpp`), the WebGL
  lobby (`lobbyui.ts`) and the simulation hooks (`bridge.ts`).
- `server/src/match.*` — the shared per-viewer frame encoder (single-player
  sessions and the dedicated room both stream through it);
  `server/src/nostr*`, `wsc.*` — BIP-340 events, rooms/signalling and the relay
  WebSocket client; `dedicated.*` — Nostr room + WebRTC guests + the match.
- `server/` — authoritative C++17 game server: WebSocket + zlib framing
  (`src/proto.h`), the ported simulation (`src/sim*.cpp`, `src/ai.cpp`), the
  single-player session and the dedicated WebRTC room; `--root` serves the
  client. Unit tests: simulation + BIP-340/events (`server/tests/`).
- `tools/`, `public/assets/` — conversion scripts, verification tooling
  (screenshots/verify/probe/hangprobe), the asset server, converted content.
- `docs/protocol.md`, `docs/asset-formats.md` — protocol and converted asset
  formats.

## Rendering (verified behaviors)

- **Six-stage framebuffer pipeline** (`src/engine/post.ts`):
  1. Sky (dome, never blurred)
  2. Models (all meshes, depth test + write, coverage in alpha)
  3. Billboards (camera-facing sprites + smoke, shared depth, far-to-near sorted)
  4. Blur (models only, never sky/billboards; zoom blur from ship velocity)
  5. UI (WebGL HUD: score, clock, notify, timers, aim, life, markers, missiles,
     nitro, speed, missile-lock warning, lock crosshair; 16 px padding from every
     border so only the 3D game touches the edges)
  6. Final = 1 + 4 + 2 + 3 + 5, in that order, plus lens-flare ghosts and the
     exposure knee. Ships are re-drawn sharp on top of the blurred frame.
- **Focus frame**: the exact boundary where the focus veil reaches zero carries
  a 2 CSS px player-colour stroke just inside the sharp UI rectangle. It follows
  flat menus/lobby/room, the HUD inset, split-screen eyes, and the projected
  immersive menu/HUD planes. Immersive planes are uniformly fitted to 86% of the
  eye's half-view so all four frame sides stay on-screen and the world outside
  remains visible and blurred through a short veil ramp.
- **Player-colour chrome and enemy markers**: menu/lobby/room buttons, action
  labels, inputs, the respawn/timer bars, the pre-match countdown and the HUD
  action counts read the live player colour (including party-mode hue/flash);
  the bright/white `_menubtn` plates keep their art with a dark-outlined accent
  label. Enemy markers (ships, bases, flags) get a 1 px inset border in the
  opposite enemy colour, clipped to the PNG alpha silhouette in both the DOM and
  GL/XR HUD paths; allies, goals and the path keep their plain team colour.
- **Deferred depth test**: the opaque model pass runs depth-only first (colour
  masked off), then the colour pass resolves with LEQUAL, so occlusion is
  independent of draw order (the arena walls render correctly again).
- **Zoom blur**: the ship's velocity vector drives a radial smear (radius 0.10
  at full throttle, 16 taps); the models stay sharp on top. Toggleable via
  "Speed blur" in Options / the pause menu's options.
- **Lens flare** (gated on Special Effects): bright-pass bloom kept separate
  from the blur layer so the ghosts cannot duplicate the scene.
- **Motion blur was removed** at the user's request (velocity buffer, MB shader,
  debug view, config, option, tests and `src/engine/motion.ts` all deleted).
- **VR**: WebXR immersive session (per-eye pose/projection into the XR
  framebuffer) with a split-screen fallback; the chase base follows the ship's
  up vector with gyro yaw/pitch/roll composed on top; trigger/tap re-centres
  every time; the WebGL menus render on
  a world-space panel with a gaze
  crosshair (trigger click + configurable dwell, 2 s default) instead of a separate VR menu, and the
  in-game HUD is a head-locked plane at 0.75 m, close to the camera (painted once
  from the cyclops view; projected positions clamp to its edges), both
  verified by the panel
  math/pointer unit tests; enterable without a gamepad;
  the same Settings menu is shared with the WebGL pause menu (live apply,
  save/revert); pausing shows only that menu over the frozen match and the HUD
  comes back on RESUME.
- **Gameplay**: 5 s pre-match countdown (world frozen, world units per second
  "SPD" display, missile-lock warning, red lock crosshair, death-cause line in
  the respawn panel, draw distance in VR matches the setting).
- **Navigation**: LIFO back, a clickable breadcrumb path at the top of every
  menu (persisted across reloads), `router.replace()` for finished matches.
- **No context menu / long-press callout / image saving** anywhere in the UI.
- **HTTPS dev server**: self-signed cert with SAN (localhost, 127.0.0.1, LAN
  IP), served only when `certs/dev.{crt,key}` exist; `/game` is proxied to the
  C++ game server (`IE_GAME_PROXY` overrides the backend), because a `ws://`
  socket cannot be opened from an `https://` page.

## Verified behaviors (browser)

- Rendering matches the 2013 reference screenshots: engine/color flares, smoke
  trail, miniStar/cloud billboards and the hexagon walls (all previously culled
  by the missing `CullNone`), the plain-BasicEffect light (`Direction.Down`,
  white) and the corrected model winding (SS1 menu, SS3 chase view, SS6 CTF
  base).
- TT Easy 01: throttle run from origin through all 6 gates → **Gold**
  (5.90 s < 6 s), ghost recorded (2563 samples).
- TT Easy 02: all gates → **Victory** screen with medal, score + ghost saved.
- CTF Easy: 12v11 objects (10v9 ships + bases/flags), 8000 asteroids,
  30 s of AI combat without errors, respawns, doors closed.
- Menus, briefing text, options, about, tracks all render from converted data.
- All menus are WebGL UI: a driven browser run through `#/menu` →
  single player → CTF → briefing → options (checkbox toggles, slider drag,
  save → localStorage) → about reports **one canvas, zero DOM controls**, the
  original icon/`_menubtn` art drawn into the frame, `?username=` setting and
  saving the pilot name, and breadcrumb/back/primary corners.
- `npm run ui:e2e` drives the same screens with **real mouse input**
  (`Input.dispatchMouseEvent`, full browser hit-testing): menu navigation,
  options checkbox/slider/save, a real briefing START click, the in-match back
  button opening the WebGL pause menu, pause options/back and RESUME with the
  DOM chrome hidden and restored, and the multiplayer lobby's age-filter
  dropdown and back button. It is the check
  that caught the DOM overlay layer (`.ui-layer`) swallowing every canvas
  click — the menus and lobby are painted into the canvas, so that layer is
  `pointer-events: none` now, with the in-match controls opting back in.
- Options screen matches SS8: right-aligned labels with a shared right edge,
  192 px black `_pixel` bars with `_ball` knobs and value text, black square
  checks with a white ball when set, `Clear All` at 90 % of the right list.
- `node tools/verify.mjs`: 17/17 checks — deep link, menu navigation, history
  back/forward, unknown route, one surviving WebGL context across routes,
  navigation→scene mapping (background/engine/level), audio unlock + looping
  WebAudio soundtrack, frame rate, culling (tens of thousands of objects
  rejected, nothing visible dropped), context-loss recovery (loop pauses, GL
  caches drop, scene rebuilds), 2x DPR backing store, no page errors. Run
  against both the dev server and the production build, over HTTP and over the
  WebSocket channel.
- `npm test`: 211 unit tests (protocol framing/gzip/threshold/malformed input,
  frustum + ocTree culling, converted model sidecars, physics and life pools,
  BIP-340/NIP-19 vectors, Nostr event signing, multiplayer rooms over a local
  relay, the browser host's frame production decoded by the client codec,
  the voice wire format/resampling, and the VR panel/gaze math (panel basis,
  ray/plane hit-to-UI mapping, dwell/click state); the live-relay test is
  opt-in).
- Dedicated multiplayer server: `npm run mp:server-e2e` starts the C++ server
  (own Nostr room, WebRTC, no player of its own) and two browser guests —
  joins over the WebGL lobby, authoritative life pools/HUD, guest throttle
  moving the ship on the server (HUD speed), `GET /mp/status` player counts,
  and a result/restart round trip on the same room id. Time Trial (wingman
  spawn) and CTF (AI-ship takeover, 19 ships, match clock) both pass. The
  suite also passes under AddressSanitizer, which caught and fixed two latent
  C++ bugs: an octree parent-walk use-after-free and a guest-key reference
  into an erased map entry.
- Multiplayer (browser host): the `npm run mp:e2e` harness drives real headless
  Chrome tabs through the WebGL lobby — creating a room, listing it, joining
  over WebRTC, the RTC handshake, Scene/HUD delivery (life pools, RTT), guest
  throttle reaching the host simulation (HUD speed 64) and two guests on
  distinct data channels, with the host seeing both ships. Time Trial and CTF
  (AI-ship takeover) both pass. The lobby, room list, age filter, dropdowns,
  create/join/delete paths and the "creator only" deletion rule are exercised
  in-browser as well (`tools/probe.mjs`); rooms are verified against the local
  relay in `tests/mp-rooms.test.ts`, and signing against the official BIP-340
  vectors plus a live relay publish (`tests/relay.integration.test.ts`,
  opt-in).
- Boot sequence: `npm run boot:e2e` loads `#/`, `#/engine` and `#/start`
  directly and requires each to reach `#/menu` by itself, with the designed
  dwell (engine ≥ 3 s, start ≥ 1.5 s) and the **painted** main menu (WebGL
  overlay: `MAIN MENU` plus the single-player/multiplayer regions), not just a
  hash change. This pins the regression where the keyed `RouterView` remounted
  the menu at `#/start` after the preload had finished and no advance timer was
  armed.
- Multiplayer waiting room: `npm run room:e2e` drives the host and one guest
  through the room menu with **real CDP input** — the host creates a CTF room
  and stays out of the match, the guest joins the same roster, chat text and
  mic PCM travel over WebRTC (synthetic microphone), both team pickers are
  exercised, PLAY starts the match for both, the host's own ship moved to its
  picked team (`alien`), the guest flies its picked team (`human`, 11 human /
  12 alien ships, 2 flags) on the render-only `NetGame`, and chat still relays
  during the match. It fails on any missing step; screenshots of both room
  menus and both matches are written to `/tmp/opencode/shots`.
- Game channel (server authoritative): Node load client against the C++ server
  (CTF Easy 8000 asteroids/19 ships: 36 KiB/s wire, 43 % of payload; KOTS solo
  13 KiB/s), and a driven browser run with `?game=/game` — TT Easy flight
  (hudSpeed 64, smooth ~1.2 u/frame interpolation, bullets/smoke/debris, 392
  draws/frame), CTF Easy (8038 wire objects, flags owned by their bases,
  per-ship HUD life), events replay (explosion seed, voice notification),
  dispose on unmount (socket closed), and both fallbacks (no `?game=`, and an
  unreachable server URL) landing on the local simulation.