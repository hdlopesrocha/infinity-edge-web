// Nostr events (NIP-01) used by the multiplayer mode, plus the two custom
// event schemas: a rooms listing (addressable) and WebRTC signalling
// (ephemeral). Signing/verification is local (see crypto.ts) - no library.

import { bytesToHex, hexToBytes, concatBytes, randomBytes, schnorrPubkey, schnorrSign, schnorrVerify, sha256, validSecretKey, equalBytes } from './crypto';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/**
 * Rooms: parameterized replaceable event (30000-39999), `d` = room id. The
 * host rewrites it for heartbeat/player-count updates; only the original key
 * can replace it, which is what "deleted only by its creator" rests on.
 */
export const KIND_ROOM = 30333;
/** Signalling: ephemeral range (relays forward without storing). */
export const KIND_SIGNAL = 25050;
/** NIP-09 deletion request. */
export const KIND_DELETE = 5;
/** NIP-40 expiration. */
export const KIND_EXPIRATION = 'expiration';

/** `t` tag identifying our room events; keeps the list query narrow. */
export const TAG_ROOM = 'ie3d-mp-room';
/** Protocol version of the payloads below (content `v`). */
export const MP_PROTOCOL = 1;

export interface EventTemplate {
  kind: number;
  created_at?: number;
  tags: string[][];
  content: string;
}

function serialize(evt: Omit<NostrEvent, 'id' | 'sig'>): string {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}

export function eventId(evt: Omit<NostrEvent, 'id' | 'sig'>): string {
  return bytesToHex(sha256(new TextEncoder().encode(serialize(evt))));
}

/** Sign a template with a 32-byte secret key; returns the final event. */
export function finalizeEvent(template: EventTemplate, secretKey: Uint8Array): NostrEvent {
  if (!validSecretKey(secretKey)) throw new Error('nostr: invalid secret key');
  const pubkey = bytesToHex(schnorrPubkey(secretKey));
  const base = {
    pubkey,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  };
  const id = eventId(base);
  const sig = bytesToHex(schnorrSign(hexToBytes(id), secretKey));
  return { ...base, id, sig };
}

/** Verify id + BIP-340 signature (relays already check, but never trust input). */
export function verifyEvent(evt: NostrEvent): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(evt.id) || !/^[0-9a-f]{64}$/.test(evt.pubkey)) return false;
    if (!/^[0-9a-f]{128}$/.test(evt.sig)) return false;
    if (eventId(evt) !== evt.id) return false;
    return schnorrVerify(hexToBytes(evt.id), hexToBytes(evt.pubkey), hexToBytes(evt.sig));
  } catch {
    return false;
  }
}

export function tagValue(evt: { tags: string[][] }, name: string): string | null {
  for (const tag of evt.tags) if (tag[0] === name && typeof tag[1] === 'string') return tag[1];
  return null;
}

export function tagValues(evt: { tags: string[][] }, name: string): string[] {
  const out: string[] = [];
  for (const tag of evt.tags) if (tag[0] === name && typeof tag[1] === 'string') out.push(tag[1]);
  return out;
}

// ------------------------------------------------------------------- rooms
export interface RoomInfo {
  /** Room id (`d` tag): random, stable for the room's lifetime. */
  id: string;
  /** Host public key (event author). */
  hostPubkey: string;
  /** Host nickname (display only). */
  host: string;
  /** Level key of the match the host will start (`ctf-easy`, ...). */
  game: string;
  /** Level type: CTF / TT / KOTS / SURV. */
  type: string;
  /** Human-readable level title. */
  title: string;
  players: number;
  maxPlayers: number;
  /** Unix seconds the room was created (filter basis). */
  created: number;
  /** Unix seconds of the last update (heartbeat). */
  updated: number;
  /** ICE servers the host wants guests to use. */
  ice: string[];
  /** The host's pinned WebRTC certificate (absent on legacy hosts). */
  cert: HostCert | null;
  /** True when the room is hosted by a dedicated server (starts immediately). */
  srv: boolean;
  /** Event id of the current revision (deletion reference). */
  eventId: string;
  /** The signed event this record came from (kept for verification). */
  raw?: NostrEvent;
}

/** Host WebRTC certificate: an ephemeral P-256 key bound to the room's Nostr
 *  identity (see mp/cert.ts). Guests pin it for the room's lifetime. */
export interface HostCert {
  /** Base64 SPKI of the host's P-256 public key. */
  key: string;
  created: number;
  expires: number;
  /** BIP-340 signature by the room's Nostr key over the certificate payload. */
  sig: string;
}

export interface RoomContent {
  v: number;
  game: string;
  type: string;
  title: string;
  host: string;
  players: number;
  max: number;
  ice: string[];
  created: number;
  cert?: HostCert;
  /** Dedicated server room: joins go straight into the match (no waiting room). */
  srv?: boolean;
}

