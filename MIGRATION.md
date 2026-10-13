# Migration report — InfinityEdge3D 3.7 (XNA 4.0) → Vue 3 + TypeScript + WebGL2

Source: `../IE3D_37_T` (174 `.cs`, 38 FBX, ~100 textures, 26 sounds, 13 levels,
14 menu XMLs, 8 reference screenshots `screenshots/SS1–SS8.png`).

## 1. Original architecture (as found)

- **Frame loop**: 30 fps fixed step, VSync; only the top scene updates/draws.
  Boot: EngineScreen (Wheel model + engineLogo, auto-orbit camera, fades
  3000/500 ms) → StartScreen (gameLogo over Background.xml) → MainMenu.
- **Rendering**: XNA BasicEffect only. EnableDefaultLighting with
  **AmbientLightColor 0.001**, white diffuse/Light0, Light1/2 off; per draw
  SpecularPower **1024**, SpecularColor LightBlue, per-pixel lighting,
  emissive parameter, alpha. Dual model sets: `modelN.fbx` (solid) and
  `colorN.fbx` (alpha shell). LOD `j = clamp(3·len/distance + detail, 0,
  models-1)`; fade `alpha *= clamp((distance-len)/32, 0, 1)`. Meshes tested
  as spheres (ray hits measured at mesh-sphere level).
- **Per-asset import transforms** are applied by the **XNA build itself** and
  therefore baked into the compiled `.xnb` shipped with the game
  (`tools/xnb/Objects/`): the content pipeline applies the ModelProcessor
  `Scale`/`RotationX/Y/Z` from `InfinityEdgeContent.contentproj`, the per-file
  FBX unit scale, the FBX→XNA axis conversion and the node hierarchy. The
  converter replays the runtime composition instead of re-deriving it:
  `World = transforms[ParentBone] * vertex` (`Model.CopyAbsoluteBoneTransformsTo`
  = `local * parentAbsolute`, `Model3D.Draw`), and `Model3D.GetBoundingSphere`
  (merge of `mesh.BoundingSphere.Transform(absoluteBone)`), which is the sphere
  the game uses for collisions and flare placement.
- **Camera**: FOV π/4, near 0.1, far = options distance (default 192).
  Follow cam 6 units behind (stick ±π/24 + π/16 pitch bias, banked up),
  lookAt = pos + dir·distance; menu orbit r=6/h=3 at 1°/frame.
- **OcTree**: cubic root, child halves +10% clamped, fragment while X-extent
  > **32**, counts (incl. interactiveCount), prune-on-empty, refresh
  reinsertion; frustum/sphere/ray selects.
- **UI**: fully declarative scene XML (Engine factories/modules). GenericMenu
  provides `_window` (backWindow Black40 `0|0|0|100`, body −96 px), corner
  buttons 160×48 (LU back + `commandTextIfRoot exit/back`, DarkRed hover
  `50|0|0|100`; RU DarkGreen `0|50|0|100`), `_leftSide`/`_rightSide`.
  Fonts: DejaVu Sans 18/12/16/16. UI colors are `r|g|b|a` 0–255.
- **Game rules (verbatim)**: `SpaceObject` has no shield/weapons — those live
  in `SpaceShip` (**homings = 2, nitro = 0**, shield absorb one hit,
  shield HUD alpha `shield/10`). Outsider rule: object at root node AND sphere
  disjoint from box → 10 s grace (Flags exempt). Bullets: first hit only,
  ray-mesh, TTL 3000, alternating muzzle, Life1(10). Missiles: TTL 2000,
  inherited launcher velocity, cone 0.75 @256. Flag: full CTF state machine
  (score/recovery/steal/lost 20 s; carried scale 0.10). Asteroid: 4×12% drops,
  10 fragments. Addons: homing +2, repair restore, nitro 3000, shield 10.
  Rewards: AND of conditions, non-empty; `Destroyed = !_active`;
  `MorePoints = points > minimum` (not max). TT clock pauses while only the
  base is inside the base sphere. No AIBullet; bullets fly straight.
- **Navigation**: scene stack with background inheritance
  (`Scene._background`; GenericMenu/MenuXML draw it, GameInstance draws its
  own map). Back = pop + reload with preserved background; exit at root.
- **Network**: none in the original (offline game).
- **Audio**: 8 SoundEffects + 17 Voice lines (text verbatim in Engine.cs) +
  looping `sound.mp3` (repo copy 0 bytes).

## 2. What was migrated

