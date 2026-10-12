# Migration report: InfinityEdge3D (XNA) → Web (Vue 3 + TS + WebGL2)

Source: `../InfinityEdge3D` — XNA 4.0 / Windows Phone 7 space-combat game
(168 `.cs` files, ~13 kLOC; 38 FBX; ~86 textures; 25 WAV; 13 `Level.xml`).

## 1. Original architecture (as found)

- **Rendering**: XNA `BasicEffect` only (`Model3D.Draw`), `PreferPerPixelLighting`,
  Light0 on / Light1-2 off, ambient ≈ 0.001, diffuse white, specular LightBlue,
  powers 512–1024. Two passes in `Map.Draw`: opaque (`BlendState.Opaque`) then
  alpha (`DepthRead` + `AlphaBlend`). `CullCounterClockwise`, `LinearWrap`.
  `GameInstance` adds render-target motion blur + `SpriteBatch` HUD.
- **Coordinates**: Y-up, forward `+Z` (`Object3D`: Direction = UnitZ·quat).
  Cubic world centered on origin (`OcTree`, `Map.PositionInside`).
- **Camera** (`Camera.cs`): orbit state (h/v clamped), FOV π/4, near 0.1,
  far = options distance; chase/look-at per level `<camara>`.
- **Culling**: `OcTree` (fragments while size > 48, 8 children, 3 buckets by
  object type) + `BoundingFrustum` sphere-then-mesh tests; transparent sorted
  far-to-near (`ObjectDistanceComparer`).
- **Physics**: sphere-only (`NextPosition`: accel·multiplier − friction·vel,
  speed clamp, nitro multiplier 7.5; `BulletHit` ray-vs-sphere; `Move` team
  damage/shield logic). No rigid bodies.
- **Scenes/UI**: `Stack<Scene>` (`Game1`: MainMenu → StartScreen →
  EngineScreen on top). `GenericMenu` builds the chrome in code (empty XML
  stubs): full-screen `_backWindow` Black40 −96 px, left/right split, four
  160×48 corner buttons (hover DarkRed50/DarkGreen50), `back|exit` label =
  stack depth. All real layouts are C# (`MainMenu`, `SinglePlayer`,
  `TimeTrial.*`, `CTF.Menu`, `MenuXML` briefing, `MenuOptions`, `About`,
  `GameInstance` Victory/Defeat). Background: `Background.xml` game instance
  (Sky1 + base + Fighter3 + 70×Asteroid1 + 70×Asteroid3 + 600 stars) drawn
  behind every menu; levels draw their own maps.
- **Levels**: 10 TT (`type=TT`, Ark-gate races vs clock/ghost, Gold/Silver/
  Bronze `LessTime` + `Defeat` on `NoPath`/`Destroyed`) + 3 CTF (`type=CTF`,
  10 human + 9 alien respawning AI, bases ±800, 5-minute `MoreTime`/
  `MorePoints`). Full `<game>` schema preserved in `public/assets/levels/`.
- **Network**: none — zero Socket/WebSocket hits; multiplayer button commented
  out (`MainMenu.cs`); all content is `SinglePlayer/`. The game is offline.
- **Audio**: looping `sound.mp3` via `MediaPlayer` + fire-and-forget
  `SoundEffect` SFX + `Voice` subtitle lines. Note: the repo's `sound.mp3`
  is **0 bytes**, and the only built music is a `.wma` (unplayable in
  browsers) — music therefore degrades gracefully to silence; all 25 WAV SFX
  and 17 voice lines are ported.

## 2. Technology mapping

