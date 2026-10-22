// SHA-256 + secp256k1/BIP-340 Schnorr (OpenSSL), see nostr_crypto.h.
#include "nostr_crypto.h"

#include "crypto.h"

#include <openssl/bn.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/obj_mac.h>
#include <openssl/rand.h>

#include <algorithm>
#include <cstring>
#include <mutex>
#include <stdexcept>

namespace ie {
namespace nostr {

namespace {

// OpenSSL's EC/BN scratch context and the cached curve constants are shared;
// signatures (tick thread) and relay-side verification (relay threads) can
// overlap, so serialise the operations. Signing is rare - no contention.
std::recursive_mutex& cryptoMutex() {
  static std::recursive_mutex m;
  return m;
}

}  // namespace

namespace {

struct Group {
  EC_GROUP* g = nullptr;
  BN_CTX* ctx = nullptr;
  Group() {
    g = EC_GROUP_new_by_curve_name(NID_secp256k1);
    if (!g) throw std::runtime_error("secp256k1 unavailable");
    ctx = BN_CTX_new();
  }
  ~Group() {
    if (g) EC_GROUP_free(g);
    if (ctx) BN_CTX_free(ctx);
  }
};

const EC_GROUP* curve() {
  static Group group;
  return group.g;
}
BN_CTX* bnctx() {
  static Group group;
  return group.ctx;
}

const BIGNUM* order() {
  static BIGNUM* n = nullptr;
  if (!n) {
    n = BN_new();
    EC_GROUP_get_order(curve(), n, bnctx());
  }
  return n;
}

const BIGNUM* field() {
  static BIGNUM* p = nullptr;
  if (!p) {
    p = BN_new();
    EC_GROUP_get_curve(curve(), p, nullptr, nullptr, bnctx());
  }
  return p;
}

Key32 taggedHash(const char* tag, const std::vector<std::vector<uint8_t>>& parts) {
  const Key32 tagHash = sha256(std::string(tag));
  std::vector<uint8_t> buf;
  buf.reserve(64 + 256);
  buf.insert(buf.end(), tagHash.begin(), tagHash.end());
  buf.insert(buf.end(), tagHash.begin(), tagHash.end());
  for (const auto& p : parts) buf.insert(buf.end(), p.begin(), p.end());
  return sha256(buf.data(), buf.size());
}

std::vector<uint8_t> bytes(const uint8_t* p, size_t n) {
  return n ? std::vector<uint8_t>(p, p + n) : std::vector<uint8_t>();
}

/** 32-byte big-endian bytes of a BIGNUM (zero padded). */
Key32 bnBytes(const BIGNUM* v) {
  Key32 out{};
  BN_bn2binpad(v, out.data(), 32);
  return out;
}

BIGNUM* bnFromBytes(const uint8_t* data, size_t len) {
  return BN_bin2bn(data, static_cast<int>(len), nullptr);
}

bool pointX(const EC_POINT* p, Key32* out) {
  BIGNUM* x = BN_new();
  BIGNUM* y = BN_new();
  bool ok = EC_POINT_get_affine_coordinates(curve(), p, x, y, bnctx()) == 1;
  if (ok) *out = bnBytes(x);
  BN_free(x);
  BN_free(y);
  return ok;
}

bool pointYIsEven(const EC_POINT* p) {
  BIGNUM* x = BN_new();
  BIGNUM* y = BN_new();
  bool even = false;
  if (EC_POINT_get_affine_coordinates(curve(), p, x, y, bnctx()) == 1) {
    even = BN_is_odd(y) == 0;
  }
  BN_free(x);
  BN_free(y);
  return even;
}

/** Lift an x coordinate to the point with even y (nullptr when invalid). */
EC_POINT* liftX(const Key32& x) {
  if (BN_cmp(bnFromBytes(x.data(), 32), field()) >= 0) return nullptr;
  uint8_t compressed[33];
  compressed[0] = 0x02;  // even y
  std::memcpy(compressed + 1, x.data(), 32);
  EC_POINT* p = EC_POINT_new(curve());
  if (!EC_POINT_oct2point(curve(), p, compressed, sizeof(compressed), bnctx())) {
    EC_POINT_free(p);
    return nullptr;
  }
  // Reject a point whose y is odd (cannot happen with the 0x02 prefix, but the
  // check is what BIP-340 specifies).
  if (!pointYIsEven(p)) {
    EC_POINT_free(p);
    return nullptr;
  }
  return p;
}

}  // namespace

Key32 sha256(const uint8_t* data, size_t len) {
  Key32 out{};
  unsigned int outLen = 0;
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr);
  EVP_DigestUpdate(ctx, data, len);
  EVP_DigestFinal_ex(ctx, out.data(), &outLen);
  EVP_MD_CTX_free(ctx);
  return out;
}

void randomBytes(uint8_t* out, size_t n) {
  if (RAND_bytes(out, static_cast<int>(n)) != 1) throw std::runtime_error("RNG failure");
}

std::string hexEncode(const uint8_t* data, size_t len) {
  static const char* kHex = "0123456789abcdef";
  std::string s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    s.push_back(kHex[data[i] >> 4]);
    s.push_back(kHex[data[i] & 15]);
  }
  return s;
}

