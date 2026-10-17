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

# verification tooling (headless Chrome, no extra dependencies)
npm run asset-server    # HTTP + WebSocket asset channel on :8090
npm run shots           # screenshots of every route -> tools/shots/
node tools/verify.mjs   # behavioural checks: routing, history, single GL context,
                        # navigation -> scene, audio, fps, frustum culling
node tools/probe.mjs <url> "<js>"      # evaluate an expression in the page
node tools/hangprobe.mjs <url> "<js>"  # poll an expression, detect main-thread stalls
node tools/context-probe.mjs           # step-by-step WebGL context loss/restore trace
```

Model conversion reads the **original compiled XNA content** (the 2013 build
output shipped with the game, reused byte-for-byte by the `../infinity-edge-mono`
port). A copy of every `modelN.xnb` / `colorN.xnb` is vendored under
`tools/xnb/Objects/`; the converter bakes `transforms[ParentBone] * vertex`
(XNA `Model.CopyAbsoluteBoneTransformsTo` + `Model3D.Draw`) and reproduces
`Model3D.GetBoundingSphere`. Each model is written as metadata JSON plus a
binary vertex/index sidecar (`<Name>.json` + `<Name>.bin`; format documented in
`docs/asset-formats.md`), which the loader uploads straight from the fetched
buffer. Texture *file* names are resolved against
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
| `#/` → `#/engine` → `#/start` | EngineScreen (wheel + logo, 3 s) → StartScreen (logo, 3 s) → MainMenu. Both boot screens show the Floating-Gear loading bar while every model, texture and level is preloaded; the sequence only advances to the menu once that finishes |
| `#/menu` | MainMenu (SINGLE PLAYER / OPTIONS / ABOUT) |
| `#/single-player` | CTF / TIME TRIAL |
| `#/ctf`, `#/tt`, `#/tt/{easy,normal,hard}` | Difficulty menus; TT lists Track 01.. / Demo Track |
| `#/briefing/:level` | Level Menu.xml: scoreBoard (10 rows) + briefing textBox + "start" |
| `#/game/:level` | Level.xml game (TT race or CTF 10v9) |
| `#/options` (`#/settings`) | Options (ranges 128–512 / 4–0 / 0–1, saves on "save") |
| `#/about` | Credits (verbatim) |
| `#/victory/:level`, `#/defeat/:level` | "Congratulations <user>!" + medal / defeat message |
| unknown | empty chrome, no invented text |

Back/forward and deep links work; the WebGL context persists across routes —
only the scene description swaps (menus share the Background.xml scene).

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

## Controls

Keyboard (Control.cs): arrows steer, Space fire, LeftControl throttle,
LeftAlt homing, LeftShift nitro (WASD/C/M/N aliases). Touch: left 2/3 stick
(recenter + deadzone), right throttle slider, fire / homing (count) / nitro (%)
buttons; Gamepad Back: Esc. Menu: browser back. A fullscreen toggle button
(web addition) sits below the top-right corner chrome.

The throttle slider is a **cruise control**: dragging it sets the speed and
releasing the finger keeps it (the original only zeroed it in the `#if WINDOWS`
branch; on the phone the value survives the frame), so the ship keeps moving
while you steer and fire. The keyboard is hold-to-thrust and falls back to the
value left on the slider.

No Ctrl/Alt modifiers are used (plain keys only), so browser shortcuts
(Ctrl+W etc.) never fire. The UI blocks `contextmenu`/`dragstart` and
image-saving everywhere.

## VR

Enterable from the **Settings** menu (same menu as the in-game pause overlay).
Two paths, in order:

- **Immersive WebXR** (`navigator.xr` immersive-vr): per-eye pose and
  projection rendered straight into the XR framebuffer, tap on the screen
  re-centres via the session's `select` event, gyroscope look is dropped
  (the head pose carries the view), the HUD is drawn in WebGL per eye.
- **Split-screen fallback** (no WebXR or refused): two eyes side by side
  (camera shifted ±0.125 world units along its right axis, own scissor and
  viewport per eye), with the gyroscope look (or a drag-to-look fallback
  when sensors are blocked) and the DOM UI on top.

VR input: gyroscope (DeviceOrientationEvent, iOS permission requested when
present but never blocking) with a drag-to-look fallback on the scene; a
reactive diagnostic readout (`sensor: N events · yaw … · pitch … · drag look`)
proves the mode is alive. Gaze-dwell (1 s) clicks menu buttons. VR ends with
the match so the result screens come up as normal menus. Tap on the scene
re-centres in both modes.

