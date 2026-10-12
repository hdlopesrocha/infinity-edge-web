# Migration report: InfinityEdge3D (XNA) → Web (full port)

Source: `../InfinityEdge3D` — XNA 4.0 space-combat game (168 `.cs` files;
38 FBX; ~86 textures; 25 WAV; 13 `Level.xml` + `Background.xml`).

## 1. What was ported (everything)

- **Simulation**: `Object3D.NextPosition/Move` (accel·multiplier −
  friction·vel, speed clamp, nitro ×7.5, multiplier lerp .2), sphere-only
  collisions, ram = mutual `GetTotal()` damage, shield absorbs whole hits.
- **Objects**: SpaceShip (10 homings, 3000 nitro, engine/color flares,
  shield shell ≤0.1 alpha, glow decay .03, smoke), Asteroid (tumble, 4×12%
  addon drops, 10 fragments + husk), Addon (7-size glow billboard +
  homing+2/life/nitro=3000/shield=5), Base (double-sided, shield 1,
  `RandomAround` shell), Flag (full CTF state machine: score/catch/lost
  20 s/follow/pose, sounds on `_team`), Bullet (segment sphere, Life1(10),
  TTL 3000, alternating muzzle), HomingMissile (MISSILE physics, lock
  cone 0.75 @256, TTL 2000, AIHoming, smoke trail), Shield shell,
  Ark (alpha 0.2, gate sequencing), Sky (camera-follow, unlit),
  Billboard/TimedBillboard (fade), Fragment (vel 30, TTL 500).
- **AI**: AIPoint/AIGoPoint (32-brake)/AIGoRandom/AIGoSphere/AIOffensive
  (128, stale-target quirk)/AIFreePath (64)/AIFollow/AIFlagCap
  (last-flag-wins)/AIGoRandomOffensive/AIBreak (10+rand5 / 5+rand10,
  TimeSpan.Seconds semantics)/AIBullet (radius 8, first-hit quirk)/
  AIHoming/AITimeTrial/HILocal (stick ∓π/2, cap·|stick|, _distance
  search, lead-or-dumbfire) + factories (BodyGuard/FlagProt/SpawnKiller).
- **Map**: octree (10% overlap, frag > 48, prune, refresh), respawns
  (10 s, face-enemy-base), path highlight, bullets (ray-mesh `BulletHit`,
  shield absorb, spark billboards, TTL), smoke/frags/outsiders (10 s),
  visible asteroid/addon ticks, two-pass draw + hexagon walls (64/0.1),
  exact factory (`around`=ONE ship, asteroids loop unnamed, ministars
  only if billboards), `random/around/x|y|z` + `a|b|c` grammars.
- **GameInstance**: BACK vs game update order, team clocks (TT pause
  rule), non-Flag ticks then flags, goals → Victory/Defeat scenes,
  ghost record/playback (alpha 0.5), scoreboard `ToVisual`, aim at
  `pos+dir·_distance`, `DrawPointer` (over+life% / icon+MyClamp+ellipse),
  life bars (fixed-width quirk), notification 3000 ms, `Team.Manage`
  voice drain, scores top-10 + best detection, ghost save on best.
- **Menus/navigation**: scene stack → hash routes; GenericMenu chrome;
  all menus verbatim; Options exact defaults (Infinity Fan/2/192/0.5/
  off/off, empty→Infinity Edge Fan, `suckmyrocket` cheat, version-wipe);
  splashes 3000/500 ms; Victory medal rules (128 px, click→back).
- **Assets**: 40 JSON models (ASCII 2013 + binary v6100 parsers, LODs,
  materials/textures/bounds/transforms), 14 level JSON (comments
  stripped), 100+ textures incl. icons/holoSmoke/hexagon, 25 WAV.
  Missing assets fall back (procedural/white/silence), never crash.
- **Net**: versioned binary framing (type/len/gzip-flag), gzip only when
  smaller and ≥256 B, `DecompressionStream`→pako fallback, typed errors,
  capped-reconnect socket. Used by ghost persistence; game is
  offline-first like the original (which has no network code).

## 2. Verification (real browser)

- TT Easy 01: spawn → throttle → 6 gates → clock → **Gold victory**,
  score + ghost saved, medal + briefing scores shown.
- CTF Easy: 30 s AI combat, kills, respawns (10 s), addon drops/pickups,
  steal → carry → score (points + voices), outsider destruction.
- Respawn/outsider/flag/score targeted tests pass; defeat path verified.
- All routes render; back/forward + deep links sync scenes; context
  persists; zero console errors; 19/19 unit tests (protocol, frustum
  incl. near-plane layout, physics, octree descent regression).

## 3. Known approximations

- Motion-blur render targets → same scene without accumulation pass
  (option flag kept). No wireframe (WebGL2 lacks it; no UI referenced it).
- `Stone`/`Ship` engine-flare billboards use team/white colors as coded.
- FBX outlier parts preserved as exported (authentic baked bounds; the
  tutorial's gate-1 auto-collect follows from the real data).
- `.spritefont` → system sans at matching sizes/colors; `.wma`/0-byte
  `.mp3` → music degrades to silence; scores/ghosts/options use
  localStorage JSON/XML instead of isolated storage (formats documented
  in code).
- WASD aliases added to the exact arrow/Space/Ctrl/Alt/Shift mapping.
