// GhostRecord port (37_T): per-frame capture, framed+gzip persistence,
// XML .ghs shape for export, playback cursor.

import { quat, vec3 } from '../engine/math';
import { decodeMessage, encodeMessage, MsgType } from './net';
import { timeSpanToString } from './team';

export interface GhostRecord {
  pos: vec3;
  rot: quat;
  timeMs: number;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeGhost(level: string, records: GhostRecord[]): Uint8Array {
  const floats = new Float32Array(records.length * 8);
  records.forEach((r, i) => {
    floats[i * 8] = r.timeMs / 1000;
    floats[i * 8 + 1] = r.pos[0];
    floats[i * 8 + 2] = r.pos[1];
    floats[i * 8 + 3] = r.pos[2];
    floats[i * 8 + 4] = r.rot[0];
    floats[i * 8 + 5] = r.rot[1];
    floats[i * 8 + 6] = r.rot[2];
    floats[i * 8 + 7] = r.rot[3];
  });
  const payload = new Uint8Array(floats.buffer);
  const name = new TextEncoder().encode(level);
  const framed = new Uint8Array(2 + name.length + payload.length);
  framed[0] = name.length & 0xff;
  framed[1] = (name.length >> 8) & 0xff;
  framed.set(name, 2);
  framed.set(payload, 2 + name.length);
  return encodeMessage(MsgType.GhostData, framed, { compress: true });
}

export async function deserializeGhost(
  data: Uint8Array,
): Promise<{ level: string; records: GhostRecord[] } | null> {
  try {
    const msg = await decodeMessage(data);
    if (msg.type !== MsgType.GhostData) return null;
    const body = msg.payload;
    const nameLen = body[0] | (body[1] << 8);
    const level = new TextDecoder().decode(body.slice(2, 2 + nameLen));
    const floats = new Float32Array(body.buffer, body.byteOffset + 2 + nameLen);
    const records: GhostRecord[] = [];
    for (let i = 0; i + 8 <= floats.length; i += 8) {
      records.push({
        timeMs: floats[i] * 1000,
        pos: vec3.fromValues(floats[i + 1], floats[i + 2], floats[i + 3]),
        rot: quat.fromValues(floats[i + 4], floats[i + 5], floats[i + 6], floats[i + 7]),
      });
    }
    return { level, records };
  } catch {
    return null;
  }
}

export function saveGhostFile(ghostFile: string, records: GhostRecord[]): void {
  try {
    localStorage.setItem(ghostFile, toB64(serializeGhost(ghostFile, records)));
  } catch { /* ignore */ }
}

export async function loadGhostFile(ghostFile: string): Promise<GhostRecord[] | null> {
  try {
    const raw = localStorage.getItem(ghostFile);
    if (!raw) return null;
    const g = await deserializeGhost(fromB64(raw));
    return g ? g.records : null;
  } catch {
    return null;
  }
}

export function hasGhostFile(ghostFile: string): boolean {
  try {
    return localStorage.getItem(ghostFile) !== null;
  } catch {
    return false;
  }
}

/** Legacy .ghs XML shape (importGhost format) for export. */
export function ghostToXml(ghostFile: string, records: GhostRecord[]): string {
  let xml = `<import><ghosts directory="${ghostFile}">`;
  for (const r of records) {
    xml += `<ghost position="${r.pos[0]}|${r.pos[1]}|${r.pos[2]}" ` +
      `quaternion="${r.rot[0]}|${r.rot[1]}|${r.rot[2]}|${r.rot[3]}" time="${timeSpanToString(r.timeMs)}" />`;
  }
  return xml + `</ghosts></import>`;
}