std::vector<uint8_t> hexDecode(const std::string& hex) {
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2);
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    const int hi = nib(hex[i]);
    const int lo = nib(hex[i + 1]);
    if (hi < 0 || lo < 0) return {};
    out.push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return out;
}

std::string signHex(const Key32& sk, const uint8_t* msg, size_t len) {
  Key32 aux{};
  randomBytes(aux.data(), aux.size());
  return hexEncode(schnorrSign(msg, len, sk, aux));
}

bool verifyHex(const Key32& pubkey, const uint8_t* msg, size_t len, const std::string& sigHex) {
  const std::vector<uint8_t> raw = hexDecode(sigHex);
  if (raw.size() != 64) return false;
  Sig64 sig{};
  std::copy(raw.begin(), raw.end(), sig.begin());
  return schnorrVerify(msg, len, pubkey, sig);
}

// ------------------------------------------------------------------- NIP-04
namespace {

/** AES-256-CBC/PKCS7 encrypt; `iv` is the 16-byte IV. */
std::string aesCbcEncrypt(const Key32& key, const uint8_t* iv, const uint8_t* data, size_t len) {
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) return "";
  std::vector<uint8_t> out(len + 32);
  int total = 0;
  int chunk = 0;
  bool ok = EVP_EncryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr, key.data(), iv) == 1 &&
            EVP_EncryptUpdate(ctx, out.data(), &chunk, data, static_cast<int>(len)) == 1;
  total = chunk;
  if (ok) ok = EVP_EncryptFinal_ex(ctx, out.data() + total, &chunk) == 1;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) return "";
  total += chunk;
  out.resize(static_cast<size_t>(total));
  return std::string(out.begin(), out.end());
}

/** AES-256-CBC/PKCS7 decrypt; false on bad padding (wrong key / tampering). */
bool aesCbcDecrypt(const Key32& key, const uint8_t* iv, const uint8_t* data, size_t len,
                   std::string* out) {
  if (len == 0 || len % 16 != 0) return false;
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) return false;
  std::vector<uint8_t> plain(len + 16);
  int total = 0;
  int chunk = 0;
  bool ok = EVP_DecryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr, key.data(), iv) == 1 &&
            EVP_DecryptUpdate(ctx, plain.data(), &chunk, data, static_cast<int>(len)) == 1;
  total = chunk;
  if (ok) ok = EVP_DecryptFinal_ex(ctx, plain.data() + total, &chunk) == 1;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) return false;
  total += chunk;
  plain.resize(static_cast<size_t>(total));
  *out = std::string(plain.begin(), plain.end());
  return true;
}

}  // namespace

