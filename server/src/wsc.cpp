// WebSocket client, see wsc.h.
#include "wsc.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

#include <cstring>
#include <stdexcept>

#include "crypto.h"

namespace ie {

namespace {

constexpr char kGUID[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

struct Url {
  bool tls = false;
  std::string host;
  std::string port;
  std::string path;
};

bool parseUrl(const std::string& url, Url* out, std::string* err) {
  const size_t scheme = url.find("://");
  if (scheme == std::string::npos) {
    *err = "url without scheme: " + url;
    return false;
  }
  const std::string proto = url.substr(0, scheme);
  if (proto != "ws" && proto != "wss") {
    *err = "unsupported scheme: " + proto;
    return false;
  }
  out->tls = proto == "wss";
  std::string rest = url.substr(scheme + 3);
  const size_t slash = rest.find('/');
  std::string hostPort = slash == std::string::npos ? rest : rest.substr(0, slash);
  out->path = slash == std::string::npos ? "/" : rest.substr(slash);
  const size_t colon = hostPort.rfind(':');
  if (colon != std::string::npos && hostPort.find(']') == std::string::npos) {
    out->host = hostPort.substr(0, colon);
    out->port = hostPort.substr(colon + 1);
  } else {
    out->host = hostPort;
    out->port = out->tls ? "443" : "80";
  }
  if (out->host.empty()) {
    *err = "empty host in " + url;
    return false;
  }
  return true;
}

int tcpConnect(const std::string& host, const std::string& port, std::string* err) {
  struct addrinfo hints {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo* res = nullptr;
  const int rc = getaddrinfo(host.c_str(), port.c_str(), &hints, &res);
  if (rc != 0 || !res) {
    *err = "dns failed for " + host + ": " + gai_strerror(rc);
    return -1;
  }
  int fd = -1;
  for (struct addrinfo* ai = res; ai; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    // Non-blocking connect with a 10 s timeout.
    const int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    const int c = ::connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (c == 0) {
      fcntl(fd, F_SETFL, flags);
      break;
    }
    if (errno == EINPROGRESS) {
      struct pollfd pfd { fd, POLLOUT, 0 };
      if (poll(&pfd, 1, 10000) == 1) {
        int soErr = 0;
        socklen_t len = sizeof(soErr);
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &soErr, &len);
        if (soErr == 0) {
          fcntl(fd, F_SETFL, flags);
          break;
        }
      }
    }
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) *err = "cannot connect to " + host + ":" + port;
  return fd;
}

bool readHttpHeaders(int fd, SSL* ssl, std::string* headers) {
  std::string buf;
  char c = 0;
  while (buf.size() < 64 * 1024) {
    const int n = ssl ? SSL_read(ssl, &c, 1) : static_cast<int>(::read(fd, &c, 1));
    if (n <= 0) return false;
    buf.push_back(c);
    if (buf.size() >= 4 && buf.compare(buf.size() - 4, 4, "\r\n\r\n") == 0) {
      *headers = buf;
      return true;
    }
  }
  return false;
}

std::string headerValue(const std::string& headers, const std::string& name) {
  std::string lower;
  lower.reserve(headers.size());
  for (char c : headers) lower.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
  std::string key = name + ":";
  const size_t pos = lower.find(key);
  if (pos == std::string::npos) return "";
  size_t start = pos + key.size();
  while (start < headers.size() && (headers[start] == ' ' || headers[start] == '\t')) start++;
  size_t end = headers.find("\r\n", start);
  if (end == std::string::npos) end = headers.size();
  return headers.substr(start, end - start);
}

bool writeAll(int fd, SSL* ssl, const uint8_t* data, size_t len) {
  while (len > 0) {
    const int n = ssl ? SSL_write(ssl, data, static_cast<int>(len))
                      : static_cast<int>(::send(fd, data, len, MSG_NOSIGNAL));
    if (n <= 0) return false;
    data += n;
    len -= static_cast<size_t>(n);
  }
  return true;
}

bool readAll(int fd, SSL* ssl, uint8_t* data, size_t len) {
  while (len > 0) {
    const int n = ssl ? SSL_read(ssl, data, static_cast<int>(len)) : static_cast<int>(::recv(fd, data, len, 0));
    if (n <= 0) return false;
    data += n;
    len -= static_cast<size_t>(n);
  }
  return true;
}

void frameHeader(std::vector<uint8_t>* out, uint8_t opcode, size_t len, bool mask) {
  out->push_back(static_cast<uint8_t>(0x80 | opcode));
  const uint8_t maskBit = mask ? 0x80 : 0x00;
  if (len < 126) {
    out->push_back(static_cast<uint8_t>(maskBit | len));
  } else if (len <= 0xffff) {
    out->push_back(static_cast<uint8_t>(maskBit | 126));
    out->push_back(static_cast<uint8_t>((len >> 8) & 0xff));
    out->push_back(static_cast<uint8_t>(len & 0xff));
  } else {
    out->push_back(static_cast<uint8_t>(maskBit | 127));
    for (int i = 7; i >= 0; i--) out->push_back(static_cast<uint8_t>((len >> (i * 8)) & 0xff));
  }
}

}  // namespace

struct WsClient::Impl {
  Url url;
  int fd = -1;
  SSL_CTX* ctx = nullptr;
  SSL* ssl = nullptr;
  std::thread reader;
  std::mutex writeMutex;
  std::atomic<bool> closed{false};
};

WsClient::WsClient() : impl_(std::make_unique<Impl>()) {}

WsClient::~WsClient() {
  close();
  if (impl_ && impl_->reader.joinable()) impl_->reader.join();
}

bool WsClient::connect(const std::string& url, std::string* err) {
  Url u;
  if (!parseUrl(url, &u, err)) return false;
  impl_->url = u;
  const int fd = tcpConnect(u.host, u.port, err);
  if (fd < 0) return false;
  impl_->fd = fd;

  if (u.tls) {
    impl_->ctx = SSL_CTX_new(TLS_client_method());
    if (!impl_->ctx) {
      *err = "TLS init failed";
      return false;
    }
    SSL_CTX_set_default_verify_paths(impl_->ctx);
    SSL_CTX_set_verify(impl_->ctx, SSL_VERIFY_PEER, nullptr);
    impl_->ssl = SSL_new(impl_->ctx);
    SSL_set_tlsext_host_name(impl_->ssl, u.host.c_str());
    SSL_set1_host(impl_->ssl, u.host.c_str());
    SSL_set_fd(impl_->ssl, fd);
    if (SSL_connect(impl_->ssl) != 1) {
      *err = "TLS handshake failed for " + u.host;
      return false;
    }
    if (SSL_get_verify_result(impl_->ssl) != X509_V_OK) {
      *err = "TLS certificate verification failed for " + u.host;
      return false;
    }
  }

  // RFC 6455 opening handshake.
  uint8_t nonce[16];
  if (RAND_bytes(nonce, sizeof(nonce)) != 1) {
    *err = "RNG failure";
    return false;
  }
  const std::string key = base64Encode(nonce, sizeof(nonce));
  std::string req;
  req += "GET " + u.path + " HTTP/1.1\r\n";
  req += "Host: " + u.host + (u.port == (u.tls ? "443" : "80") ? "" : ":" + u.port) + "\r\n";
  req += "Upgrade: websocket\r\n";
  req += "Connection: Upgrade\r\n";
  req += "Sec-WebSocket-Key: " + key + "\r\n";
  req += "Sec-WebSocket-Version: 13\r\n";
  req += "User-Agent: ie-server\r\n\r\n";
  if (!writeAll(fd, impl_->ssl, reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
    *err = "cannot send handshake";
    return false;
  }
  std::string headers;
  if (!readHttpHeaders(fd, impl_->ssl, &headers)) {
    *err = "no handshake response";
    return false;
  }
  if (headers.find("101") == std::string::npos) {
    const size_t line = headers.find("\r\n");
    *err = "handshake rejected: " + headers.substr(0, line == std::string::npos ? 80 : line);
    return false;
  }
  const std::string accept = base64Encode(sha1(key + kGUID));
  if (headerValue(headers, "sec-websocket-accept") != accept) {
    *err = "bad Sec-WebSocket-Accept";
    return false;
  }
  open_ = true;
  if (onState_) onState_(true);
  return true;
}

void WsClient::startReading() {
  impl_->reader = std::thread([this] {
    std::vector<uint8_t> message;
    uint8_t opcode = 0;
    bool running = true;
    while (running && !impl_->closed) {
      uint8_t h[2];
      if (!readAll(impl_->fd, impl_->ssl, h, 2)) break;
      const bool fin = (h[0] & 0x80) != 0;
      const uint8_t op = h[0] & 0x0f;
      const bool masked = (h[1] & 0x80) != 0;
      uint64_t len = h[1] & 0x7f;
      if (len == 126) {
        uint8_t ext[2];
        if (!readAll(impl_->fd, impl_->ssl, ext, 2)) break;
        len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
      } else if (len == 127) {
        uint8_t ext[8];
        if (!readAll(impl_->fd, impl_->ssl, ext, 8)) break;
        len = 0;
        for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
      }
      uint8_t mask[4] = {0, 0, 0, 0};
      if (masked && !readAll(impl_->fd, impl_->ssl, mask, 4)) break;
      if (len > 8 * 1024 * 1024) break;  // sanity cap
      std::vector<uint8_t> payload(len);
      if (len > 0 && !readAll(impl_->fd, impl_->ssl, payload.data(), len)) break;
      if (masked) {
        for (size_t i = 0; i < payload.size(); i++) payload[i] ^= mask[i % 4];
      }
      if (op == 0x8) {  // close
        running = false;
        break;
      }
      if (op == 0x9) {  // ping
        std::lock_guard<std::mutex> lock(impl_->writeMutex);
        std::vector<uint8_t> frame;
        frameHeader(&frame, 0xA, payload.size(), true);
        uint8_t keyBytes[4];
        RAND_bytes(keyBytes, 4);
        for (uint8_t b : keyBytes) frame.push_back(b);
        for (size_t i = 0; i < payload.size(); i++) frame.push_back(payload[i] ^ keyBytes[i % 4]);
        writeAll(impl_->fd, impl_->ssl, frame.data(), frame.size());
        continue;
      }
      if (op == 0xA) continue;  // pong
      if (op == 0x1 || op == 0x2) {
        message = std::move(payload);
        opcode = op;
        if (fin && opcode == 0x1 && onMessage_) {
          onMessage_(std::string(reinterpret_cast<const char*>(message.data()), message.size()));
        }
        continue;
      }
      if (op == 0x0) {  // continuation
        message.insert(message.end(), payload.begin(), payload.end());
        if (fin && opcode == 0x1 && onMessage_) {
          onMessage_(std::string(reinterpret_cast<const char*>(message.data()), message.size()));
        }
      }
    }
    open_ = false;
    if (onState_) onState_(false);
  });
}

void WsClient::sendText(const std::string& text) {
  if (!open_) return;
  std::lock_guard<std::mutex> lock(impl_->writeMutex);
  if (!open_) return;
  std::vector<uint8_t> frame;
  frameHeader(&frame, 0x1, text.size(), true);
  uint8_t mask[4];
  if (RAND_bytes(mask, 4) != 1) return;
  for (uint8_t b : mask) frame.push_back(b);
  for (size_t i = 0; i < text.size(); i++) {
    frame.push_back(static_cast<uint8_t>(text[i]) ^ mask[i % 4]);
  }
  if (!writeAll(impl_->fd, impl_->ssl, frame.data(), frame.size())) {
    open_ = false;
  }
}

void WsClient::close() {
  if (!impl_) return;
  impl_->closed = true;
  if (impl_->ssl) {
    SSL_shutdown(impl_->ssl);
    SSL_free(impl_->ssl);
    impl_->ssl = nullptr;
  }
  if (impl_->ctx) {
    SSL_CTX_free(impl_->ctx);
    impl_->ctx = nullptr;
  }
  if (impl_->fd >= 0) {
    ::shutdown(impl_->fd, SHUT_RDWR);
    ::close(impl_->fd);
    impl_->fd = -1;
  }
  open_ = false;
}

}  // namespace ie
