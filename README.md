# Infinity Edge — Full XNA Migration to the Browser

Complete migration of the XNA game **InfinityEdge3D** (`../InfinityEdge3D`)
to **Vue 3 + TypeScript + raw WebGL2 + gl-matrix**. This is a full port of
the game — simulation, combat, AI, CTF/time-trial rules, menus, audio —
not a demo. No game engine and no ported UI framework.

## Quick start

```sh
npm install
npm run copy:assets     # textures + sounds from ../InfinityEdge3D (once)
npm run convert         # FBX -> JSON models + Level.xml -> JSON (once)
npm run dev             # http://localhost:5173/#/
npm run build           # typecheck + production build into dist/
npm run preview         # serve dist/ locally
```

`node tools/convert-fbx.mjs --check` parses without writing;
`public/assets/models/MANIFEST.json` records every output.

## Routes (hash-based, no server config needed)

| URL | Original |
|---|---|
| `#/` → `#/engine` → `#/start` | EngineScreen → StartScreen (3 s + fades, Welcome) |
| `#/menu` | MainMenu (single player / options / about) |
| `#/single-player` | SinglePlayer (CTF / time trial) |
| `#/tt`, `#/tt/easy|normal|hard` | TimeTrial menus + track lists |
| `#/ctf` | CTF menu (easy / normal / hard) |
| `#/briefing/:level` | MenuXML briefing (scores + description + start + ghost note) |
| `#/game/:level` | GameInstance: full simulation + HUD |
| `#/options` (`#/settings`) | MenuOptions (exact fields + Save/Clear rules) |
| `#/about` | About credits |
| `#/victory/:level`, `#/defeat/:level` | Victory (medal + score/ghost save) / Defeat |
| unknown | graceful fallback, background unchanged |

Back/forward and deep links work; the WebGL context persists across routes.

## Controls (game route — mirrors Control.cs)

Touch: left 2/3 stick (recenter on touch, deadzone 0.1), right throttle
slider, fire / homing+count / nitro+% buttons. Keyboard: arrows steer,
Space fire, LeftControl throttle, LeftAlt homing, LeftShift nitro
(WASD aliases included). Gamepad Back / Esc: back.

## Layout

- `src/engine/` — math (GetH/GetV/YPR/`|`-parsers), GL context, GLSL
  (lit/unlit/instanced/points/billboard/quad), texture cache, model
  loader + validation + ray-mesh intersect, camera (follow + auto-orbit),
  frustum, faithful OcTree, draw primitives, renderer host + loop.
- `src/game/` — configs, Life1/Life3 (bug-compatible), physics presets,
  Team/Score/GameScore/Reward/conditions, full object hierarchy, all 14
  AIs + factories, Map (6-region update, two-pass draw, walls, factory),
  GameInstance (update/draw/HUD/pointers/scores/ghost), controls,
  resources (options XML, voices, caches), ghost, audio, net protocol,
  store, level loader.
- `src/components/`, `src/views/`, `src/router/` — canvas host, menu
  shell, 11 views, hash router.
- `tools/` — `convert-fbx.mjs`, `convert-levels.mjs`, `copy-assets.mjs`.
- `public/assets/` — converted models/levels + copied textures/sounds.

See `MIGRATION.md` for analysis, formats, verification, and approximations.
