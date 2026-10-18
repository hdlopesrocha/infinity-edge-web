// One match, one WebSocket connection: decodes Join/Input/Ping, drives the
// server Game at a fixed tick and encodes Scene/Snapshot/Events/Hud/Result.
//
// Wire layouts are documented in docs/protocol.md ("Game channel") and mirrored
// by src/game/protocol.ts on the client. Everything is binary; proto::encodeFrame
// applies the gzip rule.
#pragma once

#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

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
  void sendFrame(uint16_t type, const proto::Writer& w);

  void sendScene();
  void sendSnapshot();
  void sendEvents();
  void sendHud();
  void sendResult();
  void sendPong(uint32_t id);

  uint32_t idOf(Abstract3D* obj);
  bool isDynamic(Abstract3D* obj) const;
  uint16_t modelIndexOf(const ModelData* m) const;
  uint16_t teamIndexOf(Team* t) const;
  void writeSpawn(proto::Writer& w, Abstract3D* obj);
  void writePose(proto::Writer& w, Abstract3D* obj);
  void writeTransform(proto::Writer& w, const Vec3& pos, const Quat& rot, float scale);

  WsServer::ConnId conn_;
  WsServer* srv_;
  ModelTable* models_;
  LevelTable* levels_;
  uint32_t seed_;

  std::unique_ptr<Game> game_;
  SessionOptions options_;

  uint32_t nextId_ = 1;
  uint32_t tick_ = 0;
  uint32_t explosionSeed_ = 0;
  bool sceneSent_ = false;
  bool resultSent_ = false;
  bool leaving_ = false;

  std::map<const Abstract3D*, uint32_t> ids_;
  std::set<uint32_t> liveIds_;
  std::map<const ModelData*, uint16_t> modelIndex_;
  std::vector<const ModelData*> modelList_;
  std::vector<Team*> teamList_;
};

}  // namespace ie