- **Assets** (`tools/`): model converter reading the original compiled XNA
  content (`tools/convert-xnb.mjs`: XNB v5 Model reader, bone hierarchy →
  absolute matrices, `world = boneAbs · vertex` bake, per-mesh spheres,
  XNA-style `_bsphere` merge, BasicEffect → material + texture resolution
  against the source content dir; `node tools/convert-xnb.mjs --check` parses
  without writing) — 43 files, 0 failures. Level/menu XML→JSON with comments
  stripped (commented objects/actions never parse) and sibling Menu.xml
  texts/scoreBoard captured — 14 files. Textures/sounds/icons copied
  (113 files). `tools/convert-fbx.mjs` (raw FBX + contentproj replay) is kept
  for reference only; it could not reproduce the compiled result.
- **Engine**: GL2 context + loop with context-loss recovery, BasicEffect-exact
  shaders, texture cache with mipmaps, model validation + LOD/fade + per
  material textures, follow/orbit cameras, frustum, OcTree (>32), billboards
  (gated on Special Effects + distance fade ×clamp((d−len)/32)), hexagon walls
  (64/0.1), sky (unlit, camera-centred).
- **Game**: full 37_T simulation per section 1, all 13 AIs and the XM_Actions
  factory table, Map timer lists (stack semantics), GameInstance update/draw
  order, HUD (scoreboard `ToVisualIngame`, aim at pos+dir·distance, DrawPointer
  with _over brackets/life% and icon clamping, life bars with fixed widths),
  scores top-10 + best-detection, **ghost**: per-frame records, playback with
  0.5 alpha, framed+gzip persistence of the winning run, XML `.ghs` export.
- **UI**: GenericMenu shell values reproduced exactly (panels, corners,
  hover colours, exit/back), menus built from the same XML data (icons,
  PEGASUS/LEO/DRACO, Track 01../Demo Track, PEGASUS watermark at 20%,
  briefing scoreBoard padded to 10 + verbatim textBox, options exact ranges
  and labels, about 1.0.0.5 credits, victory "Congratulations <user>!" with
  128 px medal). `src/ui/scene-xml.ts` parses the same scene XML surface
  (background/body/buttonSkin/font/textures/models/scoreBoard/options/about/
  element refs) for data-driven views.
- **Navigation**: hash router with boot sequence, unknown-route fallback,
  deep-link restore, history back/forward, and the navigation→scene mapping
  (`sceneForRoute`) keeping the shared Background scene resident.

## 3. Verification (real browser)

- **Model matrices (fix)**: geometry now comes from the original compiled
  content and matches the reference screenshots: Fighter3 is a flat horizontal
  dart (wingspan 2.59, length 2.06, nose +Z, centered), Ark rings face the
  flight axis (radius 16.75), the base hexagon sphere is 12.7, bullets/missiles
  point +Z, the flag cluster sits at its origin, planets align with their cloud
  layers. Camera framing matches SS3 (ship ≈31% of the 800 px width at the
  original 6-unit chase distance = 2.59/8.3). Addon aliases (`adShield` →
  `AddonShield.json`, ...) and the HUD pointer clamp (`MyClamp` + reflect off
  the near plane) now follow `GameInstance.DrawPointer`; the base pointer sits
  at the top edge exactly as in SS3.
- TT Easy 01: full-throttle run collects all 6 gates in ~4.5 s → Gold victory
  (limit 6 s), ghost recorded.
- TT Easy 02: gate course → Victory screen, medal, score (`TT_E_02.svg`) and
  ghost (`TT_E_02.ghs`) saved (new best only).
- CTF Easy: 10v9 ships + bases + flags + 8000 asteroids; 25 s AI combat with
  the player firing every second, zero page errors; the teal hexagon base,
  bracket pointers ("100%"), ship icons and flag pointer match SS6/SS7.
- Menus, briefing (verbatim training text), options, about, tracks render
  from converted data; background scene persists across navigation; the main
  menu composition matches SS1 (ship over the base sphere, same icons).
- Unit tests 21/21 (previous revision): binary protocol + gzip (flag rules,
  small-message raw, malformed rejection), frustum (sphere/box/near-plane),
  OcTree (descent, queries, prune), physics (integration, clamp, lead-shot,
  clamps).

## 4. Known approximations

- **UI implementation**: the original's `FloatingGear` widget engine is
  re-created as app-specific Vue components with the same measured values
  (the scene XML surface is parsed, not a general widget engine).
- **Motion blur / wireframe**: render-target post effects are not reproduced
  (option flags preserved); the original's wireframe UI is commented out.
- **`.spritefont`** → DejaVu Sans at the declared sizes; `.wma`/0-byte `.mp3`
  → music degrades to silence.
- **Ghost `.ghs`** files ship empty; ghosts persist in localStorage using the
  framed binary format (XML export available via `ghostToXml`).
- Options/scores persist as XML/JSON in localStorage (IEFile replacement).
- The `Min`/`Max` conversions of `Maths.StringToVector3` keep the original
  comma→exception quirk; commented level content stays unparsed.
