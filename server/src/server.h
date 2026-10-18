// The game server: model/level tables, the session map, static file serving
// and the accept loop. main.cpp only parses the CLI into ServerConfig.
//
//   ws://host:port/game     one WebSocket per match (session.h)
//   http://host:port/*      the converted assets in `root` (the vite build's
//                           `public/`, so the C++ server can host the app)
#pragma once

#include <atomic>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "dedicated.h"
#include "session.h"
#include "sim.h"
#include "ws.h"

namespace ie {

struct ServerConfig {
  std::string host = "127.0.0.1";
  uint16_t port = 8091;
  std::string root = "public";
  std::string wsPath = "/game";
  uint32_t seed = 123456789u;
  bool quiet = false;

  // Dedicated multiplayer room (Nostr + WebRTC). `--room <level>` enables it:
  // the server publishes the room, accepts guests and runs the whole match
  // itself; it has no player of its own.
  bool dedicated = false;
  std::string roomLevel;
  std::string roomName = "Infinity Edge Server";
  int roomMax = 8;
  std::string nostrKeyFile = "ie-server-nostr.key";
  std::string nostrKeyHex;
  std::vector<std::string> nostrRelays;
  std::vector<std::string> iceServers;
  /** Testing hook: end each round after N seconds (0 = level goals). */
  int roomAutoFinishSec = 0;
};

class GameServer {
 public:
  explicit GameServer(ServerConfig cfg);
  ~GameServer();

  /** Loads `root/assets/models/SIM.json` and the level catalogue. */
  bool init(std::string* err);
  /** Blocking accept loop at ~30 Hz; returns when stop() was called. */
  bool run(std::string* err);
  void stop();
  /** Async-signal-safe: asks the run loop to wind down (SIGINT/SIGTERM). */
  static void requestStop();

 private:
  bool serveStatic(WsServer::ConnId conn, const HttpRequest& req);
  void onMessage(WsServer::ConnId conn, const uint8_t* data, size_t len);
  void onClose(WsServer::ConnId conn);
  void logLine(const std::string& line);

  ServerConfig cfg_;
  ModelTable models_;
  LevelTable levels_;
  WsServer ws_;
  std::map<WsServer::ConnId, std::unique_ptr<Session>> sessions_;
  std::unique_ptr<DedicatedRoom> room_;
  static std::atomic<bool> stopFlag_;
};

}  // namespace ie
