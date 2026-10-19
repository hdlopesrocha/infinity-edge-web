// Dedicated multiplayer room, see dedicated.h.
#include "dedicated.h"

#include <rtc/rtc.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <random>
#include <thread>

#include "ai.h"
#include "gzip.h"
#include "proto.h"

namespace ie {

namespace {

constexpr float kTickMs = 1000.0f / 30.0f;
constexpr int kRoomTtlSec = 30 * 60;
constexpr int64_t kHeartbeatMs = 4 * 60 * 1000;
constexpr int64_t kInputTimeoutMs = 1200;
constexpr int64_t kRestartDelayMs = 8000;
constexpr int64_t kCloseAfterResultMs = 1500;
constexpr int64_t kCandidateFlushMs = 250;

int64_t steadyMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}

std::string hex12() {
  uint8_t bytes[12];
  nostr::randomBytes(bytes, sizeof(bytes));
  return nostr::hexEncode(bytes, sizeof(bytes));
}

std::string formatLevelTitle(const Level& level) {
  if (!level.name.empty()) return level.name;
  return level.key;
}

}  // namespace

DedicatedRoom::DedicatedRoom(DedicatedConfig cfg, ModelTable* models, LevelTable* levels)
    : cfg_(std::move(cfg)), models_(models), levels_(levels) {}

DedicatedRoom::~DedicatedRoom() { shutdown(); }

// ------------------------------------------------------------------- setup
bool DedicatedRoom::loadKey(std::string* err) {
  std::string hex = cfg_.keyHex;
  if (hex.size() != 64 && !cfg_.keyFile.empty()) {
    std::ifstream in(cfg_.keyFile);
    if (in.good()) {
      std::string line;
      std::getline(in, line);
      if (line.size() == 64) hex = line;
    }
  }
  if (hex.size() == 64) {
    const std::vector<uint8_t> bytes = nostr::hexDecode(hex);
    if (bytes.size() == 32) {
      std::copy(bytes.begin(), bytes.end(), key_.begin());
    }
  }
  if (!nostr::validSecretKey(key_)) {
    do {
      nostr::randomBytes(key_.data(), key_.size());
    } while (!nostr::validSecretKey(key_));
  }
  pubkeyHex_ = nostr::hexEncode(nostr::pubkeyOf(key_));
  if (!cfg_.keyFile.empty()) {
    std::ofstream out(cfg_.keyFile, std::ios::trunc);
    if (out.good()) out << nostr::hexEncode(key_) << "\n";
    else if (err) *err = "cannot write key file " + cfg_.keyFile;
  }
  return true;
}

bool DedicatedRoom::createMatch(std::string* err) {
  const Level* level = levels_->get(cfg_.levelKey);
  if (!level) {
    *err = "unknown level: " + cfg_.levelKey;
    return false;
  }
  if (level->type == "BACK") {
    *err = "cannot host a background scene: " + cfg_.levelKey;
    return false;
  }
  game_ = std::make_unique<Game>(models_, cfg_.seed + round_ * 7919u);
  game_->playerDistance = 192;
  game_->axisX = false;
  game_->axisY = false;
  if (!game_->create(*level)) {
    game_.reset();
    *err = "cannot create level: " + cfg_.levelKey;
    return false;
  }
  stream_ = std::make_unique<MatchStream>(*game_, models_);
  tickEvents_ = TickEvents{};
  finishedSent_ = false;
  matchRunning_ = true;
  installHooks();
  return true;
}

