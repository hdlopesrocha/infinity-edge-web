// Transport contract for encrypted Nostr direct messages.
//
// The multiplayer manager (`mp/manager.ts`) implements this; the economic
// layer (`game/economy.ts`) consumes it. Keeping the interface here lets both
// sides be built and unit-tested independently (the economy tests pass a fake).
//
// A DM is a NIP-04 `kind: 4` event: content is `ciphertext?iv=...` (AES-256-CBC
// over the secp256k1 ECDH shared secret), tagged `p` with the recipient and
// addressed to them. The manager owns key management, relay publishing and
// decryption; the economy only sees plaintext payloads.

/** One decrypted DM. */
export interface DmMessage {
  /** Sender x-only public key (32-byte hex). */
  from: string;
  /** Decrypted plaintext body. */
  plaintext: string;
  /** Event created_at (Unix seconds). */
  created: number;
  /** Event id (dedup / deletion). */
  id: string;
}

/** What the economy layer needs from the Nostr client. */
export interface DmTransport {
  /** Our own x-only public key (32-byte hex). */
  readonly pubkey: string;
  /** Encrypt and publish a DM to `to` (x-only public key hex). */
  sendDm(to: string, plaintext: string): Promise<void>;
  /** Live DMs addressed to us; returns an unsubscribe function. */
  onDm(handler: (msg: DmMessage) => void): () => void;
  /** Stored DMs addressed to us, for replaying messages on startup. */
  fetchDms(since?: number): Promise<DmMessage[]>;
}
