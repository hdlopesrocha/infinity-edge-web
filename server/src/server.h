// The game server: model/level tables, the session map, static file serving
// and the accept loop. main.cpp only parses the CLI into ServerConfig.
//
//   ws://host:port/game     one WebSocket per match (session.h)
//   http://host:port/*      the converted assets in `root` (the vite build's
//                           `public/`, so the C++ server can host the app)
#pragma once

#include <map>
#include <memory>
#include <string>

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
};

}  // namespace ie
