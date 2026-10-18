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
  private pendingChannels: { pubkey: string; name: string; transport: GameTransport }[] = [];
  private session: HostSession | null = null;
  private heartTimer = 0;
  private sigSub: (() => void) | null = null;

  // Joining.
  private guest: { pc: RTCPeerConnection; sub: () => void; timer: number } | null = null;
  private joinResolve: ((t: GameTransport) => void) | null = null;
  private joinReject: ((e: Error) => void) | null = null;
  private pendingJoin: JoinIntent | null = null;
  private hostIntent: RoomInfo | null = null;

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
    return this.pendingJoin?.room ?? null;
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
    };
    const room = await this.publishRoom(id, content);
    this.hostingRoom = room;
    this.subscribeSignals();
    this.heartTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
    this.hostIntent = room;
    this.emit();
    return room;
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
      const players = 1 + (this.session?.guestCount ?? 0);
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
    this.session = new HostSession(gi);
    this.session.onGuests = (list) => {
      this.onGuests?.(list);
      void this.heartbeat();
      this.emit();
    };
    for (const pending of this.pendingChannels.splice(0)) {
      this.addGuestChannel(pending.pubkey, pending.name, pending.transport);
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
    if (keepRoom) {
      // The room carries on (a match is being rebuilt for it): keep the
      // signalling subscription, the heartbeat and the listing alive.
      if (this.hostingRoom) {
        this.heartTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
      }
      this.emit();
      return;
    }
    this.sigSub?.();
    this.sigSub = null;
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

  /** True while a hosted match is streaming to its guests. */
  get sessionActive(): boolean {
    return this.session !== null;
  }

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
    if ((this.session?.guestCount ?? 0) >= this.hostingRoom.maxPlayers - 1) {
      return; // room is full: no answer, the guest times out
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
      if (this.session) this.addGuestChannel(pubkey, peer.name, transport);
      else this.pendingChannels.push({ pubkey, name: peer.name, transport });
      e.channel.onclose = () => this.dropPeer(pubkey);
    };
    peer.pc.onconnectionstatechange = () => {
      const st = peer.pc.connectionState;
      if (st === 'failed' || st === 'closed') this.dropPeer(pubkey);
    };
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      for (const cand of peer.pendingCandidates.splice(0)) {
        try { await peer.pc.addIceCandidate(cand as RTCIceCandidateInit); } catch { /* ignore */ }
      }
      peer.answerSent = true;
      const out = finalizeEvent(
        signalTemplate(roomId, pubkey, { kind: 'answer', sdp: peer.pc.localDescription?.sdp ?? '' }),
        this.sk,
      );
      await this.pool.publish(out);
    } catch {
      this.dropPeer(pubkey);
    }
  }

  private addGuestChannel(pubkey: string, name: string, transport: GameTransport): void {
    if (!this.session) {
      this.pendingChannels.push({ pubkey, name, transport });
      return;
    }
    const id = this.session.addGuest({ pubkey, name, transport });
    transport.onmessage = (data) => void this.session?.handleFrame(id, data);
    transport.onclose = () => this.dropPeer(pubkey);
  }

  private dropPeer(pubkey: string): void {
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
    void this.heartbeat();
    this.emit();
  }

  // ---------------------------------------------------------------- joining
  /**
   * Connect to a room: offer/answer + ICE over the relays, then the RTC data
   * channel. Resolves with a ready transport (GameCanvas passes it to
   * NetGame.openTransport).
   */
  async joinRoom(room: RoomInfo): Promise<JoinIntent> {
    trace('joinRoom.start', { id: room.id, host: room.host });
    if (room.raw && !verifyEvent(room.raw)) throw new Error('room event failed verification');
    const ok = await this.connect();
    if (!ok) throw new Error(this.error || 'no relay reachable');
    if (!this.pool) throw new Error('no relay');
    this.cancelJoin();
    this.error = '';
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
        void pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => undefined);
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
      channel.onopen = () => {
        trace('joinRoom.channelOpen', null);
        this.joinResolve?.(transport);
      };
      channel.onclose = () => {
        this.joinReject?.(new Error('connection closed'));
      };
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === 'failed') this.joinReject?.(new Error('connection failed'));
      };
      if (channel.readyState === 'open') this.joinResolve?.(transport);
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
    const intent: JoinIntent = { room, transport: result };
    this.pendingJoin = intent;
    trace('joinRoom.ready', { id: room.id });
    this.emit();
    return intent;
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
    const room = this.guestSession;
    if (room && this.pool) {
      const evt = finalizeEvent(signalTemplate(room.id, room.hostPubkey, { kind: 'bye' }), this.sk);
      void this.pool.publish(evt);
    }
    this.cancelJoin();
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
