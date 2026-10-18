// Minimal WebSocket *client* for Nostr relays (RFC 6455, ws:// and wss://).
//
// The asset/game side of the server only ever accepted WebSockets; the
// dedicated multiplayer mode has to connect out to relays. One blocking reader
// thread per relay; sends are mutex-guarded. TLS uses OpenSSL with normal
// certificate + hostname verification.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace ie {

class WsClient {
 public:
  using MessageHandler = std::function<void(const std::string&)>;
  using StateHandler = std::function<void(bool open)>;

  WsClient();
  ~WsClient();

  void setMessageHandler(MessageHandler h) { onMessage_ = std::move(h); }
  void setStateHandler(StateHandler h) { onState_ = std::move(h); }

  /** Opens ws:// or wss:// immediately (blocking connect + handshake). */
  bool connect(const std::string& url, std::string* err);
  /** Starts the reader thread (call after connect). */
  void startReading();
  void sendText(const std::string& text);
  void close();
  bool isOpen() const { return open_; }

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
  MessageHandler onMessage_;
  StateHandler onState_;
  std::atomic<bool> open_{false};
};

}  // namespace ie
