// FBX -> JSON converter for InfinityEdge3D assets.
// Usage: node tools/convert-fbx.mjs [--check]
// Reads:  ../InfinityEdge3D/InfinityEdge/InfinityEdgeContent/Objects/*/model*.fbx
// Writes: public/assets/models/<Alias>.json (+ <Alias>_lod<N>.json), MANIFEST.json
//
// Handles ASCII FBX 2013 (geometry in `Model:` blocks, `Connect:` name links)
// and binary FBX v6100+ (geometry in `Model` nodes, scalar-per-number props,
// zlib arrays, name- or id-based links). Sources are CRLF: all line splitting
// is CR-safe. Preserves positions/normals/UVs/indices, bounds, phong
// materials + texture refs, node Lcl transforms, up-axis/units metadata.
// Empty 0-byte placeholders are skipped; the lowest real LOD becomes
// <Alias>.json (CONVENCOES.txt: model 0 is master).

import { inflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const objectsDir = join(webRoot, '..', 'InfinityEdge3D', 'InfinityEdge', 'InfinityEdgeContent', 'Objects');
const outDir = join(webRoot, 'public', 'assets', 'models');
const CHECK = process.argv.includes('--check');

// ---------------- mesh builder ----------------
function buildMesh(geom) {
  const { vertices, pvi, normalLayer, uvLayer } = geom;
  const positions = [], normals = [], uvs = [], indices = [];
  const seen = new Map();
  const attr = (layer, data, indexArr, corner, ctrl, isUV) => {
    if (!data || !data.length) return null;
    const m = (layer.mapping || 'ByPolygonVertex').toLowerCase();
    const r = (layer.reference || 'Direct').toLowerCase();
    if (m === 'bypolygonvertex') {
      const ii = r === 'direct' ? corner : (indexArr[corner] ?? 0);
      return isUV ? ii * 2 : ii * 3;
    }
    if (m === 'byvertice' || m === 'byvertex' || m === 'bycontrolpoint') {
      const ii = r === 'direct' ? ctrl : (indexArr[ctrl] ?? 0);
      return isUV ? ii * 2 : ii * 3;
    }
    if (m === 'bypolygon') {
      const ii = r === 'direct' ? 0 : (indexArr[0] ?? 0);
      return isUV ? ii * 2 : ii * 3;
    }
    if (m === 'allthesame') return 0;
    return null;
  };
  const triCorners = [];
  {
    let poly = [], ci = 0;
    for (const raw of pvi) {
      const ctrl = raw < 0 ? ~raw : raw;
      poly.push({ ctrl, corner: ci++ });
      if (raw < 0) {
        for (let i = 1; i < poly.length - 1; i++) triCorners.push(poly[0], poly[i], poly[i + 1]);
        poly = [];
      }
    }
  }
  for (const { ctrl, corner } of triCorners) {
    const px = vertices[ctrl * 3] ?? 0, py = vertices[ctrl * 3 + 1] ?? 0, pz = vertices[ctrl * 3 + 2] ?? 0;
    let nx = 0, ny = 1, nz = 0;
    if (normalLayer?.data?.length) {
      const o = attr(normalLayer, normalLayer.data, normalLayer.index ?? [], corner, ctrl, false);
      if (o !== null && normalLayer.data[o] !== undefined) {
        nx = normalLayer.data[o]; ny = normalLayer.data[o + 1]; nz = normalLayer.data[o + 2];
      }
    }
    let uu = 0, vv = 0;
    if (uvLayer?.data?.length) {
      const o = attr(uvLayer, uvLayer.data, uvLayer.index ?? [], corner, ctrl, true);
      if (o !== null && uvLayer.data[o] !== undefined) { uu = uvLayer.data[o]; vv = uvLayer.data[o + 1]; }
    }
    const key = `${px.toFixed(5)},${py.toFixed(5)},${pz.toFixed(5)}|${nx.toFixed(4)},${ny.toFixed(4)},${nz.toFixed(4)}|${uu.toFixed(5)},${vv.toFixed(5)}`;
    let vi = seen.get(key);
    if (vi === undefined) {
      vi = positions.length / 3; seen.set(key, vi);
      positions.push(px, py, pz); normals.push(nx, ny, nz); uvs.push(uu, vv);
    }
    indices.push(vi);
  }
  return { positions, normals, uvs, indices };
}

function boundsOf(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const d = Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]);
    if (d > radius) radius = d;
  }
  return { min, max, center, radius };
}