void DedicatedRoom::installHooks() {
  hooks_ = PlayerHooks{};
  hooks_.shipSfx = [this](SpaceObject* ship, const std::string& name, float volume, float pan) {
    Guest* g = guestFor(ship);
    if (g) g->view.sfx.push_back(SfxEvent{name, volume, pan});
  };
  hooks_.shipNotification = [this](SpaceObject* ship, const std::string& field) {
    Guest* g = guestFor(ship);
    if (g) g->view.voices.push_back(field);
  };
  hooks_.explosionSfx = [this](SpaceObject* obj) {
    for (auto& kv : guests_) {
      Guest& g = kv.second;
      SpaceShip* ship = g.view.ship;
      if (!g.joined || !ship || !ship->active || ship == obj) continue;
      const Vec3 v = vsub(obj->pos, ship->pos);
      const float dist = vlen(v) == 0 ? 1 : vlen(v);
      const float volume = clampf(1 - dist / game_->playerDistance, 0, 1);
      if (volume <= 0) continue;
      const float pan = clampf(-8 * vdot(ship->side, vscale(v, 1.0f / dist)), -1, 1);
      const char* name = dynamic_cast<Ark*>(obj) ? "addonSound"
                         : dist < game_->playerDistance / 2 ? "closeExplosion"
                                                            : "farExplosion";
      g.view.sfx.push_back(SfxEvent{name, volume, pan});
    }
  };
  if (game_) game_->hooks = &hooks_;
}

// ------------------------------------------------------------------- relay
void DedicatedRoom::publishRoom() {
  if (!relay_) return;
  nostr::RoomContent content;
  content.game = cfg_.levelKey;
  const Level* level = levels_->get(cfg_.levelKey);
  content.type = level ? level->type : "";
  content.title = level ? formatLevelTitle(*level) : cfg_.levelKey;
  content.host = cfg_.name;
  content.players = static_cast<int>(guests_.size());
  content.maxPlayers = cfg_.maxPlayers;
  content.ice = cfg_.iceServers;
  content.created = created_;
  content.cert = cert_;
  // Mark server rooms: a browser joining one starts immediately (there is no
  // waiting room to press PLAY in). Browser hosts leave this false.
  content.srv = true;
  const nostr::Event evt = nostr::makeRoomEvent(roomId_, content, kRoomTtlSec, key_, 0);
  relay_->publish(evt);
  std::printf("[mp] room %s \"%s\" (%s) published as %s\n", roomId_.c_str(),
              content.title.c_str(), cfg_.levelKey.c_str(), pubkeyHex_.c_str());
  std::fflush(stdout);
}

void DedicatedRoom::publishDeletion() {
  if (!relay_ || roomId_.empty()) return;
  relay_->publish(nostr::makeDeletionEvent(roomId_, key_, 0));
}

void DedicatedRoom::subscribeSignals() {
  if (!relay_) return;
  Json filter = Json::object();
  std::vector<Json> kinds;
  kinds.emplace_back(static_cast<double>(nostr::kKindSignal));
  filter.set("kinds", Json(std::move(kinds)));
  std::vector<Json> d;
  d.emplace_back(roomId_);
  filter.set("#d", Json(std::move(d)));
  std::vector<Json> p;
  p.emplace_back(pubkeyHex_);
  filter.set("#p", Json(std::move(p)));
  relay_->subscribe("mp-sig-host", {filter});
}

bool DedicatedRoom::start(std::string* err) {
  if (!loadKey(err)) return false;
  created_ = std::chrono::duration_cast<std::chrono::seconds>(
                 std::chrono::system_clock::now().time_since_epoch())
                 .count();
  roomId_ = hex12();
  // Warm the curve statics before any RTC thread can sign concurrently.
  (void)nostr::pubkeyOf(key_);
  // Room certificate: an ephemeral P-256 key vouched for by the room's Nostr
  // key (guests pin it and verify every answer SDP against it).
  p256_ = nostr::P256::generate();
  if (p256_) {
    cert_.key = p256_->spkiBase64();
    cert_.created = created_;
    cert_.expires = created_ + 24 * 3600;
    cert_.sig = nostr::signHex(
        key_, reinterpret_cast<const uint8_t*>(nostr::certPayload(roomId_, pubkeyHex_, cert_).data()),
        nostr::certPayload(roomId_, pubkeyHex_, cert_).size());
  }
  if (!createMatch(err)) return false;
  relay_ = std::make_unique<nostr::RelayPool>(cfg_.relays);
  relay_->start();
  // Wait (bounded) for at least one relay.
  const int64_t deadline = steadyMs() + 8000;
  while (steadyMs() < deadline && !relay_->anyOpen()) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  if (!relay_->anyOpen()) {
    *err = "no Nostr relay reachable";
    relay_->stop();
    relay_.reset();
    return false;
  }
  subscribeSignals();
  publishRoom();
  lastHeartbeatMs_ = steadyMs();
  levelCreatedAtMs_ = steadyMs();
  active_ = true;
  std::printf("[mp] dedicated room ready: %zu relay(s), level %s, max %d guests\n",
              relay_->openCount(), cfg_.levelKey.c_str(), cfg_.maxPlayers);
  std::fflush(stdout);
  return true;
}

