// Dedicated multiplayer room: the server creates the game, publishes it on
// Nostr, answers WebRTC offers and streams the authoritative match to every
// guest. It has no player of its own - all collision/physics/AI runs here and
// the clients only render the frames (Scene/Snapshot/Events/Hud/Result).
//
// The room and signalling wire formats are the browser multiplayer's
// (docs/multiplayer.md); the frames are the C++ game channel
// (docs/protocol.md, MatchStream). libdatachannel is only used in
// dedicated.cpp, so the simulation library stays WebRTC-free.
#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "match.h"
#include "nostr.h"
#include "sim.h"

namespace rtc {
class DataChannel;
class PeerConnection;
}  // namespace rtc

namespace ie {

struct DedicatedConfig {
  std::string levelKey;
  std::string name = "Infinity Edge Server";
  int maxPlayers = 8;
  std::vector<std::string> relays;
  std::vector<std::string> iceServers;
  /** Persisted Nostr key (hex). Empty = generated and stored in `keyFile`. */
  std::string keyHex;
  std::string keyFile;
  uint32_t seed = 123456789u;
  /** Testing hook: finish the round after N seconds (0 = normal goals). */
  int autoFinishSec = 0;
};

class DedicatedRoom {
 public:
  DedicatedRoom(DedicatedConfig cfg, ModelTable* models, LevelTable* levels);
  ~DedicatedRoom();

  bool start(std::string* err);
  /** Called from the server's 30 Hz loop. */
  void tick(int64_t nowMs);
  /** Closes the room event and every peer (idempotent). */
  void shutdown();

  bool active() const { return active_; }
  std::string roomId() const { return roomId_; }
  std::string statusJson() const;
  /** Ends the current round now (ops / the e2e's deterministic finish). */
  void requestFinish() { finishRequested_ = true; }

 private:
  struct Guest {
    bool authed = false;
    std::string pubkey;
    std::string name;
    std::shared_ptr<rtc::DataChannel> channel;
    PlayerView view;
    PlayerInput input;
    bool axisX = false;
    bool axisY = false;
    int64_t lastInputAt = 0;
    bool joined = false;
    bool resultSent = false;
    std::unique_ptr<Command> savedIntelligence;
    bool spawned = false;
    SpaceShip* ship = nullptr;
  };

  struct Peer {
    std::string pubkey;
    std::string name;
    std::shared_ptr<rtc::PeerConnection> pc;
    /** Candidates gathered locally: published after the answer. */
    std::vector<nostr::Candidate> localCandidates;
    bool answered = false;
    int64_t lastFlushMs = 0;
  };

  enum class RtcEventType { Channel, Message, Closed, Candidate, Description, State };
  struct RtcEvent {
    RtcEventType type = RtcEventType::Message;
    std::string pubkey;
    std::string text;       // description sdp / state
    std::vector<uint8_t> data;
    std::shared_ptr<rtc::DataChannel> channel;
  };

  bool loadKey(std::string* err);
  bool createMatch(std::string* err);
  void publishRoom();
  void publishDeletion();
  void subscribeSignals();

  void drainRelay(int64_t nowMs);
  void drainRtc(int64_t nowMs);
  void handleOffer(const nostr::Event& evt, const nostr::Signal& sig);
  void attachChannel(const std::string& pubkey, const std::shared_ptr<rtc::DataChannel>& channel);
  void removeGuest(std::string pubkey);
  void handleFrame(Guest& guest, const std::vector<uint8_t>& data);
  void handleJoin(Guest& guest, proto::Reader& r);
  void assignShip(Guest& guest);
  void releaseShip(Guest& guest);
  void flushCandidates(int64_t nowMs);
  void sendSignal(const std::string& to, const std::string& kind, const std::string& sdp,
                  const std::vector<nostr::Candidate>& candidates, const std::string& sig = "");

  void tickMatch(int64_t nowMs);
  void fanOut();
  void sendFrame(Guest& guest, uint16_t type, const std::vector<uint8_t>& payload);
  void sendError(Guest& guest, const std::string& message);
  Guest* guestFor(const SpaceObject* ship);
  void installHooks();

  DedicatedConfig cfg_;
  ModelTable* models_;
  LevelTable* levels_;

  nostr::Key32 key_{};
  std::string pubkeyHex_;
  std::unique_ptr<nostr::P256> p256_;
  nostr::HostCert cert_;
  std::unique_ptr<nostr::RelayPool> relay_;
  std::string roomId_;
  int64_t created_ = 0;
  int64_t levelCreatedAtMs_ = 0;

  std::unique_ptr<Game> game_;
  std::unique_ptr<MatchStream> stream_;
  PlayerHooks hooks_{};
  TickEvents tickEvents_;

  std::map<std::string, Guest> guests_;
  std::map<std::string, Peer> peers_;
  /** Guest candidates that arrived before their offer. */
  std::map<std::string, std::vector<nostr::Candidate>> earlyCandidates_;

  std::mutex rtcMutex_;
  std::vector<RtcEvent> rtcEvents_;

  bool active_ = false;
  bool matchRunning_ = false;
  bool finishedSent_ = false;
  std::atomic<bool> finishRequested_{false};
  int64_t restartAtMs_ = 0;
  int64_t closeAtMs_ = 0;
  int64_t lastHeartbeatMs_ = 0;
  int64_t lastJoinAcceptedMs_ = 0;
  uint32_t round_ = 0;
};

}  // namespace ie
