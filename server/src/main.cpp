// ie-server: the authoritative 37_T game server.
//
//   ie-server [--host 127.0.0.1] [--port 8091] [--root public]
//             [--ws-path /game] [--seed 123456789] [--quiet]
//             [--room <level> --room-name <name> --room-max <n>
//              --nostr-relay <url> --nostr-key-file <path> --stun <url>]
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "server.h"

namespace {

const char* kUsage =
    "usage: ie-server [options]\n"
    "  --host <addr>     bind address (default 127.0.0.1)\n"
    "  --port <n>        listen port (default 8091)\n"
    "  --root <dir>      static file root (default public)\n"
    "  --ws-path <path>  websocket path (default /game)\n"
    "  --seed <n>        simulation RNG seed (default 123456789)\n"
    "  --quiet           do not log connections\n"
    "\n"
    "dedicated multiplayer room (the server is the host, it does not play):\n"
    "  --room <level>    create a room for this level (e.g. ctf-easy)\n"
    "  --room-name <s>   host name shown in the lobby (default Infinity Edge Server)\n"
    "  --room-max <n>    maximum guests (default 8)\n"
    "  --nostr-relay <u> comma-separated relay list\n"
    "                    (default wss://nos.lol,wss://relay.snort.social)\n"
    "  --nostr-key-file  where the room identity key is kept\n"
    "                    (default ie-server-nostr.key)\n"
    "  --nostr-key <hex> fixed identity key (overrides the key file)\n"
    "  --stun <url>      comma-separated ICE servers\n"
    "                    (default stun:stun.l.google.com:19302)\n"
    "  --auto-finish <s> testing: end every round after s seconds\n"
    "  --help            this text\n";

/** Splits a comma-separated option value. */
std::vector<std::string> splitList(const std::string& value) {
  std::vector<std::string> out;
  size_t start = 0;
  while (start <= value.size()) {
    const size_t comma = value.find(',', start);
    const size_t end = comma == std::string::npos ? value.size() : comma;
    std::string piece = value.substr(start, end - start);
    while (!piece.empty() && (piece.front() == ' ' || piece.front() == '\t')) piece.erase(piece.begin());
    while (!piece.empty() && (piece.back() == ' ' || piece.back() == '\t')) piece.pop_back();
    if (!piece.empty()) out.push_back(piece);
    if (comma == std::string::npos) break;
    start = comma + 1;
  }
  return out;
}

void onSignal(int) { ie::GameServer::requestStop(); }

}  // namespace

int main(int argc, char** argv) {
  ie::ServerConfig cfg;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto value = [&](const char* name) -> const char* {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "ie-server: missing value for %s\n", name);
        return nullptr;
      }
      return argv[++i];
    };
    if (a == "--help" || a == "-h") {
      std::printf("%s", kUsage);
      return 0;
    } else if (a == "--host") {
      const char* v = value("--host");
      if (!v) return 2;
      cfg.host = v;
    } else if (a == "--port") {
      const char* v = value("--port");
      if (!v) return 2;
      cfg.port = static_cast<uint16_t>(std::atoi(v));
    } else if (a == "--root") {
      const char* v = value("--root");
      if (!v) return 2;
      cfg.root = v;
    } else if (a == "--ws-path") {
      const char* v = value("--ws-path");
      if (!v) return 2;
      cfg.wsPath = v;
    } else if (a == "--seed") {
      const char* v = value("--seed");
      if (!v) return 2;
      cfg.seed = static_cast<uint32_t>(std::strtoul(v, nullptr, 10));
    } else if (a == "--quiet") {
      cfg.quiet = true;
    } else if (a == "--room") {
      const char* v = value("--room");
      if (!v) return 2;
      cfg.dedicated = true;
      cfg.roomLevel = v;
    } else if (a == "--room-name") {
      const char* v = value("--room-name");
      if (!v) return 2;
      cfg.roomName = v;
    } else if (a == "--room-max") {
      const char* v = value("--room-max");
      if (!v) return 2;
      cfg.roomMax = std::atoi(v);
      if (cfg.roomMax < 2 || cfg.roomMax > 32) {
        std::fprintf(stderr, "ie-server: --room-max must be 2..32\n");
        return 2;
      }
    } else if (a == "--nostr-relay") {
      const char* v = value("--nostr-relay");
      if (!v) return 2;
      cfg.nostrRelays = splitList(v);
    } else if (a == "--nostr-key-file") {
      const char* v = value("--nostr-key-file");
      if (!v) return 2;
      cfg.nostrKeyFile = v;
    } else if (a == "--nostr-key") {
      const char* v = value("--nostr-key");
      if (!v) return 2;
      cfg.nostrKeyHex = v;
    } else if (a == "--stun") {
      const char* v = value("--stun");
      if (!v) return 2;
      cfg.iceServers = splitList(v);
    } else if (a == "--auto-finish") {
      const char* v = value("--auto-finish");
      if (!v) return 2;
      cfg.roomAutoFinishSec = std::atoi(v);
    } else {
      std::fprintf(stderr, "unknown option: %s\n%s", a.c_str(), kUsage);
      return 2;
    }
  }

  if (cfg.dedicated) {
    if (cfg.nostrRelays.empty()) {
      cfg.nostrRelays = {"wss://nos.lol", "wss://relay.snort.social"};
    }
    if (cfg.iceServers.empty()) {
      cfg.iceServers = {"stun:stun.l.google.com:19302"};
    }
  }
  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  ie::GameServer server(std::move(cfg));
  std::string err;
  if (!server.init(&err)) {
    std::fprintf(stderr, "ie-server: %s\n", err.c_str());
    return 1;
  }
  if (!server.run(&err)) {
    std::fprintf(stderr, "ie-server: %s\n", err.c_str());
    return 1;
  }
  return 0;
}
