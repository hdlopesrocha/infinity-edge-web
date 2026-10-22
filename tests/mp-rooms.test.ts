// Multiplayer room lifecycle over a local relay: publishing, listing, age
// filtering, deletion (creator only) and signalling addressing. The local
// relay (tools/relay.mjs) runs in-process; the client uses the same RelayPool
// and Multiplayer code the browser does.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startRelay } from '../tools/relay.mjs';
import { Multiplayer } from '../src/game/mp/manager';
import { RelayPool } from '../src/game/nostr/relay';
import {
  finalizeEvent, signalFromEvent, signalTemplate, roomTemplate, tagValues,
  KIND_SIGNAL, MP_PROTOCOL, roomFromEvent, TAG_OFFER,
} from '../src/game/nostr/event';
import type { NostrEvent } from '../src/game/nostr/event';
import type { DmMessage } from '../src/game/nostr/dm';
import { randomBytes, bytesToHex, schnorrPubkey } from '../src/game/nostr/crypto';
import { deriveKey, openSignal } from '../src/game/mp/crypto';

let relay: { port: number; url: string; close: () => Promise<void> };

beforeAll(async () => {
  relay = await startRelay();
});

afterAll(async () => {
  await relay.close();
});

function instance(): Multiplayer {
  const mp = new Multiplayer();
  mp.configure({ relays: [relay.url], iceServers: [] });
  mp.onChange = () => undefined;
  return mp;
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('multiplayer rooms (local relay)', () => {
  it('creates a bookable room and lists it for everyone', async () => {
    const host = instance();
    const other = instance();
    await host.createRoom({ game: 'ctf-easy', type: 'CTF', title: 'Capture the Flag - Easy', maxPlayers: 8 });
    expect(host.hosting).not.toBeNull();
    expect(host.hosting!.id).toMatch(/^[0-9a-f]{24}$/);
    await other.connect();
    await waitFor(() => other.rooms.some((r) => r.id === host.hosting!.id));
    const seen = other.rooms.find((r) => r.id === host.hosting!.id)!;
    expect(seen.game).toBe('ctf-easy');
    expect(seen.type).toBe('CTF');
    expect(seen.hostPubkey).toBe(host.pubkey);
    expect(seen.hostPubkey).toBe(host.pubkeyHex);
    expect(seen.players).toBe(1);
    expect(seen.maxPlayers).toBe(8);
    // The owner sees it too, flagged by the same public key.
    await waitFor(() => host.rooms.some((r) => r.id === seen.id));
    host.endSession();
    other.close();
    host.close();
  });

  it('only the creator can delete a room', async () => {
    const host = instance();
    const other = instance();
    const room = await host.createRoom({ game: 'kots-solo-easy', type: 'KOTS', title: 'King', maxPlayers: 4 });
    await other.connect();
    await waitFor(() => other.rooms.some((r) => r.id === room.id));
    const asSeenByOther = other.rooms.find((r) => r.id === room.id)!;
    // A foreign deletion is a no-op for us and leaves the listing intact.
    await other.deleteRoom(asSeenByOther);
    expect(other.rooms.some((r) => r.id === room.id)).toBe(true);
    // The creator's deletion removes it from the host's list right away; other
    // clients drop it when they refresh (relays do not fan deletions out).
    await host.deleteRoom(room);
    expect(host.rooms.some((r) => r.id === room.id)).toBe(false);
    other.refreshRooms();
    await waitFor(() => !other.rooms.some((r) => r.id === room.id));
    expect(host.hosting).toBeNull();
    other.close();
    host.close();
  });

  it('filters rooms by age and re-lists when the filter widens', async () => {
    const host = instance();
    const pool = new RelayPool([relay.url]);
    pool.connect();
    await pool.waitOpen(4000);
    const sk = randomBytes(32);
    const now = Math.floor(Date.now() / 1000);
    const old = finalizeEvent(roomTemplate({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      content: {
        v: 1, game: 'tt-easy-01', type: 'TT', title: 'Track 01', host: 'Old Pilot',
        players: 1, max: 4, ice: [], created: now - 8 * 3600,
      },
      ttlSec: 12 * 3600,        // still alive, just old
      created_at: now - 8 * 3600,
    }), sk);
    const fresh = finalizeEvent(roomTemplate({
      id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      content: {
        v: 1, game: 'tt-easy-01', type: 'TT', title: 'Track 01', host: 'Fresh Pilot',
        players: 1, max: 4, ice: [], created: now - 60,
      },
      ttlSec: 30 * 60,
      created_at: now - 60,
    }), sk);
    await pool.publish(old);
    await pool.publish(fresh);
    await host.connect();
    await waitFor(() => host.rooms.some((r) => r.id === 'bbbbbbbbbbbbbbbbbbbbbbbb'));
    expect(host.rooms.some((r) => r.id === 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    host.setMaxAge(12);
    await waitFor(() => host.rooms.some((r) => r.id === 'aaaaaaaaaaaaaaaaaaaaaaaa'));
    host.setMaxAge(6);
    expect(host.rooms.some((r) => r.id === 'aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
    pool.close();
    host.close();
  });

  it('carries signalling events to their recipient only', async () => {
    const hostSk = randomBytes(32);
    const guestSk = randomBytes(32);
    const hostPub = bytesToHex((await import('../src/game/nostr/crypto')).schnorrPubkey(hostSk));
    const guestPub = bytesToHex((await import('../src/game/nostr/crypto')).schnorrPubkey(guestSk));
    const roomId = 'cccccccccccccccccccccccc';
    const pool = new RelayPool([relay.url]);
    pool.connect();
    await pool.waitOpen(4000);
    const hostSeen: unknown[] = [];
    const guestSeen: unknown[] = [];
    // Exactly the filters the manager installs.
    pool.subscribe('host', [{ kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [hostPub] }], (e) => hostSeen.push(e));
    pool.subscribe('guest', [{ kinds: [KIND_SIGNAL], '#d': [roomId], '#p': [guestPub] }], (e) => guestSeen.push(e));
    const offer = finalizeEvent(
      signalTemplate(roomId, hostPub, { kind: 'offer', sdp: 'v=0\r\n', name: 'Guest Pilot' }),
      guestSk,
    );
    await pool.publish(offer);
    await waitFor(() => hostSeen.length > 0);
    const evt = hostSeen[0] as import('../src/game/nostr/event').NostrEvent;
    expect(evt.pubkey).toBe(guestPub);
    const msg = signalFromEvent(evt, hostPub, roomId);
    expect(msg?.kind).toBe('offer');
    expect(msg?.name).toBe('Guest Pilot');
    // The guest's own subscription never sees its offer (addressed to the host).
    expect(guestSeen).toHaveLength(0);
    pool.close();
  });

  it('replaces the room event on heartbeat rather than duplicating it', async () => {
    const host = instance();
    const other = instance();
    const room = await host.createRoom({ game: 'surv-easy', type: 'SURV', title: 'Survival', maxPlayers: 6 });
    await other.connect();
    await waitFor(() => other.rooms.some((r) => r.id === room.id));
    // Simulate a second revision (heartbeat with a new player count).
    const sk = (host as unknown as { sk: Uint8Array }).sk;
    const evt = finalizeEvent(roomTemplate({
      id: room.id,
      content: {
        v: 1, game: 'surv-easy', type: 'SURV', title: 'Survival', host: 'Pilot',
        players: 3, max: 6, ice: [], created: room.created,
      },
      ttlSec: 1800,
    }), sk);
    const pool = new RelayPool([relay.url]);
    pool.connect();
    await pool.waitOpen(4000);
    await pool.publish(evt);
    pool.close();
    await waitFor(() => other.rooms.find((r) => r.id === room.id)?.players === 3);
    const matches = other.rooms.filter((r) => r.id === room.id);
    expect(matches).toHaveLength(1);
    expect(roomFromEvent(evt)?.updated).toBe(evt.created_at);
    host.endSession();
    other.close();
    host.close();
  });
});

describe('room persistence (local relay)', () => {
  it('keeps the hosted room alive when the host leaves and re-enters', async () => {
    const host = instance();
    const room = await host.createRoom({ game: 'ctf-easy', type: 'CTF', title: 'Owned', maxPlayers: 8 });
    expect(host.hosting).not.toBeNull();
    // The host is still in its own room, listed for everyone.
    expect(host.inRoom).toBe(true);
    expect(host.rooms.some((r) => r.id === room.id)).toBe(true);
    // Re-entering (the lobby's RETURN TO ROOM) reuses the same room.
    const again = host.rejoinRoom();
    expect(again?.id).toBe(room.id);
    expect(host.hosting?.id).toBe(room.id);
    expect(host.players[0].host).toBe(true);
    // Only the explicit close tears it down.
    host.closeRoom();
    expect(host.hosting).toBeNull();
    expect(host.debugSessionId()).toBe('');
    host.close();
  });

  it('publishes a protected room as a flag + salt, never the password', async () => {
    const host = instance();
    const other = instance();
    const room = await host.createRoom({
      game: 'ctf-easy', type: 'CTF', title: 'Locked', maxPlayers: 4, password: 'hunter2',
    });
    expect(room.protected).toBe(true);
    expect(room.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(room.sid).toMatch(/^[0-9a-f]{24}$/);
    // The password is nowhere in the room event a guest would read.
    expect(room.raw!.content).not.toContain('hunter2');
    await other.connect();
    await waitFor(() => other.rooms.some((r) => r.id === room.id));
    const seen = other.rooms.find((r) => r.id === room.id)!;
    expect(seen.protected).toBe(true);
    expect(seen.salt).toBe(room.salt);
    expect(seen.raw!.content).not.toContain('hunter2');
    // An open room is not flagged.
    const open = await instance().createRoom({ game: 'tt-easy-01', type: 'TT', title: 'Open', maxPlayers: 2 });
    expect(open.protected).toBe(false);
    expect(open.salt).toBe('');
    host.closeRoom();
    other.close();
    host.close();
  });

  it('only broadcasts host offers with the offer tag (parsed with broadcast)', () => {
    const evt = finalizeEvent(
      signalTemplate('abcabcabcabcabcabcabcabc', '', { kind: 'offer', sdp: 'v=0', offerId: 'o1' }),
      randomBytes(32),
    );
    expect(tagValues(evt, 'p')).toHaveLength(0);
    expect(tagValues(evt, 't')).toContain(TAG_OFFER);
    expect(signalFromEvent(evt, 'me', 'abcabcabcabcabcabcabcabc')).toBeNull();
    const msg = signalFromEvent(evt, 'me', 'abcabcabcabcabcabcabcabc', { broadcast: true });
    expect(msg?.kind).toBe('offer');
    expect(msg?.offerId).toBe('o1');
  });
});

// ------------------------------------------- host-published offers (fake RTC)

/** Minimal RTCPeerConnection double: enough for the host offer flow in Node. */
class FakeChannel {
  readyState = 'open';
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public label: string) {}
  send(): void { /* no wire */ }
  close(): void { this.readyState = 'closed'; }
}

class FakePeer {
  static instances: FakePeer[] = [];
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  connectionState = 'new';
  onicecandidate: ((e: { candidate: null }) => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(public config: RTCConfiguration) { FakePeer.instances.push(this); }
  createDataChannel(label: string): FakeChannel { return new FakeChannel(label); }
  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'v=0\r\no=- fake-offer\r\n' };
  }
  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'v=0\r\no=- fake-answer\r\n' };
  }
  async setLocalDescription(d: { type: string; sdp: string }): Promise<void> { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> { this.remoteDescription = d; }
  async addIceCandidate(): Promise<void> { /* no wire */ }
  close(): void { this.connectionState = 'closed'; }
}

const isOffer = (e: NostrEvent): boolean => {
  if (e.kind !== KIND_SIGNAL) return false;
  try { return (JSON.parse(e.content) as { kind?: string }).kind === 'offer'; } catch { return false; }
};

describe('host-published offers (local relay)', () => {
  let savedRtc: unknown;
  beforeEach(() => {
    savedRtc = (globalThis as Record<string, unknown>).RTCPeerConnection;
    (globalThis as Record<string, unknown>).RTCPeerConnection = FakePeer;
    FakePeer.instances = [];
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).RTCPeerConnection = savedRtc;
  });

  /** A pool that records every signalling event it sees. */
  async function watchSignals(): Promise<{ pool: RelayPool; signals: NostrEvent[] }> {
    const pool = new RelayPool([relay.url]);
    pool.connect();
    await pool.waitOpen(4000);
    const signals: NostrEvent[] = [];
    pool.subscribe('watch', [{ kinds: [KIND_SIGNAL] }], (e) => signals.push(e));
    return { pool, signals };
  }

  it('publishes one offer per guest slot and a fresh one after an answer', async () => {
    const { pool: watch, signals } = await watchSignals();
    const host = instance();
    const guestSk = randomBytes(32);
    const guestPub = bytesToHex(schnorrPubkey(guestSk));
    const room = await host.createRoom({ game: 'ctf-easy', type: 'CTF', title: 'Hosted', maxPlayers: 4 });
    await waitFor(() => signals.filter(isOffer).length >= 3);
    expect(host.debugOffers()).toHaveLength(3);
    const evt = signals.filter(isOffer)[0];
    // A broadcast offer: no `p` tag, tagged for discovery.
    expect(tagValues(evt, 'p')).toHaveLength(0);
    expect(tagValues(evt, 't')).toContain(TAG_OFFER);
    const offer = signalFromEvent(evt, host.pubkey, room.id, { broadcast: true })!;
    expect(offer.kind).toBe('offer');
    expect(offer.offerId).toBeTruthy();
    expect(offer.sdp).toContain('fake-offer');
    expect(offer.sid).toBe(room.sid);
    expect(signalFromEvent(evt, host.pubkey, room.id)).toBeNull();

    // The guest answers: the host completes that peer and tops the pool up
    // with a fresh offer for the next client.
    const before = new Set(host.debugOffers());
    const answer = finalizeEvent(signalTemplate(room.id, host.pubkey, {
      kind: 'answer', offerId: offer.offerId, sdp: 'v=0\r\nfake-answer', name: 'Guest',
    }), guestSk);
    await watch.publish(answer);
    await waitFor(() => host.debugPeers().includes(guestPub));
    expect(host.debugOffers()).toHaveLength(3);
    expect(host.debugOffers().some((id) => !before.has(id))).toBe(true);

    host.closeRoom();
    watch.close();
    host.close();
  });

  it('ignores an answer from a previous room session', async () => {
    const { pool: watch, signals } = await watchSignals();
    const host = instance();
    const guestSk = randomBytes(32);
    const room = await host.createRoom({ game: 'kots-solo-easy', type: 'KOTS', title: 'K', maxPlayers: 4 });
    await waitFor(() => signals.filter(isOffer).length >= 1);
    const offer = signalFromEvent(signals.filter(isOffer)[0], host.pubkey, room.id, { broadcast: true })!;
    const stale = finalizeEvent(signalTemplate(room.id, host.pubkey, {
      kind: 'answer', offerId: offer.offerId, sid: 'dead'.repeat(6), sdp: 'v=0', name: 'Ghost',
    }), guestSk);
    await watch.publish(stale);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.debugPeers()).toHaveLength(0);
    host.closeRoom();
    watch.close();
    host.close();
  });

  it('seals host offers for a protected room; only the password opens them', async () => {
    const { pool: watch, signals } = await watchSignals();
    const host = instance();
    const room = await host.createRoom({
      game: 'ctf-easy', type: 'CTF', title: 'Secret', maxPlayers: 4, password: 's3cret',
    });
    await waitFor(() => signals.filter(isOffer).length >= 1);
    const evt = signals.filter(isOffer)[0];
    // The SDP never travels in the clear.
    expect(evt.content).not.toContain('fake-offer');
    const msg = signalFromEvent(evt, host.pubkey, room.id, { broadcast: true })!;
    expect(msg.enc).toBeTruthy();
    expect(msg.sdp).toBeUndefined();
    const key = await deriveKey('s3cret', room.salt);
    const opened = await openSignal(key, msg);
    expect(opened?.sdp).toContain('fake-offer');
    const wrong = await deriveKey('nope', room.salt);
    expect(await openSignal(wrong, msg)).toBeNull();

    // A sealed answer with the same key completes the peer.
    const guestSk = randomBytes(32);
    const guestPub = bytesToHex(schnorrPubkey(guestSk));
    const { sealSignal } = await import('../src/game/mp/crypto');
    const body = await sealSignal(key, {
      kind: 'answer', offerId: msg.offerId, sdp: 'v=0\r\nfake-answer', name: 'Guest',
    });
    const answer = finalizeEvent(signalTemplate(room.id, host.pubkey, { sid: room.sid, ...body }), guestSk);
    await watch.publish(answer);
    await waitFor(() => host.debugPeers().includes(guestPub));
    host.closeRoom();
    watch.close();
    host.close();
  });

  it('rotates the session on re-enter so stale signalling is dropped', async () => {
    const { pool: watch, signals } = await watchSignals();
    const host = instance();
    const room = await host.createRoom({ game: 'surv-easy', type: 'SURV', title: 'S', maxPlayers: 4 });
    await waitFor(() => signals.filter(isOffer).length >= 1);
    const firstSid = host.debugSessionId();
    expect(firstSid).toBe(room.sid);
    // Simulate a lost subscription (a real reconnect), then re-enter the room.
    const priv = host as unknown as { sigSub: (() => void) | null };
    priv.sigSub?.();
    priv.sigSub = null;
    expect(host.rejoinRoom()?.id).toBe(room.id);
    const secondSid = host.debugSessionId();
    expect(secondSid).not.toBe(firstSid);
    // The republished offers carry the new session id.
    await waitFor(() => signals.filter(isOffer).some((e) => {
      const m = signalFromEvent(e, host.pubkey, room.id, { broadcast: true });
      return m?.sid === secondSid;
    }));
    host.closeRoom();
    watch.close();
    host.close();
  });

  it('completes a guest peer from a NIP-04 DM answer, never a public signal', async () => {
    const { pool: watch, signals } = await watchSignals();
    const host = instance();
    const guest = instance();
    const room = await host.createRoom({ game: 'ctf-easy', type: 'CTF', title: 'Private', maxPlayers: 4 });
    await waitFor(() => signals.filter(isOffer).length >= 1);
    const offer = signalFromEvent(signals.filter(isOffer)[0], host.pubkey, room.id, { broadcast: true })!;
    // Private signalling: the answer is an encrypted DM, not a KIND_SIGNAL.
    await guest.sendDm(host.pubkey, JSON.stringify({
      v: MP_PROTOCOL, room: room.id, to: host.pubkey, sid: room.sid,
      kind: 'answer', offerId: offer.offerId, sdp: 'v=0\r\nfake-answer', name: 'Guest',
    }));
    await waitFor(() => host.debugPeers().includes(guest.pubkey));
    // Only the host's offers ever travelled as public signalling events.
    expect(signals.every(isOffer)).toBe(true);
    host.closeRoom();
    watch.close();
    host.close();
    guest.close();
  });
});

// --------------------------------------------------- DMs, identity, teams

describe('direct messages and identity (local relay)', () => {
  it('exchanges NIP-04 DMs and replays stored ones with fetchDms', async () => {
    const a = instance();
    const b = instance();
    await a.connect();
    await b.connect();
    const got: DmMessage[] = [];
    const off = b.onDm((m) => got.push(m));
    await a.sendDm(b.pubkey, 'secret payload');
    await waitFor(() => got.length === 1);
    expect(got[0].from).toBe(a.pubkey);
    expect(got[0].plaintext).toBe('secret payload');
    off();
    // Stored DMs addressed to us are replayed for the ledger on startup.
    const stored = await b.fetchDms();
    expect(stored.some((m) => m.plaintext === 'secret payload' && m.from === a.pubkey)).toBe(true);
    a.close();
    b.close();
  });

  it('exposes npub and nsec for the same identity', () => {
    const host = instance();
    expect(host.pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(host.npub).toMatch(/^npub1[0-9a-z]+$/);
    expect(host.nsec).toMatch(/^nsec1[0-9a-z]+$/);
    host.close();
  });

  it('defaults an unpicked player to team1 in the room', async () => {
    const host = instance();
    await host.createRoom({ game: 'ctf-easy', type: 'CTF', title: 'Defaults', maxPlayers: 4 });
    const snap = host.roomSnapshot()!;
    expect(snap.players[0].team).toBe('team1');
    host.closeRoom();
    host.close();
  });
});
