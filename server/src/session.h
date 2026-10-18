// One match, one WebSocket connection: decodes Join/Input/Ping, drives the
// server Game at a fixed tick and streams it through MatchStream (the same
// encoder the dedicated multiplayer room uses for its guests).
//
// Wire layouts are documented in docs/protocol.md ("Game channel") and mirrored
// by src/game/protocol.ts on the client. Everything is binary; proto::encodeFrame
// applies the gzip rule.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "match.h"
#include "proto.h"
#include "sim.h"
#include "ws.h"

namespace ie {

/** Options a Join frame contributes to the match. */
struct SessionOptions {
  std::string levelKey;
  bool smartAI = false;
  float playerDistance = 192;
  bool axisX = false;
  bool axisY = false;
};

class Session {
 public:
  Session(WsServer::ConnId conn, WsServer* srv, ModelTable* models, LevelTable* levels,
          uint32_t seed = 123456789u);
  ~Session();

  /** Decodes one client frame; malformed frames yield an Error message, an
   *  unknown message type is ignored (forward compatibility). */
  void onMessage(const uint8_t* data, size_t len);

  /** One 30 Hz server tick: advance the game (once joined) and send the
   *  per-tick Snapshot/Events/Hud (+ Result when the match ended). */
  void tick(int64_t nowMs);

  bool joined() const { return game_ != nullptr; }
  /** Set by a Leave frame; the owner closes the socket once onMessage returns. */
  bool leaving() const { return leaving_; }
  WsServer::ConnId conn() const { return conn_; }

 private:
  void handleJoin(proto::Reader& r);
  void handleInput(proto::Reader& r);
  void sendError(const std::string& message);
  void sendFrame(uint16_t type, const std::vector<uint8_t>& payload);
  void sendPong(uint32_t id);
  void sendEvents();

  WsServer::ConnId conn_;
  WsServer* srv_;
  ModelTable* models_;
  LevelTable* levels_;
  uint32_t seed_;

  std::unique_ptr<Game> game_;
  std::unique_ptr<MatchStream> stream_;
  PlayerView view_;
  TickEvents tickEvents_;
  SessionOptions options_;

  bool resultSent_ = false;
  bool leaving_ = false;
};

}  // namespace ie
