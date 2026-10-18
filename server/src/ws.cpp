#include "ws.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <cstdio>
#include <stdexcept>

#include "crypto.h"

namespace ie {

namespace {

constexpr const char* kWsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
constexpr size_t kMaxHeaderBytes = 64 * 1024;

bool setNonBlocking(int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  return flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}

std::string lower(const std::string& s) {
  std::string out = s;
  for (char& c : out) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) a++;
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) b--;
  return s.substr(a, b - a);
}

std::string urlDecode(const std::string& s) {
  std::string out;
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == '%' && i + 2 < s.size()) {
      const int hi = std::isxdigit(static_cast<unsigned char>(s[i + 1])) ? std::stoi(s.substr(i + 1, 1), nullptr, 16) : -1;
      const int lo = std::isxdigit(static_cast<unsigned char>(s[i + 2])) ? std::stoi(s.substr(i + 2, 1), nullptr, 16) : -1;
      if (hi >= 0 && lo >= 0) {
        out.push_back(static_cast<char>((hi << 4) | lo));
        i += 2;
        continue;
      }
    }
    out.push_back(s[i]);
  }
  return out;
}

}  // namespace

std::string mimeTypeFor(const std::string& path) {
  const size_t dot = path.rfind('.');
  if (dot == std::string::npos) return "application/octet-stream";
  const std::string ext = lower(path.substr(dot));
  if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
  if (ext == ".js" || ext == ".mjs") return "text/javascript";
  if (ext == ".css") return "text/css";
  if (ext == ".json") return "application/json";
  if (ext == ".png") return "image/png";
  if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
  if (ext == ".svg") return "image/svg+xml";
  if (ext == ".ico") return "image/x-icon";
  if (ext == ".wav") return "audio/wav";
  if (ext == ".mp3") return "audio/mpeg";
  if (ext == ".txt") return "text/plain; charset=utf-8";
  if (ext == ".bin") return "application/octet-stream";
  return "application/octet-stream";
}

int64_t WsServer::nowMs() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return static_cast<int64_t>(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

bool WsServer::listen(const std::string& host, uint16_t port, std::string* err) {
  listenFd_ = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (listenFd_ < 0) {
    if (err) *err = std::string("socket: ") + strerror(errno);
    return false;
  }
  const int one = 1;
  setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  if (inet_pton(AF_INET, host.c_str(), &addr.sin_addr) != 1) {
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  }
  if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    if (err) *err = std::string("bind ") + host + ":" + std::to_string(port) + ": " + strerror(errno);
    ::close(listenFd_);
    listenFd_ = -1;
    return false;
  }
  if (::listen(listenFd_, 64) != 0) {
    if (err) *err = std::string("listen: ") + strerror(errno);
    ::close(listenFd_);
    listenFd_ = -1;
    return false;
  }
  if (!setNonBlocking(listenFd_)) {
    if (err) *err = "fcntl(O_NONBLOCK) failed";
    return false;
  }
  epfd_ = epoll_create1(EPOLL_CLOEXEC);
  if (epfd_ < 0) {
    if (err) *err = std::string("epoll_create1: ") + strerror(errno);
    return false;
  }
  epoll_event ev{};
  ev.events = EPOLLIN;
  ev.data.fd = listenFd_;
  epoll_ctl(epfd_, EPOLL_CTL_ADD, listenFd_, &ev);
  return true;
}

WsServer::Conn* WsServer::get(ConnId c) {
  auto it = conns_.find(c);
  return it == conns_.end() ? nullptr : &it->second;
}

void WsServer::acceptLoop() {
  for (;;) {
    sockaddr_in peer{};
    socklen_t len = sizeof(peer);
    const int fd = accept4(listenFd_, reinterpret_cast<sockaddr*>(&peer), &len, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (fd < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) return;
      if (errno == EINTR) continue;
      return;
    }
    const int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
    const int id = nextConnId_++;
    Conn& conn = conns_[id];
    conn.fd = fd;
    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = fd;
    epoll_ctl(epfd_, EPOLL_CTL_ADD, fd, &ev);
  }
}

