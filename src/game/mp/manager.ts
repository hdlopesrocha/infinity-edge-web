// Multiplayer mode: rooms in Nostr, connections over WebRTC.
//
// The host publishes an addressable room event (kind 30333) signed with its
// own key - only that key can replace or delete it. Guests list those events,
// and connection setup (SDP + ICE candidates) travels as public ephemeral
// signalling events on the same relay set, so no server of ours is involved.
// The match itself runs in the host's browser (mp/host.ts) and every guest
// connects straight to it with an RTC data channel (one per guest).
//
// Everything here is UI-agnostic: the WebGL lobby (mp/lobbyui.ts) reads the
// room list and calls createRoom/joinRoom/deleteRoom (plus rejoinRoom to
// re-open a hosted room that was left alive).
//
// Browser-hosted rooms are host-offered: the host posts its SDP offer as a
// comment under the room post (see publishOffer), and a joining guest answers
// it with a NIP-04 DM. Password-protected rooms seal the signalling with a
// password-derived AES-GCM key (mp/crypto.ts).

import {
  candidateInit, finalizeEvent, KIND_DELETE, KIND_OFFER, KIND_ROOM, KIND_SIGNAL, MP_PROTOCOL, newRoomId,
  roomFromEvent, roomTemplate, signalFromEvent, signalTemplate, tagValues, verifyEvent,
  deletionTemplate, ROOM_BOARD_PUBKEY,
  offerCommentTemplate, offerDeletionTemplate, offerFromEvent, roomCoordinate,
} from '../nostr/event';
import type { NostrEvent, RoomContent, RoomInfo, SignalCandidate, SignalMessage } from '../nostr/event';
import { deriveKey, newSalt, openSignal, sealSignal } from './crypto';
import { RelayPool } from '../nostr/relay';
import { bytesToHex, hexToBytes, randomBytes, schnorrPubkey, validSecretKey } from '../nostr/crypto';
import { npubEncode, nsecEncode, decodeKeyEntity } from '../nostr/bech32';
import { nip04Decrypt, nip04Encrypt } from '../nostr/nip04';
import type { DmMessage, DmTransport } from '../nostr/dm';
import { decodeMessage, encodeMessage, textDecoder, textEncoder } from '../net';
import { GameMsg } from '../protocol';
import { decodeVoiceFrame, encodeVoiceFrame } from './voice';
import { loadLevel } from '../levels';
import { TEAMS } from '../config';
import {
  createHostCert, importCertKey, newNonce, signAnswer, signAuth, verifyAnswer, verifyAuth,
  verifyHostCert,
} from './cert';
import type { HostCert } from '../nostr/event';
import { rtcTransport } from './transport';
import type { GameTransport } from './transport';
import { DEFAULT_TEAM, HostSession } from './host';
import type { GuestSummary } from './host';
import type { GameInstance } from '../instance';
import { store } from '../store';
import { getWallet } from '../wallet';
import { lnurlPayInvoice } from '../ln/lnurl';
// The bank is gone: currency is Lightning (NWC) on the client, and the manager
// only relays Nostr events (rooms, DMs, profiles).

const CONFIG_KEY = 'ie.mp.config';
const IDENTITY_KEY = 'ie.mp.identity';
const RELAY_DEFAULTS = ['wss://nos.lol', 'wss://relay.snort.social'];
const ICE_DEFAULTS = ['stun:stun.l.google.com:19302'];
/** Room events expire (NIP-40) unless the host keeps heartbeating. */
const ROOM_TTL_SEC = 30 * 60;
const HEARTBEAT_MS = 4 * 60 * 1000;
/** How long a guest waits for the host's offer + data channel. */
const JOIN_TIMEOUT_MS = 30000;
/** How long a guest tries one host offer before switching to another. */
const OFFER_ANSWER_TIMEOUT_MS = 8000;
/**
 * Signals created more than this many seconds before the session started are
 * stale. Generous, because clocks on different machines drift; the session id
 * is the authoritative staleness guard.
 */
const SIGNAL_SKEW_SEC = 120;
/** Age filter choices (hours); 6 h is the default. */
export const MAX_AGE_CHOICES = [1, 3, 6, 12, 24];

/** The room bet amounts the host cycles through (sats; 0 = no bet). */
export const BET_AMOUNTS = [0, 50, 100, 200] as const;

export interface MpConfig {
  relays: string[];
  maxAgeHours: number;
  iceServers: string[];
}

export interface JoinIntent {
  room: RoomInfo;
  transport: GameTransport;
}

/** One player in the waiting room (host first). */
export interface RoomPlayerInfo {
  name: string;
  pubkey: string;
  /** Chosen team name ('' = the level's default for that player). */
  team: string;
  /** Microphone enabled (voice chat). */
  mic: boolean;
  host: boolean;
  /** Guest's bet acceptance (true for the host). */
  betAccepted?: boolean;
  /** Lightning address advertised for bet payouts ('' = none). */
  lud16?: string;
}

export interface ChatLine {
  from: string;
  text: string;
  at: number;
  /** Join/leave/status notices (rendered dimmer, no author). */
  system?: boolean;
}

/** Everything the room menu draws (host and guest views of the same room). */
export interface RoomSnapshot {
  roomId: string;
  level: string;
  title: string;
  maxPlayers: number;
  /** True when the room is password protected (signalling is encrypted). */
  protected: boolean;
  /** Teams the level offers (host loads the level, guests get them in state). */
  teams: string[];
  players: RoomPlayerInfo[];
  meIndex: number;
  isHost: boolean;
  phase: 'waiting' | 'playing';
  chat: ChatLine[];
  micOn: boolean;
  /** Host-set escrowed bet (0 = no bet). */
  betAmount: number;
  /** True when this client has accepted the bet (always true for the host). */
  betAccepted: boolean;
  /** Last bank bet error, surfaced in the room ('' = none). */
  betError: string;
  status: string;
}

/** Host-side per-guest link. */
interface GuestLink {
  name: string;
  transport: GameTransport;
  authed: boolean;
  team: string;
  mic: boolean;
  /** Guest accepted the host's bet. */
  betAccepted: boolean;
  /** Guest's lightning address (for bet payouts). */
  lud16: string;
}

/** Guest-side view of the room it joined and is waiting in. */
interface GuestRoom {
  info: RoomInfo;
  /** Proxy transport handed to NetGame when the match starts. */
  transport: GameTransport;
  you: number;
  players: RoomPlayerInfo[];
  teams: string[];
  phase: 'waiting' | 'playing';
  betAmount: number;
  /** The local guest accepted the host's bet. */
  betAccepted: boolean;
  betError: string;
}

/**
 * One host-published offer (one guest slot). The host creates the data channel
 * and the SDP offer; a guest answers it, which turns this into a peer.
 */
interface HostPeer {
  /** Random offer id (in the clear on the wire; echoed by the answer/ICE). */
  offerId: string;
  pc: RTCPeerConnection;
  /** Guest pubkey, once its answer arrived. */
  guestPubkey: string | null;
  name: string;
  channel: RTCDataChannel | null;
  /** Guest ICE that arrived before the answer set the remote description. */
  pendingCandidates: SignalCandidate[];
  /** Host ICE generated before the guest was known (flushed on the answer). */
  localCandidates: SignalCandidate[];
  /** True once the answer has been applied (remote description set). */
  remoteSet: boolean;
  /** The sealed offer body, so a refresh can republish it with a new stamp. */
  offerBody: Omit<SignalMessage, 'v' | 'room' | 'to'>;
  /** Event id of the last published offer (NIP-09 cleanup on replace). */
  offerEventId: string;
  /** Unix seconds the offer was last published. */
  offerAt: number;
}

/** Guest-side state while negotiating a browser-hosted room (host offers). */
interface GuestJoin {
  room: RoomInfo;
  pc: RTCPeerConnection;
  sub: () => void;
  timer: number;
  /** Password-derived signalling key (null = plaintext room). */
  key: CryptoKey | null;
  certKey: CryptoKey | null;
  /** The offer currently being answered (null until one is chosen). */
  offerId: string | null;
  /** Offer ids already answered (a collision switches to the next one). */
  tried: Set<string>;
  /** The newest offer seen, so a retry can answer it again. */
  lastOffer: SignalMessage | null;
  /** True while an offer is being applied / an answer published. */
  answering: boolean;
  answered: boolean;
  /** Host ICE that arrived before we answered an offer. */
  pendingCandidates: SignalCandidate[];
  /** Switches to another offer if the channel does not come up in time. */
  answerTimer: number;
  /** Resends the `join` while we have not answered an offer yet. */
  nudgeTimer: number;
  resolve: (t: GameTransport) => void;
  reject: (e: Error) => void;
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode */ }
}

function windowValue<T>(name: string): T | null {
  if (typeof window === 'undefined') return null;
  const v = (window as unknown as Record<string, unknown>)[name];
  return (v ?? null) as T | null;
}

function listOf(value: string | string[] | null | undefined): string[] | null {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean);
  return null;
}