Key32 ecdhSharedX(const Key32& sk, const Key32& peerXOnly) {
  std::lock_guard<std::recursive_mutex> lock(cryptoMutex());
  if (!validSecretKey(sk)) throw std::runtime_error("ecdh: invalid secret key");
  EC_POINT* P = liftX(peerXOnly);
  if (!P) throw std::runtime_error("ecdh: invalid public key");
  BIGNUM* d = bnFromBytes(sk.data(), 32);
  EC_POINT* shared = EC_POINT_new(curve());
  EC_POINT_mul(curve(), shared, nullptr, P, d, bnctx());
  Key32 out{};
  const bool ok = !EC_POINT_is_at_infinity(curve(), shared) && pointX(shared, &out);
  EC_POINT_free(shared);
  EC_POINT_free(P);
  BN_free(d);
  if (!ok) throw std::runtime_error("ecdh: point at infinity");
  return out;
}

std::string nip04Encrypt(const Key32& sk, const Key32& peerXOnly, const std::string& plaintext) {
  const Key32 shared = ecdhSharedX(sk, peerXOnly);
  const Key32 aesKey = sha256(shared.data(), shared.size());
  uint8_t iv[16];
  randomBytes(iv, sizeof(iv));
  const std::string cipher =
      aesCbcEncrypt(aesKey, iv, reinterpret_cast<const uint8_t*>(plaintext.data()), plaintext.size());
  return base64Encode(reinterpret_cast<const uint8_t*>(cipher.data()), cipher.size()) + "?iv=" +
         base64Encode(iv, sizeof(iv));
}

bool nip04Decrypt(const Key32& sk, const Key32& peerXOnly, const std::string& payload,
                  std::string* out) {
  if (!out) return false;
  const size_t sep = payload.find("?iv=");
  if (sep == std::string::npos || sep == 0) return false;
  const std::string cipherText = payload.substr(0, sep);
  const std::string ivText = payload.substr(sep + 4);
  if (cipherText.empty() || ivText.empty()) return false;
  const std::vector<uint8_t> iv = base64Decode(ivText);
  if (iv.size() != 16) return false;
  const std::vector<uint8_t> cipher = base64Decode(cipherText);
  if (cipher.empty() || cipher.size() % 16 != 0) return false;
  Key32 shared{};
  try {
    shared = ecdhSharedX(sk, peerXOnly);
  } catch (...) {
    return false;
  }
  const Key32 aesKey = sha256(shared.data(), shared.size());
  return aesCbcDecrypt(aesKey, iv.data(), cipher.data(), cipher.size(), out);
}

P256::~P256() {
  if (key_) EVP_PKEY_free(static_cast<EVP_PKEY*>(key_));
}

std::unique_ptr<P256> P256::generate() {
  auto out = std::unique_ptr<P256>(new P256());
  EVP_PKEY_CTX* ctx = EVP_PKEY_CTX_new_from_name(nullptr, "EC", nullptr);
  if (!ctx) return nullptr;
  EVP_PKEY* key = nullptr;
  if (EVP_PKEY_keygen_init(ctx) <= 0) {
    EVP_PKEY_CTX_free(ctx);
    return nullptr;
  }
  EVP_PKEY_CTX_set_group_name(ctx, "prime256v1");
  const int ok = EVP_PKEY_keygen(ctx, &key);
  EVP_PKEY_CTX_free(ctx);
  if (ok <= 0 || !key) return nullptr;
  out->key_ = key;
  return out;
}

std::string P256::spkiBase64() const {
  if (!key_) return "";
  unsigned char* der = nullptr;
  const int len = i2d_PUBKEY(static_cast<EVP_PKEY*>(key_), &der);
  if (len <= 0 || !der) return "";
  std::string b64 = base64Encode(der, static_cast<size_t>(len));
  OPENSSL_free(der);
  return b64;
}

