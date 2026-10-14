# Converted asset formats

Everything the renderer consumes is produced by the scripts in `tools/` from
the **original XNA build output**, and every output is reproducible:

```sh
npm run copy:assets      # textures, sounds, icons  -> public/assets/{textures,sounds}
npm run convert:models   # modelN.xnb / colorN.xnb  -> public/assets/models/*.json + *.bin
npm run convert:levels   # Level.xml / Menu.xml     -> public/assets/levels/*.json
node tools/convert-xnb.mjs --check   # parse + validate without writing
```

## 1. Textures, sounds, icons

`tools/copy-assets.mjs` copies the original PNG/JPG/WAV/MP3 files with their
`TextureConfig.xml` aliases (`_buttonLU` → `assets/textures/_buttonLU.png`, …)
plus the per-object icons and the app icons, and writes
`public/assets/textures/objects/` for reference. No re-encoding, so dimensions,
alpha and colour space are preserved exactly.

## 2. Models: `<Name>.json` + `<Name>.bin`

Source: the compiled `.xnb` from the shipped build (vendored under
`tools/xnb/Objects/`), read by `tools/convert-xnb.mjs` (XNB v5 `Model` reader,
LZX/gzip-aware). The converter replays the runtime composition instead of
re-deriving it:

* `World = transforms[ParentBone] * vertex` (XNA
  `Model.CopyAbsoluteBoneTransformsTo` + `Model3D.Draw`), i.e. mesh-space
  vertices are baked through their absolute bone matrix,
* per-mesh spheres are computed with the same min/max midpoint + max distance
  rule as `Model3D.GetBoundingSphere`, and merged the same way for
  `boundingSphere`,
* material colours and the texture *file* name come from the compiled
  `BasicEffect`,
* the per-file import transforms (unit scale, axis conversion, content-pipeline
  `Scale`/`RotationX/Y/Z`) are already inside the XNB, which is why this route
  reproduces the original geometry where a raw-FBX re-import cannot.

### JSON (version 2) — metadata

```jsonc
{
  "version": 2,
  "source": "Objects/Fighter3/model0.xnb",
  "generator": "tools/convert-xnb.mjs (original XNA build output)",
  "upAxis": "Y",            // XNA convention, kept as-is
  "units": "xna",
  "binary": { "file": "Fighter3.bin", "byteLength": 46504,
              "endianness": "little",
              "layout": "position:f32x3,normal:f32x3,uv:f32x2,index:u16|u32" },
  "boundingSphere": { "center": [x, y, z], "radius": r },
  "boundingBox":    { "min": [x, y, z], "max": [x, y, z] },
  "meshes": [{
    "name": "ID10",
    "material": "metal",
    "vertexCount": 116, "indexCount": 144, "indexType": "u16",
    "section": { "position": { "offset": 0, "length": 1392 },
                 "normal":   { "offset": 1392, "length": 1392 },
                 "uv":       { "offset": 2784, "length": 928 },
                 "index":    { "offset": 3712, "length": 288 } },
    "bounds": { "center": [x, y, z], "radius": r }
  }],
  "materials": [{ "name", "diffuse", "emissive", "specular", "shininess", "alpha", "texture" }],
  "nodes": [{ "name", "parent", "matrix" }]   // bone hierarchy, for reference
}
```

### Binary sidecar — vertex/index data

Per mesh, in mesh order, each section 4-byte aligned, little-endian:

```
Float32 position[vertexCount * 3]
Float32 normal[vertexCount * 3]
Float32 uv[vertexCount * 2]
Uint16|Uint32 index[indexCount]     // Uint32 when a vertex index exceeds 65535
```

The loader (`src/engine/model.ts`) fetches the JSON, validates every range
against the declared `byteLength`, fetches the sidecar — over the WebSocket
channel when it is enabled, otherwise HTTP — and uploads the buffer with
`bufferData` through typed-array *views*, so no per-vertex JavaScript arrays
are created at load time. Inline `positions/normals/uvs/indices` arrays are
still accepted (version 1 / procedural fallback models).

Effect of the split (all 43 converted models, 72 meshes):

| model | before (JSON only) | after (JSON + bin) |
|---|---|---|
| `Asteroid3.json` | 657 KB | 1 KB + 408 KB |
| all models | 2.6 MB | 1.9 MB (and ~1 KB parsed per model) |

## 3. Levels and menus: `*.json`

`tools/convert-levels.mjs` converts `Level.xml` (+ the sibling `Menu.xml`) into
JSON: description, imports, objects (team/type/model/position/life/amount),
camera, actions, goals, briefing text and scoreboard tag. XML comments are
stripped first, because commented-out objects/actions never reach the original
parser either. `public/assets/levels/INDEX.json` lists every converted level
with its source path and object count.

## 4. Ghost recordings: framed binary

`src/game/ghost.ts` serialises a recorded run with the same frame format as the
WebSocket protocol (`src/game/net.ts`): version + flags + type + length, gzip
above 256 bytes. The winning run is persisted in `localStorage`, and
`ghostToXml()` provides the `.ghs`-style XML export.