/** Random room id (96 bits, lowercase hex). */
export function newRoomId(): string {
  return bytesToHex(randomBytes(12));
}

export function roomTemplate(room: {
  id: string; content: RoomContent; ttlSec: number; created_at?: number;
}): EventTemplate {
  const created = room.created_at ?? Math.floor(Date.now() / 1000);
  return {
    kind: KIND_ROOM,
    created_at: created,
    tags: [
      ['d', room.id],
      ['t', TAG_ROOM],
      ['t', room.content.type],
      [KIND_EXPIRATION, String(created + room.ttlSec)],
    ],
    content: JSON.stringify(room.content),
  };
}

export function deletionTemplate(room: { id: string; hostPubkey: string }): EventTemplate {
  return {
    kind: KIND_DELETE,
    tags: [
      ['a', `${KIND_ROOM}:${room.hostPubkey}:${room.id}`],
      ['k', String(KIND_ROOM)],
      ['t', TAG_ROOM],
    ],
    content: 'room closed',
  };
}

/** Parse a room event; returns null for foreign/deleted/malformed events. */
export function roomFromEvent(evt: NostrEvent): RoomInfo | null {
  if (evt.kind !== KIND_ROOM) return null;
  const tTags = tagValues(evt, 't');
  if (!tTags.includes(TAG_ROOM)) return null;
  const id = tagValue(evt, 'd');
  if (!id) return null;
  let content: RoomContent;
  try {
    content = JSON.parse(evt.content) as RoomContent;
  } catch {
    return null;
  }
  if (!content || content.v !== MP_PROTOCOL) return null;
  if (typeof content.game !== 'string' || typeof content.title !== 'string') return null;
  if (typeof content.host !== 'string') return null;
  const exp = tagValue(evt, KIND_EXPIRATION);
  if (exp && Number(exp) > 0 && Number(exp) * 1000 < Date.now()) return null;
  return {
    id,
    hostPubkey: evt.pubkey,
    host: content.host,
    game: content.game,
    type: typeof content.type === 'string' ? content.type : '',
    title: content.title,
    players: Math.max(1, Number(content.players) || 1),
    maxPlayers: Math.max(2, Number(content.max) || 8),
    created: Number(content.created) || evt.created_at,
    updated: evt.created_at,
    ice: Array.isArray(content.ice) && content.ice.length > 0 ? content.ice.map(String) : [],
    cert: content.cert && typeof content.cert === 'object' && typeof content.cert.key === 'string'
      ? {
          key: content.cert.key,
          created: Number(content.cert.created) || 0,
          expires: Number(content.cert.expires) || 0,
          sig: String(content.cert.sig ?? ''),
        }
      : null,
    srv: content.srv === true,
    eventId: evt.id,
    raw: evt,
  };
}

// ---------------------------------------------------------------- signalling
export interface SignalCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export interface SignalMessage {
  v: number;
  room: string;
  /** Recipient public key (hex). */
  to: string;
  kind: 'offer' | 'answer' | 'ice' | 'bye';
  sdp?: string;
  candidates?: SignalCandidate[];
  /** Guest nickname, on offers (the host shows it in its guest list). */
  name?: string;
  /** Host certificate signature, on answers (mp/cert.ts). */
  sig?: string;
}

export function signalTemplate(roomId: string, toPubkey: string, msg: Omit<SignalMessage, 'v' | 'room' | 'to'>): EventTemplate {
  const content: SignalMessage = { v: MP_PROTOCOL, room: roomId, to: toPubkey, ...msg };
  return {
    kind: KIND_SIGNAL,
    tags: [
      ['d', roomId],
      ['p', toPubkey],
      ['t', TAG_ROOM],
    ],
    content: JSON.stringify(content),
  };
}

/** Parse a signalling event addressed to `me`; null when not ours/malformed. */
export function signalFromEvent(evt: NostrEvent, me: string, roomId?: string): SignalMessage | null {
  if (evt.kind !== KIND_SIGNAL) return null;
  let msg: SignalMessage;
  try {
    msg = JSON.parse(evt.content) as SignalMessage;
  } catch {
    return null;
  }
  if (!msg || msg.v !== MP_PROTOCOL) return null;
  if (msg.to !== me) return null;
  if (roomId !== undefined && msg.room !== roomId) return null;
  if (msg.kind !== 'offer' && msg.kind !== 'answer' && msg.kind !== 'ice' && msg.kind !== 'bye') return null;
  const room = tagValue(evt, 'd');
  if (!room || room !== msg.room) return null;
  return msg;
}

/** Serialize an RTCIceCandidateInit for the wire (only the JSON fields). */
export function candidateInit(c: {
  candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment?: string | null;
}): SignalCandidate {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid ?? null,
    sdpMLineIndex: c.sdpMLineIndex ?? null,
    usernameFragment: c.usernameFragment ?? null,
  };
}

export { concatBytes };
