// Minimal NIP-01 relay for tests and local multiplayer sessions.
//
// In-memory, no dependencies beyond `ws`: EVENT/REQ/EOSE/CLOSE/OK, replaceable
// and addressable events (kind 30000-39999 keyed by pubkey+d), ephemeral kinds
// (20000-29999) forwarded but never stored, and NIP-09 deletions. Event ids
// are re-hashed and checked; signatures are NOT verified (the public relays
// already prove the signing path - see tests/relay.integration.test.ts).
//
//   node tools/relay.mjs [--port 7777]
//   # then point the client at it:
//   #   localStorage: ie.mp.config {"relays":["ws://127.0.0.1:7777"]}
//   #   or window.__IE_MP_RELAYS = ['ws://127.0.0.1:7777']

import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';

const isEphemeral = (kind) => kind >= 20000 && kind < 30000;
const isAddressable = (kind) => kind >= 30000 && kind < 40000;

function eventId(evt) {
  const ser = JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
  return createHash('sha256').update(ser, 'utf8').digest('hex');
}

function tagValue(evt, name) {
  for (const tag of evt.tags) if (tag[0] === name) return tag[1];
  return null;
}

function matches(evt, filter) {
  if (filter.kinds && !filter.kinds.includes(evt.kind)) return false;
  if (filter.authors && !filter.authors.includes(evt.pubkey)) return false;
  if (filter.since && evt.created_at < filter.since) return false;
  if (filter.until && evt.created_at > filter.until) return false;
  if (filter.ids && !filter.ids.includes(evt.id)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const tagName = key.slice(1);
    const have = evt.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
    if (!have.some((v) => values.includes(v))) return false;
  }
  return true;
}

/** Starts the relay; resolves with { port, url, close() }. */
export async function startRelay({ port = 0, verbose = false } = {}) {
  const stored = new Map();          // id -> event
  const addressable = new Map();     // kind:pubkey:d -> id
  const bySub = new Map();           // ws -> Map<subId, filters>

  const index = (evt) => {
    stored.set(evt.id, evt);
    if (isAddressable(evt.kind)) {
      const d = tagValue(evt, 'd') ?? '';
      const key = `${evt.kind}:${evt.pubkey}:${d}`;
      const prev = addressable.get(key);
      if (prev && prev !== evt.id) {
        const old = stored.get(prev);
        // Replace only when the new revision is newer (NIP-01 ordering).
        if (old && old.created_at > evt.created_at) return;
        stored.delete(prev);
      }
      addressable.set(key, evt.id);
    }
  };

  const wss = new WebSocketServer({ port });
  await new Promise((resolve) => wss.once('listening', resolve));
  const actualPort = wss.address().port;

  wss.on('connection', (ws) => {
    bySub.set(ws, new Map());
    const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch { /* closing */ } };
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!Array.isArray(msg)) return;
      const [verb] = msg;
      if (verb === 'EVENT') {
        const evt = msg[1];
        if (!evt || typeof evt !== 'object' || typeof evt.id !== 'string') {
          send(['OK', '', false, 'invalid: malformed event']);
          return;
        }
        if (eventId(evt) !== evt.id) {
          send(['OK', evt.id, false, 'invalid: bad id']);
          return;
        }
        if (evt.kind === 5) {
          // NIP-09: drop the referenced addressable event when the author
          // matches, but keep the deletion itself (clients query it).
          for (const tag of evt.tags) {
            if (tag[0] === 'a' && typeof tag[1] === 'string') {
              const [kind, pubkey, d] = tag[1].split(':');
              if (pubkey === evt.pubkey) {
                const key = `${kind}:${pubkey}:${d}`;
                const target = addressable.get(key);
                if (target) stored.delete(target);
                addressable.delete(key);
              }
            }
          }
          index(evt);
          send(['OK', evt.id, true, '']);
        } else if (!isEphemeral(evt.kind)) {
          index(evt);
          send(['OK', evt.id, true, '']);
        } else {
          send(['OK', evt.id, true, '']);
        }
        send(['OK', evt.id, true, '']);
        // Live fan-out to every matching subscription.
        for (const [client, subs] of bySub) {
          for (const [subId, filters] of subs) {
            if (filters.some((f) => matches(evt, f))) {
              try { client.send(JSON.stringify(['EVENT', subId, evt])); } catch { /* closing */ }
            }
          }
        }
        if (verbose) console.log('[relay] event', evt.kind, evt.id.slice(0, 8));
        return;
      }
      if (verb === 'REQ') {
        const subId = String(msg[1]);
        const filters = msg.slice(2);
        bySub.get(ws)?.set(subId, filters);
        // Newest first, honoring `limit` per subscription (NIP-01).
        const limit = Math.min(...filters.map((f) => f.limit ?? 500));
        const hits = [...stored.values()]
          .filter((evt) => filters.some((f) => matches(evt, f)))
          .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
          .slice(0, limit);
        for (const evt of hits) send(['EVENT', subId, evt]);
        send(['EOSE', subId]);
        return;
      }
      if (verb === 'CLOSE') {
        bySub.get(ws)?.delete(String(msg[1]));
        return;
      }
      if (verb === 'COUNT') {
        const filters = msg.slice(2);
        const count = [...stored.values()].filter((evt) => filters.some((f) => matches(evt, f))).length;
        send(['COUNT', String(msg[1]), { count }]);
      }
    });
    ws.on('close', () => bySub.delete(ws));
    ws.on('error', () => bySub.delete(ws));
  });

  return {
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}`,
    close: () => new Promise((resolve) => {
      // Drop live sockets first: close() alone would wait for them.
      for (const client of wss.clients) {
        try { client.terminate(); } catch { /* already gone */ }
      }
      wss.close(() => resolve());
    }),
  };
}

// CLI entry (node tools/relay.mjs --port 7777).
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argPort = (() => {
    const i = process.argv.indexOf('--port');
    return i >= 0 ? Number(process.argv[i + 1]) : 7777;
  })();
  const relay = await startRelay({ port: argPort, verbose: process.argv.includes('-v') });
  console.log(`relay listening on ${relay.url}`);
}