void DedicatedRoom::shutdown() {
  if (!active_ && !relay_) return;
  active_ = false;
  if (game_) game_->hooks = nullptr;
  for (auto& kv : guests_) {
    if (kv.second.channel) {
      try { kv.second.channel->close(); } catch (...) {}
    }
  }
  guests_.clear();
  for (auto& kv : peers_) {
    if (kv.second.pc) {
      try { kv.second.pc->close(); } catch (...) {}
    }
  }
  peers_.clear();
  publishDeletion();
  if (relay_) {
    // Give the deletion a moment to leave before the sockets close.
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    relay_->stop();
    relay_.reset();
  }
  game_.reset();
  stream_.reset();
  roomId_.clear();
  std::printf("[mp] room closed\n");
  std::fflush(stdout);
}

// --------------------------------------------------------------- threading
void DedicatedRoom::drainRelay(int64_t nowMs) {
  if (!relay_) return;
  const std::vector<nostr::RelayEvent> events = relay_->takeEvents();
  for (const auto& re : events) {
    if (re.event.kind != nostr::kKindSignal) continue;
    nostr::Signal sig;
    if (!nostr::parseSignal(re.event, pubkeyHex_, roomId_, &sig)) continue;
    if (sig.kind == "offer") {
      if (!sig.sdp.empty()) handleOffer(re.event, sig);
    } else if (sig.kind == "ice") {
      auto it = peers_.find(re.event.pubkey);
      if (it == peers_.end()) {
        // Trickle can cross the offer on the relays: keep it for the offer.
        auto& early = earlyCandidates_[re.event.pubkey];
        early.insert(early.end(), sig.candidates.begin(), sig.candidates.end());
        continue;
      }
      for (const auto& cand : sig.candidates) {
        try {
          it->second.pc->addRemoteCandidate(rtc::Candidate(cand.candidate));
        } catch (...) {
        }
      }
    } else if (sig.kind == "bye") {
      removeGuest(re.event.pubkey);
    }
  }
  flushCandidates(nowMs);
}

void DedicatedRoom::drainRtc(int64_t nowMs) {
  std::vector<RtcEvent> events;
  {
    std::lock_guard<std::mutex> lock(rtcMutex_);
    events.swap(rtcEvents_);
  }
  for (const RtcEvent& ev : events) {
    switch (ev.type) {
      case RtcEventType::Channel:
        attachChannel(ev.pubkey, ev.channel);
        break;
      case RtcEventType::Message: {
        auto it = guests_.find(ev.pubkey);
        if (it != guests_.end()) handleFrame(it->second, ev.data);
        break;
      }
      case RtcEventType::Closed: {
        auto it = guests_.find(ev.pubkey);
        if (it != guests_.end()) {
          auto ch = it->second.channel;
          if (ch) {
            try { ch->close(); } catch (...) {}
          }
        }
        removeGuest(ev.pubkey);
        break;
      }
      case RtcEventType::Candidate: {
        auto it = peers_.find(ev.pubkey);
        if (it != peers_.end()) {
          nostr::Candidate cand;
          cand.candidate = ev.text;
          cand.sdpMLineIndex = 0;
          it->second.localCandidates.push_back(std::move(cand));
        }
        break;
      }
      case RtcEventType::Description: {
        // The answer SDP (libdatachannel fired it on an RTC thread).
        const size_t nl = ev.text.find('\n');
        if (nl != std::string::npos && ev.text.substr(0, nl) == "answer") {
          const std::string sdp = ev.text.substr(nl + 1);
          std::string signature;
          if (p256_) {
            const std::string payload = nostr::answerPayload(roomId_, pubkeyHex_, ev.pubkey, sdp);
            signature = p256_->signBase64(reinterpret_cast<const uint8_t*>(payload.data()),
                                          payload.size());
          }
          sendSignal(ev.pubkey, "answer", sdp, {}, signature);
          auto peer = peers_.find(ev.pubkey);
          if (peer != peers_.end()) peer->second.answered = true;
        }
        break;
      }
      case RtcEventType::State: {
        if (ev.text == "failed" || ev.text == "closed") {
          removeGuest(ev.pubkey);
          auto it = peers_.find(ev.pubkey);
          if (it != peers_.end()) {
            try { it->second.pc->close(); } catch (...) {}
            peers_.erase(it);
          }
        }
        break;
      }
    }
  }
  (void)nowMs;
}

