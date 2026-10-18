// ie-server: the authoritative 37_T game server.
//
//   ie-server [--host 127.0.0.1] [--port 8091] [--root public]
//             [--ws-path /game] [--seed 123456789] [--quiet]
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

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
    "  --help            this text\n";

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
    } else {
      std::fprintf(stderr, "unknown option: %s\n%s", a.c_str(), kUsage);
      return 2;
    }
  }

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
