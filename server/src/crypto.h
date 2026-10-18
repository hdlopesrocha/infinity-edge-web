// SHA-1 + base64: the WebSocket opening handshake (RFC 6455 §4.2.2) needs
// Sec-WebSocket-Accept = base64(SHA1(key + GUID)). Both are small enough to
// carry in-tree; nothing else in the server uses cryptography.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ie {

/** SHA-1 of `data` (20 bytes). */
std::vector<uint8_t> sha1(const uint8_t* data, size_t len);
inline std::vector<uint8_t> sha1(const std::string& s) {
  return sha1(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

/** Standard base64 (with '=' padding). */
std::string base64Encode(const uint8_t* data, size_t len);
inline std::string base64Encode(const std::vector<uint8_t>& v) {
  return base64Encode(v.data(), v.size());
}

}  // namespace ie
