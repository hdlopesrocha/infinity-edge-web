// SHA-256 + secp256k1/BIP-340 Schnorr + NIP-19-free hex helpers.
//
// The dedicated multiplayer server signs its own Nostr events, so the same
// BIP-340 implementation the browser uses (src/game/nostr/crypto.ts) lives
// here on top of OpenSSL's big numbers and EC points. Tested against the
// official BIP-340 vectors in tests/test_nostr.cpp.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace ie {
namespace nostr {

using Key32 = std::array<uint8_t, 32>;
using Sig64 = std::array<uint8_t, 64>;

/** SHA-256 (32 bytes). */
Key32 sha256(const uint8_t* data, size_t len);
inline Key32 sha256(const std::string& s) {
  return sha256(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

/** Cryptographically secure random bytes. */
void randomBytes(uint8_t* out, size_t n);

std::string hexEncode(const uint8_t* data, size_t len);
inline std::string hexEncode(const Key32& k) { return hexEncode(k.data(), k.size()); }
inline std::string hexEncode(const Sig64& s) { return hexEncode(s.data(), s.size()); }
std::vector<uint8_t> hexDecode(const std::string& hex);

/** BIP-340 signature (hex) over arbitrary bytes - channel authentication. */
std::string signHex(const Key32& sk, const uint8_t* msg, size_t len);
bool verifyHex(const Key32& pubkey, const uint8_t* msg, size_t len, const std::string& sigHex);

/**
 * Ephemeral P-256 key for the room certificate (WebCrypto-compatible):
 * SPKI public key, raw r||s ECDSA signatures, base64 encoded.
 */
class P256 {
 public:
  ~P256();
  static std::unique_ptr<P256> generate();
  /** Base64 SubjectPublicKeyInfo (what crypto.subtle.importKey('spki')). */
  std::string spkiBase64() const;
  /** Base64 ECDSA-SHA256 signature in WebCrypto's r||s (IEEE P1363) form. */
  std::string signBase64(const uint8_t* msg, size_t len) const;

 private:
  P256() = default;
  void* key_ = nullptr;  // EVP_PKEY*
};

/** Verifies a raw r||s P-256 signature against a DER SPKI public key. */
bool p256VerifySpki(const std::string& spkiDer, const uint8_t* msg, size_t len,
                    const uint8_t rawSig[64]);

bool validSecretKey(const Key32& sk);
/** x-only public key of a secret key. */
Key32 pubkeyOf(const Key32& sk);

/** BIP-340 signature (messages of any size, 2023-04). */
Sig64 schnorrSign(const uint8_t* msg, size_t msgLen, const Key32& sk, const Key32& aux);
bool schnorrVerify(const uint8_t* msg, size_t msgLen, const Key32& pubkey, const Sig64& sig);

}  // namespace nostr
}  // namespace ie