std::string P256::signBase64(const uint8_t* msg, size_t len) const {
  if (!key_) return "";
  EVP_MD_CTX* md = EVP_MD_CTX_new();
  size_t sigLen = 0;
  std::vector<uint8_t> der;
  if (EVP_DigestSignInit(md, nullptr, EVP_sha256(), nullptr, static_cast<EVP_PKEY*>(key_)) <= 0 ||
      EVP_DigestSign(md, nullptr, &sigLen, msg, len) <= 0) {
    EVP_MD_CTX_free(md);
    return "";
  }
  der.resize(sigLen);
  if (EVP_DigestSign(md, der.data(), &sigLen, msg, len) <= 0) {
    EVP_MD_CTX_free(md);
    return "";
  }
  EVP_MD_CTX_free(md);
  der.resize(sigLen);
  // DER -> raw r||s (WebCrypto's ECDSA signature format).
  const unsigned char* p = der.data();
  ECDSA_SIG* es = d2i_ECDSA_SIG(nullptr, &p, static_cast<long>(der.size()));
  if (!es) return "";
  const BIGNUM* r = nullptr;
  const BIGNUM* s = nullptr;
  ECDSA_SIG_get0(es, &r, &s);
  uint8_t raw[64];
  BN_bn2binpad(r, raw, 32);
  BN_bn2binpad(s, raw + 32, 32);
  ECDSA_SIG_free(es);
  return base64Encode(raw, sizeof(raw));
}

bool p256VerifySpki(const std::string& spkiDer, const uint8_t* msg, size_t len,
                    const uint8_t rawSig[64]) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(spkiDer.data());
  EVP_PKEY* key = d2i_PUBKEY(nullptr, &p, static_cast<long>(spkiDer.size()));
  if (!key) return false;
  ECDSA_SIG* es = ECDSA_SIG_new();
  BIGNUM* r = BN_bin2bn(rawSig, 32, nullptr);
  BIGNUM* s = BN_bin2bn(rawSig + 32, 32, nullptr);
  ECDSA_SIG_set0(es, r, s);
  unsigned char* der = nullptr;
  const int derLen = i2d_ECDSA_SIG(es, &der);
  ECDSA_SIG_free(es);
  bool ok = false;
  if (derLen > 0) {
    EVP_MD_CTX* md = EVP_MD_CTX_new();
    if (EVP_DigestVerifyInit(md, nullptr, EVP_sha256(), nullptr, key) > 0) {
      ok = EVP_DigestVerify(md, der, static_cast<size_t>(derLen), msg, len) == 1;
    }
    EVP_MD_CTX_free(md);
    OPENSSL_free(der);
  }
  EVP_PKEY_free(key);
  return ok;
}

bool validSecretKey(const Key32& sk) {
  std::lock_guard<std::recursive_mutex> lock(cryptoMutex());
  BIGNUM* d = bnFromBytes(sk.data(), 32);
  const bool ok = !BN_is_zero(d) && BN_cmp(d, order()) < 0;
  BN_free(d);
  return ok;
}

Key32 pubkeyOf(const Key32& sk) {
  std::lock_guard<std::recursive_mutex> lock(cryptoMutex());
  BIGNUM* d = bnFromBytes(sk.data(), 32);
  EC_POINT* p = EC_POINT_new(curve());
  EC_POINT_mul(curve(), p, d, nullptr, nullptr, bnctx());
  Key32 x{};
  pointX(p, &x);
  EC_POINT_free(p);
  BN_free(d);
  return x;
}

