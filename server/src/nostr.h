// Nostr events + rooms + WebRTC signalling for the dedicated server.
//
// The wire formats are the ones the browser multiplayer mode uses
// (src/game/nostr/event.ts, docs/multiplayer.md):
//   kind 30333  addressable room event   (d = room id, t = ie3d-mp-room)
//   kind 25050  ephemeral signalling     (d = room id, p = recipient)
//   kind 5      NIP-09 room deletion
//
// RelayPool owns one outbound WebSocket client per relay (with reconnect) and
// hands received events to the caller through a thread-safe queue; everything
// in this header is plain data, no libdatachannel dependency.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "json.h"
#include "nostr_crypto.h"

namespace ie {
namespace nostr {

inline constexpr int kKindRoom = 30333;
inline constexpr int kKindSignal = 25050;
inline constexpr int kKindDelete = 5;
inline constexpr const char* kRoomTag = "ie3d-mp-room";

struct Event {
  std::string id;
  std::string pubkey;
  int64_t created_at = 0;
  int kind = 0;
  std::vector<std::vector<std::string>> tags;
  std::string content;
  std::string sig;

  std::string toJson() const;
  static bool fromJson(const Json& j, Event* out);
  bool verify() const;
};

/** Signs (and fills id/pubkey/sig) an event template. */
Event signEvent(int kind, std::vector<std::vector<std::string>> tags, const std::string& content,
                const Key32& sk, int64_t createdAt = 0);

// ------------------------------------------------------------------ rooms
struct RoomContent {
  int v = 1;
  std::string game;
  std::string type;
  std::string title;
  std::string host;
  int players = 1;
  int maxPlayers = 8;
  std::vector<std::string> ice;
  int64_t created = 0;
};

Event makeRoomEvent(const std::string& roomId, const RoomContent& content, int ttlSec,
                    const Key32& sk, int64_t now);
Event makeDeletionEvent(const std::string& roomId, const Key32& sk, int64_t now);

struct Candidate {
  std::string candidate;
  std::string sdpMid;
  int sdpMLineIndex = 0;
};

struct Signal {
  std::string kind;  // offer | answer | ice | bye
  std::string sdp;
  std::string name;
  std::vector<Candidate> candidates;
  std::string room;
  std::string to;
  std::string from;  // event author (filled by the caller)
};

Event makeSignalEvent(const std::string& roomId, const std::string& toPubkey, const Signal& signal,
                      const Key32& sk, int64_t now);

/** Parses a signalling event addressed to `me`; false when not ours/malformed. */
bool parseSignal(const Event& evt, const std::string& me, const std::string& roomId, Signal* out);

// -------------------------------------------------------------- relay pool
struct RelayEvent {
  std::string subscription;
  Event event;
};

class RelayPool {
 public:
  explicit RelayPool(std::vector<std::string> urls);
  ~RelayPool();

  void start();
  void stop();

  /** Adds/replaces a subscription (filters are NIP-01 JSON objects). */
  void subscribe(const std::string& subId, std::vector<Json> filters);
  void publish(const Event& evt);

  /** Thread-safe drain of the events received since the last call. */
  std::vector<RelayEvent> takeEvents();

  bool anyOpen() const;
  size_t openCount() const;
  size_t receivedOk() const { return okCount_; }
  size_t failedOk() const { return failedCount_; }

 private:
  struct Conn;
  std::vector<std::unique_ptr<Conn>> conns_;
  std::vector<std::pair<std::string, std::vector<Json>>> subs_;
  mutable std::mutex subsMutex_;
  mutable std::mutex eventsMutex_;
  std::vector<RelayEvent> events_;
  std::atomic<size_t> okCount_{0};
  std::atomic<size_t> failedCount_{0};
};

}  // namespace nostr
}  // namespace ie
