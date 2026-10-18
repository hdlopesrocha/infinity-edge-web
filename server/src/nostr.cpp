// Nostr events/rooms/signalling + the relay pool, see nostr.h.
#include "nostr.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <thread>

#include "wsc.h"

namespace ie {
namespace nostr {

namespace {

int64_t nowSeconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

/** JSON string literal, escaped exactly like JSON.stringify (our content). */
std::string quote(const std::string& s) { return Json(s).dump(); }

std::string tagsJson(const std::vector<std::vector<std::string>>& tags) {
  std::string out = "[";
  for (size_t i = 0; i < tags.size(); i++) {
    if (i) out += ",";
    out += "[";
    for (size_t j = 0; j < tags[i].size(); j++) {
      if (j) out += ",";
      out += quote(tags[i][j]);
    }
    out += "]";
  }
  out += "]";
  return out;
}

std::string serializeForId(const Event& evt) {
  std::string out = "[0," + quote(evt.pubkey) + "," + std::to_string(evt.created_at) + "," +
                    std::to_string(evt.kind) + "," + tagsJson(evt.tags) + "," + quote(evt.content) + "]";
  return out;
}

std::string tagValue(const Event& evt, const std::string& name) {
  for (const auto& t : evt.tags) {
    if (t.size() >= 2 && t[0] == name) return t[1];
  }
  return "";
}

}  // namespace

std::string Event::toJson() const {
  std::string out = "{\"id\":" + quote(id) + ",\"pubkey\":" + quote(pubkey) +
                    ",\"created_at\":" + std::to_string(created_at) +
                    ",\"kind\":" + std::to_string(kind) + ",\"tags\":" + tagsJson(tags) +
                    ",\"content\":" + quote(content) + ",\"sig\":" + quote(sig) + "}";
  return out;
}

bool Event::fromJson(const Json& j, Event* out) {
  if (!j.isObject()) return false;
  out->id = j["id"].asString();
  out->pubkey = j["pubkey"].asString();
  out->created_at = static_cast<int64_t>(j["created_at"].asNumber());
  out->kind = j["kind"].asInt();
  out->content = j["content"].asString();
  out->sig = j["sig"].asString();
  if (!j["tags"].isArray()) return false;
  out->tags.clear();
  for (const Json& tag : j["tags"].items()) {
    if (!tag.isArray()) return false;
    std::vector<std::string> parts;
    for (const Json& part : tag.items()) parts.push_back(part.asString());
    out->tags.push_back(std::move(parts));
  }
  return !out->id.empty() && !out->pubkey.empty();
}

bool Event::verify() const {
  if (id.size() != 64 || pubkey.size() != 64 || sig.size() != 128) return false;
  if (hexEncode(sha256(serializeForId(*this))) != id) return false;
  const std::vector<uint8_t> pk = hexDecode(pubkey);
  const std::vector<uint8_t> sg = hexDecode(sig);
  const std::vector<uint8_t> msg = hexDecode(id);
  if (pk.size() != 32 || sg.size() != 64 || msg.size() != 32) return false;
  Key32 pub{};
  Sig64 signature{};
  std::copy(pk.begin(), pk.end(), pub.begin());
  std::copy(sg.begin(), sg.end(), signature.begin());
  return schnorrVerify(msg.data(), msg.size(), pub, signature);
}

Event signEvent(int kind, std::vector<std::vector<std::string>> tags, const std::string& content,
                const Key32& sk, int64_t createdAt) {
  Event evt;
  evt.kind = kind;
  evt.tags = std::move(tags);
  evt.content = content;
  evt.created_at = createdAt > 0 ? createdAt : nowSeconds();
  evt.pubkey = hexEncode(pubkeyOf(sk));
  evt.id = hexEncode(sha256(serializeForId(evt)));
  const std::vector<uint8_t> msg = hexDecode(evt.id);
  Key32 aux{};
  randomBytes(aux.data(), aux.size());
  evt.sig = hexEncode(schnorrSign(msg.data(), msg.size(), sk, aux));
  return evt;
}

std::string certPayload(const std::string& roomId, const std::string& hostPubkey,
                        const HostCert& cert) {
  return "ie3d-mp-cert-v1|" + roomId + "|" + hostPubkey + "|" + std::to_string(cert.created) + "|" +
         std::to_string(cert.expires) + "|" + cert.key;
}

std::string answerPayload(const std::string& roomId, const std::string& from,
                          const std::string& to, const std::string& sdp) {
  return "ie3d-mp-answer-v1|" + roomId + "|" + from + "|" + to + "|" +
         hexEncode(sha256(sdp));
}

std::string authPayload(const std::string& roomId, const std::string& hostPubkey,
                        const std::string& guestPubkey, const std::string& nonce) {
  return "ie3d-mp-auth-v1|" + roomId + "|" + hostPubkey + "|" + guestPubkey + "|" + nonce;
}

Event makeRoomEvent(const std::string& roomId, const RoomContent& content, int ttlSec,
                    const Key32& sk, int64_t now) {
  Json c = Json::object();
  c.set("v", Json(static_cast<double>(content.v)));
  c.set("game", Json(content.game));
  c.set("type", Json(content.type));
  c.set("title", Json(content.title));
  c.set("host", Json(content.host));
  c.set("players", Json(static_cast<double>(content.players)));
  c.set("max", Json(static_cast<double>(content.maxPlayers)));
  std::vector<Json> iceItems;
  iceItems.reserve(content.ice.size());
  for (const auto& url : content.ice) iceItems.emplace_back(url);
  c.set("ice", Json(std::move(iceItems)));
  c.set("created", Json(static_cast<double>(content.created > 0 ? content.created : now)));
  std::vector<std::vector<std::string>> tags = {
      {"d", roomId},
      {"t", kRoomTag},
      {"t", content.type},
      {"expiration", std::to_string((content.created > 0 ? content.created : now) + ttlSec)},
  };
  return signEvent(kKindRoom, std::move(tags), c.dump(), sk, now);
}

Event makeDeletionEvent(const std::string& roomId, const Key32& sk, int64_t now) {
  Event probe;
  probe.pubkey = hexEncode(pubkeyOf(sk));
  std::vector<std::vector<std::string>> tags = {
      {"a", std::to_string(kKindRoom) + ":" + probe.pubkey + ":" + roomId},
      {"k", std::to_string(kKindRoom)},
      {"t", kRoomTag},
  };
  return signEvent(kKindDelete, std::move(tags), "room closed", sk, now);
}

Event makeSignalEvent(const std::string& roomId, const std::string& toPubkey, const Signal& signal,
                      const Key32& sk, int64_t now) {
  Json c = Json::object();
  c.set("v", Json(1.0));
  c.set("room", Json(roomId));
  c.set("to", Json(toPubkey));
  c.set("kind", Json(signal.kind));
  if (!signal.sdp.empty()) c.set("sdp", Json(signal.sdp));
  if (!signal.candidates.empty()) {
    std::vector<Json> items;
    for (const auto& cand : signal.candidates) {
      Json item = Json::object();
      item.set("candidate", Json(cand.candidate));
      if (!cand.sdpMid.empty()) item.set("sdpMid", Json(cand.sdpMid));
      item.set("sdpMLineIndex", Json(static_cast<double>(cand.sdpMLineIndex)));
      items.push_back(std::move(item));
    }
    c.set("candidates", Json(std::move(items)));
  }
  if (!signal.name.empty()) c.set("name", Json(signal.name));
  if (!signal.sig.empty()) c.set("sig", Json(signal.sig));
  std::vector<std::vector<std::string>> tags = {
      {"d", roomId},
      {"p", toPubkey},
      {"t", kRoomTag},
  };
  return signEvent(kKindSignal, std::move(tags), c.dump(), sk, now);
}

bool parseSignal(const Event& evt, const std::string& me, const std::string& roomId, Signal* out) {
  if (evt.kind != kKindSignal) return false;
  if (tagValue(evt, "d") != roomId) return false;
  Json c;
  try {
    c = Json::parse(evt.content);
  } catch (...) {
    return false;
  }
  if (!c.isObject()) return false;
  if (c["v"].asInt() != 1) return false;
  if (c["to"].asString() != me) return false;
  if (c["room"].asString() != roomId) return false;
  out->kind = c["kind"].asString();
  if (out->kind != "offer" && out->kind != "answer" && out->kind != "ice" && out->kind != "bye") {
    return false;
  }
  out->room = roomId;
  out->to = me;
  out->from = evt.pubkey;
  out->sdp = c["sdp"].asString();
  out->name = c["name"].asString();
  out->candidates.clear();
  if (c["candidates"].isArray()) {
    for (const Json& item : c["candidates"].items()) {
      Candidate cand;
      cand.candidate = item["candidate"].asString();
      cand.sdpMid = item["sdpMid"].asString();
      cand.sdpMLineIndex = item["sdpMLineIndex"].asInt();
      if (!cand.candidate.empty()) out->candidates.push_back(std::move(cand));
    }
  }
  return true;
}

// -------------------------------------------------------------- relay pool
struct RelayPool::Conn {
  std::string url;
  std::thread thread;
  std::atomic<bool> running{false};
  std::atomic<bool> open{false};
  std::mutex clientMutex;
  std::shared_ptr<WsClient> client;