void WsServer::run(int tickMs, const std::function<void(int64_t)>& onTick) {
  running_ = true;
  const int maxEvents = 64;
  std::vector<epoll_event> events(maxEvents);
  int64_t lastTick = nowMs();
  while (running_) {
    const int n = epoll_wait(epfd_, events.data(), maxEvents, tickMs);
    if (n < 0 && errno != EINTR) break;
    for (int i = 0; i < n; i++) {
      const int fd = events[i].data.fd;
      const uint32_t evs = events[i].events;
      if (fd == listenFd_) {
        acceptLoop();
        continue;
      }
      // Find the connection id for this fd.
      ConnId id = -1;
      for (auto& [cid, conn] : conns_) {
        if (conn.fd == fd) {
          id = cid;
          break;
        }
      }
      if (id < 0) continue;
      if (evs & (EPOLLHUP | EPOLLERR)) {
        destroyConn(id, true);
        continue;
      }
      if (evs & EPOLLIN) {
        handleReadable(id);
        if (!get(id)) continue;
      }
      if (evs & EPOLLOUT) {
        Conn* c = get(id);
        if (c) {
          c->wantWrite = false;
          flushOut(id);
        }
      }
    }
    const int64_t now = nowMs();
    if (now - lastTick > tickMs * 10) lastTick = now - tickMs;  // never burst a backlog
    while (now - lastTick >= tickMs) {
      lastTick += tickMs;
      onTick(now);
    }
  }
  // Shut down: close every connection.
  while (!conns_.empty()) destroyConn(conns_.begin()->first, true);
  if (listenFd_ >= 0) {
    epoll_ctl(epfd_, EPOLL_CTL_DEL, listenFd_, nullptr);
    ::close(listenFd_);
    listenFd_ = -1;
  }
  if (epfd_ >= 0) {
    ::close(epfd_);
    epfd_ = -1;
  }
}

void WsServer::stop() { running_ = false; }

void WsServer::handleReadable(ConnId id) {
  Conn* c = get(id);
  if (!c) return;
  uint8_t buf[16 * 1024];
  for (;;) {
    const ssize_t n = ::recv(c->fd, buf, sizeof(buf), 0);
    if (n > 0) {
      c->in.insert(c->in.end(), buf, buf + n);
      if (c->in.size() > maxMessage_ + kMaxHeaderBytes) {
        destroyConn(id, true);
        return;
      }
      continue;
    }
    if (n == 0) {
      destroyConn(id, true);
      return;
    }
    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
    if (errno == EINTR) continue;
    destroyConn(id, true);
    return;
  }
  // Consume as much as possible.
  size_t consumed = 0;
  if (!get(id)) return;
  if (!get(id)->ws) {
    if (!parseHttp(id, &consumed)) {
      // Incomplete request: wait for more. (A malformed request line destroys
      // the connection inside parseHttp, hence the re-check.)
      Conn* cur = get(id);
      if (!cur) return;
      cur->in.erase(cur->in.begin(), cur->in.begin() + static_cast<long>(consumed));
      return;
    }
    Conn* cur = get(id);
    if (!cur) return;
    cur->in.erase(cur->in.begin(), cur->in.begin() + static_cast<long>(consumed));
  }
  parseFrames(id);
}

bool WsServer::parseHttp(ConnId id, size_t* consumed) {
  Conn* c = get(id);
  if (!c) return false;
  const std::string data(reinterpret_cast<const char*>(c->in.data()), c->in.size());
  const size_t headEnd = data.find("\r\n\r\n");
  if (headEnd == std::string::npos) {
    if (data.size() > kMaxHeaderBytes) destroyConn(id, true);
    return false;
  }
  HttpRequest req;
  size_t lineEnd = data.find("\r\n");
  const std::string requestLine = data.substr(0, lineEnd);
  {
    const size_t sp1 = requestLine.find(' ');
    const size_t sp2 = sp1 == std::string::npos ? std::string::npos : requestLine.find(' ', sp1 + 1);
    if (sp1 == std::string::npos || sp2 == std::string::npos) {
      closeConn(id);
      return false;
    }
    req.method = requestLine.substr(0, sp1);
    std::string target = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);
    const size_t q = target.find('?');
    req.path = urlDecode(q == std::string::npos ? target : target.substr(0, q));
    req.query = q == std::string::npos ? "" : target.substr(q + 1);
  }
  size_t pos = lineEnd + 2;
  while (pos < headEnd) {
    const size_t end = data.find("\r\n", pos);
    const std::string line = data.substr(pos, end - pos);
    const size_t colon = line.find(':');
    if (colon != std::string::npos) {
      req.headers[lower(trim(line.substr(0, colon)))] = trim(line.substr(colon + 1));
    }
    pos = end + 2;
  }
  // Body (only for Content-Length requests; the game protocol is WS-only).
  size_t bodyLen = 0;
  auto cl = req.headers.find("content-length");
  if (cl != req.headers.end()) bodyLen = static_cast<size_t>(std::strtoul(cl->second.c_str(), nullptr, 10));
  if (data.size() < headEnd + 4 + bodyLen) return false;
  req.body = data.substr(headEnd + 4, bodyLen);
  *consumed = headEnd + 4 + bodyLen;

  const bool wantsUpgrade = req.headers.count("upgrade") > 0 &&
                            lower(req.headers["upgrade"]).find("websocket") != std::string::npos;
  if (wantsUpgrade && req.path == wsPath_) {
    tryHandshake(id, req);
    return true;
  }
  if (onHttp_ && onHttp_(id, req)) return true;
  static const std::string kNotFound = "404 not found\n";
  sendHttp(id, 404, "Not Found", "text/plain; charset=utf-8",
           std::vector<uint8_t>(kNotFound.begin(), kNotFound.end()));
  return true;
}

