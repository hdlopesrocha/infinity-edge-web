# Infinity Edge — Web Migration (from ../IE3D_37_T)

Browser recreation of **InfinityEdge3D 3.7** (XNA 4.0, WP7) using **Vue 3 +
TypeScript + raw WebGL2 + gl-matrix**. No game engine, no ported UI framework:
rendering, scene management, and the data-driven XML UI are implemented
directly for this application.

## Commands

```sh
npm install
npm run copy:assets     # textures + sounds + icons from ../IE3D_37_T (once)
npm run convert         # FBX -> JSON models + Level.xml -> JSON (once)
npm run dev             # http://localhost:5173/#/
npm run build           # typecheck + production build (dist/)
npm run preview         # serve the build
npm run typecheck       # vue-tsc only
```

Converter sources: `../IE3D_37_T/InfinityEdge3D/InfinityEdge/InfinityEdgeContent`
(auto-detects the `IE3D_37_T/InfinityEdge/InfinityEdgeContent` layout too).
`node tools/convert-fbx.mjs --check` parses without writing. Every output is
recorded in `public/assets/models/MANIFEST.json`.

## Routes (hash-based, no server config)

| URL | Original |
|---|---|
| `#/` → `#/engine` → `#/start` | EngineScreen (wheel + logo, 3 s) → StartScreen (logo, 3 s) → MainMenu |
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

## Controls

Keyboard (Control.cs): arrows steer, Space fire, LeftControl throttle,
LeftAlt homing, LeftShift nitro (WASD/C/M/N aliases). Touch: left 2/3 stick
(recenter + deadzone), right throttle slider, fire / homing (count) / nitro (%)
buttons; Gamepad Back: Esc. Menu: browser back.

## Layout

- `src/engine/` — GL context/loop, BasicEffect-exact GLSL (ambient 0.001,
  LightBlue specular 1024), texture cache, converted-model loader with
  validation + LOD/fade, camera (follow + orbit), frustum, OcTree (frag > 32),
  draw primitives (billboards gated on Special Effects, textured quads).
- `src/game/` — math (GetH/GetV verbatim), life pools (Life1/Life3 quirks),
  physics presets + NextPosition + PreviewDirection, Team/Score/Reward/
  Conditions (Destroyed = !active, MorePoints = strictly above minimum),
  full 37_T object hierarchy (GetMatrix fresh, pos-centered spheres, ship
  homings=2, shield absorb + HUD /10), 13 AIs + XM_Actions factories, Map
  (stack timers, outsider root+box rule, first-hit bullets, walls), GameInstance
  (build/update/draw order, ghost record/playback, scores, victory/defeat),
  controls (touch + keyboard), resources (Options XML, LOD/color caches),
  audio (SFX/voices + music), net (framed binary + gzip), ghost (framed+gzip
  persistence), store (options/scores/nav→scene map), level catalogue.
- `src/components/`, `src/views/`, `src/router/` — canvas host, GenericMenu
  shell (from Import/GenericMenu.xml values), HUD (scoreboard, aim, pointers,
  life bar, touch controls), 12 views, hash router.
- `src/ui/scene-xml.ts` — scene XML parser producing UI trees + refs
  (background/body/buttonSkin/font/textures/models/scoreBoard/options/about).
- `tools/`, `public/assets/` — conversion scripts + converted content.

## Verified behaviors (browser)

- TT Easy 01: throttle run from origin through all 6 gates → **Gold**
  (5.90 s < 6 s), ghost recorded (2563 samples).
- TT Easy 02: all gates → **Victory** screen with medal, score + ghost saved.
- CTF Easy: 12v11 objects (10v9 ships + bases/flags), 8000 asteroids,
  30 s of AI combat without errors, respawns, doors closed.
- Menus, briefing text, options, about, tracks all render from converted data.
- History back/forward syncs routes and scenes; unit tests 21/21 (protocol+gzip,
  frustum, OcTree descent/queries, physics integration/lead-shot).
