// gzip helpers for the framed protocol (zlib is the only external dependency).
//
// Both directions mirror the browser side (src/game/net.ts): the payload is
// gzipped as a whole, the flag in the frame header is the only signal, and a
// frame keeps its raw bytes when compression would not shrink it.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ie {

/** gzip-compress `data`; returns the compressed bytes (never fails silently: throws). */
std::vector<uint8_t> gzipCompress(const uint8_t* data, size_t len);

/** gunzip `data`; throws std::runtime_error when the stream is malformed. */
std::vector<uint8_t> gzipDecompress(const uint8_t* data, size_t len);

}  // namespace ie
