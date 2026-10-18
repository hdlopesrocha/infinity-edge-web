// Multiplayer room lifecycle over a local relay: publishing, listing, age
// filtering, deletion (creator only) and signalling addressing. The local
// relay (tools/relay.mjs) runs in-process; the client uses the same RelayPool
// and Multiplayer code the browser does.

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { startRelay } from '../tools/relay.mjs';
import { Multiplayer } from '../src/game/mp/manager';
import { RelayPool } from '../src/game/nostr/relay';
import { finalizeEvent, signalFromEvent, signalTemplate, roomTemplate, KIND_SIGNAL, roomFromEvent } from '../src/game/nostr/event';
import { randomBytes, bytesToHex } from '../src/game/nostr/crypto';

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
