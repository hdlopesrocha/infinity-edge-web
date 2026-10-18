#include "gzip.h"

#include <zlib.h>

#include <stdexcept>

namespace ie {

std::vector<uint8_t> gzipCompress(const uint8_t* data, size_t len) {
  z_stream zs{};
  // windowBits 15 + 16 = gzip wrapper.
  if (deflateInit2(&zs, Z_DEFAULT_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
    throw std::runtime_error("gzip: deflateInit2 failed");
  }
  std::vector<uint8_t> out;
  out.resize(deflateBound(&zs, static_cast<uLong>(len)) + 16);
  zs.next_in = const_cast<Bytef*>(data);
  zs.avail_in = static_cast<uInt>(len);
  zs.next_out = out.data();
  zs.avail_out = static_cast<uInt>(out.size());
  const int rc = deflate(&zs, Z_FINISH);
  if (rc != Z_STREAM_END) {
    deflateEnd(&zs);
    throw std::runtime_error("gzip: deflate failed");
  }
  out.resize(zs.total_out);
  deflateEnd(&zs);
  return out;
}

std::vector<uint8_t> gzipDecompress(const uint8_t* data, size_t len) {
  z_stream zs{};
  // windowBits 15 + 32 = automatic zlib/gzip header detection.
  if (inflateInit2(&zs, 15 + 32) != Z_OK) throw std::runtime_error("gzip: inflateInit2 failed");
  std::vector<uint8_t> out;
  out.resize(64 * 1024);
  zs.next_in = const_cast<Bytef*>(data);
  zs.avail_in = static_cast<uInt>(len);
  size_t used = 0;
  for (;;) {
    if (used == out.size()) out.resize(out.size() * 2);
    zs.next_out = out.data() + used;
    zs.avail_out = static_cast<uInt>(out.size() - used);
    const int rc = inflate(&zs, Z_NO_FLUSH);
    used = zs.total_out;
    if (rc == Z_STREAM_END) break;
    if (rc != Z_OK && rc != Z_BUF_ERROR) {
      inflateEnd(&zs);
      throw std::runtime_error("gzip: inflate failed");
    }
    if (rc == Z_BUF_ERROR && zs.avail_in == 0) {
      inflateEnd(&zs);
      throw std::runtime_error("gzip: truncated stream");
    }
  }
  inflateEnd(&zs);
  out.resize(used);
  return out;
}

}  // namespace ie