void DedicatedRoom::sendSignal(const std::string& to, const std::string& kind,
                               const std::string& sdp,
                               const std::vector<nostr::Candidate>& candidates,
                               const std::string& signature) {
  if (!relay_) return;
  nostr::Signal sig;
  sig.kind = kind;
  sig.sdp = sdp;
  sig.sig = signature;
  sig.candidates = candidates;
  relay_->publish(nostr::makeSignalEvent(roomId_, to, sig, key_, 0));
}

void DedicatedRoom::flushCandidates(int64_t nowMs) {
  for (auto& kv : peers_) {
    Peer& peer = kv.second;
    if (!peer.answered || peer.localCandidates.empty()) continue;
    if (nowMs - peer.lastFlushMs < kCandidateFlushMs) continue;
    peer.lastFlushMs = nowMs;
    sendSignal(kv.first, "ice", "", peer.localCandidates);
    peer.localCandidates.clear();
  }
}

// ------------------------------------------------------------------ peers
void DedicatedRoom::handleOffer(const nostr::Event& evt, const nostr::Signal& sig) {
  if (!matchRunning_) return;
  if (static_cast<int>(guests_.size()) >= cfg_.maxPlayers) {
    std::printf("[mp] offer from %s ignored (room full)\n", evt.pubkey.c_str());
    return;
  }
  // One connection per guest: replace a stale one.
  auto existingGuest = guests_.find(evt.pubkey);
  if (existingGuest != guests_.end()) return;
  auto existing = peers_.find(evt.pubkey);
  if (existing != peers_.end()) {
    try { existing->second.pc->close(); } catch (...) {}
    peers_.erase(existing);
  }
  rtc::Configuration config;
  for (const auto& server : cfg_.iceServers) config.iceServers.emplace_back(server);
  auto pc = std::make_shared<rtc::PeerConnection>(config);
  Peer peer;
  peer.pubkey = evt.pubkey;
  peer.name = sig.name.empty() ? "Pilot" : sig.name;
  peer.pc = pc;
  peer.lastFlushMs = steadyMs();
  peers_[evt.pubkey] = peer;

  const std::string pubkey = evt.pubkey;
  pc->onLocalDescription([this, pubkey](rtc::Description description) {
    std::lock_guard<std::mutex> lock(rtcMutex_);
    RtcEvent e;
    e.type = RtcEventType::Description;
    e.pubkey = pubkey;
    e.text = std::string(description.typeString()) + "\n" + std::string(description);
    rtcEvents_.push_back(std::move(e));
  });
  pc->onLocalCandidate([this, pubkey](rtc::Candidate candidate) {
    std::lock_guard<std::mutex> lock(rtcMutex_);
    RtcEvent e;
    e.type = RtcEventType::Candidate;
    e.pubkey = pubkey;
    e.text = candidate.candidate();
    rtcEvents_.push_back(std::move(e));
  });
  pc->onStateChange([this, pubkey](rtc::PeerConnection::State state) {
    std::lock_guard<std::mutex> lock(rtcMutex_);
    RtcEvent e;
    e.type = RtcEventType::State;
    e.pubkey = pubkey;
    e.text = state == rtc::PeerConnection::State::Failed
                 ? "failed"
                 : state == rtc::PeerConnection::State::Closed ? "closed" : "other";
    rtcEvents_.push_back(std::move(e));
  });
  pc->onDataChannel([this, pubkey](std::shared_ptr<rtc::DataChannel> channel) {
    {
      std::lock_guard<std::mutex> lock(rtcMutex_);
      RtcEvent e;
      e.type = RtcEventType::Channel;
      e.pubkey = pubkey;
      e.channel = channel;
      rtcEvents_.push_back(std::move(e));
    }
    channel->onMessage(
        [this, pubkey](rtc::binary data) {
          std::lock_guard<std::mutex> lock(rtcMutex_);
          RtcEvent e;
          e.type = RtcEventType::Message;
          e.pubkey = pubkey;
          e.data.resize(data.size());
          for (size_t i = 0; i < data.size(); i++) e.data[i] = std::to_integer<uint8_t>(data[i]);
          rtcEvents_.push_back(std::move(e));
        },
        [](std::string) {});
    channel->onClosed([this, pubkey]() {
      std::lock_guard<std::mutex> lock(rtcMutex_);
      RtcEvent e;
      e.type = RtcEventType::Closed;
      e.pubkey = pubkey;
      rtcEvents_.push_back(std::move(e));
    });
  });

  try {
    // libdatachannel answers offers automatically (it fires onLocalDescription
    // with the answer); calling setLocalDescription here would throw.
    pc->setRemoteDescription(rtc::Description(sig.sdp, "offer"));
    // Apply candidates that crossed the offer on the relays.
    auto early = earlyCandidates_.find(pubkey);
    if (early != earlyCandidates_.end()) {
      for (const auto& cand : early->second) {
        try {
          pc->addRemoteCandidate(rtc::Candidate(cand.candidate));
        } catch (...) {
        }
      }
      earlyCandidates_.erase(early);
    }
    std::printf("[mp] offer from %s (%s): answering\n", pubkey.c_str(), peer.name.c_str());
    std::fflush(stdout);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "[mp] offer handling failed: %s\n", e.what());
    peers_.erase(pubkey);
  }
}