function composeLocal(t, rDeg, s) {
  const [rx, ry, rz] = rDeg.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const R = [
    [cy * cz, -cy * sz, sy],
    [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
    [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
  ];
  const M = [
    [R[0][0] * s[0], R[0][1] * s[1], R[0][2] * s[2], t[0]],
    [R[1][0] * s[0], R[1][1] * s[1], R[1][2] * s[2], t[1]],
    [R[2][0] * s[0], R[2][1] * s[1], R[2][2] * s[2], t[2]],
    [0, 0, 0, 1],
  ];
  const out = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out.push(M[r][c]);
  return out;
}

function applyMatrixToMesh(mesh, M) {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    p[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    p[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    p[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  const n = mesh.normals;
  for (let i = 0; i < n.length; i += 3) {
    const nx = M[0] * n[i] + M[4] * n[i + 1] + M[8] * n[i + 2];
    const ny = M[1] * n[i] + M[5] * n[i + 1] + M[9] * n[i + 2];
    const nz = M[2] * n[i] + M[6] * n[i + 1] + M[10] * n[i + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    n[i] = nx / l; n[i + 1] = ny / l; n[i + 2] = nz / l;
  }
}
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const round3 = (arr) => arr.map((v) => Math.round(v * 1000) / 1000);

// ---------------- ASCII ----------------
function asciiBlocks(text, kind) {
  const out = [];
  const re = new RegExp(`^\\s*${kind}:\\s*(?:(\\d+),\\s*)?"([^"]*)"\\s*,\\s*"([^"]*)"\\s*\\{`, 'gm');
  let m;
  while ((m = re.exec(text))) {
    let depth = 0, i = m.index + m[0].length - 1;
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push({ id: m[1] !== undefined ? Number(m[1]) : null, name: m[2], subtype: m[3], body: text.slice(start + 1, i) });
    re.lastIndex = i;
  }
  return out;
}

function asciiArray(body, key) {
  const lines = body.split(/\r?\n/);
  let collecting = false, text = '';
  for (const line of lines) {
    if (!collecting) {
      const m = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
      if (m) { collecting = true; text += ' ' + m[1]; }
    } else {
      if (/^\s*[A-Za-z][A-Za-z0-9_]*\s*:.*$/.test(line) || /^\s*\}.*$/.test(line) || /^\s*\{.*$/.test(line)) break;
      text += ' ' + line;
    }
  }
  if (!collecting) return [];
  text = text.replace(/\*\d+\s*\{/g, ' ').replace(/\ba\s*:/g, ' ').replace(/[{}]/g, ' ');
  return text.split(/[\s,]+/).filter((s) => s.length).map(Number).filter((n) => !Number.isNaN(n));
}

function asciiString(body, key) {
  const m = body.match(new RegExp(`${key}:\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

function asciiLayer(body, prefix, dataKey, indexKey) {
  const m = body.match(new RegExp(`^\\s*${prefix}:\\s*\\d+\\s*\\{`, 'm'));
  if (!m || m.index === undefined) return null;
  let depth = 0, i = m.index + m[0].length - 1;
  const start = i;
  for (; i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) break; }
  }
  const block = body.slice(start + 1, i);
  return {
    mapping: asciiString(block, 'MappingInformationType') || 'ByPolygonVertex',
    reference: asciiString(block, 'ReferenceInformationType') || 'Direct',
    data: asciiArray(block, dataKey),
    index: indexKey ? asciiArray(block, indexKey).map((n) => Math.trunc(n)) : [],
  };
}

function asciiLcl(body, prop, fallback) {
  const m = body.match(new RegExp(`(?:Property|P):\\s*"${prop}"[^\\n]*?"A\\+?"\\s*,\\s*([-\\d.eE+]+)\\s*,\\s*([-\\d.eE+]+)\\s*,\\s*([-\\d.eE+]+)`));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fallback;
}

function asciiMatProp(body, prop) {
  const m = body.match(new RegExp(`(?:Property|P):\\s*"${prop}"[^\\n]*?""\\s*,\\s*([^\\n]+)`));
  if (!m) return null;
  const nums = m[1].split(',').map((s) => Number(String(s).trim())).filter((n) => !Number.isNaN(n));
  return nums.length ? nums : null;
}

function parseAscii(buf) {
  const text = buf.toString('utf8');
  const mver = text.match(/FBXVersion:\s*(\d+)/);
  const meshHolders = [];
  for (const b of asciiBlocks(text, 'Model')) {
    if (b.subtype !== 'Mesh') continue;
    const holder = {
      key: b.id !== null ? String(b.id) : b.name,
      name: b.name.replace(/^Model::/, ''),
      matrix: composeLocal(
        asciiLcl(b.body, 'Lcl Translation', [0, 0, 0]),
        asciiLcl(b.body, 'Lcl Rotation', [0, 0, 0]),
        asciiLcl(b.body, 'Lcl Scaling', [1, 1, 1]),
      ),
      geom: null,
    };
    const verts = asciiArray(b.body, 'Vertices');
    if (verts.length) {
      holder.geom = {
        vertices: verts,
        pvi: asciiArray(b.body, 'PolygonVertexIndex').map((n) => Math.trunc(n)),
        normalLayer: asciiLayer(b.body, 'LayerElementNormal', 'Normals', 'NormalsIndex'),
        uvLayer: asciiLayer(b.body, 'LayerElementUV', 'UV', 'UVIndex'),
      };
    }
    meshHolders.push(holder);
  }
  const standalone = [];
  for (const b of asciiBlocks(text, 'Geometry')) {
    if (b.subtype !== 'Mesh') continue;
    standalone.push({
      key: b.id !== null ? String(b.id) : b.name,
      vertices: asciiArray(b.body, 'Vertices'),
      pvi: asciiArray(b.body, 'PolygonVertexIndex').map((n) => Math.trunc(n)),
      normalLayer: asciiLayer(b.body, 'LayerElementNormal', 'Normals', 'NormalsIndex'),
      uvLayer: asciiLayer(b.body, 'LayerElementUV', 'UV', 'UVIndex'),
    });
  }
  const mats = new Map();
  for (const b of asciiBlocks(text, 'Material')) {
    const key = b.id !== null ? String(b.id) : b.name;
    const diff = asciiMatProp(b.body, 'DiffuseColor') ?? asciiMatProp(b.body, 'Diffuse') ?? [0.75, 0.78, 0.85];
    const emis = asciiMatProp(b.body, 'EmissiveColor') ?? asciiMatProp(b.body, 'Emissive') ?? [0, 0, 0];
    const spec = asciiMatProp(b.body, 'SpecularColor') ?? asciiMatProp(b.body, 'Specular') ?? [0.68, 0.85, 1];
    const shin = asciiMatProp(b.body, 'ShininessExponent') ?? asciiMatProp(b.body, 'Shininess') ?? [32];
    const opac = asciiMatProp(b.body, 'Opacity') ?? [1];
    mats.set(key, {
      name: b.name.replace(/^Material::/, ''),
      diffuse: diff.slice(0, 3), emissive: emis.slice(0, 3), specular: spec.slice(0, 3),
      shininess: shin[0] ?? 32, alpha: opac[0] ?? 1,
    });
  }
  const texFiles = new Map();
  for (const b of asciiBlocks(text, 'Texture')) {
    const key = b.id !== null ? String(b.id) : b.name;
    const f = b.body.match(/FileName:\s*"([^"]*)"/);
    if (f) texFiles.set(key, f[1].replace(/\\/g, '/').split('/').pop());
  }
  const conns = [];
  const reC = /C(?:onnect)?:\s*"([^"]*)"\s*,\s*"?([^",\s]+)"?\s*,\s*"?([^",\s]+)"?/g;
  let c;
  while ((c = reC.exec(text))) conns.push({ type: c[1], from: c[2], to: c[3] });
  return { version: mver ? Number(mver[1]) : 0, upAxis: 'Y', unitScale: 1, meshHolders, standalone, mats, texFiles, conns };
}

// ---------------- Binary ----------------
function parseBinaryNodes(buf, version) {
  const is64 = version >= 7500, step = is64 ? 8 : 4;
  const readUInt = (o) => (is64 ? Number(buf.readBigUInt64LE(o)) : buf.readUInt32LE(o));
  function readProp(o) {
    const type = String.fromCharCode(buf[o]); o += 1;
    switch (type) {
      case 'Y': return { v: buf.readInt16LE(o), o: o + 2 };
      case 'C': return { v: buf[o] !== 0, o: o + 1 };
      case 'I': return { v: buf.readInt32LE(o), o: o + 4 };
      case 'F': return { v: buf.readFloatLE(o), o: o + 4 };
      case 'D': return { v: buf.readDoubleLE(o), o: o + 8 };
      case 'L': return { v: Number(buf.readBigInt64LE(o)), o: o + 8 };
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const len = buf.readUInt32LE(o), enc = buf.readUInt32LE(o + 4), compLen = buf.readUInt32LE(o + 8);
        o += 12;
        let raw = buf.subarray(o, o + compLen); o += compLen;
        if (enc === 1) raw = inflateSync(raw);
        const rb = Buffer.from(raw), out = new Array(len);
        let p = 0;
        for (let k = 0; k < len; k++) {
          if (type === 'f') { out[k] = rb.readFloatLE(p); p += 4; }
          else if (type === 'd') { out[k] = rb.readDoubleLE(p); p += 8; }
          else if (type === 'l') { out[k] = Number(rb.readBigInt64LE(p)); p += 8; }
          else if (type === 'i') { out[k] = rb.readInt32LE(p); p += 4; }
          else { out[k] = rb[p] !== 0 ? 1 : 0; p += 1; }
        }
        return { v: out, o };
      }
      case 'S': {
        const len = buf.readUInt32LE(o);
        return { v: buf.subarray(o + 4, o + 4 + len).toString('binary'), o: o + 4 + len };
      }
      case 'R': {
        const len = buf.readUInt32LE(o);
        return { v: buf.subarray(o + 4, o + 4 + len), o: o + 4 + len };
      }
      default: throw new Error('unknown FBX property type: ' + type);
    }
  }
  function readNode(o) {
    const endOffset = readUInt(o), numProps = readUInt(o + step), nameLen = buf[o + 3 * step];
    if (endOffset === 0) return { node: null, o: o + 3 * step + 1 };
    const name = buf.subarray(o + 3 * step + 1, o + 3 * step + 1 + nameLen).toString('ascii');
    let p = o + 3 * step + 1 + nameLen;
    const props = [];
    for (let k = 0; k < numProps; k++) { const r = readProp(p); props.push(r.v); p = r.o; }
    const children = [];
    if (p < endOffset) {
      while (p < endOffset) {
        const r = readNode(p); p = r.o;
        if (r.node) children.push(r.node); else break;
      }
    }
    return { node: { name, props, children }, o: endOffset };
  }
  const nodes = [];
  let o = 27, guard = 0;
  while (o + 13 <= buf.length && guard++ < 100000) {
    let r;
    try { r = readNode(o); } catch { break; }
    o = r.o;
    if (r.node) nodes.push(r.node);
    else if (o + 32 > buf.length) break;
  }
  return nodes;
}

const findKids = (node, name) => (node.children || []).filter((c) => c.name === name);
const findKid = (node, name) => (node.children || []).find((c) => c.name === name);

function kidNumbers(node, name) {
  const k = findKid(node, name);
  if (!k || !k.props.length) return [];
  if (k.props.every((p) => typeof p === 'number')) return k.props.slice();
  const v = k.props[k.props.length - 1];
  return Array.isArray(v) ? v : [v];
}

function kidString(node, name) {
  const k = findKid(node, name);
  if (!k) return '';
  for (const p of k.props) {
    if (typeof p === 'string' && p.length && p !== name) {
      const clean = p.replace(/\0.*$/, '');
      if (clean.length) return clean;
    }
  }
  return '';
}

function binKey(firstProp) {
  if (typeof firstProp === 'number') return String(firstProp);
  const s = String(firstProp), parts = s.split('');
  void parts;
  const chunks = s.split('\x00');
  const name = chunks[0] || s;
  const cls = chunks.length > 1 ? chunks[chunks.length - 1].replace(/[^\x20-\x7e]/g, '') : '';
  return cls ? `${name}::${cls}` : name;
}

function binPropVals(propNode) {
  const vals = [];
  for (let i = propNode.props.length - 1; i >= 0; i--) {
    const v = propNode.props[i];
    if (typeof v === 'number') vals.unshift(v); else break;
  }
  return vals;
}

function binLcl(modelNode, prop, fallback) {
  const holder = findKid(modelNode, 'Properties70') ?? findKid(modelNode, 'Properties60');
  if (!holder) return fallback;
  for (const p of findKids(holder, 'P').concat(findKids(holder, 'Property'))) {
    if (p.props[0] === prop) {
      const vals = binPropVals(p);
      if (vals.length >= 3) return vals.slice(-3);
    }
  }
  return fallback;
}

function binLayers(node) {
  const layers = [];
  for (const ln of findKids(node, 'LayerElementNormal')) {
    layers.push({
      kind: 'n',
      mapping: kidString(ln, 'MappingInformationType') || 'ByPolygonVertex',
      reference: kidString(ln, 'ReferenceInformationType') || 'Direct',
      data: kidNumbers(ln, 'Normals'),
      index: kidNumbers(ln, 'NormalsIndex').map((n) => Math.trunc(n)),
    });
  }
  for (const ln of findKids(node, 'LayerElementUV')) {
    layers.push({
      kind: 'u',
      mapping: kidString(ln, 'MappingInformationType') || 'ByPolygonVertex',
      reference: kidString(ln, 'ReferenceInformationType') || 'IndexToDirect',
      data: kidNumbers(ln, 'UV'),
      index: kidNumbers(ln, 'UVIndex').map((n) => Math.trunc(n)),
    });
  }
  const n = layers.find((l) => l.kind === 'n'), u = layers.find((l) => l.kind === 'u');
  return {
    normalLayer: n ? { mapping: n.mapping, reference: n.reference, data: n.data, index: n.index } : null,
    uvLayer: u ? { mapping: u.mapping, reference: u.reference, data: u.data, index: u.index } : null,
  };
}

function parseBinary(buf) {
  const version = buf.readUInt32LE(23);
  const top = parseBinaryNodes(buf, version);
  const objects = top.find((n) => n.name === 'Objects');
  const connects = top.find((n) => n.name === 'Connections');
  const meshHolders = [], standalone = [], conns = [];
  const mats = new Map(), texFiles = new Map();
  let upAxis = 'Y', unitScale = 1;
  if (objects) {
    for (const child of objects.children || []) {
      if (child.name === 'GlobalSettings') {
        const holder = findKid(child, 'Properties70') ?? findKid(child, 'Properties60');
        if (holder) {
          for (const p of findKids(holder, 'P').concat(findKids(holder, 'Property'))) {
            if (p.props[0] === 'UpAxis') {
              const v = binPropVals(p).pop();
              upAxis = v === 2 ? 'Z' : v === 0 ? 'X' : 'Y';
            } else if (p.props[0] === 'UnitScaleFactor') unitScale = binPropVals(p).pop() || 1;
          }
        }
        continue;
      }
      if (child.name === 'Model') {
        const subtype = String(child.props[child.props.length - 1]).replace(/\0.*$/, '');
        const key = binKey(child.props[0]);
        const holder = {
          key,
          name: String(child.props[0]).split('\x00')[0].replace(/^Model::/, ''),
          matrix: composeLocal(
            binLcl(child, 'Lcl Translation', [0, 0, 0]),
            binLcl(child, 'Lcl Rotation', [0, 0, 0]),
            binLcl(child, 'Lcl Scaling', [1, 1, 1]),
          ),
          geom: null,
        };
        if (subtype === 'Mesh') {
          const verts = kidNumbers(child, 'Vertices');
          if (verts.length) {
            const L = binLayers(child);
            holder.geom = {
              vertices: verts,
              pvi: kidNumbers(child, 'PolygonVertexIndex').map((n) => Math.trunc(n)),
              ...L,
            };
          }
        }
        meshHolders.push(holder);
      } else if (child.name === 'Geometry') {
        const subtype = String(child.props[child.props.length - 1]).replace(/\0.*$/, '');
        if (subtype !== 'Mesh') continue;
        const L = binLayers(child);
        standalone.push({
          key: binKey(child.props[0]),
          vertices: kidNumbers(child, 'Vertices'),
          pvi: kidNumbers(child, 'PolygonVertexIndex').map((n) => Math.trunc(n)),
          ...L,
        });
      } else if (child.name === 'Material') {
        const key = binKey(child.props[0]);
        const mat = {
          name: String(child.props[0]).split('\x00')[0].replace(/^Material::/, ''),
          diffuse: [0.75, 0.78, 0.85], emissive: [0, 0, 0],
          specular: [0.68, 0.85, 1], shininess: 32, alpha: 1,
        };
        const holder = findKid(child, 'Properties70') ?? findKid(child, 'Properties60');
        if (holder) {
          for (const p of findKids(holder, 'P').concat(findKids(holder, 'Property'))) {
            const nm = p.props[0], vals = binPropVals(p);
            if ((nm === 'DiffuseColor' || nm === 'Diffuse') && vals.length >= 3) mat.diffuse = vals.slice(-3);
            else if ((nm === 'Emissive' || nm === 'EmissiveColor') && vals.length >= 3) mat.emissive = vals.slice(-3);
            else if ((nm === 'Specular' || nm === 'SpecularColor') && vals.length >= 3) mat.specular = vals.slice(-3);
            else if ((nm === 'Shininess' || nm === 'ShininessExponent') && vals.length) mat.shininess = vals[vals.length - 1];
            else if (nm === 'Opacity' && vals.length) mat.alpha = vals[vals.length - 1];
          }
        }
        mats.set(key, mat);
      } else if (child.name === 'Texture') {
        const key = binKey(child.props[0]);
        const fn = findKid(child, 'FileName');
        if (fn) {
          for (const p of fn.props) {
            if (typeof p === 'string' && /[a-z0-9]/i.test(p)) {
              const clean = p.replace(/\0.*$/, '').replace(/\\/g, '/').split('/').pop();
              if (clean && /\.[a-z0-9]+$/i.test(clean)) texFiles.set(key, clean);
            }
          }
        }
      }
    }
  }
  if (connects) {
    for (const c of findKids(connects, 'C').concat(findKids(connects, 'Connect'))) {
      const kind = String(c.props[0]).replace(/\0.*$/, '');
      const norm = (v) => (typeof v === 'number' ? String(v) : binKey(v));
      conns.push({ type: kind, from: norm(c.props[1]), to: norm(c.props[2]) });
    }
  }
  return { version, upAxis, unitScale, meshHolders, standalone, mats, texFiles, conns };
}

// ---------------- assemble ----------------
function assemble(parsed, fbxName, folder) {
  const { meshHolders, standalone, mats, texFiles, conns } = parsed;
  const modelToMats = new Map(), matToTex = new Map(), geoToModel = new Map();
  const holderKeys = new Set(meshHolders.map((h) => h.key));
  const standKeys = new Set(standalone.map((g) => g.key));
  for (const c of conns) {
    if (c.type !== 'OO') continue;
    if (mats.has(c.from) && holderKeys.has(c.to)) {
      if (!modelToMats.has(c.to)) modelToMats.set(c.to, []);
      modelToMats.get(c.to).push(c.from);
    }
    if (texFiles.has(c.from) && mats.has(c.to)) matToTex.set(c.to, texFiles.get(c.from));
    if (texFiles.has(c.from) && holderKeys.has(c.to)) {
      const synth = `__tex_${c.from}`;
      if (!mats.has(synth)) {
        mats.set(synth, {
          name: `mat_${texFiles.get(c.from)}`, diffuse: [0.75, 0.78, 0.85],
          emissive: [0, 0, 0], specular: [0.68, 0.85, 1], shininess: 32, alpha: 1,
        });
      }
      matToTex.set(synth, texFiles.get(c.from));
      if (!modelToMats.has(c.to)) modelToMats.set(c.to, []);
      modelToMats.get(c.to).push(synth);
    }
    if (standKeys.has(c.from) && holderKeys.has(c.to)) geoToModel.set(c.from, c.to);
  }
  const meshes = [], materials = [], nodes = [];
  const matNameToIndex = new Map();
  const pushMaterial = (matKey, texture) => {
    if (matNameToIndex.has(matKey)) return matNameToIndex.get(matKey);
    const def = mats.get(matKey);
    const entry = {
      name: def?.name ?? matKey,
      diffuse: def?.diffuse ?? [0.75, 0.78, 0.85],
      emissive: def?.emissive ?? [0, 0, 0],
      specular: def?.specular ?? [0.68, 0.85, 1],
      shininess: def?.shininess ?? 32,
      alpha: def?.alpha ?? 1,
      ...(texture ? { texture: `assets/textures/objects/${folder}__${texture}` } : {}),
    };
    matNameToIndex.set(matKey, materials.length);
    materials.push(entry);
    return materials.length - 1;
  };
  const emitMesh = (name, geom, localMatrix, matKeys) => {
    if (!geom || !geom.vertices.length || !geom.pvi.length) return;
    const built = buildMesh(geom);
    if (!built.indices.length) return;
    if (localMatrix) applyMatrixToMesh(built, localMatrix);
    let matKey = matKeys?.length ? matKeys[0] : null;
    if (!matKey) {
      matKey = 'mat_default';
      if (!mats.has(matKey)) {
        mats.set(matKey, {
          name: 'mat_default', diffuse: [0.75, 0.78, 0.85], emissive: [0, 0, 0],
          specular: [0.68, 0.85, 1], shininess: 32, alpha: 1,
        });
      }
    }
    const idx = pushMaterial(matKey, matToTex.get(matKey));
    meshes.push({
      name, positions: round3(built.positions), normals: round3(built.normals),
      uvs: round3(built.uvs), indices: built.indices, material: materials[idx].name,
      ...(localMatrix ? { localMatrix: round3(localMatrix) } : {}),
    });
    nodes.push({ name, parent: null, matrix: localMatrix ?? identity() });
  };
  for (const h of meshHolders) {
    if (h.geom) emitMesh(h.name || `mesh_${h.key}`, h.geom, h.matrix, modelToMats.get(h.key));
  }
  for (const g of standalone) {
    const modelKey = geoToModel.get(g.key);
    const holder = meshHolders.find((h) => h.key === modelKey);
    emitMesh(`mesh_${g.key}`, g, holder?.matrix ?? null, modelKey ? modelToMats.get(modelKey) : null);
  }
  if (!meshes.length) throw new Error('no Mesh geometries found');
  const all = meshes.flatMap((mm) => mm.positions);
  const b = boundsOf(all);
  return {
    version: 1, source: `Objects/${folder}/${fbxName}`, generator: 'tools/convert-fbx.mjs',
    fbxVersion: parsed.version, upAxis: parsed.upAxis, units: `fbx-unit-scale-${parsed.unitScale}`,
    boundingSphere: { center: b.center, radius: b.radius },
    boundingBox: { min: b.min, max: b.max }, meshes, materials, nodes,
  };
}

// ---------------- main ----------------
if (!existsSync(objectsDir)) {
  console.error('convert-fbx: content dir not found:', objectsDir);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const manifest = { generator: 'tools/convert-fbx.mjs', models: {} };
let ok = 0;
const failed = [];
for (const folder of readdirSync(objectsDir)) {
  const dir = join(objectsDir, folder);
  if (!statSync(dir).isDirectory()) continue;
  const fbxs = readdirSync(dir).filter((f) => /\.fbx$/i.test(f)).sort();
  if (!fbxs.length) continue;
  const usable = fbxs.filter((file) => {
    try { return statSync(join(dir, file)).size > 32; } catch { return false; }
  });
  for (const file of fbxs) {
    if (!usable.includes(file)) {
      manifest.models[`${folder}__${file}.placeholder`] = { source: `Objects/${folder}/${file}`, empty: true };
      console.log(`skip ${folder}/${file}: empty placeholder`);
    }
  }
  usable.forEach((file, k) => {
    const outName = k === 0 ? `${folder}.json` : `${folder}_lod${k}.json`;
    try {
      const buf = readFileSync(join(dir, file));
      const isBinary = buf.subarray(0, 18).toString('binary').startsWith('Kaydara FBX Binary');
      const json = assemble(isBinary ? parseBinary(buf) : parseAscii(buf), file, folder);
      if (!CHECK) writeFileSync(join(outDir, outName), JSON.stringify(json));
      const tris = json.meshes.reduce((n, mm) => n + mm.indices.length / 3, 0);
      manifest.models[outName] = {
        source: json.source, meshes: json.meshes.length, triangles: tris,
        materials: json.materials.map((m) => m.name),
      };
      ok++;
      console.log(`ok ${outName}: ${json.meshes.length} mesh(es), ${tris} tris`);
    } catch (e) {
      failed.push(`${folder}/${file}: ${e.message}`);
      console.error(`FAIL ${folder}/${file}: ${e.message}`);
    }
  });
}
if (!CHECK) writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nconvert-fbx: ${ok} converted, ${failed.length} failed`);
if (failed.length) { console.log('failed:\n - ' + failed.join('\n - ')); process.exitCode = 1; }