void WsServer::tryHandshake(ConnId id, const HttpRequest& req) {
  Conn* c = get(id);
  if (!c) return;
  auto it = req.headers.find("sec-websocket-key");
  auto ver = req.headers.find("sec-websocket-version");
  if (it == req.headers.end() || ver == req.headers.end() || ver->second != "13") {
    static const std::string kBad = "400 bad websocket request\n";
    sendHttp(id, 400, "Bad Request", "text/plain; charset=utf-8",
             std::vector<uint8_t>(kBad.begin(), kBad.end()));
    return;
  }
  const std::string accept = base64Encode(sha1(it->second + kWsGuid));
  std::string reply =
      "HTTP/1.1 101 Switching Protocols\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
  c->out.insert(c->out.end(), reply.begin(), reply.end());
  c->ws = true;
  flushOut(id);
  if (get(id) && onOpen_) onOpen_(id, req);
  // No parseFrames here: the HTTP request bytes are still in the input buffer
  // (handleReadable consumes them after parseHttp returns, then calls it).
}

void WsServer::parseFrames(ConnId id) {
  for (;;) {
    Conn* c = get(id);
    if (!c || !c->ws) return;
    if (c->in.size() < 2) return;
    const uint8_t* p = c->in.data();
    const bool fin = (p[0] & 0x80) != 0;
    const uint8_t rsv = p[0] & 0x70;
    const uint8_t opcode = p[0] & 0x0F;
    const bool masked = (p[1] & 0x80) != 0;
    uint64_t len = p[1] & 0x7F;
    size_t header = 2;
    if (rsv != 0 || !masked) {  // clients must mask; no extensions negotiated
      destroyConn(id, true);
      return;
    }
    if (len == 126) {
      if (c->in.size() < 4) return;
      len = (static_cast<uint64_t>(p[2]) << 8) | p[3];
      header = 4;
    } else if (len == 127) {
      if (c->in.size() < 10) return;
      len = 0;
      for (int i = 0; i < 8; i++) len = (len << 8) | p[2 + i];
      header = 10;
    }
    if (len > maxMessage_) {
      destroyConn(id, true);
      return;
    }
    if (c->in.size() < header + 4 + len) return;
    const uint8_t* mask = c->in.data() + header;
    const uint8_t* src = c->in.data() + header + 4;
    std::vector<uint8_t> payload(static_cast<size_t>(len));
    for (size_t i = 0; i < payload.size(); i++) payload[i] = src[i] ^ mask[i & 3];
    c->in.erase(c->in.begin(), c->in.begin() + static_cast<long>(header + 4 + len));

    switch (opcode) {
      case 0x8:  // close: echo and shut down
        queueFrame(id, 0x8, payload.data(), payload.size());
        flushOut(id);
        destroyConn(id, true);
        return;
      case 0x9:  // ping -> pong
        queueFrame(id, 0xA, payload.data(), payload.size());
        flushOut(id);
        continue;
      case 0xA:  // pong
        continue;
      case 0x0: {  // continuation
        if (!c->fragmented) {
          destroyConn(id, true);
          return;
        }
        c->fragment.insert(c->fragment.end(), payload.begin(), payload.end());
        if (c->fragment.size() > maxMessage_) {
          destroyConn(id, true);
          return;
        }
        if (fin) {
          const uint8_t finalOp = c->fragmentOpcode;
          std::vector<uint8_t> message;
          message.swap(c->fragment);
          c->fragmented = false;
          if (onMessage_) onMessage_(id, message.data(), message.size(), finalOp == 0x2);
          if (!get(id)) return;
        }
        continue;
      }
      case 0x1:
      case 0x2:
        if (!fin) {
          c->fragmented = true;
          c->fragmentOpcode = opcode;
          c->fragment = std::move(payload);
          continue;
        }
        if (onMessage_) onMessage_(id, payload.data(), payload.size(), opcode == 0x2);
        if (!get(id)) return;
        continue;
      default:
        destroyConn(id, true);
        return;
    }
  }
}