## Navigation

LIFO back everywhere (`goBack` pops history; finished matches use
`router.replace()` so the game leaves the stack). Clickable breadcrumb built
from the navigation stack, persisted in `sessionStorage` with synthesised
ancestry for cold deep links. Reload rebuilds the stack.

## Layout

- `src/engine/` — GL context/loop, BasicEffect-exact GLSL (plain-BasicEffect
  light: direction Down → shader `(0,1,0)`, white diffuse, ambient 0.001,
  LightBlue specular 1024, white material diffuse), texture cache,
  converted-model loader with validation + LOD/fade, camera (follow + orbit),
  frustum, OcTree (frag > 32), draw primitives (billboards/quads drawn
  CullNone like `Draws.DrawBillBoard`, billboards gated on Special Effects),
  `post.ts` (six-stage pipeline: 1 sky / 2 models / 3 billboards / 4 blur /
  5 UI / 6 final, zoom blur + lens flare), `noise.ts` (tileable 3D Perlin
  field for smoke/plume), `hud3d.ts` (WebGL HUD overlay for stage 5).
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
- `src/game/xr.ts` — WebXR immersive session driver.
- `src/game/vr.ts` — VR state, gyro + drag-look fallback, calibration.
- `src/components/`, `src/views/`, `src/router/` — canvas host, GenericMenu
  shell (from Import/GenericMenu.xml values), HUD (scoreboard, aim, pointers,
  life bar, touch controls), 12 views, hash router.
- `src/ui/scene-xml.ts` — scene XML parser producing UI trees + refs
  (background/body/buttonSkin/font/textures/models/scoreBoard/options/about).
- `src/game/net.ts`, `src/game/netclient.ts`, `src/game/assetfetch.ts` — binary
  framing + gzip, the optional WebSocket channel (reconnect/timeout/fallback),
  and the asset fetch front-end used by the level and model loaders.
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
- **Deferred depth test**: the opaque model pass runs depth-only first (colour
  masked off), then the colour pass resolves with LEQUAL, so occlusion is
  independent of draw order (the arena walls render correctly again).
- **Zoom blur**: the ship's velocity vector drives a radial smear (radius 0.10
  at full throttle, 16 taps); the models stay sharp on top. Toggleable via
  "Speed blur" in Options / pause settings.
- **Lens flare** (gated on Special Effects): bright-pass bloom kept separate
  from the blur layer so the ghosts cannot duplicate the scene.
- **Motion blur was removed** at the user's request (velocity buffer, MB shader,
  debug view, config, option, tests and `src/engine/motion.ts` all deleted).
- **VR**: WebXR immersive session (per-eye pose/projection into the XR
  framebuffer) with a split-screen fallback; gyro look + drag-to-look; tap to
  re-centre; gaze-dwell (1 s) clicks menu buttons; enterable without a
  gamepad; the same Settings menu is shared with the pause panel (live apply,
  save/revert).
- **Gameplay**: 5 s pre-match countdown (world frozen, world units per second
  "SPD" display, missile-lock warning, red lock crosshair, death-cause line in
  the respawn panel, draw distance in VR matches the setting).
- **Navigation**: LIFO back, clickable breadcrumb persisted across reloads,
  `router.replace()` for finished matches.
- **No context menu / long-press callout / image saving** anywhere in the UI.
- **HTTPS dev server**: self-signed cert with SAN (localhost, 127.0.0.1, LAN
  IP), served only when `certs/dev.{crt,key}` exist.

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
- Options screen matches SS8: right-aligned labels with a shared right edge,
  192 px black `_pixel` bars with `_ball` knobs and value text, black square
  checks with a white ball when set, `Clear All` at 90 % of the right list.
- `node tools/verify.mjs`: 17/17 checks — deep link, menu navigation, history
  back/forward, unknown route, one surviving WebGL context across routes,
  navigation→scene mapping (background/engine/level), audio unlock + soundtrack,
  60 fps, culling (19k objects rejected, nothing visible dropped), context-loss
  recovery (loop pauses, GL caches drop, scene rebuilds), 2x DPR backing store,
  no page errors. Run against both the dev server and the production build, over
  HTTP and over the WebSocket channel.
- `npm test`: 41 unit tests (protocol framing/gzip/threshold/malformed input,
  frustum + ocTree culling, converted model sidecars, physics and life pools).