| Original | Web |
|---|---|
| XNA `Game` loop (30 fps fixed, VSync) | `requestAnimationFrame` loop, dt clamped 0.1 s |
| `BasicEffect` | `src/engine/shaders.ts` lit/unlit GLSL (1 dir light, ambient, LightBlue Blinn-Phong specular, emissive, alpha) |
| `Model`/`ModelMesh` + Content pipeline | `tools/convert-fbx.mjs` → JSON + `src/engine/model.ts` VAO/VBO/IBO loader with validation |
| `TextureCache` (AVL) + `LinearWrap` | `src/engine/texture.ts` Map cache, REPEAT + trilinear mipmaps |
| `Camera` + `BoundingFrustum` | `camera.ts` (gl-matrix) + `frustum.ts` (plane extraction, zero per-frame alloc) |
| `OcTree` + frustum/sphere queries | `octree.ts` (same thresholds: fragment > 48, 3 buckets) + chunked instancing |
| `Map.Draw` two passes | `scene.ts`: opaque pass → stars → alpha pass; instanced asteroids, `GL.POINTS` ministars |
| `Object3D.NextPosition`/`Move` | `game/physics.ts` (same integration, nitro ×7.5, cubic clamp) + renderer chase cam |
| `GhostRecord` `.ghs` / `IsolatedStorage` | `game/ghost.ts`: 1 Hz samples → framed binary → localStorage; briefing shows sample count |
| `MediaPlayer`/`SoundEffect`/`Voice` | `game/audio.ts`: Web Audio SFX + voices, `<audio>` loop, first-gesture unlock |
| Scene stack + `Command*` navigation | Vue Router hash history + `syncSceneState` route→scene map (`store.ts`) |
| Proprietary `InterfaceElement` tree | App-specific Vue components + CSS (`MenuShell`, views) — no UI engine ported |
| `options.ie3d` | localStorage options + scores (`store.ts`) |

No three.js / Babylon / game engine: `package.json` has only
`vue`, `vue-router`, `gl-matrix`, `pako` (+ build tooling).

## 3. Asset conversion

- `tools/convert-fbx.mjs` parses **ASCII FBX 2013** (geometry embedded in
  `Model:` blocks, `Connect:` name links) and **binary FBX v6100** (`Model`
  nodes, scalar-per-number properties, zlib arrays supported, name-based
  links; v7500+ 64-bit offsets supported). Handles fan triangulation,
  ByPolygonVertex/ByVertice × Direct/IndexToDirect, node Lcl matrices
  (baked), materials (phong colors, shininess, opacity), texture filenames,
  bounds, up-axis/units metadata. Result: **40 JSON models, 0 failures**
  (3 empty 0-byte placeholders skipped and recorded; lowest real LOD
  promoted to `<Alias>.json`). LOD chains match `CONVENCOES.txt`
  (e.g. Asteroid4 1024/512/256/128).
- `tools/convert-levels.mjs`: all 13 `Level.xml` + `Background.xml` →
  `public/assets/levels/*.json` + `INDEX.json` (14 files).
- `tools/copy-assets.mjs`: 106 files (UI textures by alias, object diffuse
  textures, 25 WAV + music stub).
- Runtime never breaks on missing assets: procedural fallback geometry
  (`model.ts`) + white-pixel texture + silent-audio catches.

## 4. Binary protocol + gzip (`src/game/net.ts`)

Documented framing: version u8, flags u8 (bit0 = gzip), type u16 LE,
payload-length u32 LE, payload. Rules: never compress < 256 B; only keep
gzip output when smaller; decompress via `DecompressionStream('gzip')` with
pako `gzip`/`ungzip` fallback; malformed/decompression errors throw typed
errors and never break rendering; `GameSocket` reconnects with capped
backoff. Used for real: ghost persistence; available for optional companion
servers (game runs offline-first, like the original).

## 5. Verification performed

- `vue-tsc` clean; `vite build` clean; dev + `preview` serve with deep links.
- Real-browser tests: boot → splash → menu; all routes render; scene mapping
  (menus → background, game → level, unknown → background); back/forward
  history syncs scenes; WebGL context persists across routes.
- Rendering: background 6 draws, CTF 38 draws / 19 culled, `gl.getError()==0`,
  all model/texture/sky loads resolve; keyboard → `renderer.input` routing.
- Unit tests (20/20): gzip roundtrips + flag rules + malformed rejection,
  frustum sphere/box cases, physics integration/clamp/intercept.
- Ghost cycle: record → framed+gzip → localStorage → briefing count.
- Frustum culling changes draw/culled counts with camera; chunk-level
  instancing bounds prevent edge popping (conservative radii).

## 6. Known approximations

- Motion blur: original used render targets; the port keeps the option flag
  and renders the same scene without the accumulation pass (documented in
  Options; no visual smearing).
- Wireframe: WebGL2 has no wireframe raster mode; the toggle is accepted but
  renders solid (same tradeoff documented in code).
- AI (AIFlagCap/AIBodyGuard/…), bullets, addons pickups, flag logic, and
  full win evaluation are stubbed to ambient behavior + timer goals; the
  scene population, camera, briefing data, and navigation are faithful.
- FBX `ID188`-style outlier parts are preserved as exported (authentic data).
- Fonts: XNA `.spritefont` has no web equivalent; system sans used at
  matching sizes/alignments/colors.
