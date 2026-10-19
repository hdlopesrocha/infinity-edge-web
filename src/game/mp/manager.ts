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
// room list and calls createRoom/joinRoom/deleteRoom.

import {
  candidateInit, finalizeEvent, KIND_DELETE, KIND_ROOM, KIND_SIGNAL, newRoomId, roomFromEvent,
  roomTemplate, signalFromEvent, signalTemplate, verifyEvent, deletionTemplate, TAG_ROOM,
} from '../nostr/event';
import type { NostrEvent, RoomContent, RoomInfo, SignalCandidate, SignalMessage } from '../nostr/event';
import { RelayPool } from '../nostr/relay';
import { bytesToHex, hexToBytes, randomBytes, schnorrPubkey, validSecretKey } from '../nostr/crypto';
import { npubEncode } from '../nostr/bech32';
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
import { HostSession } from './host';
import type { GuestSummary } from './host';
import type { GameInstance } from '../instance';
import { store } from '../store';

const CONFIG_KEY = 'ie.mp.config';
const IDENTITY_KEY = 'ie.mp.identity';
const RELAY_DEFAULTS = ['wss://nos.lol', 'wss://relay.snort.social'];
const ICE_DEFAULTS = ['stun:stun.l.google.com:19302'];
/** Room events expire (NIP-40) unless the host keeps heartbeating. */
const ROOM_TTL_SEC = 30 * 60;
const HEARTBEAT_MS = 4 * 60 * 1000;
/** How long a guest waits for the host's answer + data channel. */
const JOIN_TIMEOUT_MS = 30000;
/** Age filter choices (hours); 6 h is the default. */
export const MAX_AGE_CHOICES = [1, 3, 6, 12, 24];

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
  /** Teams the level offers (host loads the level, guests get them in state). */
  teams: string[];
  players: RoomPlayerInfo[];
  meIndex: number;
  isHost: boolean;
  phase: 'waiting' | 'playing';
  chat: ChatLine[];
  micOn: boolean;
  status: string;
}

/** Host-side per-guest link. */
interface GuestLink {
  name: string;
  transport: GameTransport;
  authed: boolean;
  team: string;
  mic: boolean;
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
}

/** One guest's peer connection on the host side. */
interface HostPeer {
  pc: RTCPeerConnection;
  name: string;
  channel: RTCDataChannel | null;
  /** Candidates that arrived before the remote description was set. */
  pendingCandidates: SignalCandidate[];
  answerSent: boolean;
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

export class Multiplayer {
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

  /** Room/identity public key, derived once from the stored secret key. */
  readonly pubkeyHex: string;
  private sk: Uint8Array;
  private pool: RelayPool | null = null;
  private roomsSub: (() => void) | null = null;
  private roomRevisions = new Map<string, RoomInfo>();
  private filterTimer = 0;

  // Hosting.
  private hostingRoom: RoomInfo | null = null;
  private hostPeers = new Map<string, HostPeer>();
  private pendingChannels: { pubkey: string; name: string; transport: GameTransport; team: string }[] = [];
  private session: HostSession | null = null;
  private heartTimer = 0;
  private sigSub: (() => void) | null = null;

  // Joining.
  private guest: { pc: RTCPeerConnection; sub: () => void; timer: number } | null = null;
  private joinResolve: ((t: GameTransport) => void) | null = null;
  private joinReject: ((e: Error) => void) | null = null;
  private pendingJoin: JoinIntent | null = null;
  private hostIntent: RoomInfo | null = null;
  private guestRoom: GuestRoom | null = null;

  // Waiting room (host and guest).
  private roster: RoomPlayerInfo[] = [];
  private chat: ChatLine[] = [];
  private roomPhase: 'waiting' | 'playing' = 'waiting';
  private roomTeams: string[] = [];
  private roomTeamsFor = '';
  private hostTeam = '';
  private micOn = false;

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