void DedicatedRoom::attachChannel(const std::string& pubkey,
                                  const std::shared_ptr<rtc::DataChannel>& channel) {
  auto peer = peers_.find(pubkey);
  const std::string name = peer != peers_.end() ? peer->second.name : "Pilot";
  Guest guest;
  guest.pubkey = pubkey;
  guest.name = name;
  guest.channel = channel;
  guest.lastInputAt = steadyMs();
  guests_[pubkey] = std::move(guest);
  std::printf("[mp] data channel open for %s (%s), waiting for Join\n", pubkey.c_str(), name.c_str());
  std::fflush(stdout);
}

void DedicatedRoom::removeGuest(std::string pubkey) {
  auto it = guests_.find(pubkey);
  if (it != guests_.end()) {
    if (it->second.joined) {
      releaseShip(it->second);
      std::printf("[mp] guest %s left (%zu connected)\n", pubkey.c_str(), guests_.size() - 1);
      std::fflush(stdout);
    }
    if (it->second.channel) {
      try { it->second.channel->close(); } catch (...) {}
    }
    guests_.erase(it);
    publishRoom();
  }
  auto peer = peers_.find(pubkey);
  if (peer != peers_.end()) {
    try { peer->second.pc->close(); } catch (...) {}
    peers_.erase(peer);
  }
}

// ----------------------------------------------------------------- frames
void DedicatedRoom::sendFrame(Guest& guest, uint16_t type, const std::vector<uint8_t>& payload) {
  if (!guest.channel) return;
  const std::vector<uint8_t> frame = proto::encodeFrame(type, payload.data(), payload.size(), true);
  try {
    guest.channel->send(reinterpret_cast<const std::byte*>(frame.data()), frame.size());
  } catch (...) {
  }
}

