# Infinity Edge — Web Migration

Browser recreation of the XNA game **InfinityEdge3D** (`../InfinityEdge3D`)
using **Vue 3 + TypeScript + raw WebGL2 + gl-matrix**. No game engine, no
proprietary UI framework: the renderer, scene graph, and UI are implemented
directly for this application.

## Quick start

```sh
npm install
npm run copy:assets     # copy textures + sounds from ../InfinityEdge3D (once)
npm run convert         # FBX -> JSON models + Level.xml -> JSON (once)
npm run dev             # http://localhost:5173/#/
npm run build           # typecheck + production build into dist/
npm run preview         # serve dist/ locally
```

Regeneration is reproducible: `npm run convert:models -- --check` parses
without writing; `public/assets/models/MANIFEST.json` records every output.

## Routes (hash-based, no server config needed)

| URL | Original scene |
|---|---|
| `#/` → `#/engine` → `#/start` | EngineScreen → StartScreen splashes (3 s + fade) |
| `#/menu` | MainMenu (single player / options / about) |
| `#/single-player` | SinglePlayer (CTF / time trial) |
| `#/tt`, `#/tt/easy`, `#/tt/normal`, `#/tt/hard` | TimeTrial menus + track lists |
| `#/ctf` | CaptureTheFlag menu (easy / normal / hard) |
| `#/briefing/:level` | MenuXML briefing (scores + description + start) |
| `#/game/:level` | GameInstance HUD + playable level |
| `#/options` (`#/settings` alias) | MenuOptions |
| `#/about` | About credits |
| `#/victory/:level`, `#/defeat/:level` | Victory / Defeat reward screens |
| unknown | graceful NotFound (background unchanged) |

Back/forward buttons and deep-link refresh work; the WebGL context persists
across routes — only the scene description swaps.

## Controls (game route)

W/S or ↑/↓ accelerate · A/D or ←/→ strafe · R/Space up · F down ·
Q/E orbit · Shift nitro · X/Ctrl fire · drag mouse to orbit camera ·
Esc back to briefing. Touch buttons on mobile.

## Layout

- `src/engine/` — WebGL2 context, GLSL (BasicEffect-equivalent lit + unlit +
  instanced + points), texture cache, JSON model loader/validation, camera,
  frustum culling, octree, renderer + scene graph + loop.
- `src/game/` — model/texture/team configs, 13-level catalogue, store
  (options/scores/navigation→scene map), Web Audio, binary+gzip protocol,
  ghost recording, physics helpers.
- `src/components/`, `src/views/`, `src/router/` — GenericMenu shell, menus,
  HUD, hash router.
- `tools/` — `convert-fbx.mjs`, `convert-levels.mjs`, `copy-assets.mjs`.
- `public/assets/` — converted models/levels + copied textures/sounds.

See `MIGRATION.md` for the full analysis, format docs, and fidelity notes.