Sig64 schnorrSign(const uint8_t* msg, size_t msgLen, const Key32& sk, const Key32& aux) {
  std::lock_guard<std::recursive_mutex> lock(cryptoMutex());
  if (!validSecretKey(sk)) throw std::runtime_error("schnorr: invalid secret key");
  BIGNUM* d0 = bnFromBytes(sk.data(), 32);
  EC_POINT* P = EC_POINT_new(curve());
  EC_POINT_mul(curve(), P, d0, nullptr, nullptr, bnctx());
  Key32 px{};
  pointX(P, &px);

  // d = d0 if P.y even else n - d0
  BIGNUM* d = BN_new();
  if (pointYIsEven(P)) {
    BN_copy(d, d0);
  } else {
    BN_sub(d, order(), d0);
  }

  // t = bytes(d) xor tagged_hash("BIP0340/aux", aux)
  const Key32 auxHash = taggedHash("BIP0340/aux", {{std::vector<uint8_t>(aux.begin(), aux.end())}});
  Key32 t{};
  const Key32 dBytes = bnBytes(d);
  for (int i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];

  // k0 = int(tagged_hash("BIP0340/nonce", t || P.x || msg)) mod n
  const auto nonceHash = taggedHash("BIP0340/nonce", {
      std::vector<uint8_t>(t.begin(), t.end()),
      std::vector<uint8_t>(px.begin(), px.end()),
      bytes(msg, msgLen),
  });
  BIGNUM* k0 = bnFromBytes(nonceHash.data(), 32);
  BIGNUM* k = BN_new();
  BN_mod(k, k0, order(), bnctx());
  if (BN_is_zero(k)) throw std::runtime_error("schnorr: nonce is zero");

  EC_POINT* R = EC_POINT_new(curve());
  EC_POINT_mul(curve(), R, k, nullptr, nullptr, bnctx());
  Key32 rx{};
  pointX(R, &rx);
  if (!pointYIsEven(R)) BN_sub(k, order(), k);

  // e = int(tagged_hash("BIP0340/challenge", R.x || P.x || msg)) mod n
  const auto challHash = taggedHash("BIP0340/challenge", {
      std::vector<uint8_t>(rx.begin(), rx.end()),
      std::vector<uint8_t>(px.begin(), px.end()),
      bytes(msg, msgLen),
  });
  BIGNUM* e = bnFromBytes(challHash.data(), 32);
  BN_mod(e, e, order(), bnctx());

  // s = (k + e*d) mod n
  BIGNUM* s = BN_new();
  BN_mod_mul(s, e, d, order(), bnctx());
  BN_mod_add(s, s, k, order(), bnctx());

  Sig64 sig{};
  std::memcpy(sig.data(), rx.data(), 32);
  BN_bn2binpad(s, sig.data() + 32, 32);

  BN_free(d0);
  BN_free(d);
  BN_free(k0);
  BN_free(k);
  BN_free(e);
  BN_free(s);
  EC_POINT_free(P);
  EC_POINT_free(R);
  return sig;
}

bool schnorrVerify(const uint8_t* msg, size_t msgLen, const Key32& pubkey, const Sig64& sig) {
  std::lock_guard<std::recursive_mutex> lock(cryptoMutex());
  EC_POINT* P = liftX(pubkey);
  if (!P) return false;
  BIGNUM* r = bnFromBytes(sig.data(), 32);
  BIGNUM* s = bnFromBytes(sig.data() + 32, 32);
  bool ok = false;
  if (BN_cmp(r, field()) < 0 && BN_cmp(s, order()) < 0) {
    const auto challHash = taggedHash("BIP0340/challenge", {
        std::vector<uint8_t>(sig.begin(), sig.begin() + 32),
        std::vector<uint8_t>(pubkey.begin(), pubkey.end()),
        bytes(msg, msgLen),
    });
    BIGNUM* e = bnFromBytes(challHash.data(), 32);
    BN_mod(e, e, order(), bnctx());
    BIGNUM* negE = BN_new();
    BN_sub(negE, order(), e);

    EC_POINT* sG = EC_POINT_new(curve());
    EC_POINT* eP = EC_POINT_new(curve());
    EC_POINT* R = EC_POINT_new(curve());
    EC_POINT_mul(curve(), sG, s, nullptr, nullptr, bnctx());
    EC_POINT_mul(curve(), eP, nullptr, P, negE, bnctx());
    EC_POINT_add(curve(), R, sG, eP, bnctx());
    if (!EC_POINT_is_at_infinity(curve(), R)) {
      Key32 rx{};
      if (pointX(R, &rx) && pointYIsEven(R) && std::memcmp(rx.data(), sig.data(), 32) == 0) {
        ok = true;
      }
    }
    EC_POINT_free(sG);
    EC_POINT_free(eP);
    EC_POINT_free(R);
    BN_free(e);
    BN_free(negE);
  }
  BN_free(r);
  BN_free(s);
  EC_POINT_free(P);
  return ok;
}

}  // namespace nostr
}  // namespace ie
