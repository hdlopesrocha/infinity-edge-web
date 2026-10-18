// Live relay integration: skipped unless IE_NOSTR_TEST=1 (the unit suite must
// not depend on the network). Publishes a signed event to the configured
// relays and waits for the relay's OK, proving that the hand-rolled BIP-340
// signing is accepted by real-world software.
//
//   IE_NOSTR_TEST=1 npx vitest run tests/relay.integration.test.ts

import { describe, expect, it } from 'vitest';
import { RelayPool } from '../src/game/nostr/relay';
import { finalizeEvent, KIND_ROOM, newRoomId, roomTemplate, verifyEvent } from '../src/game/nostr/event';
import { randomBytes, bytesToHex } from '../src/game/nostr/crypto';

const RELAYS = (process.env.NOSTR_RELAYS || 'wss://nos.lol').split(',').map((s) => s.trim()).filter(Boolean);
const enabled = process.env.IE_NOSTR_TEST === '1';

describe.skipIf(!enabled)('relay pool (live)', () => {
  it('publishes a room event and reads it back', async () => {
    const pool = new RelayPool(RELAYS);
    pool.connect();
    expect(await pool.waitOpen(10000)).toBe(true);

    const sk = randomBytes(32);
    const roomId = newRoomId();
    const evt = finalizeEvent(roomTemplate({
      id: roomId,
      content: {
        v: 1, game: 'tt-easy-01', type: 'TT', title: 'Track 01', host: 'Selftest',
        players: 1, max: 8, ice: [], created: Math.floor(Date.now() / 1000),
      },
      ttlSec: 120,
    }), sk);
    expect(verifyEvent(evt)).toBe(true);

    const ok = await pool.publish(evt);
    expect(ok.ok).toBe(true);

    // Rooms are addressable: query by author + `d` and expect the exact event.
    const seen = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      const off = pool.subscribe('selftest', [{ kinds: [KIND_ROOM], authors: [evt.pubkey], '#d': [roomId] }], (got) => {
        if (got.id === evt.id) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
    expect(await seen).toBe(true);
    pool.close();
  }, 30000);
});
