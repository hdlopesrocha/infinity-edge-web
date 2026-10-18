// Session: see session.h. The wire layouts live in match.cpp (shared with the
// dedicated multiplayer room); this class is the single-player WebSocket
// adapter around one MatchStream viewer.
#include "session.h"

#include <cmath>

namespace ie {

namespace {
constexpr float kTickMs = 1000.0f / 30.0f;
}

Session::Session(WsServer::ConnId conn, WsServer* srv, ModelTable* models, LevelTable* levels,
                 uint32_t seed)
    : conn_(conn), srv_(srv), models_(models), levels_(levels), seed_(seed) {}

Session::~Session() = default;

void Session::sendFrame(uint16_t type, const std::vector<uint8_t>& payload) {
  const std::vector<uint8_t> frame = proto::encodeFrame(type, payload.data(), payload.size(), true);
  srv_->sendBinary(conn_, frame.data(), frame.size());
}

void Session::sendError(const std::string& message) {
  proto::Writer w;
  w.str(message);
  sendFrame(proto::Error, std::vector<uint8_t>(w.data().begin(), w.data().end()));
}

void Session::sendEvents() {
  const std::vector<uint8_t> payload = stream_->events(view_, tickEvents_);
  if (!payload.empty()) sendFrame(proto::Events, payload);
  tickEvents_ = TickEvents{};
}

// ------------------------------------------------------------------ inbound
void Session::onMessage(const uint8_t* data, size_t len) {
  proto::DecodedFrame frame;
  try {
    frame = proto::decodeFrame(data, len);
  } catch (const std::exception& e) {
    sendError(std::string("bad frame: ") + e.what());
    return;
  }
  proto::Reader r(frame.payload.data(), frame.payload.size());
  try {
    switch (frame.type) {
      case proto::Join: handleJoin(r); break;
      case proto::Input: handleInput(r); break;
      case proto::Ping: sendPong(r.u32()); break;
      case proto::Leave: leaving_ = true; break;
      default: break;  // unknown types are ignored
    }
  } catch (const std::exception& e) {
    sendError(e.what());
  }
}

void Session::handleJoin(proto::Reader& r) {
  if (game_) {
    sendError("already joined");
    return;
  }
  SessionOptions opts;
  opts.levelKey = r.str();
  const uint8_t flags = r.u8();
  opts.smartAI = (flags & proto::JOIN_SMART_AI) != 0;
  opts.playerDistance = r.f32();
  opts.axisX = r.u8() != 0;
  opts.axisY = r.u8() != 0;
  const Level* level = levels_->get(opts.levelKey);
  if (!level) {
    sendError("unknown level: " + opts.levelKey);
    return;
  }
  options_ = opts;
  game_ = std::make_unique<Game>(models_, seed_);
  game_->playerDistance = opts.playerDistance;
  game_->axisX = opts.axisX;
  game_->axisY = opts.axisY;
  game_->smartAI = opts.smartAI;
  if (!game_->create(*level)) {
    game_.reset();
    sendError("cannot create level: " + opts.levelKey);
    return;
  }
  stream_ = std::make_unique<MatchStream>(*game_, models_);
  stream_->bindPlayer(view_, game_->selected);
}

void Session::handleInput(proto::Reader& r) {
  if (!game_) return;
  game_->input.stickX = r.f32();
  game_->input.stickY = r.f32();
  game_->input.throttle = r.f32();
  const uint8_t bits = r.u8();
  game_->input.fire = (bits & 0x01) != 0;
  game_->input.homing = (bits & 0x02) != 0;
  game_->input.nitro = (bits & 0x04) != 0;
}

void Session::sendPong(uint32_t id) {
  proto::Writer w;
  w.u32(id);
  w.u32(static_cast<uint32_t>(WsServer::nowMs()));
  sendFrame(proto::Pong, std::vector<uint8_t>(w.data().begin(), w.data().end()));
}

// ----------------------------------------------------------------------- tick
void Session::tick(int64_t nowMs) {
  (void)nowMs;
  if (!game_ || !stream_) return;
  if (!view_.sceneSent) {
    sendFrame(proto::Scene, stream_->scene(view_));
    sendFrame(proto::Snapshot, stream_->snapshot(view_));  // tick 0: every live object
    stream_->drainEvents(&tickEvents_);
    sendEvents();
    sendFrame(proto::Hud, stream_->hud(view_));
    stream_->advanceTick();
    return;
  }
  game_->update(kTickMs);
  sendFrame(proto::Snapshot, stream_->snapshot(view_));
  stream_->drainEvents(&tickEvents_);
  sendEvents();
  sendFrame(proto::Hud, stream_->hud(view_));
  if (game_->finished && !resultSent_) {
    sendFrame(proto::Result, stream_->result());
    resultSent_ = true;
  }
  stream_->advanceTick();
}

}  // namespace ie