void DedicatedRoom::sendError(Guest& guest, const std::string& message) {
  proto::Writer w;
  w.str(message);
  sendFrame(guest, proto::Error, std::vector<uint8_t>(w.data().begin(), w.data().end()));
}

void DedicatedRoom::handleFrame(Guest& guest, const std::vector<uint8_t>& data) {
  proto::DecodedFrame frame;
  try {
    frame = proto::decodeFrame(data.data(), data.size());
  } catch (...) {
    return;
  }
  proto::Reader r(frame.payload.data(), frame.payload.size());
  try {
    if (frame.type == proto::Auth) {
      // Channel challenge: answer with a BIP-340 signature by the room key so
      // only this host (never another client) can complete the handshake.
      if (guest.authed) return;
      std::string text(frame.payload.begin(), frame.payload.end());
      Json req;
      try {
        req = Json::parse(text);
      } catch (...) {
        return;
      }
      if (req["t"].asString() != "auth-request") return;
      if (req["pubkey"].asString() != guest.pubkey) return;
      const std::string nonce = req["nonce"].asString();
      if (nonce.empty()) return;
      const std::string payload = nostr::authPayload(roomId_, pubkeyHex_, guest.pubkey, nonce);
      const std::string sig = nostr::signHex(
          key_, reinterpret_cast<const uint8_t*>(payload.data()), payload.size());
      Json ack = Json::object();
      ack.set("t", Json("auth-ok"));
      ack.set("host", Json(pubkeyHex_));
      ack.set("nonce", Json(nonce));
      ack.set("sig", Json(sig));
      const std::string body = ack.dump();
      // Raw JSON payload (the client sends/reads the same, no str prefix).
      sendFrame(guest, proto::Auth, std::vector<uint8_t>(body.begin(), body.end()));
      guest.authed = true;
      std::printf("[mp] guest %s authenticated\n", guest.pubkey.c_str());
      std::fflush(stdout);
      return;
    }
    if (frame.type == proto::Join && !guest.authed) {
      sendError(guest, "authenticate first");
      return;
    }
    switch (frame.type) {
      case proto::Join: handleJoin(guest, r); break;
      case proto::Input: {
        if (!guest.joined) break;
        guest.input.stickX = r.f32();
        guest.input.stickY = r.f32();
        guest.input.throttle = r.f32();
        const uint8_t bits = r.u8();
        guest.input.fire = (bits & 0x01) != 0;
        guest.input.homing = (bits & 0x02) != 0;
        guest.input.nitro = (bits & 0x04) != 0;
        guest.lastInputAt = steadyMs();
        break;
      }
      case proto::Ping: {
        const uint32_t echo = r.u32();
        proto::Writer w;
        w.u32(echo);
        w.u32(static_cast<uint32_t>(steadyMs() & 0xffffffff));
        sendFrame(guest, proto::Pong, std::vector<uint8_t>(w.data().begin(), w.data().end()));
        break;
      }
      case proto::Leave:
        removeGuest(guest.pubkey);
        break;
      default:
        break;
    }
  } catch (const std::exception& e) {
    sendError(guest, e.what());
  }
}

void DedicatedRoom::handleJoin(Guest& guest, proto::Reader& r) {
  if (guest.joined) {
    sendError(guest, "already joined");
    return;
  }
  const std::string levelKey = r.str();
  const uint8_t flags = r.u8();
  const float distance = r.f32();
  guest.axisX = r.u8() != 0;
  guest.axisY = r.u8() != 0;
  (void)flags;
  (void)distance;
  if (levelKey != cfg_.levelKey) {
    sendError(guest, "room is playing " + cfg_.levelKey);
    return;
  }
  assignShip(guest);
  if (!guest.ship) {
    sendError(guest, "no ship available");
    return;
  }
  guest.joined = true;
  const uint32_t shipId = stream_->bindPlayer(guest.view, guest.ship);
  (void)shipId;
  (void)guestFor(guest.ship);
  sendFrame(guest, proto::Scene, stream_->scene(guest.view));
  sendFrame(guest, proto::Snapshot, stream_->snapshot(guest.view));
  TickEvents empty;
  const std::vector<uint8_t> events = stream_->events(guest.view, empty);
  if (!events.empty()) sendFrame(guest, proto::Events, events);
  sendFrame(guest, proto::Hud, stream_->hud(guest.view));
  std::printf("[mp] guest %s joined (%zu connected) as ship %u\n", guest.pubkey.c_str(),
              guests_.size(), guest.view.shipId);
  std::fflush(stdout);
  publishRoom();
}

