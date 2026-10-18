#include "proto.h"

#include "gzip.h"

namespace ie {
namespace proto {

std::vector<uint8_t> encodeFrame(uint16_t type, const uint8_t* payload, size_t len, bool compress) {
  std::vector<uint8_t> body;
  const uint8_t* bodyPtr = payload;
  size_t bodyLen = len;
  bool gz = false;
  if (compress && len >= GZIP_THRESHOLD) {
    std::vector<uint8_t> z = gzipCompress(payload, len);
    if (z.size() < len) {
      body = std::move(z);
      bodyPtr = body.data();
      bodyLen = body.size();
      gz = true;
    }
  }
  std::vector<uint8_t> out(HEADER_SIZE + bodyLen);
  out[0] = VERSION;
  out[1] = gz ? FLAG_GZIP : 0;
  out[2] = static_cast<uint8_t>(type & 0xFF);
  out[3] = static_cast<uint8_t>(type >> 8);
  const uint32_t l = static_cast<uint32_t>(bodyLen);
  out[4] = static_cast<uint8_t>(l & 0xFF);
  out[5] = static_cast<uint8_t>((l >> 8) & 0xFF);
  out[6] = static_cast<uint8_t>((l >> 16) & 0xFF);
  out[7] = static_cast<uint8_t>((l >> 24) & 0xFF);
  std::memcpy(out.data() + HEADER_SIZE, bodyPtr, bodyLen);
  return out;
}

DecodedFrame decodeFrame(const uint8_t* data, size_t len) {
  if (len < HEADER_SIZE) throw std::runtime_error("proto: truncated header");
  if (data[0] != VERSION) throw std::runtime_error("proto: bad version");
  const uint8_t flags = data[1];
  const uint16_t type = static_cast<uint16_t>(data[2] | (data[3] << 8));
  const uint32_t payloadLen = static_cast<uint32_t>(data[4]) |
                              (static_cast<uint32_t>(data[5]) << 8) |
                              (static_cast<uint32_t>(data[6]) << 16) |
                              (static_cast<uint32_t>(data[7]) << 24);
  if (len < HEADER_SIZE + payloadLen) throw std::runtime_error("proto: truncated payload");
  DecodedFrame out;
  out.type = type;
  if ((flags & FLAG_GZIP) != 0) {
    out.payload = gzipDecompress(data + HEADER_SIZE, payloadLen);
  } else {
    out.payload.assign(data + HEADER_SIZE, data + HEADER_SIZE + payloadLen);
  }
  return out;
}

}  // namespace proto
}  // namespace ie
