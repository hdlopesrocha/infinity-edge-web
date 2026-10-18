// Game protocol: the same 8-byte frame header the asset channel uses, with
// binary payloads (docs/protocol.md, "Game channel").
//
// | 0 version | 1 flags (bit0 gzip) | 2-3 type | 4-7 payload length |
//
// Payloads are binary and gzip-compressed whenever that shrinks them (every
// frame above ~40 bytes); the flag is the only signal, exactly like the asset
// channel, so a receiver never guesses. Little-endian throughout.
#pragma once

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace ie {
namespace proto {

constexpr uint8_t VERSION = 1;
constexpr uint8_t FLAG_GZIP = 0x01;
constexpr size_t HEADER_SIZE = 8;
/** Below this size gzip always loses (header + trailer overhead); the game
 *  frames stay gzipped above it. */
constexpr size_t GZIP_THRESHOLD = 64;

enum MsgType : uint16_t {
  // Server -> client.
  Scene = 100,     // level metadata + every static entity + initial dynamics
  Snapshot = 101,  // dynamic entity poses + removals, every tick
  Events = 102,    // sounds, voices, explosions
  Hud = 103,       // match clock, team stats, player ship status
  Result = 104,    // match finished
  Pong = 105,
  // Client -> server.
  Join = 110,
  Input = 111,
  Leave = 112,
  Ping = 113,
  // Both.
  Error = 0xffff,
};

/** Object kinds on the wire (the client maps them to its render classes). */
enum ObKindWire : uint8_t {
  WKindShip = 0,
  WKindAsteroid = 1,
  WKindAddon = 2,
  WKindBase = 3,
  WKindFlag = 4,
  WKindBullet = 5,
  WKindMissile = 6,
  WKindArk = 7,
  WKindBillboard = 8,
  WKindSun = 9,
  WKindRegion = 10,
};

/** Addon kinds (WKindAddon `state`). */
enum AddonWire : uint8_t {
  WAddonHoming = 0,
  WAddonLife = 1,
  WAddonNitro = 2,
  WAddonShield = 3,
};

/** Flag states (WKindFlag `state`). */
enum FlagWire : uint8_t {
  WFlagAtBase = 0,
  WFlagCarried = 1,
  WFlagFree = 2,
};

/** Event types (Events frame records). */
enum EventType : uint8_t {
  EvSound = 0,      // u8 id, u8 volume, i8 pan
  EvVoice = 1,      // str field (audio.voice text table)
  EvExplosion = 2,  // f32 pos[3], f32 scale, u16 life, u8 smoke, u8 debris, u16 modelIdx, u32 seed
};

// Join flags.
constexpr uint8_t JOIN_SMART_AI = 0x01;

/** Framed payload; `compress` applies the asset-channel rule (>= threshold, only
 *  when the result is strictly smaller). */
std::vector<uint8_t> encodeFrame(uint16_t type, const uint8_t* payload, size_t len,
                                 bool compress = true);

struct DecodedFrame {
  uint16_t type = 0;
  std::vector<uint8_t> payload;
};

/** Validates the header, checks the version and gunzips when flagged. */
DecodedFrame decodeFrame(const uint8_t* data, size_t len);

/** Little-endian payload writer. */
class Writer {
 public:
  void u8(uint8_t v) { b_.push_back(v); }
  void i8(int8_t v) { b_.push_back(static_cast<uint8_t>(v)); }
  void u16(uint16_t v) {
    b_.push_back(static_cast<uint8_t>(v & 0xFF));
    b_.push_back(static_cast<uint8_t>(v >> 8));
  }
  void i16(int16_t v) { u16(static_cast<uint16_t>(v)); }
  void u32(uint32_t v) {
    for (int i = 0; i < 4; i++) b_.push_back(static_cast<uint8_t>((v >> (i * 8)) & 0xFF));
  }
  void i32(int32_t v) { u32(static_cast<uint32_t>(v)); }
  void f32(float v) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    u32(bits);
  }
  void str(const std::string& s) {
    u16(static_cast<uint16_t>(s.size()));
    b_.insert(b_.end(), s.begin(), s.end());
  }
  void bytes(const std::vector<uint8_t>& v) { b_.insert(b_.end(), v.begin(), v.end()); }
  void raw(const uint8_t* p, size_t n) { b_.insert(b_.end(), p, p + n); }

  const std::vector<uint8_t>& data() const { return b_; }
  std::vector<uint8_t> take() { return std::move(b_); }
  size_t size() const { return b_.size(); }

 private:
  std::vector<uint8_t> b_;
};

/** Little-endian payload reader; every read validates the bounds. */
class Reader {
 public:
  Reader(const uint8_t* data, size_t len) : p_(data), n_(len) {}

  uint8_t u8() {
    need(1);
    return p_[i_++];
  }
  int8_t i8() { return static_cast<int8_t>(u8()); }
  uint16_t u16() {
    need(2);
    const uint16_t v = static_cast<uint16_t>(p_[i_] | (p_[i_ + 1] << 8));
    i_ += 2;
    return v;
  }
  int16_t i16() { return static_cast<int16_t>(u16()); }
  uint32_t u32() {
    need(4);
    uint32_t v = 0;
    for (int k = 0; k < 4; k++) v |= static_cast<uint32_t>(p_[i_ + k]) << (k * 8);
    i_ += 4;
    return v;
  }
  int32_t i32() { return static_cast<int32_t>(u32()); }
  float f32() {
    const uint32_t bits = u32();
    float v;
    std::memcpy(&v, &bits, 4);
    return v;
  }
  std::string str() {
    const uint16_t len = u16();
    need(len);
    std::string s(reinterpret_cast<const char*>(p_ + i_), len);
    i_ += len;
    return s;
  }
  bool eof() const { return i_ >= n_; }
  size_t remaining() const { return n_ - i_; }

 private:
  void need(size_t k) {
    if (i_ + k > n_) throw std::runtime_error("proto: truncated payload");
  }
  const uint8_t* p_;
  size_t n_;
  size_t i_ = 0;
};

/** Position quantisation: the arena is a cube of `size` units; i16 covers it
 *  with ~size/65536 units per step (2048 -> 0.03 u), which is far below the
 *  collision radii and keeps snapshots small enough for gzip to work well. */
inline int16_t quantPos(float v, float half) {
  const float s = 32767.0f / (half <= 0 ? 1.0f : half);
  const float q = v * s;
  return static_cast<int16_t>(q < -32767.0f ? -32767.0f : (q > 32767.0f ? 32767.0f : q));
}
inline float dequantPos(int16_t v, float half) {
  return static_cast<float>(v) * (half / 32767.0f);
}
inline int16_t quantRot(float v) {
  const float q = v * 32767.0f;
  return static_cast<int16_t>(q < -32767.0f ? -32767.0f : (q > 32767.0f ? 32767.0f : q));
}
inline float dequantRot(int16_t v) { return static_cast<float>(v) / 32767.0f; }

}  // namespace proto
}  // namespace ie
