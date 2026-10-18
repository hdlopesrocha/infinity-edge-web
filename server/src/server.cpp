#include "server.h"

#include <cstdio>
#include <cstring>

namespace ie {

namespace {

constexpr int kTickMs = 33;  // ~30 Hz, matching the fixed simulation step

bool readFile(const std::string& path, std::vector<uint8_t>* out, std::string* err) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) {
    if (err) *err = "cannot open " + path;
    return false;
  }
  if (std::fseek(f, 0, SEEK_END) != 0) {
    std::fclose(f);
    if (err) *err = "cannot seek " + path;
    return false;
  }
  const long size = std::ftell(f);
  std::rewind(f);
  if (size < 0) {
    std::fclose(f);
    if (err) *err = "cannot stat " + path;
    return false;
  }
  out->resize(static_cast<size_t>(size));
  const size_t read = out->empty() ? 0 : std::fread(out->data(), 1, out->size(), f);
  std::fclose(f);
  if (read != out->size()) {
    if (err) *err = "short read on " + path;
    return false;
  }
  return true;
}

}  // namespace

GameServer::GameServer(ServerConfig cfg) : cfg_(std::move(cfg)) {}

GameServer::~GameServer() = default;

bool GameServer::init(std::string* err) {
  const std::string sim = cfg_.root + "/assets/models/SIM.json";
  if (!models_.load(sim, err)) return false;
  if (!levels_.load(cfg_.root + "/assets/levels", err)) return false;
  return true;
}

void GameServer::logLine(const std::string& line) {
  if (cfg_.quiet) return;
  std::printf("%s\n", line.c_str());
  std::fflush(stdout);
}

bool GameServer::serveStatic(WsServer::ConnId conn, const HttpRequest& req) {
  if (req.method != "GET" && req.method != "HEAD") {
    const std::string body = "405 method not allowed\n";
    ws_.sendHttp(conn, 405, "Method Not Allowed", "text/plain; charset=utf-8",
                 std::vector<uint8_t>(body.begin(), body.end()));
    return true;
  }
  std::string path = req.path;
  if (path.empty() || path == "/") path = "/index.html";
  if (path.find("..") != std::string::npos) {
    const std::string body = "400 bad path\n";
    ws_.sendHttp(conn, 400, "Bad Request", "text/plain; charset=utf-8",
                 std::vector<uint8_t>(body.begin(), body.end()));
    return true;
  }
  const std::string file = cfg_.root + path;
  std::vector<uint8_t> data;
  std::string err;
  if (!readFile(file, &data, &err)) {
    const std::string body = "404 not found\n";
    ws_.sendHttp(conn, 404, "Not Found", "text/plain; charset=utf-8",
                 std::vector<uint8_t>(body.begin(), body.end()));
    return true;
  }
  ws_.sendHttp(conn, 200, "OK", mimeTypeFor(path), data);
  return true;
}

void GameServer::onMessage(WsServer::ConnId conn, const uint8_t* data, size_t len) {
  auto it = sessions_.find(conn);
  if (it == sessions_.end()) return;
  Session* session = it->second.get();
  session->onMessage(data, len);
  if (session->leaving()) {
    // closeConn does not notify (the app initiated it), so drop it here: safe,
    // because Session::onMessage has returned.
    ws_.closeConn(conn);
    sessions_.erase(it);
  }
}

void GameServer::onClose(WsServer::ConnId conn) {
  auto it = sessions_.find(conn);
  if (it != sessions_.end()) {
    sessions_.erase(it);
    logLine("connection " + std::to_string(conn) + " closed");
  }
}

void GameServer::stop() { ws_.stop(); }

bool GameServer::run(std::string* err) {
  ws_.setWsPath(cfg_.wsPath);
  ws_.setOpenHandler([this](WsServer::ConnId conn, const HttpRequest& req) {
    (void)req;
    sessions_[conn] = std::make_unique<Session>(conn, &ws_, &models_, &levels_, cfg_.seed);
    logLine("connection " + std::to_string(conn) + " joined the game channel");
  });
  ws_.setMessageHandler([this](WsServer::ConnId conn, const uint8_t* data, size_t len, bool binary) {
    if (!binary) return;  // the game channel is binary-only
    onMessage(conn, data, len);
  });
  ws_.setCloseHandler([this](WsServer::ConnId conn) { onClose(conn); });
  ws_.setHttpHandler([this](WsServer::ConnId conn, const HttpRequest& req) {
    return serveStatic(conn, req);
  });
  if (!ws_.listen(cfg_.host, cfg_.port, err)) return false;
  logLine("listening on http://" + cfg_.host + ":" + std::to_string(cfg_.port) +
          "  (websocket: ws://" + cfg_.host + ":" + std::to_string(cfg_.port) + cfg_.wsPath + ")");
  ws_.run(kTickMs, [this](int64_t nowMs) {
    for (auto& kv : sessions_) kv.second->tick(nowMs);
  });
  return true;
}

}  // namespace ie