void DedicatedRoom::assignShip(Guest& guest) {
  if (!game_ || !game_->selected) return;
  Team* team = game_->selected->team;
  std::vector<SpaceShip*> taken;
  for (auto& kv : guests_) {
    if (kv.second.ship) taken.push_back(kv.second.ship);
  }
  auto isTaken = [&](SpaceShip* s) {
    return std::find(taken.begin(), taken.end(), s) != taken.end();
  };
  for (SpaceObject* obj : team->objects) {
    SpaceShip* ship = dynamic_cast<SpaceShip*>(obj);
    if (!ship || !ship->active || isTaken(ship)) continue;
    if (!ship->intelligence) continue;
    guest.ship = ship;
    guest.spawned = false;
    guest.savedIntelligence = std::move(ship->intelligence);
    ship->intelligence = makeHILocal(*game_, ship, &guest.input, guest.axisX, guest.axisY);
    ship->isPlayer = true;
    return;
  }
  // No free ship: spawn a wingman next to the level's player ship.
  SpaceShip* host = game_->selected;
  Vec3 pos = vadd(host->pos, vadd(vscale(host->side, 14.0f), vscale(host->dir, -6.0f)));
  pos.y += 2;
  std::unique_ptr<Life> life;
  if (auto* l3 = dynamic_cast<Life3*>(host->life.get())) {
    life = std::make_unique<Life3>(l3->maxLeft(), l3->maxCenter(), l3->maxRight());
  } else if (auto* l1 = dynamic_cast<Life1*>(host->life.get())) {
    life = std::make_unique<Life1>(l1->maxCenter());
  } else {
    life = std::make_unique<Life1>(100);
  }
  auto* ship = game_->own(new SpaceShip(host->physics, *game_, team, pos, host->model,
                                        std::move(life), host->shieldModel));
  ship->rot = host->rot;
  ship->isPlayer = true;
  ship->intelligence = makeHILocal(*game_, ship, &guest.input, guest.axisX, guest.axisY);
  ship->update();
  guest.ship = ship;
  guest.spawned = true;
}

void DedicatedRoom::releaseShip(Guest& guest) {
  SpaceShip* ship = guest.ship;
  if (!ship) return;
  ship->intelligence.reset();
  if (!guest.spawned && guest.savedIntelligence) {
    ship->intelligence = std::move(guest.savedIntelligence);
    ship->isPlayer = false;
  } else if (guest.spawned) {
    auto& objs = ship->team->objects;
    objs.erase(std::remove(objs.begin(), objs.end(), ship), objs.end());
    game_->map.removeObject(ship);
  }
  guest.ship = nullptr;
  guest.view.ship = nullptr;
}

DedicatedRoom::Guest* DedicatedRoom::guestFor(const SpaceObject* ship) {
  if (!ship) return nullptr;
  for (auto& kv : guests_) {
    if (kv.second.view.ship == ship) return &kv.second;
  }
  return nullptr;
}

