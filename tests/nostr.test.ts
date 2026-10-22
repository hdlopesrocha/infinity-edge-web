// Nostr layer: SHA-256, secp256k1/BIP-340 (official vectors), NIP-19 bech32,
// event signing (cross-checked against nostr-tools fixtures) and the room /
// signalling payload schemas used by the multiplayer mode.

import { describe, expect, it } from 'vitest';
import {
  bytesToHex, hexToBytes, schnorrPubkey, schnorrSign, schnorrVerify, sha256, validSecretKey,
} from '../src/game/nostr/crypto';
import { bech32Decode, decodeKeyEntity, npubEncode, nsecEncode } from '../src/game/nostr/bech32';
import {
  eventId, finalizeEvent, verifyEvent, roomFromEvent, roomTemplate, signalFromEvent, signalTemplate,
  KIND_ROOM, KIND_SIGNAL,
} from '../src/game/nostr/event';

// ------------------------------------------------------------------- sha256
describe('sha256', () => {
  it('matches the known vectors', () => {
    expect(bytesToHex(sha256(new Uint8Array(0)))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bytesToHex(sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(bytesToHex(sha256(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });
});

// -------------------------------------------------------- secp256k1 (BIP-340)
// Official vectors: https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv
const BIP340_VECTORS: {
  index: number; sk?: string; pk: string; aux?: string; msg: string; sig: string; ok: boolean;
}[] = [
  { index: 0, sk: '0000000000000000000000000000000000000000000000000000000000000003',
    pk: 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0000000000000000000000000000000000000000000000000000000000000000',
    sig: 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0', ok: true },
  { index: 1, sk: 'B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF',
    pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A', ok: true },
  { index: 2, sk: 'C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9',
    pk: 'DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8',
    aux: 'C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906',
    msg: '7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C',
    sig: '5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7', ok: true },
  { index: 3, sk: '0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710',
    pk: '25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517',
    aux: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    msg: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    sig: '7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3', ok: true },
  { index: 4, sk: '', pk: 'D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9',
    aux: '', msg: '4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703',
    sig: '00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4', ok: true },
  { index: 5, pk: 'EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B', ok: false },
  { index: 6, pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: 'FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2', ok: false },
  { index: 9, pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051', ok: false },
  { index: 11, pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '4A298DACAE57395A15D0795DDBFD1DCB564DA82B0F269BC70A74F8220429BA1D69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B', ok: false },
  { index: 12, pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B', ok: false },
  { index: 13, pk: 'DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', ok: false },
  { index: 14, pk: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC30',
    msg: '243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89',
    sig: '6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B', ok: false },
  { index: 15, sk: '0340034003400340034003400340034003400340034003400340034003400340',
    pk: '778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '',
    sig: '71535DB165ECD9FBBC046E5FFAEA61186BB6AD436732FCCC25291A55895464CF6069CE26BF03466228F19A3A62DB8A649F2D560FAC652827D1AF0574E427AB63', ok: true },
  { index: 16, sk: '0340034003400340034003400340034003400340034003400340034003400340',
    pk: '778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '11',
    sig: '08A20A0AFEF64124649232E0693C583AB1B9934AE63B4C3511F3AE1134C6A303EA3173BFEA6683BD101FA5AA5DBC1996FE7CACFC5A577D33EC14564CEC2BACBF', ok: true },
  { index: 17, sk: '0340034003400340034003400340034003400340034003400340034003400340',
    pk: '778CAA53B4393AC467774D09497A87224BF9FAB6F6E68B23086497324D6FD117',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0102030405060708090A0B0C0D0E0F1011',
    sig: '5130F39A4059B43BC7CAC09A19ECE52B5D8699D1A71E3C52DA9AFDB6B50AC370C4A482B77BF960F8681540E25B6771ECE1E5A37FD80E5A51897C5566A97EA5A5', ok: true },
];

/** BIP-340 (2023-04) signs messages of any size directly. */
function vecMessage(hex: string): Uint8Array {
  return hexToBytes(hex);
}

describe('BIP-340 schnorr', () => {
  for (const v of BIP340_VECTORS) {
    it(`vector ${v.index} (${v.ok ? 'valid' : 'invalid'})`, () => {
      const msg = vecMessage(v.msg);
      const pk = hexToBytes(v.pk);
      const sig = hexToBytes(v.sig);
      if (v.sk) {
        const sk = hexToBytes(v.sk);
        expect(bytesToHex(schnorrPubkey(sk)).toUpperCase()).toBe(v.pk);
        expect(bytesToHex(schnorrSign(msg, sk, hexToBytes(v.aux || ''))).toUpperCase()).toBe(v.sig);
      }
      expect(schnorrVerify(msg, pk, sig)).toBe(v.ok);
    });
  }

  it('rejects malformed inputs', () => {
    const sk = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003');
    const pk = schnorrPubkey(sk);
    const msg = new Uint8Array(32);
    const sig = schnorrSign(msg, sk, new Uint8Array(32));
    expect(schnorrVerify(msg, pk, sig)).toBe(true);
    expect(schnorrVerify(msg, pk.slice(1), sig)).toBe(false);
    expect(schnorrVerify(msg, pk, sig.slice(1))).toBe(false);
    expect(schnorrVerify(new Uint8Array(31), pk, sig)).toBe(false);
    expect(validSecretKey(new Uint8Array(32))).toBe(false);
    expect(validSecretKey(sk)).toBe(true);
  });
});

// ---------------------------------------------------------------- NIP-19 key
describe('bech32 / NIP-19', () => {
  const fixtures = [
    {
      pubkey: '55ddfb721da817d43c8ed9eb6f4bde8ee6ec18b86852bdb1e0a495b3ef6440e2',
      npub: 'npub12hwlkusa4qtag0ywm84k7j773mnwcx9cdpftmv0q5j2m8mmygr3qqnzvxq',
      nsec: 'nsec1mj04ec89svg8lls6f4ztnflkp6ry493y9d2xm0vxrdffzjwrg9ssff5a7p',
      sk: 'dc9f5ce0e583107ffe1a4d44b9a7f60e864a96242b546dbd861b529149c34161',
    },
    {
      pubkey: 'b37e346e416155b2b0fa289e09ca1f70a2c6fed7da70a9080520219f161050c1',
      npub: 'npub1kdlrgmjpv92m9v869z0qnjslwz3vdlkhmfc2jzq9yqse79ss2rqsnty87a',
      nsec: 'nsec1qyyq79says4nyw2qga892hrrdfchslux3k2fhg4fkzmma3wv60dqnn8a4k',
      sk: '01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da',
    },
  ];

  it('encodes npub/nsec like nostr-tools', () => {
    for (const f of fixtures) {
      expect(npubEncode(hexToBytes(f.pubkey))).toBe(f.npub);
      expect(nsecEncode(hexToBytes(f.sk))).toBe(f.nsec);
    }
  });

  it('decodes back to the raw key bytes', () => {
    for (const f of fixtures) {
      const npub = decodeKeyEntity(f.npub);
      expect(npub?.type).toBe('npub');
      expect(bytesToHex(npub!.bytes)).toBe(f.pubkey);
      const nsec = decodeKeyEntity(f.nsec);
      expect(nsec?.type).toBe('nsec');
      expect(bytesToHex(nsec!.bytes)).toBe(f.sk);
      expect(decodeKeyEntity('npub1notvalid')).toBeNull();
      expect(bech32Decode(f.npub.slice(0, -1))).toBeNull();
    }
  });
});

// ------------------------------------------------------------------- events
describe('nostr events', () => {
  const skA = hexToBytes('dc9f5ce0e583107ffe1a4d44b9a7f60e864a96242b546dbd861b529149c34161');
  const skB = hexToBytes('01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da');
  const skC = hexToBytes('ce22c2b73cce57076566289e6bac98f98258a9b3aa430e7fbc4b96c11d43329e');
  const pubA = '55ddfb721da817d43c8ed9eb6f4bde8ee6ec18b86852bdb1e0a495b3ef6440e2';
  const pubB = 'b37e346e416155b2b0fa289e09ca1f70a2c6fed7da70a9080520219f161050c1';

  it('reproduces the nostr-tools fixture events byte for byte', () => {
    // nostr-tools signs with a random aux nonce, so the ids are reproducible
    // but the signatures are not: cross-check the signatures against a
    // fixed-aux reference computed with @noble/curves (and verify the
    // nostr-tools fixtures with our own verifier below).
    const aux = hexToBytes('01dd5825a7ac6e0221e352a5ac9b1dd2a3f8b605f32c1f5b5345ae2a95dc9479');
    const room = finalizeEvent({
      kind: KIND_ROOM,
      created_at: 1700000000,
      tags: [['d', '0123456789abcdef01234567'], ['t', 'ie3d-mp-room'], ['t', 'CTF'], ['expiration', '1700001800']],
      content: JSON.stringify({
        v: 1, game: 'ctf-easy', type: 'CTF', title: 'Capture the Flag - Easy', host: 'Pilot',
        players: 2, max: 8, ice: ['stun:stun.l.google.com:19302'], created: 1700000000,
      }),
    }, skA);
    expect(room.pubkey).toBe(pubA);
    expect(room.id).toBe('19313491d83de045684d785395ee4420b98d95e16530bd6382b9833b37bca114');
    expect(bytesToHex(schnorrSign(hexToBytes(room.id), skA, aux))).toBe(
      '8b882192368d1fee9290033082d975acf239b73acacb1f7a5317ec4967bb33106d5d9e3ca6be37a21d31c697d85e29550ebf6d09b6dfa1c374b7490196621ec5');
    expect(verifyEvent({
      ...room,
      sig: 'a96ff77a24858d9e713e017fefb3b9ba556e83fa55b8f75798dcfd94cefe5ced131605e8a1890dff37c62c9a817d5896ae6967bcc770dabacc29212954c8273a',
    })).toBe(true);

    const signal = finalizeEvent({
      kind: KIND_SIGNAL,
      created_at: 1700000123,
      tags: [['d', '0123456789abcdef01234567'], ['p', pubA], ['t', 'ie3d-mp-room']],
      content: JSON.stringify({
        v: 1, room: '0123456789abcdef01234567', to: pubA, kind: 'offer',
        sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
      }),
    }, skB);
    expect(signal.pubkey).toBe(pubB);
    expect(signal.id).toBe('2207f6ab0dd5512758d25650948d15ce09cab992cf21e2c6ea8f8ddc172ffb4a');
    expect(bytesToHex(schnorrSign(hexToBytes(signal.id), skB, aux))).toBe(
      'b572f92a1d5a4b59e094bed897ec43c473884f882c9c165788031562f59c37e0cd43382e70f9dfbfbd78a470927c6a14ef9993ca888401bdf162d871f2dc9562');
    expect(verifyEvent({
      ...signal,
      sig: '7e365d36841d7830eb9b768103fe2f735097f4015d99f0cedc8fc36f3916b45e8f7a521266c8711c732cfa6896bf39071fd4de2d2d9374b36524a3d52f7702c7',
    })).toBe(true);

    const empty = finalizeEvent({ kind: 1, created_at: 1700000200, tags: [], content: '' }, skC);
    expect(empty.id).toBe('290d11966843409551fce5d38bb448a7c3f58690badde001fd48f5c9401b3452');
    expect(verifyEvent({
      ...empty,
      sig: '7633792ac95bdd9f3779c261a2a45550eaad8f1d37a68d4cf7cb20f715bf2c2f1d671ef1bca3a1acc74a2b9c452d6eea214845305be896af287ddf7c9167d671',
    })).toBe(true);
  });

  it('verifies signed events and rejects tampering', () => {
    const evt = finalizeEvent({ kind: 1, created_at: 1700000000, tags: [['t', 'x']], content: 'hello' }, skA);
    expect(verifyEvent(evt)).toBe(true);
    expect(verifyEvent({ ...evt, content: 'hello!' })).toBe(false);
    expect(verifyEvent({ ...evt, id: evt.id.replace(/^./, evt.id[0] === '0' ? '1' : '0') })).toBe(false);
    expect(verifyEvent({ ...evt, pubkey: pubB })).toBe(false);
    expect(eventId(evt)).toBe(evt.id);
  });

  it('parses room events and refuses foreign or expired ones', () => {
    const template = roomTemplate({
      id: '0123456789abcdef01234567',
      content: {
        v: 1, game: 'ctf-easy', type: 'CTF', title: 'Capture the Flag - Easy', host: 'Pilot',
        players: 2, max: 8, ice: [], created: 1,
      },
      ttlSec: 3600,
      created_at: Math.floor(Date.now() / 1000),
    });
    const evt = finalizeEvent(template, skA);
    const room = roomFromEvent(evt);
    expect(room).not.toBeNull();
    expect(room!.id).toBe('0123456789abcdef01234567');
    expect(room!.host).toBe('Pilot');
    expect(room!.game).toBe('ctf-easy');
    expect(room!.hostPubkey).toBe(pubA);
    expect(room!.maxPlayers).toBe(8);
    // Non-room kinds and a missing board `p` tag are ignored.
    expect(roomFromEvent({ ...evt, kind: 1 })).toBeNull();
    expect(roomFromEvent({ ...evt, tags: evt.tags.filter((t) => t[0] !== 'p') })).toBeNull();
    // Expired rooms are dropped locally, whatever the relay kept.
    const expired = finalizeEvent(roomTemplate({
      id: '0123456789abcdef01234568',
      content: {
        v: 1, game: 'tt-easy-01', type: 'TT', title: 'Track 01', host: 'Pilot',
        players: 1, max: 4, ice: [], created: 1,
      },
      ttlSec: 60,
      created_at: 1700000000,
    }), skA);
    expect(roomFromEvent(expired)).toBeNull();
  });

  it('addresses signalling events to a recipient only', () => {
    const template = signalTemplate('0123456789abcdef01234567', pubA, { kind: 'answer', sdp: 'v=0' });
    const evt = finalizeEvent(template, skB);
    const mine = signalFromEvent(evt, pubA, '0123456789abcdef01234567');
    expect(mine).not.toBeNull();
    expect(mine!.kind).toBe('answer');
    expect(mine!.sdp).toBe('v=0');
    // Not addressed to me / wrong room / malformed.
    expect(signalFromEvent(evt, pubB, '0123456789abcdef01234567')).toBeNull();
    expect(signalFromEvent(evt, pubA, 'ffffffffffffffffffffffff')).toBeNull();
    const broken = { ...evt, content: '{oops' };
    expect(signalFromEvent(broken, pubA)).toBeNull();
    const wrongKind = { ...evt, content: JSON.stringify({ v: 1, room: '0123456789abcdef01234567', to: pubA, kind: 'drop' }) };
    expect(signalFromEvent(wrongKind, pubA)).toBeNull();
  });
});
