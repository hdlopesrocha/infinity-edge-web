// Binary protocol + gzip framing (docs/protocol.md).

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  decodeMessage, decodeJson, encodeJson, encodeMessage, FLAG_GZIP, GZIP_THRESHOLD,
  HEADER_SIZE, MsgType, PROTOCOL_VERSION,
} from '../src/game/net';
import { binaryPayloadId } from '../src/game/netclient';

function header(bytes: Uint8Array): { version: number; flags: number; type: number; length: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: v.getUint8(0), flags: v.getUint8(1),
    type: v.getUint16(2, true), length: v.getUint32(4, true),
  };
}

describe('net framing', () => {
  it('writes a little-endian 8-byte header', () => {
    const bytes = encodeMessage(MsgType.Ping, new Uint8Array([1, 2, 3]));
    expect(HEADER_SIZE).toBe(8);
    expect(bytes.byteLength).toBe(HEADER_SIZE + 3);
    const h = header(bytes);
    expect(h.version).toBe(PROTOCOL_VERSION);
    expect(h.type).toBe(MsgType.Ping);
    expect(h.length).toBe(3);
    expect(h.flags & FLAG_GZIP).toBe(0);
  });

  it('round-trips small payloads uncompressed', async () => {
    const payload = new Uint8Array([9, 8, 7]);
    const msg = await decodeMessage(encodeMessage(MsgType.ModelData, payload));
    expect(msg.type).toBe(MsgType.ModelData);
    expect(msg.compressed).toBe(false);
    expect(Array.from(msg.payload)).toEqual([9, 8, 7]);
  });

  it('does not compress payloads below the threshold', () => {
    const payload = new Uint8Array(GZIP_THRESHOLD - 1);
    const bytes = encodeMessage(MsgType.ModelData, payload);
    expect(header(bytes).flags & FLAG_GZIP).toBe(0);
    expect(bytes.byteLength).toBe(HEADER_SIZE + payload.byteLength);
  });

  it('compresses repetitive payloads above the threshold and flags them', async () => {
    const payload = new Uint8Array(4096);
    payload.fill(65);
    const bytes = encodeMessage(MsgType.LevelData, payload);
    const h = header(bytes);
    expect(h.flags & FLAG_GZIP).toBe(FLAG_GZIP);
    expect(h.length).toBeLessThan(payload.byteLength);
    const msg = await decodeMessage(bytes);
    expect(msg.compressed).toBe(true);
    expect(msg.payload.byteLength).toBe(payload.byteLength);
    expect(msg.payload.every((b) => b === 65)).toBe(true);
  });

  it('keeps an incompressible large payload raw', async () => {
    // Random bytes do not gzip below the original size.
    const payload = new Uint8Array(1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 97 + (i % 7) * 31) & 0xff;
    const bytes = encodeMessage(MsgType.GhostData, payload);
    const msg = await decodeMessage(bytes);
    expect(msg.payload.byteLength).toBe(payload.byteLength);
    expect(Array.from(msg.payload)).toEqual(Array.from(payload));
  });

  it('rejects a truncated header', async () => {
    await expect(decodeMessage(new Uint8Array(4))).rejects.toThrow(/truncated header/);
  });

  it('rejects a truncated payload', async () => {
    const bytes = encodeMessage(MsgType.Ping, new Uint8Array([1, 2, 3, 4]));
    await expect(decodeMessage(bytes.subarray(0, bytes.byteLength - 2))).rejects.toThrow(/truncated payload/);
  });

  it('rejects a wrong protocol version', async () => {
    const bytes = encodeMessage(MsgType.Ping, new Uint8Array([1]));
    bytes[0] = 99;
    await expect(decodeMessage(bytes)).rejects.toThrow(/bad version/);
  });

  it('reports a decompression error for a corrupt gzip payload', async () => {
    const payload = new Uint8Array(2048).fill(66);
    const bytes = encodeMessage(MsgType.LevelData, payload);
    expect(header(bytes).flags & FLAG_GZIP).toBe(FLAG_GZIP);
    // Corrupt the compressed body (after the header).
    bytes[HEADER_SIZE + 2] ^= 0xff;
    bytes[HEADER_SIZE + 3] ^= 0xff;
    await expect(decodeMessage(bytes)).rejects.toThrow(/gzip/);
  });

  it('decodes a gzip frame produced by another implementation', async () => {
    // The dev asset server compresses with node:zlib; the browser must accept it.
    const body = gzipSync(Buffer.from('{"id":7,"file":"assets/models/Sky1.json"}'));
    const frame = new Uint8Array(HEADER_SIZE + body.byteLength);
    const v = new DataView(frame.buffer);
    v.setUint8(0, PROTOCOL_VERSION);
    v.setUint8(1, FLAG_GZIP);
    v.setUint16(2, MsgType.ModelData, true);
    v.setUint32(4, body.byteLength, true);
    frame.set(body, HEADER_SIZE);
    const msg = await decodeMessage(frame);
    expect(msg.compressed).toBe(true);
    expect(decodeJson<{ id: number }>(msg).id).toBe(7);
  });

  it('rejects malformed JSON payloads', async () => {
    const bytes = encodeJson(MsgType.ModelData, { id: 1 });
    const broken = await decodeMessage(bytes);
    broken.payload = new TextEncoder().encode('{oops');
    expect(() => decodeJson(broken)).toThrow(/malformed JSON/);
  });

  it('reads the correlation id out of a BinaryData payload header', () => {
    const meta = new TextEncoder().encode(JSON.stringify({ id: 42, file: 'a.bin', byteLength: 3 }));
    const payload = new Uint8Array(4 + meta.byteLength + 3);
    new DataView(payload.buffer).setUint32(0, meta.byteLength, true);
    payload.set(meta, 4);
    payload.set([1, 2, 3], 4 + meta.byteLength);
    expect(binaryPayloadId(payload)).toBe(42);
    expect(binaryPayloadId(payload.subarray(0, 3))).toBeUndefined();
    expect(binaryPayloadId(new Uint8Array(4))).toBeUndefined();
  });

  it('compresses JSON control payloads like any other payload', async () => {
    const big = { id: 1, rows: Array.from({ length: 200 }, (_, i) => `row-${i}`) };
    const bytes = encodeJson(MsgType.LevelData, big);
    const msg = await decodeMessage(bytes);
    expect(msg.compressed).toBe(true);
    expect(decodeJson<typeof big>(msg).rows[199]).toBe('row-199');
  });
});