void WsServer::queueFrame(ConnId id, uint8_t opcode, const uint8_t* data, size_t len) {
  Conn* c = get(id);
  if (!c || c->closing) return;
  std::vector<uint8_t> frame;
  frame.push_back(static_cast<uint8_t>(0x80 | opcode));
  if (len < 126) {
    frame.push_back(static_cast<uint8_t>(len));
  } else if (len <= 0xFFFF) {
    frame.push_back(126);
    frame.push_back(static_cast<uint8_t>(len >> 8));
    frame.push_back(static_cast<uint8_t>(len & 0xFF));
  } else {
    frame.push_back(127);
    for (int i = 7; i >= 0; i--) frame.push_back(static_cast<uint8_t>((static_cast<uint64_t>(len) >> (i * 8)) & 0xFF));
  }
  frame.insert(frame.end(), data, data + len);
  c->out.insert(c->out.end(), frame.begin(), frame.end());
}

void WsServer::flushOut(ConnId id) {
  Conn* c = get(id);
  if (!c) return;
  while (c->outSent < c->out.size()) {
    const ssize_t n = ::send(c->fd, c->out.data() + c->outSent, c->out.size() - c->outSent, MSG_NOSIGNAL);
    if (n > 0) {
      c->outSent += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (!c->wantWrite) {
        c->wantWrite = true;
        epoll_event ev{};
        ev.events = EPOLLIN | EPOLLOUT;
        ev.data.fd = c->fd;
        epoll_ctl(epfd_, EPOLL_CTL_MOD, c->fd, &ev);
      }
      return;
    }
    if (n < 0 && errno == EINTR) continue;
    destroyConn(id, true);
    return;
  }
  c->out.clear();
  c->outSent = 0;
  if (c->wantWrite) {
    c->wantWrite = false;
    epoll_event ev{};
    ev.events = EPOLLIN;
    ev.data.fd = c->fd;
    epoll_ctl(epfd_, EPOLL_CTL_MOD, c->fd, &ev);
  }
}

void WsServer::sendBinary(ConnId id, const uint8_t* data, size_t len) {
  Conn* c = get(id);
  if (!c || !c->ws) return;
  queueFrame(id, 0x2, data, len);
  flushOut(id);
}

void WsServer::sendText(ConnId id, const std::string& text) {
  Conn* c = get(id);
  if (!c || !c->ws) return;
  queueFrame(id, 0x1, reinterpret_cast<const uint8_t*>(text.data()), text.size());
  flushOut(id);
}

void WsServer::sendHttp(ConnId id, int status, const std::string& statusText,
                        const std::string& contentType, const std::vector<uint8_t>& body,
                        const std::vector<std::pair<std::string, std::string>>& extraHeaders) {
  Conn* c = get(id);
  if (!c) return;
  std::string head = "HTTP/1.1 " + std::to_string(status) + " " + statusText + "\r\n";
  head += "Content-Type: " + contentType + "\r\n";
  head += "Content-Length: " + std::to_string(body.size()) + "\r\n";
  head += "Connection: close\r\n";
  head += "Access-Control-Allow-Origin: *\r\n";
  for (const auto& [k, v] : extraHeaders) head += k + ": " + v + "\r\n";
  head += "\r\n";
  c->out.insert(c->out.end(), head.begin(), head.end());
  c->out.insert(c->out.end(), body.begin(), body.end());
  c->closing = true;  // close after the response
  flushOut(id);
  destroyConn(id, false);
}

void WsServer::closeConn(ConnId id) {
  Conn* c = get(id);
  if (!c) return;
  static const uint8_t kClose[2] = {0x03, 0xE8};  // 1000 normal closure
  if (c->ws) {
    queueFrame(id, 0x8, kClose, sizeof(kClose));
    flushOut(id);
  }
  destroyConn(id, false);
}

void WsServer::destroyConn(ConnId id, bool notify) {
  auto it = conns_.find(id);
  if (it == conns_.end()) return;
  const int fd = it->second.fd;
  const bool wasWs = it->second.ws;
  const bool haveOut = !it->second.out.empty() &&
                       (it->second.closing || it->second.ws);
  if (haveOut) {
    // Best effort: try one last blocking-ish write of what is queued.
    size_t sent = it->second.outSent;
    while (sent < it->second.out.size()) {
      const ssize_t n = ::send(fd, it->second.out.data() + sent, it->second.out.size() - sent, MSG_NOSIGNAL);
      if (n > 0) {
        sent += static_cast<size_t>(n);
        continue;
      }
      break;
    }
  }
  epoll_ctl(epfd_, EPOLL_CTL_DEL, fd, nullptr);
  ::close(fd);
  conns_.erase(it);
  if (notify && wasWs && onClose_) onClose_(id);
}

}  // namespace ie
