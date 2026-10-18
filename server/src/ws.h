// Minimal epoll WebSocket + static HTTP server.
//
// Only what the game server needs: RFC 6455 opening handshake, client-masked
// frame decoding (continuation, ping/pong, close), unmasked server frames, and
// a plain GET handler that serves the converted assets when the app is hosted
// by this process instead of `vite`. Single-threaded and non-blocking; every
// message is delivered whole to the callback.
#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace ie {

struct HttpRequest {
  std::string method;
  std::string path;      // decoded, without the query string
  std::string query;     // raw, after '?'
  std::string body;
  std::map<std::string, std::string> headers;  // lower-case keys
};

class WsServer {
 public:
  using ConnId = int;
  using OpenHandler = std::function<void(ConnId, const HttpRequest&)>;
  using MessageHandler = std::function<void(ConnId, const uint8_t*, size_t, bool binary)>;
  using CloseHandler = std::function<void(ConnId)>;
  /** Handles a plain HTTP request; return true when a response was written. */
  using HttpHandler = std::function<bool(ConnId, const HttpRequest&)>;

  /** Path that becomes a WebSocket (e.g. "/game"); everything else is HTTP. */
  void setWsPath(std::string path) { wsPath_ = std::move(path); }
  void setOpenHandler(OpenHandler h) { onOpen_ = std::move(h); }
  void setMessageHandler(MessageHandler h) { onMessage_ = std::move(h); }
  void setCloseHandler(CloseHandler h) { onClose_ = std::move(h); }
  void setHttpHandler(HttpHandler h) { onHttp_ = std::move(h); }
  void setMaxMessageBytes(size_t n) { maxMessage_ = n; }

  bool listen(const std::string& host, uint16_t port, std::string* err);
  /** Blocks until stop() is called. Ticks `onTick` every `tickMs` (matches ~30 fps). */
  void run(int tickMs, const std::function<void(int64_t nowMs)>& onTick);
  void stop();

  void sendBinary(ConnId c, const uint8_t* data, size_t len);
  void sendText(ConnId c, const std::string& text);
  void sendHttp(ConnId c, int status, const std::string& statusText,
                const std::string& contentType, const std::vector<uint8_t>& body,
                const std::vector<std::pair<std::string, std::string>>& extraHeaders = {});
  void closeConn(ConnId c);

  static int64_t nowMs();

 private:
  struct Conn {
    int fd = -1;
    bool ws = false;
    bool closing = false;
    std::vector<uint8_t> in;
    std::vector<uint8_t> out;
    size_t outSent = 0;
    bool wantWrite = false;
    // Frame assembly.
    bool fragmented = false;
    uint8_t fragmentOpcode = 0;
    std::vector<uint8_t> fragment;
  };

  void acceptLoop();
  void handleReadable(ConnId c);
  bool parseHttp(ConnId c, size_t* consumed);
  void tryHandshake(ConnId c, const HttpRequest& req);
  void parseFrames(ConnId c);
  void queueFrame(ConnId c, uint8_t opcode, const uint8_t* data, size_t len);
  void flushOut(ConnId c);
  void destroyConn(ConnId c, bool notify);
  Conn* get(ConnId c);

  int epfd_ = -1;
  int listenFd_ = -1;
  bool running_ = false;
  std::string wsPath_ = "/game";
  size_t maxMessage_ = 4 * 1024 * 1024;
  std::map<ConnId, Conn> conns_;
  int nextConnId_ = 1;

  OpenHandler onOpen_;
  MessageHandler onMessage_;
  CloseHandler onClose_;
  HttpHandler onHttp_;
};

/** Mime type for a static file path ("" when unknown). */
std::string mimeTypeFor(const std::string& path);

}  // namespace ie
