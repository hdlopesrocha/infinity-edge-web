// Match wire streamer: encodes one Game into the binary game-channel frames
// (Scene/Snapshot/Events/Hud/Result, docs/protocol.md) for any number of
// viewers. The single-player WebSocket session has one viewer, the dedicated
// WebRTC room has one per guest - the wire output is identical either way.
#pragma once

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "proto.h"
#include "sim.h"

namespace ie {

/** One player's view of the world: their ship and what they have been sent. */
struct PlayerView {
  SpaceShip* ship = nullptr;
  uint32_t shipId = 0;
  bool sceneSent = false;
  /** Objects already spawned on this client (snapshot diff basis). */
  std::set<uint32_t> liveIds;
  /** Events only this player sees (own-ship sfx, voices, nearby explosions). */
  std::vector<std::string> voices;
  std::vector<SfxEvent> sfx;
};

/** One tick's global events (shared by every viewer). */
struct TickEvents {
  std::vector<std::string> voices;
  std::vector<SfxEvent> sfx;
  std::vector<ExplosionEvent> explosions;
};

class MatchStream {
 public:
  MatchStream(Game& game, ModelTable* models);

  Game& game() { return game_; }
  uint32_t tick() const { return tick_; }
  void advanceTick() { tick_++; }

  /** Assigns the player's wire id (Scene playerId / Hud selectedId). */
  uint32_t bindPlayer(PlayerView& view, SpaceShip* ship);
  uint32_t idOf(Abstract3D* obj);

  /** Moves the game's global event queues into `out` (once per tick). */
  void drainEvents(TickEvents* out);

  std::vector<uint8_t> scene(PlayerView& view);
  std::vector<uint8_t> snapshot(PlayerView& view);
  std::vector<uint8_t> events(PlayerView& view, const TickEvents& tick);
  std::vector<uint8_t> hud(PlayerView& view);
  std::vector<uint8_t> result();

  bool isDynamic(Abstract3D* obj) const;
  uint16_t modelIndexOf(const ModelData* m) const;
  uint16_t teamIndexOf(Team* t) const;
  const std::vector<Team*>& teams() const { return teamList_; }
  uint32_t nextExplosionSeed();

 private:
  void ensureTables();
  void writeSpawn(proto::Writer& w, Abstract3D* obj);
  void writePose(proto::Writer& w, Abstract3D* obj);
  void writeTransform(proto::Writer& w, const Vec3& pos, const Quat& rot, float scale);

  Game& game_;
  ModelTable* models_;
  uint32_t tick_ = 0;
  uint32_t nextId_ = 1;
  uint32_t explosionSeed_ = 0;
  std::map<const Abstract3D*, uint32_t> ids_;
  std::map<const ModelData*, uint16_t> modelIndex_;
  std::vector<const ModelData*> modelList_;
  std::vector<Team*> teamList_;
};

}  // namespace ie