  /** Nickname shown in the lobby and sent with room/signalling events. */
  identityName(): string {
    return store.options.username || 'Pilot';
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

  /** Guest: leave the waiting room (or the match) and tell the host. */
  leaveGuestRoom(): void {
    const room = this.guestRoom?.info ?? null;
    if (room && this.pool) {
      const evt = finalizeEvent(signalTemplate(room.id, room.hostPubkey, { kind: 'bye' }), this.sk);
      void this.pool.publish(evt);
    }
    try { this.guestRoom?.transport.close(); } catch { /* already closed */ }
    this.guestRoom = null;
    this.roster = [];
    this.chat = [];
    this.roomPhase = 'waiting';
    this.cancelJoin();
    this.onRoom?.();
    this.emit();
  }

  // ------------------------------------------------------------ relay pool
  /** Opens the relays (idempotent) and starts the room subscription. */
  async connect(): Promise<boolean> {
    if (this.online) return true;
    if (!this.pool) {
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
    this.roomsSub = this.pool.subscribe('mp-rooms', [
      { kinds: [KIND_ROOM, KIND_DELETE], '#t': [TAG_ROOM], since, limit: 200 },
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

  // ---------------------------------------------------------------- hosting
  /**
   * Publish a room and start hosting. The match itself is started by the app
   * (the lobby navigates to the level, GameCanvas calls attachHost).
   */
  async createRoom(opts: { game: string; type: string; title: string; maxPlayers: number }): Promise<RoomInfo> {
    const ok = await this.connect();
    if (!ok) throw new Error(this.error || 'no relay reachable');
    this.endSession();
    const id = newRoomId();
    const bundle = await createHostCert(id, this.pubkey, this.sk);
    this.hostCert = bundle.cert;
    this.hostCertKey = bundle.privateKey;
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
    };
    const room = await this.publishRoom(id, content);
    this.hostingRoom = room;
    // Waiting room: the match only starts when the host presses PLAY.
    this.roomPhase = 'waiting';
    this.chat = [];
    this.roster = [{ name: content.host, pubkey: this.pubkey, team: '', mic: false, host: true }];
    this.hostTeam = '';
    void this.loadTeams(opts.game);
    this.subscribeSignals();
    this.heartTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
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
      this.roomTeams = names.length > 0 ? names : ['human'];
    } catch {
      this.roomTeams = ['human'];
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
    // The waiting room's team picks travel into the match: the host's own team
    // now, every guest's team when it sends Join.
    this.session = new HostSession(gi, this.hostTeam || '');
    this.session.onGuests = (list) => {
      this.onGuests?.(list);
      void this.heartbeat();
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
    const peers = [...this.hostPeers.values()];
    const pending = this.pendingChannels.splice(0);
    this.session = null;
    this.hostPeers.clear();
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
    this.roster = [];
    this.chat = [];
    this.roomPhase = 'waiting';
    const room = this.hostingRoom;
    this.hostingRoom = null;
    this.hostIntent = null;
    if (room && this.pool && room.hostPubkey === this.pubkey) {
      // Close the room publicly so nobody sees a stale listing.
      const evt = finalizeEvent(deletionTemplate({ id: room.id, hostPubkey: room.hostPubkey }), this.sk);
      void this.pool.publish(evt);
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
      ? [{ name: info.host, pubkey: this.pubkey, team: this.hostTeam, mic: this.micOn, host: true },
          ...[...this.links.values()].filter((l) => l.authed).map((l) => ({
            name: l.name, pubkey: '', team: l.team, mic: l.mic, host: false,
          }))]
      : this.roster;
    return {
      roomId: info.id,
      level: info.game,
      title: info.title,
      maxPlayers: info.maxPlayers,
      teams: this.roomTeams,
      players,
      meIndex: this.hostingRoom ? 0 : (this.guestRoom?.you ?? 0),
      isHost: !!this.hostingRoom,
      phase: this.roomPhase,
      chat: this.chat,
      micOn: this.micOn,
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

  /** Host: start the match (the guests are told and follow). */
  startMatch(): string | null {
    if (!this.hostingRoom) return null;
    this.roomPhase = 'playing';
    const payload = textEncoder.encode(JSON.stringify({ t: 'start', level: this.hostingRoom.game }));
    for (const link of this.links.values()) if (link.authed) link.transport.send(encodeMessage(GameMsg.Room, payload));
    // GameCanvas consumes this when it builds the level for the match.
    this.hostIntent = this.hostingRoom;
    this.onRoom?.();
    this.emit();
    return this.hostingRoom.game;
  }

  /** Host: close the room and drop everyone (back from the room menu). */
  closeRoom(): void {
    this.endSession();
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

  // ------------------------------------------------------------- signalling
  private subscribeSignals(): void {
    if (!this.pool || !this.hostingRoom) return;
    const roomId = this.hostingRoom.id;
    this.sigSub = this.pool.subscribe('mp-sig-host', [
      { kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [this.pubkey] },
    ], (evt) => void this.onSignal(evt, roomId));
  }

  private async onSignal(evt: NostrEvent, roomId: string): Promise<void> {
    if (!verifyEvent(evt)) return;
    const msg = signalFromEvent(evt, this.pubkey, roomId);
    if (!msg) return;
    if (msg.kind === 'offer' && msg.sdp) {
      await this.acceptOffer(evt, msg);
      return;
    }
    if (msg.kind === 'ice') {
      const peer = this.hostPeers.get(evt.pubkey);
      if (!peer) return;
      for (const cand of msg.candidates ?? []) {
        try {
          if (peer.answerSent) await peer.pc.addIceCandidate(cand as RTCIceCandidateInit);
          else peer.pendingCandidates.push(cand);
        } catch { /* a bad candidate must not kill the call */ }
      }
      return;
    }
    if (msg.kind === 'bye') {
      const peer = this.hostPeers.get(evt.pubkey);
      if (peer) {
        try { peer.pc.close(); } catch { /* already closed */ }
        this.hostPeers.delete(evt.pubkey);
      }
      return;
    }
  }

  private async acceptOffer(evt: NostrEvent, msg: SignalMessage): Promise<void> {
    trace('acceptOffer', { from: evt.pubkey.slice(0, 8), hosting: !!this.hostingRoom });
    if (!this.hostingRoom || !this.pool) return;
    const pubkey = evt.pubkey;
    if (this.hostPeers.has(pubkey)) return; // one connection per guest
    // Waiting-room guests count too: the session is only attached on PLAY.
    if (this.links.size >= this.hostingRoom.maxPlayers - 1) {
      return; // room is full: no answer, the guest times out
    }
    if (this.hostPeers.size >= this.hostingRoom.maxPlayers) {
      return; // hardening: cap half-open handshakes as well
    }
    const peer: HostPeer = {
      pc: new RTCPeerConnection(iceConfig(this.hostingRoom.ice.length ? this.hostingRoom.ice : this.config.iceServers)),
      name: msg.name || 'Pilot',
      channel: null,
      pendingCandidates: [],
      answerSent: false,
    };
    this.hostPeers.set(pubkey, peer);
    const roomId = this.hostingRoom.id;
    const candidates: SignalCandidate[] = [];
    let flushTimer = 0;
    const flush = (): void => {
      flushTimer = 0;
      if (candidates.length === 0 || !this.pool) return;
      const evtOut = finalizeEvent(
        signalTemplate(roomId, pubkey, { kind: 'ice', candidates: candidates.splice(0) }),
        this.sk,
      );
      void this.pool.publish(evtOut);
    };
    peer.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      candidates.push(candidateInit(e.candidate));
      if (!flushTimer) flushTimer = setTimeout(flush, 250);
    };
    peer.pc.ondatachannel = (e) => {
      trace('host.dataChannel', { guest: pubkey.slice(0, 8) });
      peer.channel = e.channel;
      const transport = rtcTransport(e.channel);
      // Every channel goes through the challenge gate first: it becomes a
      // guest of the waiting room (and later of the match) once authenticated.
      this.addGuestChannel(pubkey, peer.name, transport);
      e.channel.onclose = () => this.dropPeer(pubkey);
    };
    peer.pc.onconnectionstatechange = () => {
      const st = peer.pc.connectionState;
      if (st === 'failed' || st === 'closed') this.dropPeer(pubkey);
    };
    // A handshake that never opens a channel must not linger forever.
    setTimeout(() => {
      const current = this.hostPeers.get(pubkey);
      if (current === peer && !current.channel) this.dropPeer(pubkey);
    }, 30000);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      for (const cand of peer.pendingCandidates.splice(0)) {
        try { await peer.pc.addIceCandidate(cand as RTCIceCandidateInit); } catch { /* ignore */ }
      }
      peer.answerSent = true;
      const answerSdp = peer.pc.localDescription?.sdp ?? '';
      // Sign the answer SDP (it carries the DTLS fingerprint) with the room
      // certificate's key: the guest refuses answers it cannot verify.
      const answerSig = this.hostCert && this.hostCertKey
        ? await signAnswer(this.hostCertKey, roomId, this.pubkey, pubkey, answerSdp)
        : undefined;
      trace('host.answerSigned', { len: answerSig?.length ?? 0 });
      const out = finalizeEvent(
        signalTemplate(roomId, pubkey, { kind: 'answer', sdp: answerSdp, sig: answerSig }),
        this.sk,
      );
      await this.pool.publish(out);
    } catch {
      this.dropPeer(pubkey);
    }
  }

  private addGuestChannel(pubkey: string, name: string, transport: GameTransport): void {
    // The channel stays closed to game traffic until it answers the host
    // challenge: only then is it a guest the session may talk to.
    this.links.set(pubkey, { name, transport, authed: false, team: '', mic: false });
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
    let msg: { t?: string; text?: string; team?: string; on?: boolean };
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
    if (msg.t === 'hello') {
      this.broadcastRoom();
    }
  }

  private attachGuest(pubkey: string, name: string, transport: GameTransport, team = ''): void {
    if (!this.session) {
      this.pendingChannels.push({ pubkey, name, transport, team });
      return;
    }
    const id = this.session.addGuest({ pubkey, name, transport, team });
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
  }

  // ------------------------------------------------------------- waiting room
  /** Per-guest state snapshot (the `you` index differs for every guest). */
  private roomStatePayload(you: number): Uint8Array {
    const info = this.hostingRoom;
    const players: RoomPlayerInfo[] = info
      ? [{ name: info.host, pubkey: this.pubkey, team: this.hostTeam, mic: this.micOn, host: true },
          ...[...this.links.entries()].filter(([, l]) => l.authed).map(([pubkey, l]) => ({
            name: l.name, pubkey, team: l.team, mic: l.mic, host: false,
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

  private dropPeer(pubkey: string): void {
    const leaving = this.links.get(pubkey);
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
    if (this.hostingRoom) this.broadcastRoom();
    void this.heartbeat();
    this.onRoom?.();
    this.emit();
  }

  // ---------------------------------------------------------------- joining
  /**
   * Connect to a room: offer/answer + ICE over the relays, then the RTC data
   * channel and the host challenge. Browser-hosted rooms land in the waiting
   * room (`guestRoom`, the /room screen); dedicated servers hand the transport
   * straight to GameCanvas (`pendingJoin`).
   */
  async joinRoom(room: RoomInfo): Promise<RoomInfo> {
    trace('joinRoom.start', { id: room.id, host: room.host });
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
    this.status = 'connecting to ' + room.host + '…';
    this.emit();
    const pc = new RTCPeerConnection(iceConfig(room.ice.length ? room.ice : this.config.iceServers));
    const channel = pc.createDataChannel('game', { ordered: true });
    const transport = rtcTransport(channel);
    const roomId = room.id;
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

    const result = await new Promise<GameTransport>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(room.host + ' did not answer'));
      }, JOIN_TIMEOUT_MS);
      this.guest = { pc, sub, timer };
      this.joinResolve = (t) => {
        clearTimeout(timer);
        resolve(t);
      };
      this.joinReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      // Host authentication: prove the peer holds the room's Nostr key before
      // any game data flows. Only the host can sign our nonce.
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
                || !verifyAuth(room.hostPubkey, roomId, this.pubkey, nonce, msg.sig ?? '')) {
              trace('joinRoom.authFailed', msg.reason ?? 'bad signature');
              this.joinReject?.(new Error('host authentication failed'));
              return;
            }
            trace('joinRoom.authOk', null);
            const proxy = tapTransport(transport, (data) => void this.onRoomFrame(data));
            this.joinResolve?.(proxy);
          } catch {
            this.joinReject?.(new Error('host authentication failed'));
          }
        })();
      };
      channel.onopen = () => {
        trace('joinRoom.channelOpen', null);
        sendAuthRequest();
      };
      channel.onclose = () => {
        this.joinReject?.(new Error('connection closed'));
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'failed') this.joinReject?.(new Error('connection failed'));
      };
      if (channel.readyState === 'open') sendAuthRequest();
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
    this.status = '';
    trace('joinRoom.ready', { id: room.id, srv: room.srv });
    const hello = textEncoder.encode(JSON.stringify({ t: 'hello', name: this.identityName() }));
    result.send(encodeMessage(GameMsg.Room, hello));
    if (room.srv) {
      // Dedicated server rooms start immediately: no waiting room.
      this.pendingJoin = { room, transport: result };
    } else {
      this.guestRoom = {
        info: room,
        transport: result,
        you: 0,
        players: [],
        teams: [],
        phase: 'waiting',
      };
      this.chat = [];
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
  }): void {
    const room = this.guestRoom;
    switch (msg.t) {
      case 'state':
        if (!room) return;
        room.you = typeof msg.you === 'number' ? msg.you : room.you;
        room.players = Array.isArray(msg.players) ? msg.players : room.players;
        room.teams = Array.isArray(msg.teams) && msg.teams.length > 0 ? msg.teams : room.teams;
        room.phase = msg.phase === 'playing' ? 'playing' : 'waiting';
        this.roster = room.players;
        this.roomTeams = room.teams;
        this.roomPhase = room.phase;
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
        // Hand the ready transport to GameCanvas (the scene rebuild consumes it).
        this.pendingJoin = { room: room.info, transport: room.transport };
        this.onRoom?.();
        this.onStart?.(msg.level ?? room.info.game);
        return;
      }
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
