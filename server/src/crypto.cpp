#include "crypto.h"

#include <cstring>

namespace ie {

std::vector<uint8_t> sha1(const uint8_t* data, size_t len) {
  uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
  const uint64_t bitLen = static_cast<uint64_t>(len) * 8;

  std::vector<uint8_t> msg(data, data + len);
  msg.push_back(0x80);
  while (msg.size() % 64 != 56) msg.push_back(0);
  for (int i = 7; i >= 0; i--) msg.push_back(static_cast<uint8_t>((bitLen >> (i * 8)) & 0xFF));

  const auto rol = [](uint32_t v, int n) { return (v << n) | (v >> (32 - n)); };
  for (size_t off = 0; off < msg.size(); off += 64) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++) {
      w[i] = (static_cast<uint32_t>(msg[off + i * 4]) << 24) |
             (static_cast<uint32_t>(msg[off + i * 4 + 1]) << 16) |
             (static_cast<uint32_t>(msg[off + i * 4 + 2]) << 8) |
             static_cast<uint32_t>(msg[off + i * 4 + 3]);
    }
    for (int i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5A827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ED9EBA1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8F1BBCDC;
      } else {
        f = b ^ c ^ d;
        k = 0xCA62C1D6;
      }
      const uint32_t tmp = rol(a, 5) + f + e + k + w[i];
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = tmp;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }

  std::vector<uint8_t> out(20);
  for (int i = 0; i < 5; i++) {
    out[i * 4] = static_cast<uint8_t>(h[i] >> 24);
    out[i * 4 + 1] = static_cast<uint8_t>(h[i] >> 16);
    out[i * 4 + 2] = static_cast<uint8_t>(h[i] >> 8);
    out[i * 4 + 3] = static_cast<uint8_t>(h[i]);
  }
  return out;
}

std::string base64Encode(const uint8_t* data, size_t len) {
  static const char* kTable = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    const uint32_t b0 = data[i];
    const uint32_t b1 = i + 1 < len ? data[i + 1] : 0;
    const uint32_t b2 = i + 2 < len ? data[i + 2] : 0;
    const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
    out.push_back(kTable[(triple >> 18) & 0x3F]);
    out.push_back(kTable[(triple >> 12) & 0x3F]);
    out.push_back(i + 1 < len ? kTable[(triple >> 6) & 0x3F] : '=');
    out.push_back(i + 2 < len ? kTable[triple & 0x3F] : '=');
  }
  return out;
}

}  // namespace ie