// ------------------------------------------------------------------- tick
void DedicatedRoom::tick(int64_t nowMs) {
  (void)nowMs;
  const int64_t now = steadyMs();
  drainRelay(now);
  drainRtc(now);
  if (!active_) return;
  if (now - lastHeartbeatMs_ >= kHeartbeatMs) {
    lastHeartbeatMs_ = now;
    publishRoom();
  }
  if (matchRunning_) tickMatch(now);
  if (!matchRunning_) {
    if (closeAtMs_ > 0 && now >= closeAtMs_) {
      closeAtMs_ = 0;
      for (auto& kv : guests_) {
        if (kv.second.channel) {
          try { kv.second.channel->close(); } catch (...) {}
        }
      }
      guests_.clear();
      peers_.clear();
      publishRoom();
    }
    if (restartAtMs_ > 0 && now >= restartAtMs_) {
      restartAtMs_ = 0;
      round_++;
      guests_.clear();
      peers_.clear();
      std::string err;
      if (!createMatch(&err)) {
        std::fprintf(stderr, "[mp] restart failed: %s\n", err.c_str());
        return;
      }
      levelCreatedAtMs_ = now;
      publishRoom();
      std::printf("[mp] new round started (%s)\n", cfg_.levelKey.c_str());
      std::fflush(stdout);
    }
  }
}

void DedicatedRoom::tickMatch(int64_t nowMs) {
  if (!game_ || !stream_) return;
  // Pre-step: remote nitro / idle input release.
  for (auto& kv : guests_) {
    Guest& g = kv.second;
    if (!g.joined || !g.ship) continue;
    if (nowMs - g.lastInputAt > kInputTimeoutMs) g.input = PlayerInput{};
    if (g.input.nitro && g.ship->active) g.ship->launchNitro(kTickMs);
  }
  game_->update(kTickMs);
  // Testing hook: end the round on a timer (the restart path is exercised by
  // the e2e; ordinary matches end through the level goals).
  const bool finishDue =
      finishRequested_.exchange(false) ||
      (cfg_.autoFinishSec > 0 && nowMs - levelCreatedAtMs_ >=
                                     static_cast<int64_t>(cfg_.autoFinishSec) * 1000);
  if (finishDue && !finishedSent_) {
    game_->finished = true;
    game_->resultSet = true;
    game_->resultWon = true;
    game_->resultReward = "Victory";
    game_->resultMessage = "round timer";
  }
  stream_->drainEvents(&tickEvents_);
  for (auto& kv : guests_) {
    Guest& g = kv.second;
    if (!g.joined) continue;
    sendFrame(g, proto::Snapshot, stream_->snapshot(g.view));
    const std::vector<uint8_t> events = stream_->events(g.view, tickEvents_);
    if (!events.empty()) sendFrame(g, proto::Events, events);
    sendFrame(g, proto::Hud, stream_->hud(g.view));
  }
  tickEvents_ = TickEvents{};
  if (game_->finished && !finishedSent_) {
    finishedSent_ = true;
    for (auto& kv : guests_) {
      Guest& g = kv.second;
      if (!g.joined || g.resultSent) continue;
      g.resultSent = true;
      sendFrame(g, proto::Result, stream_->result());
    }
    matchRunning_ = false;
    closeAtMs_ = nowMs + kCloseAfterResultMs;
    restartAtMs_ = nowMs + kRestartDelayMs;
    std::printf("[mp] match finished, restarting in %lld s\n",
                static_cast<long long>(kRestartDelayMs / 1000));
    std::fflush(stdout);
  }
  stream_->advanceTick();
  (void)levelCreatedAtMs_;
}

std::string DedicatedRoom::statusJson() const {
  std::string out = "{\"room\":\"" + roomId_ + "\",\"level\":\"" + cfg_.levelKey +
                    "\",\"name\":\"" + cfg_.name + "\",\"running\":";
  out += active_ ? "true" : "false";
  out += ",\"match\":" + std::string(matchRunning_ ? "true" : "false");
  out += ",\"players\":" + std::to_string(guests_.size());
  out += ",\"max\":" + std::to_string(cfg_.maxPlayers);
  out += ",\"pubkey\":\"" + pubkeyHex_ + "\"";
  out += ",\"relayOpen\":" + std::to_string(relay_ ? relay_->openCount() : 0) + "}";
  return out;
}

}  // namespace ie