/** `?mp=` in the URL beats window/VITE config (handy behind firewalls). */
function urlParam(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function envRelays(): string[] | null {
  return listOf(urlParam('mp'))
    ?? listOf(windowValue<string | string[]>('__IE_MP_RELAYS'))
    ?? listOf(import.meta.env.VITE_IE_MP_RELAYS as string | undefined);
}

function envIce(): string[] | null {
  return listOf(urlParam('mpIce'))
    ?? listOf(windowValue<string | string[]>('__IE_MP_ICE'))
    ?? listOf(import.meta.env.VITE_IE_MP_ICE as string | undefined);
}

function iceConfig(urls: string[]): RTCConfiguration {
  return { iceServers: urls.map((u) => ({ urls: u })) };
}

/** Random id for a host-published offer (correlates the answer + ICE). */
function newOfferId(): string {
  return newRoomId();
}

/** Random signalling session id (rotated when the host re-enters its room). */
function newSessionId(): string {
  return newRoomId();
}

/**
 * Keep a tap on an incoming transport: the room control frames (chat, voice,
 * roster) stay with the manager while whatever consumes the proxy — NetGame
 * during a match — sets its own handlers on the proxy.
 */
function tapTransport(inner: GameTransport, tap: (data: ArrayBuffer | Uint8Array) => void): GameTransport {
  const proxy: GameTransport = {
    send: (frame) => inner.send(frame),
    close: () => inner.close(),
    get open() { return inner.open; },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  inner.onmessage = (data) => {
    tap(data);
    proxy.onmessage?.(data);
  };
  inner.onopen = () => proxy.onopen?.();
  inner.onclose = () => proxy.onclose?.();
  return proxy;
}

export class Multiplayer implements DmTransport {
  config: MpConfig = {
    relays: envRelays() ?? RELAY_DEFAULTS,
    maxAgeHours: 6,
    iceServers: envIce() ?? ICE_DEFAULTS,
  };
  /** Rooms younger than the filter, newest first. */
  rooms: RoomInfo[] = [];
  /** Rooms whose host never answered a join (this session). */
  deadRooms = new Map<string, number>();
  /** Status line for the lobby ("connecting…", errors). */
  status = '';
  error = '';
  /** True once the relay pool is open. */
  online = false;
  /** Called when rooms/status/guests change (the lobby repaints). */
  onChange: (() => void) | null = null;
  /** Called when the hosted match's guest list changes. */
  onGuests: ((list: GuestSummary[]) => void) | null = null;
  /** Called when the waiting room (roster, chat, phase) changes. */
  onRoom: (() => void) | null = null;
  /** Called when the host starts the match (guests navigate to the level). */
  onStart: ((level: string) => void) | null = null;
  /** Voice frame received from the room (speaker index + 16 kHz PCM). */
  onVoice: ((speaker: number, pcm: Int16Array) => void) | null = null;
  /** Called when the network-pause state changes (host or guest view). */
  onNetPause: (() => void) | null = null;
  /** Called when our Nostr identity changes (nsec imported in the lobby). */
  onIdentity: (() => void) | null = null;
  /** True while the hosted match is frozen waiting for a disconnected guest. */
  netPaused = false;
  /** Names of the guests the match is waiting for. */
  netPausedBy = '';

  /** Room/identity public key, derived once from the stored secret key. */
  pubkeyHex: string;
  private sk: Uint8Array;
  private pool: RelayPool | null = null;
  private roomsSub: (() => void) | null = null;
  private roomRevisions = new Map<string, RoomInfo>();
  private filterTimer = 0;

  // Direct messages (NIP-04 kind 4): the transport the economy layer consumes.
  private dmSub: (() => void) | null = null;
  private dmHandlers = new Set<(msg: DmMessage) => void>();
  /** Event ids already dispatched, so live + replayed DMs never double-fire. */
  private dmSeen = new Set<string>();

  // Hosting.
  private hostingRoom: RoomInfo | null = null;
  /** Answered peers, keyed by guest pubkey. */
  private hostPeers = new Map<string, HostPeer>();
  /** Open (unanswered) offers, keyed by offer id: one per free guest slot. */
  private hostOffers = new Map<string, HostPeer>();
  private pendingChannels: { pubkey: string; name: string; transport: GameTransport; team: string }[] = [];
  private session: HostSession | null = null;
  private heartTimer = 0;
  private sigSub: (() => void) | null = null;
  /** Current signalling session id (rotated when the host re-enters). */
  private hostSid = '';
  /** Unix seconds the current host session started (stale-signal filter). */
  private hostSessionStarted = 0;
  /** Password of the hosted room (kept in memory, never published). */
  private roomPassword = '';
  /** Password-derived signalling key of the hosted room. */
  private hostKey: CryptoKey | null = null;

  // Joining.
  private guest: { pc: RTCPeerConnection; sub: () => void; timer: number } | null = null;
  private guestJoin: GuestJoin | null = null;
  private joinResolve: ((t: GameTransport) => void) | null = null;
  private joinReject: ((e: Error) => void) | null = null;
  private pendingJoin: JoinIntent | null = null;
  private hostIntent: RoomInfo | null = null;
  private guestRoom: GuestRoom | null = null;
  /** Last room/password this client joined, so it can re-join later. */
  private lastRoom: RoomInfo | null = null;
  private lastPassword = '';

  // Waiting room (host and guest).
  private roster: RoomPlayerInfo[] = [];
  private chat: ChatLine[] = [];
  private roomPhase: 'waiting' | 'playing' = 'waiting';
  private roomTeams: string[] = [];
  private roomTeamsFor = '';
  private hostTeam = '';
  private micOn = false;
  /** Host-set escrowed bet amount (0 = none). */
  private betAmount = 0;
  /** Guest view: the local guest accepted the bet. */
  private guestBetAccepted = false;
  /** Last bet error, surfaced in the room. */
  private betError = '';
  /** The running hosted simulation, for settling the bet with its result. */
  private hostGi: GameInstance | null = null;
  /** Last announced bet payout plan (after a match). */
  private betSettlement: { winners: { pubkey: string; lud16: string }[]; losers: string[]; perWinner: number; voided: boolean } | null = null;

  constructor() {
    const stored = loadJson<Partial<MpConfig>>(CONFIG_KEY);
    if (stored) {
      if (Array.isArray(stored.relays) && stored.relays.length > 0) this.config.relays = stored.relays.map(String);
      if (typeof stored.maxAgeHours === 'number' && stored.maxAgeHours > 0) this.config.maxAgeHours = stored.maxAgeHours;
      if (Array.isArray(stored.iceServers) && stored.iceServers.length > 0) this.config.iceServers = stored.iceServers.map(String);
    }
    // Identity: `?mpKey=` (tests, several players on one machine who are not
    // sharing the browser profile) beats the persisted per-browser key.
    const keyParam = urlParam('mpKey');
    const skHex = keyParam
      ?? (() => {
        try { return localStorage.getItem(IDENTITY_KEY); } catch { return null; }
      })();
    let sk: Uint8Array | null = null;
    if (skHex && /^[0-9a-f]{64}$/i.test(skHex)) {
      const candidate = hexToBytes(skHex);
      if (validSecretKey(candidate)) sk = candidate;
    }
    if (!sk) {
      sk = randomBytes(32);
      while (!validSecretKey(sk)) sk = randomBytes(32);
      try { localStorage.setItem(IDENTITY_KEY, bytesToHex(sk)); } catch { /* private mode */ }
    } else if (!keyParam) {
      try { localStorage.setItem(IDENTITY_KEY, bytesToHex(sk)); } catch { /* private mode */ }
    }
    this.sk = sk;
    this.pubkeyHex = bytesToHex(schnorrPubkey(sk));
  }

  /** Our Nostr identity (the room key: only we can delete our rooms). */
  get pubkey(): string {
    return this.pubkeyHex;
  }

  get npub(): string {
    return npubEncode(schnorrPubkey(this.sk));
  }

  /** Our secret key in NIP-19 form (a secret: only the identity panel shows it). */
  get nsec(): string {
    return nsecEncode(this.sk);
  }

  /** Nickname shown in the lobby and sent with room/signalling events. */
  identityName(): string {
    return store.options.username || 'Pilot';
  }

  /**
   * Replace our Nostr identity from an `nsec` (or raw 64-hex secret key). Used
   * by the room's identity panel. Returns false when the value is invalid; the
   * new key is persisted so it survives reloads. Pick your identity before
   * hosting or joining — existing rooms keep the old key.
   */
  setIdentity(input: string): boolean {
    const trimmed = String(input ?? '').trim();
    let sk: Uint8Array | null = null;
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      const candidate = hexToBytes(trimmed);
      if (validSecretKey(candidate)) sk = candidate;
    } else if (trimmed.toLowerCase().startsWith('nsec1')) {
      const decoded = decodeKeyEntity(trimmed);
      if (decoded?.type === 'nsec' && validSecretKey(decoded.bytes)) sk = decoded.bytes;
    }
    if (!sk) return false;
    this.sk = sk;
    this.pubkeyHex = bytesToHex(schnorrPubkey(sk));
    try { localStorage.setItem(IDENTITY_KEY, bytesToHex(sk)); } catch { /* private mode */ }
    this.onIdentity?.();
    this.emit();
    return true;
  }

  /** Test hook: point the client at a local relay / test ICE servers. */
  configure(opts: { relays?: string[]; iceServers?: string[]; maxAgeHours?: number }): void {
    if (opts.relays) this.config.relays = [...opts.relays];
    if (opts.iceServers) this.config.iceServers = [...opts.iceServers];
    if (opts.maxAgeHours) this.config.maxAgeHours = opts.maxAgeHours;
  }

  get hosting(): RoomInfo | null {
    return this.hostingRoom;
  }

  get guestSession(): RoomInfo | null {
    return this.guestRoom?.info ?? this.pendingJoin?.room ?? null;
  }

  /**
   * Guest: leave the waiting room (or the match) and tell the host. The room
   * itself stays listed on the relays, so the guest can join it again.
   */
  leaveGuestRoom(): void {
    const room = this.guestRoom?.info ?? this.lastRoom;
    if (room && this.pool) {
      const evt = finalizeEvent(
        signalTemplate(room.id, room.hostPubkey, { kind: 'bye', sid: room.sid }), this.sk);
      void this.pool.publish(evt);
    }
    try { this.guestRoom?.transport.close(); } catch { /* already closed */ }
    this.guestRoom = null;
    this.roster = [];
    this.chat = [];
    this.roomPhase = 'waiting';
    this.guestBetAccepted = false;
    this.betError = '';
    this.cancelJoin();
    this.onRoom?.();
    this.emit();
  }

  // ------------------------------------------------------------ relay pool
  /** Opens the relays (idempotent) and starts the room subscription. */
  async connect(): Promise<boolean> {
    if (this.online) return true;
    if (!this.pool) {
      // A fresh pool: drop stale subscriptions from the previous one.
      this.dmSub = null;
      this.pool = new RelayPool(this.config.relays);
      this.pool.onStatus = () => {
        this.online = this.pool ? this.pool.openCount > 0 : false;
        this.emit();
      };
      this.pool.connect();
    }
    const ok = await this.pool.waitOpen(8000);
    this.online = ok;
    if (!ok) this.error = 'no relay reachable';
    this.refreshRooms();
    this.subscribeDms();
    if (!this.filterTimer) {
      // Rooms age out of the filter list even when nothing arrives.
      this.filterTimer = setInterval(() => this.refilter(), 30000);
    }
    this.emit();
    return ok;
  }

  close(): void {
    this.endSession();
    try { this.guestRoom?.transport.close(); } catch { /* already closed */ }
    this.guestRoom = null;
    this.cancelJoin();
    if (this.filterTimer) {
      clearInterval(this.filterTimer);
      this.filterTimer = 0;
    }
    this.roomsSub?.();
    this.roomsSub = null;
    this.dmSub?.();
    this.dmSub = null;
    this.pool?.close();
    this.pool = null;
    this.online = false;
    this.rooms = [];
    this.roomRevisions.clear();
    this.emit();
  }

  setMaxAge(hours: number): void {
    this.config.maxAgeHours = hours;
    saveJson(CONFIG_KEY, this.config);
    // Narrowing the filter must drop rooms immediately (the re-subscription
    // only adds what the relay sends).
    this.refilter();
    this.refreshRooms();
    this.emit();
  }

  setRelays(relays: string[]): void {
    const clean = relays.map((s) => s.trim()).filter(Boolean);
    if (clean.length === 0) return;
    this.config.relays = clean;
    saveJson(CONFIG_KEY, this.config);
    this.roomsSub?.();
    this.roomsSub = null;
    this.dmSub?.();
    this.dmSub = null;
    this.pool?.close();
    this.pool = null;
    this.online = false;
    this.rooms = [];
    this.emit();
    void this.connect();
  }

  /** Subscribe (or re-subscribe) to the public room list. */
  refreshRooms(): void {
    if (!this.pool) return;
    this.roomsSub?.();
    const since = Math.floor(Date.now() / 1000) - this.config.maxAgeHours * 3600 - 600;
    // The lobby is the list of events that tag the room-board profile.
    this.roomsSub = this.pool.subscribe('mp-rooms', [
      { kinds: [KIND_ROOM, KIND_DELETE], '#p': [ROOM_BOARD_PUBKEY], since, limit: 200 },
    ], (evt) => this.onRoomEvent(evt));
  }

  private onRoomEvent(evt: NostrEvent): void {
    if (evt.kind === KIND_DELETE) {
      // NIP-09: the author closed a room we may be listing.
      for (const tag of evt.tags) {
        if (tag[0] !== 'a' || typeof tag[1] !== 'string') continue;
        const [kind, pubkey, d] = tag[1].split(':');
        if (Number(kind) !== KIND_ROOM || !pubkey || !d) continue;
        if (pubkey !== evt.pubkey) continue;
        this.roomRevisions.delete(pubkey + ':' + d);
      }
      this.refilter();
      this.emit();
      return;
    }
    const room = roomFromEvent(evt);
    if (!room) return;
    const key = room.hostPubkey + ':' + room.id;
    const known = this.roomRevisions.get(key);
    // Addressable events: keep the newest revision per (pubkey, d). Equal
    // timestamps (a heartbeat in the same second) still replace.
    if (known && known.updated > room.updated) return;
    this.roomRevisions.set(key, room);
    this.refilter();
    this.emit();
  }

  private refilter(): void {
    const cutoff = Date.now() / 1000 - this.config.maxAgeHours * 3600;
    const list = [...this.roomRevisions.values()].filter((r) => r.created >= cutoff);
    list.sort((a, b) => {
      const own = (r: RoomInfo): number => (r.hostPubkey === this.pubkey ? 0 : 1);
      if (own(a) !== own(b)) return own(a) - own(b);
      return b.created - a.created;
    });
    this.rooms = list;
  }

  private emit(): void {
    this.onChange?.();
  }

  // -------------------------------------------------------- direct messages
  /** Subscribe (or re-subscribe) to NIP-04 DMs addressed to our pubkey. */
  private subscribeDms(): void {
    if (!this.pool || this.dmSub) return;
    this.dmSub = this.pool.subscribe('mp-dm', [
      { kinds: [4], '#p': [this.pubkey] },
    ], (evt) => void this.onDmEvent(evt));
  }

  /** A stored or live kind-4 event: decrypt and dispatch (and route signals). */
  private async onDmEvent(evt: NostrEvent): Promise<void> {
    if (evt.kind !== 4 || !verifyEvent(evt)) return;
    if (!tagValues(evt, 'p').includes(this.pubkey)) return;
    const plaintext = await nip04Decrypt(this.sk, evt.pubkey, evt.content);
    if (plaintext == null) return;
    this.dispatchDm({ from: evt.pubkey, plaintext, created: evt.created_at, id: evt.id });
    // Inside a hosted room, guest answers/ICE arrive as DMs (private signalling).
    if (this.hostingRoom) void this.onDmSignal(evt, plaintext);
  }

  /** Hand one decrypted DM to every subscriber, deduplicated by event id. */
  private dispatchDm(msg: DmMessage): void {
    if (this.dmSeen.has(msg.id)) return;
    this.dmSeen.add(msg.id);
    if (this.dmSeen.size > 2000) {
      const first = this.dmSeen.values().next();
      if (!first.done) this.dmSeen.delete(first.value);
    }
    for (const handler of this.dmHandlers) {
      try { handler(msg); } catch { /* a subscriber error never breaks the client */ }
    }
  }

  /** DmTransport: encrypt and publish a kind-4 DM to `to` (x-only hex). */
  async sendDm(to: string, plaintext: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(to)) throw new Error('sendDm: bad recipient pubkey');
    await this.connect();
    if (!this.pool) throw new Error('no relay');
    const content = await nip04Encrypt(this.sk, to, plaintext);
    const evt = finalizeEvent({ kind: 4, tags: [['p', to]], content }, this.sk);
    await this.pool.publish(evt);
    // A DM addressed to ourselves is delivered locally too, so it works even
    // if the relay does not echo it back.
    if (to === this.pubkey) {
      this.dispatchDm({ from: this.pubkey, plaintext, created: evt.created_at, id: evt.id });
    }
  }

  /** DmTransport: live DMs addressed to us; returns an unsubscribe function. */
  onDm(handler: (msg: DmMessage) => void): () => void {
    this.dmHandlers.add(handler);
    this.subscribeDms();
    return () => { this.dmHandlers.delete(handler); };
  }

  /** DmTransport: stored DMs addressed to us, decrypted and time-ordered. */
  async fetchDms(since = 0): Promise<DmMessage[]> {
    const ok = await this.connect();
    const pool = this.pool;
    if (!pool || !ok) return [];
    const events: NostrEvent[] = [];
    await new Promise<void>((resolve) => {
      let done = false;
      let unsub: (() => void) | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        unsub?.();
        resolve();
      };
      const filter: Record<string, unknown> = { kinds: [4], '#p': [this.pubkey], limit: 500 };
      if (since > 0) filter.since = since;
      unsub = pool.subscribe('mp-dm-fetch', [filter], (evt) => { events.push(evt); }, finish);
      setTimeout(finish, 4000);
    });
    const out: DmMessage[] = [];
    for (const evt of events) {
      if (evt.kind !== 4 || !verifyEvent(evt) || !tagValues(evt, 'p').includes(this.pubkey)) continue;
      const plaintext = await nip04Decrypt(this.sk, evt.pubkey, evt.content);
      if (plaintext == null) continue;
      out.push({ from: evt.pubkey, plaintext, created: evt.created_at, id: evt.id });
    }
    out.sort((a, b) => a.created - b.created);
    return out;
  }

  /**
   * Publish a signed Nostr event (our identity) to the room relays. Used for
   * the high-score profile and shop ownership.
   */
  async publishNostr(kind: number, tags: string[][], content: string): Promise<boolean> {
    const ok = await this.connect();
    if (!ok || !this.pool) return false;
    const evt = finalizeEvent({ kind, tags, content }, this.sk);
    const res = await this.pool.publish(evt);
    return res.ok;
  }

  /**
   * Fetch stored events matching `filters` (one-shot collect, like
   * {@link fetchDms}). Returns verified events, newest last.
   */
  async fetchNostr(filters: unknown[], waitMs = 4000): Promise<NostrEvent[]> {
    const ok = await this.connect();
    const pool = this.pool;
    if (!pool || !ok) return [];
    const events: NostrEvent[] = [];
    await new Promise<void>((resolve) => {
      let done = false;
      let unsub: (() => void) | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        unsub?.();
        resolve();
      };
      unsub = pool.subscribe('ie-fetch', filters, (evt) => { events.push(evt); }, finish);
      setTimeout(finish, waitMs);
    });
    const out = events.filter((evt) => verifyEvent(evt));
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  }

  // ---------------------------------------------------------------- hosting

  // ---------------------------------------------------------------- hosting
  /**
   * Publish a room and start hosting. The match itself is started by the app
   * (the lobby navigates to the level, GameCanvas calls attachHost).
   */
  async createRoom(
    opts: { game: string; type: string; title: string; maxPlayers: number; password?: string },
  ): Promise<RoomInfo> {
    const ok = await this.connect();
    if (!ok) throw new Error(this.error || 'no relay reachable');
    this.endSession();
    const id = newRoomId();
    const bundle = await createHostCert(id, this.pubkey, this.sk);
    this.hostCert = bundle.cert;
    this.hostCertKey = bundle.privateKey;
    // Password protection: derive the signalling key now, but publish only a
    // flag + salt - never the password (see mp/crypto.ts).
    const password = (opts.password ?? '').trim();
    const salt = password ? newSalt() : undefined;
    this.roomPassword = password;
    this.hostKey = password ? await deriveKey(password, salt!) : null;
    // A fresh signalling session: stale events from a previous room are ignored.
    this.hostSid = newSessionId();
    this.hostSessionStarted = Math.floor(Date.now() / 1000);
    const content: RoomContent = {
      v: 1,
      game: opts.game,
      type: opts.type,
      title: opts.title,
      host: store.options.username || 'Pilot',
      players: 1,
      max: Math.max(2, Math.min(16, opts.maxPlayers)),
      ice: this.config.iceServers,
      created: Math.floor(Date.now() / 1000),
      cert: bundle.cert,
      pw: password ? true : undefined,
      salt,
      sid: this.hostSid,
    };
    const room = await this.publishRoom(id, content);
    this.hostingRoom = room;
    // Waiting room: the match only starts when the host presses PLAY.
    this.roomPhase = 'waiting';
    this.chat = [];
    this.roster = [{ name: content.host, pubkey: this.pubkey, team: DEFAULT_TEAM, mic: false, host: true }];
    this.hostTeam = '';
    this.betAmount = 0;
    this.betError = '';
    void this.loadTeams(opts.game);
    this.subscribeSignals();
    this.heartTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    // Host offers: one stored comment per free guest slot (no refresh needed).
    this.ensureOffers();
    this.emit();
    this.onRoom?.();
    return room;
  }

  /** Teams the level offers (config order), used by the team pickers. */
  private async loadTeams(levelKey: string): Promise<void> {
    if (this.roomTeamsFor === levelKey && this.roomTeams.length > 0) return;
    try {
      const def = await loadLevel(levelKey);
      const names = [...new Set(def.objects.map((o) => o.team))].filter((n) => n && n !== 'ambient');
      const order = TEAMS.map((t) => t.name);
      names.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      this.roomTeams = names.length > 0 ? names : ['team1'];
    } catch {
      this.roomTeams = ['team1'];
    }
    this.roomTeamsFor = levelKey;
    this.onRoom?.();
  }

  private async publishRoom(id: string, content: RoomContent): Promise<RoomInfo> {
    if (!this.pool) throw new Error('no relay');
    const evt = finalizeEvent(roomTemplate({ id, content, ttlSec: ROOM_TTL_SEC }), this.sk);
    await this.pool.publish(evt);
    const room = roomFromEvent(evt);
    if (!room) throw new Error('bad room event');
    this.roomRevisions.set(evt.pubkey + ':' + id, room);
    this.refilter();
    return room;
  }

  private async heartbeat(): Promise<void> {
    if (!this.hostingRoom || !this.pool) return;
    try {
      const players = this.hostingRoom && this.roster.length > 0 ? this.roster.length : 1;
      const content: RoomContent = {
        v: 1,
        game: this.hostingRoom.game,
        type: this.hostingRoom.type,
        title: this.hostingRoom.title,
        host: this.hostingRoom.host,
        players,
        max: this.hostingRoom.maxPlayers,
        ice: this.config.iceServers,
        created: this.hostingRoom.created,
        cert: this.hostCert ?? undefined,
        pw: this.roomPassword ? true : undefined,
        salt: this.roomPassword ? this.hostingRoom.salt : undefined,
        sid: this.hostSid,
      };
      this.hostingRoom = await this.publishRoom(this.hostingRoom.id, content);
      this.emit();
    } catch { /* the relay will expire the room */ }
  }

  /** Deletes one of our rooms (NIP-09); no-op for foreign rooms. */
  async deleteRoom(room: RoomInfo): Promise<void> {
    if (room.hostPubkey !== this.pubkey) return;
    if (this.hostingRoom && room.id === this.hostingRoom.id) {
      this.endSession();
      return;
    }
    if (!this.pool) return;
    const evt = finalizeEvent(deletionTemplate({ id: room.id, hostPubkey: room.hostPubkey }), this.sk);
    await this.pool.publish(evt);
    this.roomRevisions.delete(room.hostPubkey + ':' + room.id);
    this.refilter();
    this.emit();
  }

  /** GameCanvas: the room this client should host on the level it builds. */
  consumeHostIntent(): RoomInfo | null {
    const room = this.hostIntent;
    this.hostIntent = null;
    trace('consumeHostIntent', !!room);
    return room;
  }

  /** GameCanvas: hooks the running local simulation up as the match host. */
  attachHost(gi: GameInstance): void {
    trace('attachHost', !!this.hostingRoom);
    if (!this.hostingRoom) return;
    this.hostGi = gi;
    // The waiting room's team picks travel into the match: the host's own team
    // now, every guest's team when it sends Join.
    this.session = new HostSession(gi, this.hostTeam || '');
    this.session.onGuests = (list) => {
      this.onGuests?.(list);
      void this.heartbeat();
      this.emit();
    };
    // Network pause: a guest dropping mid-match freezes the match for everyone
    // (the host included) until it rejoins or the host drops it. Everything is
    // announced to the remaining guests over the room channel.
    this.session.onPauseChanged = (_paused, names) => {
      this.netPaused = this.session?.netPaused ?? false;
      this.netPausedBy = names;
      this.broadcastNetPause();
      this.onNetPause?.();
      this.emit();
    };
    // Authenticated room guests become match guests. Channels queued while the
    // room waited are the same links: only attach a queued one when its guest
    // is not already known (avoids a duplicate, never-joined guest entry).
    const attached = new Set<string>();
    for (const [pubkey, link] of this.links) {
      if (!link.authed) continue;
      attached.add(pubkey);
      if (!this.linkSessionIds.has(pubkey)) this.attachGuest(pubkey, link.name, link.transport, link.team);
    }
    for (const pending of this.pendingChannels.splice(0)) {
      if (attached.has(pending.pubkey)) continue;
      this.attachGuest(pending.pubkey, pending.name, pending.transport, pending.team);
    }
    this.emit();
  }

  /** Before the world steps: remote nitro burns and idle-input release. */
  preTick(dtMs: number): void {
    this.session?.preTick(dtMs);
  }

  /** After the world stepped: stream snapshots/events/hud to every guest. */
  postTick(dtMs: number): void {
    this.session?.postTick(dtMs);
  }

  /**
   * The hosted match is over (scene rebuilt, host left): close the room. A
   * short grace lets the Result frame reach the guests before the channels go.
   */
  endSession(graceMs = 0, keepRoom = false): void {
    trace('endSession', { graceMs, keepRoom, hosting: !!this.hostingRoom, session: !!this.session });
    if (keepRoom) {
      // Opening the match in a room that is already live (the host pressed
      // PLAY): keep the signalling subscription, the heartbeat, the peer
      // connections, the authenticated links and the queued channels — the
      // guests are waiting in the room menu and become match guests next.
      this.session?.dispose();
      this.session = null;
      this.linkSessionIds.clear();
      this.emit();
      return;
    }
    if (this.heartTimer) {
      clearInterval(this.heartTimer);
      this.heartTimer = 0;
    }
    const session = this.session;
    const peers = [...this.hostPeers.values(), ...this.hostOffers.values()];
    const pending = this.pendingChannels.splice(0);
    const offerEventIds = [...this.hostOffers.values()].map((p) => p.offerEventId).filter(Boolean);
    this.session = null;
    this.hostPeers.clear();
    this.hostOffers.clear();
    const closeAll = (): void => {
      session?.dispose();
      for (const peer of peers) {
        try { peer.pc.close(); } catch { /* already closed */ }
      }
      for (const p of pending) {
        try { p.transport.close(); } catch { /* already closed */ }
      }
    };
    if (graceMs > 0 && (session || peers.length > 0)) setTimeout(closeAll, graceMs);
    else closeAll();
    this.links.clear();
    this.linkSessionIds.clear();
    this.pendingFrames.clear();
    this.sigSub?.();
    this.sigSub = null;
    this.hostCert = null;
    this.hostCertKey = null;
    this.hostKey = null;
    this.roomPassword = '';
    this.roster = [];
    this.chat = [];
    this.roomPhase = 'waiting';
    this.betAmount = 0;
    this.betError = '';
    this.hostGi = null;
    const room = this.hostingRoom;
    this.hostingRoom = null;
    this.hostIntent = null;
    this.hostSid = '';
    this.hostSessionStarted = 0;
    if (room && this.pool && room.hostPubkey === this.pubkey) {
      // Close the room publicly so nobody sees a stale listing, and ask the
      // relays to drop any signalling still floating around (NIP-09).
      const evt = finalizeEvent(deletionTemplate({ id: room.id, hostPubkey: room.hostPubkey }), this.sk);
      void this.pool.publish(evt);
      if (offerEventIds.length > 0) {
        const del = finalizeEvent(offerDeletionTemplate(offerEventIds), this.sk);
        void this.pool.publish(del);
      }
      this.roomRevisions.delete(room.hostPubkey + ':' + room.id);
      this.refilter();
    }
    this.emit();
  }

  guestCount(): number {
    return this.session?.guestCount ?? 0;
  }

  /** The waiting room's roster (host view; guests mirror the host's state). */
  get players(): RoomPlayerInfo[] {
    return this.roster;
  }

  /** True while this client sits in a waiting room (host or guest). */
  get inRoom(): boolean {
    return !!(this.hostingRoom || this.guestRoom);
  }

  /** Everything the room menu draws, or null when not in a room. */
  roomSnapshot(): RoomSnapshot | null {
    const info = this.hostingRoom ?? this.guestRoom?.info ?? null;
    if (!info) return null;
    const players = this.hostingRoom
      ? [{ name: info.host, pubkey: this.pubkey, team: this.hostTeam || DEFAULT_TEAM, mic: this.micOn, host: true, betAccepted: true },
          ...[...this.links.values()].filter((l) => l.authed).map((l) => ({
            name: l.name, pubkey: '', team: l.team || DEFAULT_TEAM, mic: l.mic, host: false,
            betAccepted: l.betAccepted,
          }))]
      : this.roster;
    return {
      roomId: info.id,
      level: info.game,
      title: info.title,
      maxPlayers: info.maxPlayers,
      protected: info.protected,
      teams: this.roomTeams,
      players,
      meIndex: this.hostingRoom ? 0 : (this.guestRoom?.you ?? 0),
      isHost: !!this.hostingRoom,
      phase: this.roomPhase,
      chat: this.chat,
      micOn: this.micOn,
      betAmount: this.hostingRoom ? this.betAmount : (this.guestRoom?.betAmount ?? 0),
      betAccepted: this.hostingRoom ? true : this.guestBetAccepted,
      betError: this.betError,
      status: this.status,
    };
  }

  /** Host: pick a team for any player; guests: for themselves. */
  setPlayerTeam(index: number, team: string): void {
    if (this.hostingRoom) {
      if (index === 0) {
        this.hostTeam = team;
        if (this.session) this.session.setHostTeam(team);
      } else {
        const link = [...this.links.values()].filter((l) => l.authed)[index - 1];
        if (link) {
          link.team = team;
          const pubkey = [...this.links.entries()].filter(([, l]) => l.authed)[index - 1]?.[0];
          if (pubkey && this.session) this.session.setGuestTeam(pubkey, team);
        }
      }
      this.broadcastRoom();
      this.onRoom?.();
      return;
    }
    if (this.guestRoom && index === this.guestRoom.you) {
      const payload = textEncoder.encode(JSON.stringify({ t: 'team', team }));
      this.guestRoom.transport.send(encodeMessage(GameMsg.Room, payload));
    }
  }

  /** Chat message from this client (room or match: the relay keeps it alive). */
  sendChat(text: string): void {
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    if (this.hostingRoom) {
      this.pushChat({ from: this.identityName(), text: clean, at: Date.now() }, true);
      return;
    }
    if (this.guestRoom) {
      const payload = textEncoder.encode(JSON.stringify({ t: 'chat', text: clean }));
      this.guestRoom.transport.send(encodeMessage(GameMsg.Room, payload));
    }
  }

  /** Mic toggle: the capture itself lives in the room view. */
  setMic(on: boolean): void {
    this.micOn = on;
    if (this.hostingRoom) {
      this.broadcastRoom();
    } else if (this.guestRoom) {
      const payload = textEncoder.encode(JSON.stringify({ t: 'mic', on }));
      this.guestRoom.transport.send(encodeMessage(GameMsg.Room, payload));
    }
    this.onRoom?.();
  }

  /** One PCM chunk (16 kHz mono) to everyone else in the room/match. */
  sendVoice(pcm: Int16Array): void {
    if (!this.micOn || pcm.length === 0) return;
    const frame = encodeMessage(GameMsg.Voice, encodeVoiceFrame(0, pcm));
    if (this.hostingRoom) {
      for (const link of this.links.values()) if (link.authed) link.transport.send(frame);
    } else if (this.guestRoom) {
      this.guestRoom.transport.send(frame);
    }
  }

  // ------------------------------------------------------------- room bets
  /** Host: set the escrowed bet (restricted to BET_AMOUNTS; resets acceptances). */
  setBetAmount(amount: number): void {
    if (!this.hostingRoom) return;
    const allowed = (BET_AMOUNTS as readonly number[]).includes(amount) ? amount : 0;
    this.betAmount = allowed;
    this.betError = '';
    // A new stake invalidates every acceptance: guests must accept again.
    for (const link of this.links.values()) link.betAccepted = false;
    this.broadcastRoom();
    this.onRoom?.();
    this.emit();
  }

  /** Host: cycle the bet through 0 / 50 / 100 / 200 (the room button). */
  cycleBet(): void {
    const i = (BET_AMOUNTS as readonly number[]).indexOf(this.betAmount);
    this.setBetAmount(BET_AMOUNTS[(i + 1) % BET_AMOUNTS.length]);
  }

  /** Guest: toggle acceptance of the host's bet and tell the host. */
  toggleBetAccept(): void {
    if (this.hostingRoom || !this.guestRoom) return;
    this.guestBetAccepted = !this.guestBetAccepted;
    const payload = textEncoder.encode(JSON.stringify({ t: 'bet', accepted: this.guestBetAccepted }));
    this.guestRoom.transport.send(encodeMessage(GameMsg.Room, payload));
    this.onRoom?.();
    this.emit();
  }

  /** True when every authenticated guest has accepted a non-zero bet. */
  private betsAccepted(): boolean {
    if (this.betAmount <= 0) return true;
    for (const link of this.links.values()) {
      if (link.authed && !link.betAccepted) return false;
    }
    return true;
  }

  /** Lightning address advertised by a participant (host or guest). */
  private lud16Of(pubkey: string): string {
    if (pubkey === this.pubkey) return getWallet()?.lud16 ?? '';
    return this.links.get(pubkey)?.lud16 ?? '';
  }

  /** A losing client pays each winner `perWinner` sats over Lightning. */
  private async payBetWinners(
    winners: { pubkey: string; lud16: string }[], perWinner: number,
  ): Promise<void> {
    const wallet = getWallet();
    if (!wallet || !wallet.connected || perWinner <= 0) {
      this.betError = 'connect a Lightning wallet to pay the bet';
      this.onRoom?.();
      this.emit();
      return;
    }
    let paid = 0;
    for (const w of winners) {
      if (!w.lud16) continue;
      const invoice = await lnurlPayInvoice(w.lud16, perWinner, 'Infinity Edge bet');
      if (!invoice) continue;
      try {
        await wallet.pay(invoice);
        paid++;
      } catch { /* try the next winner */ }
    }
    this.betError = paid > 0 ? `paid ${paid} winner(s) ${perWinner} sats` : 'could not pay the bet';
    this.onRoom?.();
    this.emit();
  }

  /**
   * Host: settle the room's bet at match end. Winners/losers are computed by
   * team; a draw or missing result voids it. With no escrow the payout happens
   * AFTER the match: the host announces the split and every losing client pays
   * each winner in sats over Lightning.
   */
  async settleBet(result?: { won: boolean; draw?: boolean } | null): Promise<void> {
    const room = this.hostingRoom;
    if (!room || this.betAmount <= 0) return;
    const res = result ?? this.hostGi?.result ?? null;
    const voided = !res || res.draw === true;
    const winners: string[] = [];
    const losers: string[] = [];
    if (!voided && res) {
      const hostTeam = this.hostTeam || DEFAULT_TEAM;
      const hostWon = res.won === true;
      (hostWon ? winners : losers).push(this.pubkey);
      for (const [pubkey, link] of this.links) {
        if (!link.authed) continue;
        const sameTeam = (link.team || hostTeam) === hostTeam;
        (hostWon === sameTeam ? winners : losers).push(pubkey);
      }
    }
    const winnerInfo = winners.map((pubkey) => ({ pubkey, lud16: this.lud16Of(pubkey) }));
    const perWinner = winners.length > 0 ? Math.ceil(this.betAmount / winners.length) : 0;
    this.betSettlement = { winners: winnerInfo, losers, perWinner, voided };
    const payload = textEncoder.encode(JSON.stringify({
      t: 'settle', voided, losers, winners: winnerInfo, perWinner,
    }));
    for (const link of this.links.values()) {
      if (link.authed) link.transport.send(encodeMessage(GameMsg.Room, payload));
    }
    if (!voided && losers.includes(this.pubkey)) {
      await this.payBetWinners(winnerInfo, perWinner);
    }
    this.betAmount = 0;
    this.onRoom?.();
    this.emit();
  }

  /** Host: start the match (the guests are told and follow). */
  async startMatch(): Promise<string | null> {
    if (!this.hostingRoom) return null;
    if (!this.betsAccepted()) {
      this.betError = 'every pilot must accept the bet before the match starts';
      this.broadcastRoom();
      this.onRoom?.();
      this.emit();
      return null;
    }
    this.roomPhase = 'playing';
    const payload = textEncoder.encode(JSON.stringify({ t: 'start', level: this.hostingRoom.game }));
    for (const link of this.links.values()) if (link.authed) link.transport.send(encodeMessage(GameMsg.Room, payload));
    // GameCanvas consumes this when it builds the level for the match.
    this.hostIntent = this.hostingRoom;
    this.onRoom?.();
    this.emit();
    return this.hostingRoom.game;
  }

  /** Host: close the room and drop everyone (from the lobby's room-row DELETE). */
  closeRoom(): void {
    this.endSession();
  }

  /**
   * Re-enter the room this client already has. Going back from the waiting
   * room (or the lobby) must NOT delete the hosted room: the host keeps
   * `hostingRoom`, its roster, chat and peer connections, and calls this to
   * re-open the room menu. If the signalling subscription was lost (a real
   * disconnect), the session id is rotated, old offers are deleted (NIP-09)
   * and fresh ones are published, so stale events are never reused.
   */
  rejoinRoom(): RoomInfo | null {
    // Guest still connected to a waiting room: just re-enter it.
    if (this.guestRoom) {
      this.emit();
      this.onRoom?.();
      return this.guestRoom.info;
    }
    const room = this.hostingRoom;
    if (!room) return null;
    // If signalling was torn down (a real disconnect rather than a plain view
    // switch), this is a reconnect: new session + fresh offers, while the
    // existing peers/links/roster/chat survive.
    if (!this.sigSub) {
      this.rotateHostSession(room);
      this.subscribeSignals();
    }
    if (!this.heartTimer) this.heartTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.ensureOffers();
    this.roomPhase = 'waiting';
    void this.heartbeat();
    this.emit();
    this.onRoom?.();
    return room;
  }

  /**
   * Reconnect cleanup: a fresh signalling session id (stale answers/ICE are
   * ignored), delete the old offers by event id (NIP-09) and republish the
   * room so guests see the new session. Roster, chat and live peers survive.
   */
  private rotateHostSession(room: RoomInfo): void {
    const oldOffers = [...this.hostOffers.values()].map((p) => p.offerEventId).filter(Boolean);
    this.hostSid = newSessionId();
    this.hostSessionStarted = Math.floor(Date.now() / 1000);
    for (const peer of this.hostOffers.values()) {
      try { peer.pc.close(); } catch { /* already closed */ }
    }
    this.hostOffers.clear();
    if (this.pool && oldOffers.length > 0) {
      const del = finalizeEvent(offerDeletionTemplate(oldOffers), this.sk);
      void this.pool.publish(del);
    }
    // Republish the room (and later fresh offers) under the new session id.
    void this.heartbeat();
  }

  /** True while a hosted match is streaming to its guests. */
  get sessionActive(): boolean {
    return this.session !== null;
  }

  /** The room certificate published with our room (null when not hosting). */
  hostCert: HostCert | null = null;
  private hostCertKey: CryptoKey | null = null;
  /** Per-peer links until the channel challenge is answered. */
  private links = new Map<string, GuestLink>();
  /** Session guest ids, so game frames can be routed after room frames. */
  private linkSessionIds = new Map<string, number>();
  /** Game frames that arrived before the host's session was attached. */
  private pendingFrames = new Map<string, (ArrayBuffer | Uint8Array)[]>();

  /** Diagnostics (console / e2e): the hosted session's guests. */
  debugGuests(): Record<string, unknown>[] {
    return this.session?.debugGuests() ?? [];
  }

  /** Diagnostics (tests): guest pubkeys with an answered offer. */
  debugPeers(): string[] {
    return [...this.hostPeers.keys()];
  }

  /** Diagnostics (tests): open (unanswered) host offer ids. */
  debugOffers(): string[] {
    return [...this.hostOffers.keys()];
  }

  /** Diagnostics (tests): the current host signalling session id. */
  debugSessionId(): string {
    return this.hostSid;
  }

  // ------------------------------------------------------------- signalling
  private subscribeSignals(): void {
    if (!this.pool || !this.hostingRoom) return;
    const roomId = this.hostingRoom.id;
    // Public: join requests and (legacy) answers/ICE addressed to the host.
    // New guests answer with NIP-04 DMs, handled by onDmSignal.
    this.sigSub = this.pool.subscribe('mp-sig-host', [
      { kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [this.pubkey] },
    ], (evt) => void this.onSignal(evt, roomId));
  }

  /** Host: handle an answer / ICE / bye / join addressed to us. */
  private async onSignal(evt: NostrEvent, roomId: string): Promise<void> {
    if (!verifyEvent(evt)) return;
    const room = this.hostingRoom;
    if (!room) return;
    // Reconnect cleanup: events older than the current session are stale.
    if (evt.created_at + SIGNAL_SKEW_SEC < this.hostSessionStarted) return;
    const msg = signalFromEvent(evt, this.pubkey, roomId);
    if (!msg) return;
    if (msg.sid && msg.sid !== this.hostSid) return; // another session
    if (msg.kind === 'answer') return this.onHostAnswer(evt, msg);
    if (msg.kind === 'join') {
      // A joining guest asked for an offer: make sure every free slot has one.
      trace('host.join', { from: evt.pubkey.slice(0, 8) });
      this.ensureOffers();
      return;
    }
    if (msg.kind === 'ice') {
      await this.handleIceSignal(evt, msg);
      return;
    }
    if (msg.kind === 'bye') {
      this.dropPeer(evt.pubkey, true);
    }
  }

  /** Host: apply a guest's ICE candidates to its peer (public or DM path). */
  private async handleIceSignal(evt: NostrEvent, msg: SignalMessage): Promise<void> {
    const body = await openSignal(this.hostKey, msg);
    if (!body) return;
    const peer = this.hostPeers.get(evt.pubkey)
      ?? (msg.offerId ? this.hostOffers.get(msg.offerId) : undefined);
    if (!peer) return;
    for (const cand of body.candidates ?? []) {
      try {
        if (peer.remoteSet) await peer.pc.addIceCandidate(cand as RTCIceCandidateInit);
        else peer.pendingCandidates.push(cand);
      } catch { /* a bad candidate must not kill the call */ }
    }
  }

  /**
   * Host: a guest's answer / ICE arrived as a NIP-04 DM (private signalling:
   * the guest never publishes its SDP or candidates on a public KIND_SIGNAL).
   * The DM body is the same sealed SignalMessage the public flow used.
   */
  private async onDmSignal(evt: NostrEvent, plaintext: string): Promise<void> {
    const room = this.hostingRoom;
    if (!room) return;
    let msg: SignalMessage;
    try {
      msg = JSON.parse(plaintext) as SignalMessage;
    } catch {
      return;
    }
    if (!msg || msg.v !== MP_PROTOCOL) return;
    if (msg.room !== room.id || msg.to !== this.pubkey) return;
    if (msg.kind !== 'answer' && msg.kind !== 'ice') return;
    if (msg.sid && msg.sid !== this.hostSid) return; // another session
    if (evt.created_at + SIGNAL_SKEW_SEC < this.hostSessionStarted) return;
    if (msg.kind === 'answer') return this.onHostAnswer(evt, msg);
    await this.handleIceSignal(evt, msg);
  }

  /** Host: complete the peer connection the guest's answer refers to. */
  private async onHostAnswer(evt: NostrEvent, msg: SignalMessage): Promise<void> {
    trace('onHostAnswer', { from: evt.pubkey.slice(0, 8), hosting: !!this.hostingRoom });
    const room = this.hostingRoom;
    if (!room || !this.pool) return;
    const body = await openSignal(this.hostKey, msg);
    if (!body || !body.sdp) return;
    const offerId = msg.offerId ?? '';
    const peer = offerId ? this.hostOffers.get(offerId) : undefined;
    if (!peer) return; // unknown or already-claimed offer
    const pubkey = evt.pubkey;
    if (this.hostPeers.has(pubkey)) return; // one connection per guest
    if (this.hostPeers.size >= room.maxPlayers - 1) return; // room is full
    this.hostOffers.delete(offerId);
    // The slot is taken: retire the offer comment so it stops advertising.
    if (peer.offerEventId) {
      void this.pool.publish(finalizeEvent(offerDeletionTemplate([peer.offerEventId]), this.sk));
    }
    peer.guestPubkey = pubkey;
    peer.name = body.name || 'Pilot';
    this.hostPeers.set(pubkey, peer);
    try {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: body.sdp });
      peer.remoteSet = true;
      for (const cand of peer.pendingCandidates.splice(0)) {
        try { await peer.pc.addIceCandidate(cand as RTCIceCandidateInit); } catch { /* ignore */ }
      }
      // The guest is known now: flush the host candidates that were waiting.
      this.publishIce(room.id, pubkey, peer.offerId, peer.localCandidates.splice(0));
    } catch {
      this.dropPeer(pubkey);
      return;
    }
    // A fresh offer for the next client, and a heartbeat (player count).
    this.ensureOffers();
    void this.heartbeat();
    this.emit();
  }

  /**
   * Host: publish one SDP offer per guest slot. The host is the offerer now:
   * it creates the data channel and the offer, signs the SDP with the room
   * certificate and (for a protected room) seals it with the password-derived
   * key. The pool is kept at `maxPlayers - 1` offers until the room is full.
   */
  private ensureOffers(): void {
    const room = this.hostingRoom;
    if (!room || !this.pool) return;
    // Node/tests have no WebRTC: keep the room lifecycle working without it.
    if (typeof RTCPeerConnection === 'undefined') return;
    // Keep one offer per free slot, plus one extra so a fresh offer is always
    // ready "for the next client" (the pool never over-advertises by more than
    // that one). A full room advertises nothing.
    const free = room.maxPlayers - 1 - this.hostPeers.size;
    const target = free <= 0 ? 0 : Math.min(room.maxPlayers - 1, free + 1);
    while (this.hostOffers.size > target) {
      const first = this.hostOffers.keys().next();
      if (first.done) break;
      this.dropOffer(first.value);
    }
    while (this.hostOffers.size < target) void this.publishOffer();
  }

  private async publishOffer(): Promise<void> {
    const room = this.hostingRoom;
    if (!room || !this.pool) return;
    const offerId = newOfferId();
    const pc = new RTCPeerConnection(
      iceConfig(room.ice.length ? room.ice : this.config.iceServers));
    const channel = pc.createDataChannel('game', { ordered: true });
    const peer: HostPeer = {
      offerId,
      pc,
      guestPubkey: null,
      name: '',
      channel,
      pendingCandidates: [],
      localCandidates: [],
      remoteSet: false,
      offerBody: { kind: 'offer', offerId },
      offerEventId: '',
      offerAt: 0,
    };
    this.hostOffers.set(offerId, peer);
    // Trickle: buffer our candidates until the guest is known, then send them.
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cand = candidateInit(e.candidate);
      if (peer.guestPubkey) this.publishIce(room.id, peer.guestPubkey, offerId, [cand]);
      else peer.localCandidates.push(cand);
    };
    // The host created the channel: once it opens, the guest answers the room
    // challenge (auth-request) and the link becomes a waiting-room guest.
    channel.onopen = () => {
      if (!peer.guestPubkey) return;
      this.addGuestChannel(peer.guestPubkey, peer.name, rtcTransport(channel));
    };
    channel.onclose = () => {
      if (peer.guestPubkey) this.dropPeer(peer.guestPubkey);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (peer.guestPubkey && (st === 'failed' || st === 'closed')) this.dropPeer(peer.guestPubkey);
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? '';
      // Sign the offer SDP (it carries the DTLS fingerprint) with the room
      // certificate key; the guest checks it with verifyAnswer.
      const sig = this.hostCert && this.hostCertKey
        ? await signAnswer(this.hostCertKey, room.id, this.pubkey, '', sdp)
        : undefined;
      peer.offerBody = await sealSignal(this.hostKey, {
        kind: 'offer', offerId, sdp, sig, name: this.identityName(),
      });
      await this.publishOfferEvent(peer);
      trace('host.offerPublished', { offerId: offerId.slice(0, 8) });
    } catch {
      this.dropOffer(offerId);
    }
  }

  /** Post (or re-post) the offer as a comment under the room event. */
  private async publishOfferEvent(peer: HostPeer): Promise<void> {
    const room = this.hostingRoom;
    if (!room || !this.pool) return;
    const prev = peer.offerEventId;
    const evt = finalizeEvent(
      offerCommentTemplate(room, { sid: this.hostSid, ...peer.offerBody }), this.sk);
    peer.offerEventId = evt.id;
    peer.offerAt = evt.created_at;
    await this.pool.publish(evt);
    // One live offer per slot: delete the comment we are replacing.
    if (prev && prev !== evt.id) {
      void this.pool.publish(finalizeEvent(offerDeletionTemplate([prev]), this.sk));
    }
  }

  /**
   * Retire an unanswered offer: close its peer and delete the comment (NIP-09)
   * so the room does not accumulate dead offers.
   */
  private dropOffer(offerId: string): void {
    const peer = this.hostOffers.get(offerId);
    if (!peer) return;
    this.hostOffers.delete(offerId);
    try { peer.pc.close(); } catch { /* already closed */ }
    if (peer.offerEventId && this.pool) {
      void this.pool.publish(finalizeEvent(offerDeletionTemplate([peer.offerEventId]), this.sk));
    }
  }

  /** Host: trickle ICE to a guest (sealed when the room is protected). */
  private publishIce(roomId: string, to: string, offerId: string, candidates: SignalCandidate[]): void {
    if (!this.pool || candidates.length === 0) return;
    const pool = this.pool;
    void (async () => {
      const body = await sealSignal(this.hostKey, { kind: 'ice', offerId, candidates });
      const evt = finalizeEvent(signalTemplate(roomId, to, { sid: this.hostSid, ...body }), this.sk);
      await pool.publish(evt);
    })();
  }

  private addGuestChannel(pubkey: string, name: string, transport: GameTransport): void {
    // The channel stays closed to game traffic until it answers the host
    // challenge: only then is it a guest the session may talk to.
    this.links.set(pubkey, { name, transport, authed: false, team: '', mic: false, betAccepted: false, lud16: '' });
    transport.onclose = () => this.dropPeer(pubkey);
    transport.onmessage = (data) => void this.onGuestFrame(pubkey, data);
  }

  private async onGuestFrame(pubkey: string, data: ArrayBuffer | Uint8Array): Promise<void> {
    const link = this.links.get(pubkey);
    if (!link) return;
    let frame;
    try {
      frame = await decodeMessage(data);
    } catch {
      return;
    }
    if (!link.authed) {
      if (frame.type !== GameMsg.Auth) return;
      try {
        const req = JSON.parse(textDecoder.decode(frame.payload)) as {
          t?: string; pubkey?: string; nonce?: string;
        };
        if (req.t !== 'auth-request' || req.pubkey !== pubkey || !req.nonce) return;
        if (!this.hostingRoom) return;
        const sig = signAuth(this.sk, this.hostingRoom.id, this.pubkey, pubkey, req.nonce);
        const ack = textEncoder.encode(JSON.stringify({
          t: 'auth-ok', host: this.pubkey, nonce: req.nonce, sig,
        }));
        link.transport.send(encodeMessage(GameMsg.Auth, ack));
        link.authed = true;
        trace('host.authOk', { guest: pubkey.slice(0, 8) });
        this.pushChat({ from: '', text: `${link.name} joined the room`, at: Date.now(), system: true });
        this.sendRoomTo(pubkey, this.authedIndex(pubkey));
        if (this.session) this.attachGuest(pubkey, link.name, link.transport, link.team);
        else this.attachGuestDelayed(pubkey, link.name, link.transport, link.team);
        this.broadcastRoom();
      } catch { /* malformed request: leave the link unauthenticated */ }
      return;
    }
    // Authenticated: room control and voice stay in the manager, game frames
    // go to the match session when one is attached (they share the channel).
    if (frame.type === GameMsg.Room) {
      this.handleGuestRoom(pubkey, frame.payload);
      return;
    }
    if (frame.type === GameMsg.Voice) {
      const voice = decodeVoiceFrame(frame.payload);
      if (voice) this.relayVoice(pubkey, voice.pcm);
      return;
    }
    const id = this.linkSessionIds.get(pubkey);
    if (this.session && id !== undefined) {
      await this.session.handleFrame(id, data);
    } else if (frame.type === GameMsg.Join || frame.type === GameMsg.Input || frame.type === GameMsg.Ping) {
      // The host is still loading the level: hold the first frames (Join!) so
      // they are not lost between the waiting room and the match session.
      const queue = this.pendingFrames.get(pubkey) ?? [];
      if (queue.length < 256) queue.push(data);
      this.pendingFrames.set(pubkey, queue);
    }
  }

  /** Replay frames a guest sent before the match session existed. */
  private async drainPendingFrames(pubkey: string, id: number): Promise<void> {
    const queue = this.pendingFrames.get(pubkey);
    if (!queue) return;
    this.pendingFrames.delete(pubkey);
    for (const data of queue) {
      if (!this.session) return;
      await this.session.handleFrame(id, data);
    }
  }

  /** One-based roster index of an authenticated guest (voice speaker id). */
  private authedIndex(pubkey: string): number {
    const keys = [...this.links.entries()].filter(([, l]) => l.authed).map(([k]) => k);
    return keys.indexOf(pubkey) + 1;
  }

  /** Queue a guest until the match session exists (waiting room). */
  private attachGuestDelayed(pubkey: string, name: string, transport: GameTransport, team: string): void {
    const existing = this.pendingChannels.find((p) => p.pubkey === pubkey);
    if (existing) {
      existing.name = name;
      existing.transport = transport;
      existing.team = team;
    } else {
      this.pendingChannels.push({ pubkey, name, transport, team });
    }
  }

  /** Guest -> host waiting-room messages. */
  private handleGuestRoom(pubkey: string, payload: Uint8Array): void {
    const link = this.links.get(pubkey);
    if (!link) return;
    let msg: { t?: string; text?: string; team?: string; on?: boolean; accepted?: boolean; lud16?: string };
    try {
      msg = JSON.parse(textDecoder.decode(payload)) as typeof msg;
    } catch {
      return;
    }
    if (msg.t === 'chat' && typeof msg.text === 'string') {
      this.pushChat({ from: link.name, text: msg.text.trim().slice(0, 200), at: Date.now() }, true);
      return;
    }
    if (msg.t === 'team' && typeof msg.team === 'string') {
      if (msg.team === '' || this.roomTeams.includes(msg.team)) {
        link.team = msg.team;
        this.broadcastRoom();
        this.onRoom?.();
      }
      return;
    }
    if (msg.t === 'mic') {
      link.mic = msg.on === true;
      this.broadcastRoom();
      this.onRoom?.();
      return;
    }
    if (msg.t === 'bet') {
      link.betAccepted = msg.accepted === true;
      this.broadcastRoom();
      this.onRoom?.();
      return;
    }
    if (msg.t === 'hello') {
      if (typeof msg.lud16 === 'string') link.lud16 = msg.lud16.trim().slice(0, 120);
      this.broadcastRoom();
    }
  }

  private attachGuest(pubkey: string, name: string, transport: GameTransport, team = ''): void {
    if (!this.session) {
      this.pendingChannels.push({ pubkey, name, transport, team });
      return;
    }
    // A guest the paused match is waiting for re-binds to its own slot; its
    // fresh Join re-sends the Scene + a full baseline.
    const reattached = this.session.reattachGuest(pubkey, transport);
    const id = reattached ?? this.session.addGuest({ pubkey, name, transport, team });
    this.linkSessionIds.set(pubkey, id);
    const link = this.links.get(pubkey);
    if (link) {
      link.authed = true;
      link.team = team;
    }
    // Incoming frames keep flowing through the manager router: room control
    // and voice stay live during the match, game frames go to the session.
    void this.drainPendingFrames(pubkey, id);
    transport.onclose = () => this.dropPeer(pubkey);
    if (reattached !== null) {
      this.pushChat({ from: '', text: `${name} reconnected`, at: Date.now(), system: true });
      this.broadcastNetPause();
      this.onRoom?.();
    }
  }

  // ------------------------------------------------------------- waiting room
  /** Per-guest state snapshot (the `you` index differs for every guest). */
  private roomStatePayload(you: number): Uint8Array {
    const info = this.hostingRoom;
    const players: RoomPlayerInfo[] = info
      ? [{ name: info.host, pubkey: this.pubkey, team: this.hostTeam || DEFAULT_TEAM, mic: this.micOn, host: true, betAccepted: true, lud16: getWallet()?.lud16 ?? '' },
          ...[...this.links.entries()].filter(([, l]) => l.authed).map(([pubkey, l]) => ({
            name: l.name, pubkey, team: l.team || DEFAULT_TEAM, mic: l.mic, host: false,
            betAccepted: l.betAccepted, lud16: l.lud16,
          }))]
      : [];
    this.roster = players;
    return textEncoder.encode(JSON.stringify({
      t: 'state',
      level: info?.game ?? '',
      title: info?.title ?? '',
      max: info?.maxPlayers ?? 0,
      phase: this.roomPhase,
      teams: this.roomTeams,
      you,
      players,
      bet: this.betAmount,
      betError: this.betError,
    }));
  }

  /** Push the current roster to every authenticated guest. */
  private broadcastRoom(): void {
    if (!this.hostingRoom) return;
    let index = 1;
    for (const link of this.links.values()) {
      if (!link.authed) continue;
      link.transport.send(encodeMessage(GameMsg.Room, this.roomStatePayload(index)));
      index++;
    }
  }

  private sendRoomTo(pubkey: string, you: number): void {
    const link = this.links.get(pubkey);
    if (link?.authed) link.transport.send(encodeMessage(GameMsg.Room, this.roomStatePayload(you)));
  }

  /** Tell every guest the match is (un)paused and who it waits for. */
  private broadcastNetPause(): void {
    if (!this.hostingRoom) return;
    const payload = textEncoder.encode(JSON.stringify({
      t: 'paused', paused: this.netPaused, name: this.netPausedBy,
    }));
    for (const link of this.links.values()) {
      if (link.authed) link.transport.send(encodeMessage(GameMsg.Room, payload));
    }
  }

  /** Host: drop every guest the paused match is waiting for, then resume. */
  dropMissingGuests(): void {
    const session = this.session;
    if (!session) return;
    for (const g of session.suspendedGuests()) session.dropGuest(g.id);
    this.netPaused = false;
    this.netPausedBy = '';
    this.broadcastNetPause();
    this.onNetPause?.();
    this.emit();
  }

  /**
   * Guest: re-establish the match connection after an unexpected drop. Re-runs
   * the host-offer join and hands the new transport to GameCanvas, which
   * rebuilds the NetGame and re-syncs from a full Scene + snapshot baseline.
   * The host re-binds the waiting slot by public key, so the match resumes.
   */
  async reconnectMatch(): Promise<boolean> {
    const room = this.lastRoom;
    if (!room || this.hostingRoom || this.guest || this.guestJoin) return false;
    try {
      this.status = 'reconnecting…';
      this.error = '';
      this.emit();
      await this.joinRoom(room, this.lastPassword, true);
      this.status = '';
      this.emit();
      // Force the persistent GameCanvas to rebuild its NetGame on the new link.
      store.sceneEpoch++;
      return true;
    } catch (e) {
      this.error = (e as Error).message;
      this.status = '';
      this.emit();
      return false;
    }
  }

  /** Append a chat line (host authoritative) and fan it out. */
  private pushChat(line: ChatLine, broadcast = true): void {
    this.chat.push(line);
    if (this.chat.length > 200) this.chat.shift();
    if (broadcast && this.hostingRoom) {
      const payload = textEncoder.encode(JSON.stringify({
        t: 'chat', from: line.from, text: line.text, system: line.system ?? false,
      }));
      for (const link of this.links.values()) {
        if (link.authed) link.transport.send(encodeMessage(GameMsg.Room, payload));
      }
    }
    this.onRoom?.();
    this.emit();
  }

  /** Voice from a guest: fan it out (with their roster index) and play locally. */
  private relayVoice(fromPubkey: string, pcm: Int16Array): void {
    const keys = [...this.links.entries()].filter(([, l]) => l.authed).map(([k]) => k);
    const index = keys.indexOf(fromPubkey) + 1;
    if (index <= 0) return;
    for (const [pubkey, link] of this.links) {
      if (pubkey === fromPubkey || !link.authed) continue;
      link.transport.send(encodeMessage(GameMsg.Voice, encodeVoiceFrame(index, pcm)));
    }
    this.onVoice?.(index, pcm);
  }

  private dropPeer(pubkey: string, intentional = false): void {
    const leaving = this.links.get(pubkey);
    const sessionId = this.linkSessionIds.get(pubkey);
    // An UNEXPECTED drop of a joined guest during a live match keeps its slot
    // and freezes the match for everyone until it rejoins (or the host drops
    // it). An intentional leave (bye / Leave frame) removes it as before.
    if (!intentional && this.session && sessionId !== undefined
        && this.session.guestList().some((g) => g.id === sessionId)
        && !this.session.finished) {
      this.links.delete(pubkey);
      this.linkSessionIds.delete(pubkey);
      this.pendingFrames.delete(pubkey);
      const peer = this.hostPeers.get(pubkey);
      if (peer) {
        try { peer.pc.close(); } catch { /* already closed */ }
        this.hostPeers.delete(pubkey);
      }
      this.session.suspendGuest(sessionId);
      this.pushChat({
        from: '', at: Date.now(),
        text: `${leaving?.name ?? 'A pilot'} disconnected — waiting for them to rejoin`,
        system: true,
      });
      if (this.hostingRoom) this.ensureOffers();
      void this.heartbeat();
      this.onRoom?.();
      this.emit();
      return;
    }
    if (leaving && this.hostingRoom) {
      this.pushChat({ from: '', text: `${leaving.name} left the room`, at: Date.now(), system: true });
    }
    this.links.delete(pubkey);
    this.linkSessionIds.delete(pubkey);
    this.pendingFrames.delete(pubkey);
    const peer = this.hostPeers.get(pubkey);
    if (peer) {
      try { peer.pc.close(); } catch { /* already closed */ }
      this.hostPeers.delete(pubkey);
    }
    if (this.session) {
      for (const g of this.session.guestList()) {
        if (g.pubkey === pubkey) this.session.removeGuest(g.id, false);
      }
    }
    this.pendingChannels = this.pendingChannels.filter((p) => p.pubkey !== pubkey);
    if (this.hostingRoom) {
      this.broadcastRoom();
      // A slot just freed up: publish a fresh offer for the next client.
      this.ensureOffers();
    }
    void this.heartbeat();
    this.onRoom?.();
    this.emit();
  }

  // ---------------------------------------------------------------- joining
  /**
   * Connect to a room. Browser-hosted rooms are host-offered: the host
   * publishes the SDP offer and we answer it (a `join` signal asks for a
   * fresh one). Dedicated-server rooms keep the guest-offer flow the C++
   * server implements. Either way the RTC data channel then answers the host
   * challenge. Browser rooms land in the waiting room (`guestRoom`), servers
   * hand the transport straight to GameCanvas (`pendingJoin`).
   */
  async joinRoom(room: RoomInfo, password = '', reconnect = false): Promise<RoomInfo> {
    trace('joinRoom.start', { id: room.id, host: room.host, protected: room.protected });
    if (room.raw && !verifyEvent(room.raw)) throw new Error('room event failed verification');
    const ok = await this.connect();
    if (!ok) throw new Error(this.error || 'no relay reachable');
    if (!this.pool) throw new Error('no relay');
    this.cancelJoin();
    this.error = '';
    // Host certificate: the room key must vouch for the WebRTC identity.
    let certKey: CryptoKey | null = null;
    if (room.cert) {
      if (!(await verifyHostCert(room.id, room.hostPubkey, room.cert))) {
        throw new Error('room certificate does not verify');
      }
      try {
        certKey = await importCertKey(room.cert);
      } catch {
        throw new Error('room certificate key is invalid');
      }
    }
    // Password protection: derive the signalling key locally (it is never
    // published). A wrong password shows up as undecryptable offers.
    let key: CryptoKey | null = null;
    if (room.protected) {
      if (!password) throw new Error('this room is password protected');
      if (!room.salt) throw new Error('protected room is missing its salt');
      key = await deriveKey(password, room.salt);
    }
    this.lastRoom = room;
    this.lastPassword = password;
    this.status = 'connecting to ' + room.host + '…';
    this.emit();
    if (room.srv) return this.joinServerRoom(room, certKey);
    return this.joinBrowserRoom(room, certKey, key, reconnect);
  }

  /** Guest offer -> server answer: the flow the C++ server implements. */
  private async joinServerRoom(room: RoomInfo, certKey: CryptoKey | null): Promise<RoomInfo> {
    if (!this.pool) throw new Error('no relay');
    const roomId = room.id;
    const pc = new RTCPeerConnection(iceConfig(room.ice.length ? room.ice : this.config.iceServers));
    const channel = pc.createDataChannel('game', { ordered: true });
    const transport = rtcTransport(channel);
    const sub = this.pool.subscribe('mp-sig-guest', [
      { kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [this.pubkey] },
    ], (evt) => {
      if (!verifyEvent(evt)) return;
      if (evt.pubkey !== room.hostPubkey) return;
      const msg = signalFromEvent(evt, this.pubkey, roomId);
      if (!msg) return;
      if (msg.kind === 'answer' && msg.sdp) {
        void (async () => {
          if (certKey && !(await verifyAnswer(certKey, roomId, room.hostPubkey, this.pubkey, msg.sdp!, msg.sig ?? ''))) {
            trace('joinRoom.answerRejected', 'certificate signature');
            return; // unsigned/forged answer: never negotiate with it
          }
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => undefined);
        })();
      } else if (msg.kind === 'ice') {
        for (const cand of msg.candidates ?? []) {
          void pc.addIceCandidate(cand as RTCIceCandidateInit).catch(() => undefined);
        }
      }
    });
    // Trickle our candidates to the host.
    const candidates: SignalCandidate[] = [];
    let flushTimer = 0;
    const flush = (): void => {
      flushTimer = 0;
      if (candidates.length === 0 || !this.pool) return;
      const evt = finalizeEvent(
        signalTemplate(roomId, room.hostPubkey, { kind: 'ice', candidates: candidates.splice(0) }),
        this.sk,
      );
      void this.pool.publish(evt);
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      candidates.push(candidateInit(e.candidate));
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const name = store.options.username || 'Pilot';
    const offerEvt = finalizeEvent(
      signalTemplate(roomId, room.hostPubkey, { kind: 'offer', sdp: pc.localDescription?.sdp ?? '', name }),
      this.sk,
    );
    await this.pool.publish(offerEvt);
    trace('joinRoom.offerSent', { room: room.id });
    const result = await this.awaitGuestChannel(room, pc, sub, channel, transport);
    return this.finishJoin(room, result);
  }

  /** Host offer -> our answer: the browser-hosted room flow. */
  private async joinBrowserRoom(
    room: RoomInfo, certKey: CryptoKey | null, key: CryptoKey | null, reconnect = false,
  ): Promise<RoomInfo> {
    if (!this.pool) throw new Error('no relay');
    const pool = this.pool;
    const roomId = room.id;
    const pc = new RTCPeerConnection(iceConfig(room.ice.length ? room.ice : this.config.iceServers));
    // The host creates the data channel; it arrives through ondatachannel.
    pc.ondatachannel = (e) => {
      const join = this.guestJoin;
      if (!join) return;
      this.guestAuthHandshake(room, e.channel, rtcTransport(e.channel), pc, join.resolve, join.reject);
    };
    // Trickle our candidates to the host once we have answered an offer.
    const candidates: SignalCandidate[] = [];
    let flushTimer = 0;
    const flush = (): void => {
      flushTimer = 0;
      const join = this.guestJoin;
      if (candidates.length === 0 || !join?.offerId) return;
      const offerId = join.offerId;
      const cands = candidates.splice(0);
      void (async () => {
        const body = await sealSignal(key, { kind: 'ice', offerId, candidates: cands });
        // Private signalling: our candidates go to the host as a NIP-04 DM.
        await this.sendSignalDm(room.hostPubkey, roomId, room.sid, body);
      })();
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate || !this.guestJoin?.offerId) return;
      candidates.push(candidateInit(e.candidate));
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };
    // Offers are comments under the room post; host ICE/bye arrive addressed.
    const sub = pool.subscribe('mp-sig-guest', [
      { kinds: [KIND_OFFER], '#a': [roomCoordinate(room)] },
      { kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [this.pubkey] },
    ], (evt) => void this.onGuestSignal(evt, room, certKey, key, pc));
    const result = await new Promise<GameTransport>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(room.host + ' did not answer')), JOIN_TIMEOUT_MS);
      const join: GuestJoin = {
        room, pc, sub, timer, key, certKey,
        offerId: null, tried: new Set(), lastOffer: null, answering: false, answered: false,
        pendingCandidates: [], answerTimer: 0, nudgeTimer: 0,
        resolve: () => undefined,
        reject: () => undefined,
      };
      const stop = (): void => {
        clearTimeout(timer);
        if (join.nudgeTimer) { clearInterval(join.nudgeTimer); join.nudgeTimer = 0; }
      };
      join.resolve = (t) => { stop(); resolve(t); };
      join.reject = (e) => { stop(); reject(e); };
      this.guestJoin = join;
      // Ephemeral offers are not stored: ask the host to refresh them, and
      // nudge again if we still have not answered one.
      void this.sendGuestJoin(room, key);
      join.nudgeTimer = setInterval(() => {
        const g = this.guestJoin;
        if (!g || g !== join || g.answered) return;
        void this.sendGuestJoin(join.room, join.key);
      }, 5000) as unknown as number;
    }).catch((e: unknown) => {
      trace('joinRoom.failed', String((e as Error).message));
      this.deadRooms.set(room.hostPubkey + ':' + room.id, Date.now());
      this.cancelJoin();
      this.status = '';
      this.error = (e as Error).message;
      this.emit();
      throw e as Error;
    });
    this.guestJoin = null;
    return this.finishJoin(room, result, reconnect);
  }

  /** Wait for the data channel and the host challenge (shared by both flows). */
  private async awaitGuestChannel(
    room: RoomInfo, pc: RTCPeerConnection, sub: () => void,
    channel: RTCDataChannel, transport: GameTransport,
  ): Promise<GameTransport> {
    const result = await new Promise<GameTransport>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(room.host + ' did not answer')), JOIN_TIMEOUT_MS);
      this.guest = { pc, sub, timer };
      this.joinResolve = (t) => { clearTimeout(timer); resolve(t); };
      this.joinReject = (e) => { clearTimeout(timer); reject(e); };
      this.guestAuthHandshake(room, channel, transport, pc, this.joinResolve, this.joinReject);
    }).catch((e: unknown) => {
      trace('joinRoom.failed', String((e as Error).message));
      this.deadRooms.set(room.hostPubkey + ':' + room.id, Date.now());
      this.cancelJoin();
      this.status = '';
      this.error = (e as Error).message;
      this.emit();
      throw e as Error;
    });
    this.guest = null;
    this.joinResolve = null;
    this.joinReject = null;
    return result;
  }

  /**
   * Channel challenge: prove the peer holds the room's Nostr key before any
   * game data flows. Only the host can sign our nonce.
   */
  private guestAuthHandshake(
    room: RoomInfo, channel: RTCDataChannel, transport: GameTransport, pc: RTCPeerConnection,
    resolve: (t: GameTransport) => void, reject: (e: Error) => void,
  ): void {
    let nonce = '';
    const sendAuthRequest = (): void => {
      nonce = newNonce();
      const payload = textEncoder.encode(JSON.stringify({ t: 'auth-request', pubkey: this.pubkey, nonce }));
      transport.send(encodeMessage(GameMsg.Auth, payload));
    };
    transport.onmessage = (data) => {
      void (async () => {
        try {
          const frame = await decodeMessage(data);
          if (frame.type !== GameMsg.Auth) return;
          const msg = JSON.parse(textDecoder.decode(frame.payload)) as {
            t?: string; host?: string; nonce?: string; sig?: string; reason?: string;
          };
          if (msg.t !== 'auth-ok' || msg.nonce !== nonce
              || !verifyAuth(room.hostPubkey, room.id, this.pubkey, nonce, msg.sig ?? '')) {
            trace('joinRoom.authFailed', msg.reason ?? 'bad signature');
            reject(new Error('host authentication failed'));
            return;
          }
          trace('joinRoom.authOk', null);
          resolve(tapTransport(transport, (data) => void this.onRoomFrame(data)));
        } catch {
          reject(new Error('host authentication failed'));
        }
      })();
    };
    channel.onopen = () => {
      trace('joinRoom.channelOpen', null);
      const join = this.guestJoin;
      if (join?.answerTimer) { clearTimeout(join.answerTimer); join.answerTimer = 0; }
      sendAuthRequest();
    };
    channel.onclose = () => reject(new Error('connection closed'));
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') reject(new Error('connection failed'));
    };
    if (channel.readyState === 'open') sendAuthRequest();
  }

  /** Guest: a signal from the host (offer / ICE / bye) for a browser room. */
  private async onGuestSignal(
    evt: NostrEvent, room: RoomInfo, certKey: CryptoKey | null, key: CryptoKey | null,
    pc: RTCPeerConnection,
  ): Promise<void> {
    const join = this.guestJoin;
    if (!join || join.pc !== pc) return;
    if (!verifyEvent(evt)) return;
    if (evt.pubkey !== room.hostPubkey) return;
    // Offers are stored comments under the room post.
    const offer = offerFromEvent(evt, room);
    if (offer) {
      // Reconnect cleanup: ignore offers from another host session.
      if (offer.sid && room.sid && offer.sid !== room.sid) return;
      // Always remember the newest offer so a retry can answer it again.
      join.lastOffer = offer;
      if (join.answered || join.answering) return;
      const offerId = offer.offerId ?? '';
      if (offerId && join.tried.has(offerId)) return;
      await this.tryAnswerOffer(join, offer);
      return;
    }
    // Everything else (host ICE, bye) is addressed to us.
    const msg = signalFromEvent(evt, this.pubkey, room.id);
    if (!msg) return;
    if (msg.sid && room.sid && msg.sid !== room.sid) return;
    if (msg.kind === 'ice') {
      const body = await openSignal(key, msg);
      if (!body) return;
      const cands = body.candidates ?? [];
      if (!join.answered) { join.pendingCandidates.push(...cands); return; }
      for (const c of cands) void pc.addIceCandidate(c as RTCIceCandidateInit).catch(() => undefined);
      return;
    }
    if (msg.kind === 'bye') {
      join.reject(new Error('the host closed the room'));
    }
  }

  /** Guest: verify a host offer and answer it (published sealed if needed). */
  private async tryAnswerOffer(join: GuestJoin, msg: SignalMessage): Promise<void> {
    const room = join.room;
    const body = await openSignal(join.key, msg);
    if (!body || !body.sdp) {
      // Only the host can sign (and seal) this offer; failing to open it on a
      // protected room means the password was wrong.
      if (room.protected) {
        trace('joinRoom.offerUndecryptable', null);
        join.reject(new Error('wrong room password'));
      }
      return;
    }
    const offerId = msg.offerId ?? '';
    // The offer SDP carries the DTLS fingerprint: verify the host signed it.
    if (join.certKey
        && !(await verifyAnswer(join.certKey, room.id, room.hostPubkey, '', body.sdp, body.sig ?? ''))) {
      trace('joinRoom.offerRejected', 'certificate signature');
      return;
    }
    join.answering = true;
    if (offerId) join.tried.add(offerId);
    try {
      await join.pc.setRemoteDescription({ type: 'offer', sdp: body.sdp });
      const answer = await join.pc.createAnswer();
      // Set the offer id before the local description so trickled candidates
      // are tagged with it from the very first one.
      join.offerId = offerId;
      await join.pc.setLocalDescription(answer);
      join.answered = true;
      join.answering = false;
      // If another guest took this slot the channel never opens: try again.
      join.answerTimer = setTimeout(() => this.retryGuestOffer(), OFFER_ANSWER_TIMEOUT_MS);
      const outBody = await sealSignal(join.key, {
        kind: 'answer', offerId, sdp: join.pc.localDescription?.sdp ?? '', name: this.identityName(),
      });
      // Private signalling: the SDP answer goes to the host as a NIP-04 DM, so
      // it is never published on a public KIND_SIGNAL event.
      await this.sendSignalDm(room.hostPubkey, room.id, room.sid, outBody);
      for (const c of join.pendingCandidates.splice(0)) {
        void join.pc.addIceCandidate(c as RTCIceCandidateInit).catch(() => undefined);
      }
    } catch {
      join.answering = false;
    }
  }

  /** Ask the host for a fresh offer (ephemeral relays do not store them). */
  private async sendGuestJoin(room: RoomInfo, key: CryptoKey | null): Promise<void> {
    if (!this.pool) return;
    const body = await sealSignal(key, { kind: 'join', name: this.identityName() });
    const evt = finalizeEvent(signalTemplate(room.id, room.hostPubkey, { sid: room.sid, ...body }), this.sk);
    await this.pool.publish(evt);
  }

  /**
   * Guest: send an answer / ICE to the host as a NIP-04 DM. The body is the
   * same sealed SignalMessage the public flow carried; only the transport
   * differs (encrypted and addressed to the host instead of a public event).
   */
  private async sendSignalDm(
    to: string, roomId: string, sid: string | undefined,
    body: Omit<SignalMessage, 'v' | 'room' | 'to'>,
  ): Promise<void> {
    const msg: SignalMessage = { v: MP_PROTOCOL, room: roomId, to, ...(sid ? { sid } : {}), ...body };
    await this.sendDm(to, JSON.stringify(msg));
  }

  /** A host offer did not connect: re-answer the newest one / ask for more. */
  private retryGuestOffer(): void {
    const join = this.guestJoin;
    if (!join) return;
    trace('joinRoom.retryOffer', { tried: join.tried.size });
    join.answered = false;
    join.answering = false;
    join.offerId = null;
    if (join.answerTimer) { clearTimeout(join.answerTimer); join.answerTimer = 0; }
    // Ask the host to republish (a fresh offer for the next client) and try
    // the newest offer we have seen.
    void this.sendGuestJoin(join.room, join.key);
    if (join.lastOffer) void this.tryAnswerOffer(join, join.lastOffer);
  }

  /** Guest: hand the ready transport to the waiting room or the match. */
  private finishJoin(room: RoomInfo, result: GameTransport, reconnect = false): RoomInfo {
    this.status = '';
    trace('joinRoom.ready', { id: room.id, srv: room.srv, reconnect });
    const hello = textEncoder.encode(JSON.stringify({ t: 'hello', name: this.identityName(), lud16: getWallet()?.lud16 ?? '' }));
    result.send(encodeMessage(GameMsg.Room, hello));
    if (room.srv || reconnect) {
      // Dedicated server rooms start immediately; a reconnect goes straight
      // back into the running match (no waiting room).
      this.pendingJoin = { room, transport: result };
    } else {
      this.guestRoom = {
        info: room,
        transport: result,
        you: 0,
        players: [],
        teams: [],
        phase: 'waiting',
        betAmount: 0,
        betAccepted: false,
        betError: '',
      };
      this.chat = [];
      this.guestBetAccepted = false;
      this.betError = '';
    }
    this.emit();
    this.onRoom?.();
    return room;
  }

  /** Guest: host -> client waiting-room messages (chat, roster, start). */
  private handleGuestRoomMessage(msg: {
    t?: string; level?: string; title?: string; max?: number; phase?: 'waiting' | 'playing';
    you?: number; players?: RoomPlayerInfo[]; teams?: string[];
    from?: string; text?: string; system?: boolean;
    /** Host-set escrowed bet amount and its last bank error. */
    bet?: number; betError?: string;
    /** Network pause: the host is waiting for a disconnected guest. */
    paused?: boolean; name?: string;
    /** Post-match bet settlement broadcast by the host. */
    voided?: boolean; losers?: string[]; winners?: { pubkey: string; lud16: string }[];
    perWinner?: number;
  }): void {
    const room = this.guestRoom;
    switch (msg.t) {
      case 'paused':
        this.netPaused = msg.paused === true;
        this.netPausedBy = typeof msg.name === 'string' ? msg.name : '';
        this.onNetPause?.();
        this.emit();
        return;
      case 'state':
        if (!room) return;
        room.you = typeof msg.you === 'number' ? msg.you : room.you;
        room.players = Array.isArray(msg.players) ? msg.players : room.players;
        room.teams = Array.isArray(msg.teams) && msg.teams.length > 0 ? msg.teams : room.teams;
        room.phase = msg.phase === 'playing' ? 'playing' : 'waiting';
        room.betAmount = typeof msg.bet === 'number' ? msg.bet : room.betAmount;
        room.betError = typeof msg.betError === 'string' ? msg.betError : '';
        this.guestBetAccepted = room.players[room.you]?.betAccepted === true;
        this.roster = room.players;
        this.roomTeams = room.teams;
        this.roomPhase = room.phase;
        this.betError = room.betError;
        this.onRoom?.();
        this.emit();
        return;
      case 'chat':
        if (typeof msg.text !== 'string') return;
        this.chat.push({
          from: typeof msg.from === 'string' ? msg.from : '',
          text: msg.text,
          at: Date.now(),
          system: msg.system === true,
        });
        if (this.chat.length > 200) this.chat.shift();
        this.onRoom?.();
        return;
      case 'start': {
        if (!room) return;
        room.phase = 'playing';
        this.roomPhase = 'playing';
        // The bet is settled AFTER the match (no escrow): nothing to lock here.
        // Hand the ready transport to GameCanvas (the scene rebuild consumes it).
        this.pendingJoin = { room: room.info, transport: room.transport };
        this.onRoom?.();
        this.onStart?.(msg.level ?? room.info.game);
        return;
      }
      case 'settle':
        if (msg.voided === true) {
          this.betSettlement = { winners: [], losers: [], perWinner: 0, voided: true };
          this.betError = 'bet voided';
          this.onRoom?.();
          return;
        }
        this.betSettlement = {
          winners: Array.isArray(msg.winners) ? msg.winners : [],
          losers: Array.isArray(msg.losers) ? msg.losers : [],
          perWinner: typeof msg.perWinner === 'number' ? msg.perWinner : 0,
          voided: false,
        };
        if (this.betSettlement.losers.includes(this.pubkey)) {
          void this.payBetWinners(this.betSettlement.winners, this.betSettlement.perWinner);
        }
        this.onRoom?.();
        this.emit();
        return;
      case 'closed':
        this.error = 'the host closed the room';
        this.guestRoom = null;
        this.roster = [];
        this.chat = [];
        this.onRoom?.();
        this.emit();
        return;
      default:
        return;
    }
  }

  /** Cheap frame-type peek so game frames are not decoded twice. */
  private roomFrameType(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (bytes.length < 8) return -1;
    return bytes[2] | (bytes[3] << 8);
  }

  /** Guest: incoming frames — room control/voice are ours, the rest is NetGame's. */
  private async onRoomFrame(data: ArrayBuffer | Uint8Array): Promise<void> {
    const type = this.roomFrameType(data);
    if (type !== GameMsg.Voice && type !== GameMsg.Room) return;
    let frame;
    try {
      frame = await decodeMessage(data);
    } catch {
      return;
    }
    if (frame.type === GameMsg.Voice) {
      const voice = decodeVoiceFrame(frame.payload);
      if (voice) this.onVoice?.(voice.speaker, voice.pcm);
      return;
    }
    try {
      this.handleGuestRoomMessage(JSON.parse(textDecoder.decode(frame.payload)));
    } catch {
      /* malformed room message: ignore */
    }
  }

  cancelJoin(): void {
    if (this.guest) {
      try { this.guest.pc.close(); } catch { /* already closed */ }
      this.guest.sub();
      clearTimeout(this.guest.timer);
      this.guest = null;
    }
    if (this.guestJoin) {
      try { this.guestJoin.pc.close(); } catch { /* already closed */ }
      this.guestJoin.sub();
      clearTimeout(this.guestJoin.timer);
      if (this.guestJoin.answerTimer) clearTimeout(this.guestJoin.answerTimer);
      if (this.guestJoin.nudgeTimer) clearInterval(this.guestJoin.nudgeTimer);
      this.guestJoin = null;
    }
    this.joinResolve = null;
    this.joinReject = null;
    this.status = '';
    this.emit();
  }

  /** GameCanvas: the transport prepared by joinRoom (consumed once). */
  consumeJoin(): JoinIntent | null {
    const intent = this.pendingJoin;
    this.pendingJoin = null;
    return intent;
  }

  /** Announce a clean exit to the host (best effort) and drop the session. */
  leaveGuest(): void {
    this.leaveGuestRoom();
  }
}

/** Debug trace of the manager's session state machine (tests/diagnostics). */
type MpTraceEntry = [string, number, unknown];
const mpTrace: MpTraceEntry[] = [];
export function mpTraceEntries(): MpTraceEntry[] {
  return mpTrace;
}
function trace(what: string, detail: unknown): void {
  mpTrace.push([what, Date.now(), detail]);
  if (mpTrace.length > 60) mpTrace.shift();
}

/** Same trace, from outside the manager (the lobby view's join button). */
export function mpTraceMark(what: string, detail?: unknown): void {
  trace(what, detail ?? null);
}

export const mp = new Multiplayer();

// Debug hook (same pattern as __ieGame/__ieRenderer): the lobby and the
// multiplayer e2e tooling inspect the manager through this.
if (typeof window !== 'undefined') {
  (window as unknown as { __ieMP?: Multiplayer }).__ieMP = mp;
  (window as unknown as { __ieMPTrace?: () => MpTraceEntry[] }).__ieMPTrace = mpTraceEntries;
}