  void send(const std::string& text) {
    std::lock_guard<std::mutex> lock(clientMutex);
    if (client) client->sendText(text);
  }
};

RelayPool::RelayPool(std::vector<std::string> urls) {
  for (const auto& url : urls) {
    if (url.empty()) continue;
    auto conn = std::make_unique<Conn>();
    conn->url = url;
    conns_.push_back(std::move(conn));
  }
}

RelayPool::~RelayPool() { stop(); }

void RelayPool::start() {
  for (auto& connPtr : conns_) {
    Conn* conn = connPtr.get();
    conn->running = true;
    conn->thread = std::thread([this, conn] {
      int backoffMs = 1000;
      while (conn->running) {
        auto ws = std::make_shared<WsClient>();
        ws->setMessageHandler([this, conn](const std::string& text) {
          Json msg;
          try {
            msg = Json::parse(text);
          } catch (...) {
            return;
          }
          if (!msg.isArray() || msg.items().empty()) return;
          const std::string& type = msg.items()[0].asString();
          if (type == "EVENT" && msg.items().size() >= 3) {
            Event evt;
            if (!Event::fromJson(msg.items()[2], &evt)) return;
            if (!evt.verify()) return;
            std::lock_guard<std::mutex> lock(eventsMutex_);
            if (events_.size() < 4096) {
              events_.push_back(RelayEvent{msg.items()[1].asString(), std::move(evt)});
            }
            return;
          }
          if (type == "OK") {
            const bool ok = msg.items().size() >= 3 && msg.items()[2].asBool();
            if (ok) okCount_++;
            else {
              failedCount_++;
              if (msg.items().size() >= 4) {
                std::fprintf(stderr, "[nostr] publish rejected: %s\n", msg.items()[3].asString().c_str());
              }
            }
            return;
          }
          if (type == "NOTICE" || type == "CLOSED") {
            if (msg.items().size() >= 2) {
              std::fprintf(stderr, "[nostr] %s %s: %s\n", conn->url.c_str(), type.c_str(),
                           msg.items()[1].asString().c_str());
            }
          }
        });
        std::string err;
        if (ws->connect(conn->url, &err)) {
          conn->open = true;
          backoffMs = 1000;
          {
            std::lock_guard<std::mutex> lock(conn->clientMutex);
            conn->client = ws;
          }
          // (Re)send the active subscriptions.
          std::vector<std::pair<std::string, std::vector<Json>>> subs;
          {
            std::lock_guard<std::mutex> lock(subsMutex_);
            subs = subs_;
          }
          for (const auto& [id, filters] : subs) {
            std::string req = "[\"REQ\"," + quote(id);
            for (const auto& f : filters) req += "," + f.dump();
            req += "]";
            ws->sendText(req);
          }
          ws->startReading();
          while (conn->running && ws->isOpen()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
          }
          ws->close();
          {
            std::lock_guard<std::mutex> lock(conn->clientMutex);
            conn->client.reset();
          }
          conn->open = false;
        } else {
          std::fprintf(stderr, "[nostr] %s: %s\n", conn->url.c_str(), err.c_str());
        }
        // Backoff before reconnecting.
        for (int slept = 0; slept < backoffMs && conn->running; slept += 100) {
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        backoffMs = std::min(backoffMs * 2, 30000);
      }
    });
  }
}

void RelayPool::stop() {
  for (auto& conn : conns_) {
    conn->running = false;
    {
      std::lock_guard<std::mutex> lock(conn->clientMutex);
      if (conn->client) conn->client->close();
    }
  }
  for (auto& conn : conns_) {
    if (conn->thread.joinable()) conn->thread.join();
  }
  conns_.clear();
}

void RelayPool::subscribe(const std::string& subId, std::vector<Json> filters) {
  {
    std::lock_guard<std::mutex> lock(subsMutex_);
    bool replaced = false;
    for (auto& [id, list] : subs_) {
      if (id == subId) {
        list = filters;
        replaced = true;
        break;
      }
    }
    if (!replaced) subs_.emplace_back(subId, filters);
  }
  // A second REQ with the same id replaces the subscription on the relay.
  std::string req = "[\"REQ\"," + quote(subId);
  for (const auto& f : filters) req += "," + f.dump();
  req += "]";
  for (auto& conn : conns_) conn->send(req);
}

void RelayPool::publish(const Event& evt) {
  const std::string msg = "[\"EVENT\"," + evt.toJson() + "]";
  for (auto& conn : conns_) conn->send(msg);
}

std::vector<RelayEvent> RelayPool::takeEvents() {
  std::lock_guard<std::mutex> lock(eventsMutex_);
  std::vector<RelayEvent> out;
  out.swap(events_);
  return out;
}

bool RelayPool::anyOpen() const {
  for (const auto& conn : conns_) {
    if (conn->open) return true;
  }
  return false;
}

size_t RelayPool::openCount() const {
  size_t n = 0;
  for (const auto& conn : conns_) {
    if (conn->open) n++;
  }
  return n;
}

}  // namespace nostr
}  // namespace ie
