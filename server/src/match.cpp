// Match wire streamer, see match.h. The payload layouts mirror
// src/game/protocol.ts / docs/protocol.md exactly (this is the code that used
// to live in session.cpp, split so a shared match can stream N viewers).
#include "match.h"

#include <algorithm>
#include <cmath>

namespace ie {

namespace {

/** SFX name -> wire id (config.ts SFX order). */
const char* const kSfxNames[] = {
    "button", "missileSound", "bulletSound", "hitSound",
    "addonSound", "farExplosion", "closeExplosion", "absorbSound",
};

/** Voice field -> wire id (config.ts VOICES order). */
const char* const kVoiceFields[] = {
    "welcome", "youLost", "objectiveCompleted", "criticalDamage", "incomingHomingMissile",
    "leavingFieldOfBattle", "missileIncoming", "newEnemyWave", "youWereTeleported",
    "ourFlagWasStolen", "targetAquired", "teleported", "warning",
    "ourTeamHasTheFlag", "enemyTeamHasTheFlag", "ourTeamRecoveredTheFlag",
    "enemyTeamRecoveredTheFlag",
};

uint8_t sfxId(const std::string& name) {
  for (size_t i = 0; i < sizeof(kSfxNames) / sizeof(kSfxNames[0]); i++) {
    if (name == kSfxNames[i]) return static_cast<uint8_t>(i);
  }
  return 0xFF;
}

int voiceId(const std::string& field) {
  for (size_t i = 0; i < sizeof(kVoiceFields) / sizeof(kVoiceFields[0]); i++) {
    if (field == kVoiceFields[i]) return static_cast<int>(i);
  }
  return -1;
}

uint8_t quantVol(float v) {
  const float c = v < 0 ? 0 : (v > 1 ? 1 : v);
  return static_cast<uint8_t>(std::lround(c * 255.0f));
}

int8_t quantPan(float v) {
  const float c = v < -1 ? -1 : (v > 1 ? 1 : v);
  return static_cast<int8_t>(std::lround(c * 127.0f));
}

uint16_t quantScale(float v) {
  const float c = v < 0 ? 0 : (v > 255.0f ? 255.0f : v);
  return static_cast<uint16_t>(std::lround(c * 256.0f));
}

uint8_t flagState(const Flag* f) {
  if (!f->getOwner()) return proto::WFlagFree;
  return dynamic_cast<const Base*>(f->getOwner()) ? proto::WFlagAtBase : proto::WFlagCarried;
}

bool teamIn(const std::vector<Team*>& list, const Team* t) {
  for (const Team* x : list) {
    if (x == t) return true;
  }
  return false;
}

}  // namespace

MatchStream::MatchStream(Game& game, ModelTable* models) : game_(game), models_(models) {}

uint32_t MatchStream::idOf(Abstract3D* obj) {
  auto it = ids_.find(obj);
  if (it != ids_.end()) return it->second;
  const uint32_t id = nextId_++;
  ids_.emplace(obj, id);
  obj->id = static_cast<int>(id);
  return id;
}

uint32_t MatchStream::bindPlayer(PlayerView& view, SpaceShip* ship) {
  view.ship = ship;
  view.shipId = ship ? idOf(ship) : 0;
  view.liveIds.clear();
  view.voices.clear();
  view.sfx.clear();
  view.sceneSent = false;
  return view.shipId;
}

bool MatchStream::isDynamic(Abstract3D* obj) const {
  return dynamic_cast<SpaceShip*>(obj) || dynamic_cast<Flag*>(obj) || dynamic_cast<Ark*>(obj) ||
         dynamic_cast<Bullet*>(obj);  // Bullet covers HomingMissile
}

uint16_t MatchStream::modelIndexOf(const ModelData* m) const {
  if (!m) return 0xFFFF;
  auto it = modelIndex_.find(m);
  return it == modelIndex_.end() ? 0xFFFF : it->second;
}

uint16_t MatchStream::teamIndexOf(Team* t) const {
  if (!t) return 0xFFFF;
  for (size_t i = 0; i < teamList_.size(); i++) {
    if (teamList_[i] == t) return static_cast<uint16_t>(i);
  }
  return 0xFFFF;
}

uint32_t MatchStream::nextExplosionSeed() {
  explosionSeed_ = explosionSeed_ * 1664525u + 1013904223u;
  return explosionSeed_;
}

void MatchStream::ensureTables() {
  modelList_.clear();
  modelIndex_.clear();
  const std::vector<std::string> aliases = models_->aliases();
  for (const std::string& alias : aliases) {
    const ModelData* m = models_->get(alias);
    if (!m) continue;
    modelIndex_.emplace(m, static_cast<uint16_t>(modelList_.size()));
    modelList_.push_back(m);
  }
  teamList_.clear();
  for (auto& kv : game_.teams) teamList_.push_back(kv.second.get());
}

void MatchStream::drainEvents(TickEvents* out) {
  out->voices.insert(out->voices.end(), game_.voices.begin(), game_.voices.end());
  out->sfx.insert(out->sfx.end(), game_.sfx.begin(), game_.sfx.end());
  out->explosions.insert(out->explosions.end(), game_.explosions.begin(), game_.explosions.end());
  game_.voices.clear();
  game_.sfx.clear();
  game_.explosions.clear();
}

// ------------------------------------------------------------------- scene
std::vector<uint8_t> MatchStream::scene(PlayerView& view) {
  ensureTables();
  proto::Writer w;
  w.u8(static_cast<uint8_t>(game_.gameType));
  w.str(game_.levelKey);
  w.str(game_.levelTitle);
  w.str(game_.levelText);
  w.f32(game_.map.size);
  w.str(game_.map.skyName);
  w.f32(game_.matchTimeMs);
  w.u32(view.shipId);

  w.u16(static_cast<uint16_t>(modelList_.size()));
  for (const ModelData* m : modelList_) w.str(m->alias);

  w.u8(static_cast<uint8_t>(teamList_.size()));
  for (Team* t : teamList_) {
    w.str(t->name);
    w.f32(t->color.x);
    w.f32(t->color.y);
    w.f32(t->color.z);
    // Enemy relations as a bitmask over this same team list (bit i = enemy).
    uint8_t mask = 0;
    for (size_t i = 0; i < teamList_.size() && i < 8; i++) {
      if (teamIn(t->enemys, teamList_[i])) mask |= static_cast<uint8_t>(1u << i);
    }
    w.u8(mask);
  }

  // miniStar billboards: scenery the client recreates (no simulation, no id).
  std::vector<Decor*> decors;
  for (auto& owned : game_.owned) {
    if (Decor* d = dynamic_cast<Decor*>(owned.get())) decors.push_back(d);
  }
  w.u16(static_cast<uint16_t>(decors.size()));
  for (Decor* d : decors) {
    w.f32(d->pos.x);
    w.f32(d->pos.y);
    w.f32(d->pos.z);
    w.f32(d->scale);
  }

  w.u8(game_.map.hasSun ? 1 : 0);
  if (game_.map.hasSun) {
    w.f32(game_.map.sunPos.x);
    w.f32(game_.map.sunPos.y);
    w.f32(game_.map.sunPos.z);
    w.f32(game_.map.sunRadius);
  }
  w.u8(game_.map.hasRegion ? 1 : 0);
  if (game_.map.hasRegion) {
    w.f32(game_.map.regionPos.x);
    w.f32(game_.map.regionPos.y);
    w.f32(game_.map.regionPos.z);
    w.f32(game_.map.regionRadius);
  }
  view.sceneSent = true;
  return w.data();
}

// ---------------------------------------------------------------- snapshot
void MatchStream::writeTransform(proto::Writer& w, const Vec3& pos, const Quat& rot, float scale) {
  const float half = game_.map.size / 2;
  w.u16(quantScale(scale));
  w.i16(proto::quantPos(pos.x, half));
  w.i16(proto::quantPos(pos.y, half));
  w.i16(proto::quantPos(pos.z, half));
  w.i16(proto::quantRot(rot.x));
  w.i16(proto::quantRot(rot.y));
  w.i16(proto::quantRot(rot.z));
  w.i16(proto::quantRot(rot.w));
}

void MatchStream::writeSpawn(proto::Writer& w, Abstract3D* obj) {
  uint8_t kind = proto::WKindBillboard;
  uint8_t state = 0;
  Vec3 pos;
  Quat rot;
  float scale = obj->scale;
  const ModelData* model = nullptr;
  Team* team = nullptr;

  if (auto* ship = dynamic_cast<SpaceShip*>(obj)) {
    kind = proto::WKindShip;
    state = ship->physics->reSpawns ? 1 : 0;
    pos = ship->pos;
    rot = ship->rot;
    model = ship->model;
    team = ship->team;
    scale = 1;
  } else if (auto* missile = dynamic_cast<HomingMissile*>(obj)) {
    kind = proto::WKindMissile;
    pos = missile->pos;
    rot = missile->rot;
    model = missile->model;
    team = missile->team;
  } else if (auto* bullet = dynamic_cast<Bullet*>(obj)) {
    kind = proto::WKindBullet;
    pos = bullet->pos;
    rot = bullet->rot;
    model = bullet->model;
    team = bullet->team;
  } else if (auto* flag = dynamic_cast<Flag*>(obj)) {
    kind = proto::WKindFlag;
    state = flagState(flag);
    pos = flag->pos;
    rot = flag->rot;
    model = flag->model;
    team = flag->team;
  } else if (auto* ark = dynamic_cast<Ark*>(obj)) {
    kind = proto::WKindArk;
    pos = ark->pos;
    rot = ark->rot;
    model = ark->model;
    team = ark->team;
  } else if (auto* addon = dynamic_cast<Addon*>(obj)) {
    kind = proto::WKindAddon;
    state = static_cast<uint8_t>(addon->addonKind);
    pos = addon->pos;
    rot = addon->rot;
    model = addon->model;
    team = addon->team;
  } else if (auto* base = dynamic_cast<Base*>(obj)) {
    kind = proto::WKindBase;
    pos = base->pos;
    rot = base->rot;
    model = base->model;
    team = base->team;
  } else if (auto* asteroid = dynamic_cast<Asteroid*>(obj)) {
    kind = proto::WKindAsteroid;
    pos = asteroid->pos;
    rot = asteroid->rot;
    model = asteroid->model;
    team = asteroid->team;
  } else if (auto* decor = dynamic_cast<Decor*>(obj)) {
    kind = proto::WKindBillboard;
    pos = decor->pos;
    rot = Quat{};
    scale = decor->scale;
  }

  w.u32(idOf(obj));
  w.u8(kind);
  w.u8(state);
  w.u16(modelIndexOf(model));
  w.u16(teamIndexOf(team));
  writeTransform(w, pos, rot, scale);
}

void MatchStream::writePose(proto::Writer& w, Abstract3D* obj) {
  const SpaceObject* so = dynamic_cast<SpaceObject*>(obj);
  const Vec3 pos = so ? so->pos : static_cast<Decor*>(obj)->pos;
  const Quat rot = so ? so->rot : Quat{};
  w.u32(idOf(obj));
  writeTransform(w, pos, rot, obj->scale);
}

std::vector<uint8_t> MatchStream::snapshot(PlayerView& view) {
  std::vector<Abstract3D*> spawns;
  std::vector<Abstract3D*> poses;
  std::set<uint32_t> now;
  for (Abstract3D* obj : game_.map.live) {
    if (obj->destroyed) continue;
    const uint32_t id = idOf(obj);
    now.insert(id);
    if (!view.liveIds.count(id)) spawns.push_back(obj);
    if (isDynamic(obj)) poses.push_back(obj);
  }
  std::vector<uint32_t> removed;
  for (uint32_t id : view.liveIds) {
    if (!now.count(id)) removed.push_back(id);
  }
  view.liveIds = std::move(now);

  proto::Writer w;
  w.u32(tick_);
  w.u16(static_cast<uint16_t>(spawns.size()));
  for (Abstract3D* obj : spawns) writeSpawn(w, obj);
  w.u16(static_cast<uint16_t>(poses.size()));
  for (Abstract3D* obj : poses) writePose(w, obj);
  w.u16(static_cast<uint16_t>(removed.size()));
  for (uint32_t id : removed) w.u32(id);
  return w.data();
}

// ------------------------------------------------------------------ events
std::vector<uint8_t> MatchStream::events(PlayerView& view, const TickEvents& tick) {
  // Voices first, then sfx, then explosions: deterministic order for replay
  // tests; the client treats them as independent records.
  struct Rec {
    uint8_t type;
    size_t index;
    bool local;  // from the viewer's queue
  };
  std::vector<Rec> recs;
  for (size_t i = 0; i < tick.voices.size(); i++) {
    if (voiceId(tick.voices[i]) >= 0) recs.push_back(Rec{proto::EvVoice, i, false});
  }
  for (size_t i = 0; i < view.voices.size(); i++) {
    if (voiceId(view.voices[i]) >= 0) recs.push_back(Rec{proto::EvVoice, i, true});
  }
  for (size_t i = 0; i < tick.sfx.size(); i++) {
    if (sfxId(tick.sfx[i].name) != 0xFF) recs.push_back(Rec{proto::EvSound, i, false});
  }
  for (size_t i = 0; i < view.sfx.size(); i++) {
    if (sfxId(view.sfx[i].name) != 0xFF) recs.push_back(Rec{proto::EvSound, i, true});
  }
  for (size_t i = 0; i < tick.explosions.size(); i++) {
    recs.push_back(Rec{proto::EvExplosion, i, false});
  }
  if (recs.empty()) {
    view.voices.clear();
    view.sfx.clear();
    return {};
  }

  proto::Writer w;
  w.u16(static_cast<uint16_t>(recs.size()));
  for (const Rec& rec : recs) {
    w.u8(rec.type);
    if (rec.type == proto::EvVoice) {
      const std::string& field = rec.local ? view.voices[rec.index] : tick.voices[rec.index];
      w.u8(static_cast<uint8_t>(voiceId(field)));
    } else if (rec.type == proto::EvSound) {
      const SfxEvent& s = rec.local ? view.sfx[rec.index] : tick.sfx[rec.index];
      w.u8(sfxId(s.name));
      w.u8(quantVol(s.volume));
      w.i8(quantPan(s.pan));
    } else {
      const ExplosionEvent& e = tick.explosions[rec.index];
      const float half = game_.map.size / 2;
      w.i16(proto::quantPos(e.pos.x, half));
      w.i16(proto::quantPos(e.pos.y, half));
      w.i16(proto::quantPos(e.pos.z, half));
      w.f32(e.scale);
      w.u16(static_cast<uint16_t>(e.life > 0 ? e.life : 0));
      w.u8(static_cast<uint8_t>(e.smoke < 0 ? 0 : (e.smoke > 255 ? 255 : e.smoke)));
      w.u8(static_cast<uint8_t>(e.debris < 0 ? 0 : (e.debris > 255 ? 255 : e.debris)));
      w.u16(modelIndexOf(e.debrisModel));
      w.u32(nextExplosionSeed());
    }
  }
  view.voices.clear();
  view.sfx.clear();
  return w.data();
}

// --------------------------------------------------------------------- hud
std::vector<uint8_t> MatchStream::hud(PlayerView& view) {
  Game& g = game_;
  SpaceShip* sel = view.ship;
  proto::Writer w;
  w.u32(tick_);
  const float matchLeft =
      (g.matchTimeMs > 0 && sel) ? std::max(0.0f, g.matchTimeMs - sel->team->timeMs) : -1.0f;
  w.f32(matchLeft);
  w.u8(g.startCountdownMs > 0 ? static_cast<uint8_t>(std::ceil(g.startCountdownMs / 1000.0f)) : 0);
  // Per-viewer death cause (each guest sees how *their* ship died).
  if (view.ship) {
    auto cause = g.deathCauses.find(view.ship);
    w.str(cause == g.deathCauses.end() ? std::string() : cause->second);
  } else {
    w.str(g.deathCause);
  }

  if (sel && sel->life) {
    if (auto* l3 = dynamic_cast<Life3*>(sel->life.get())) {
      w.u8(3);
      w.f32(l3->left());
      w.f32(l3->maxLeft());
      w.f32(l3->center());
      w.f32(l3->maxCenter());
      w.f32(l3->right());
      w.f32(l3->maxRight());
    } else {
      w.u8(1);
      w.f32(sel->life->total());
      w.f32(100);
    }
  } else {
    w.u8(0);
  }

  const OutsideTimer* out = nullptr;
  if (sel) {
    for (const OutsideTimer& t : g.map.outsideObjects) {
      if (t.obj == sel) {
        out = &t;
        break;
      }
    }
  }
  w.u8(out ? 1 : 0);
  if (out) {
    w.f32(std::max(0.0f, out->max - out->elapsed));
    w.f32(out->max);
  }
  const OutsideTimer* resp = nullptr;
  if (sel) {
    for (const OutsideTimer& t : g.map.respawned) {
      if (t.obj == sel) {
        resp = &t;
        break;
      }
    }
  }
  w.u8(resp ? 1 : 0);
  if (resp) {
    w.f32(std::max(0.0f, resp->max - resp->elapsed));
    w.f32(resp->max);
  }

  w.f32(sel ? vlen(sel->vel) : 0);

  bool warn = false;
  for (Abstract3D* o : g.map.live) {
    HomingMissile* m = dynamic_cast<HomingMissile*>(o);
    if (m && m->active && m->intelligence && m->intelligence->lockedTarget() == sel) {
      warn = true;
      break;
    }
  }
  w.u8(warn ? 1 : 0);

  bool lock = false;
  if (sel) {
    std::vector<OctItem*> found;
    g.map.octree->sphereSelectInteractive(sel->sx, sel->sy, sel->sz, 256, found);
    const float cosCone = std::cos(0.175f);
    for (OctItem* it : found) {
      SpaceShip* other = dynamic_cast<SpaceShip*>(it);
      if (!other || !other->active || other == sel) continue;
      if (!teamIn(sel->team->enemys, other->team)) continue;
      const Vec3 d = vsub(other->pos, sel->pos);
      const float len = vlen(d) == 0 ? 1 : vlen(d);
      if (vdot(sel->dir, d) / len > cosCone) {
        lock = true;
        break;
      }
    }
  }
  w.u8(lock ? 1 : 0);

  w.u8(sel ? static_cast<uint8_t>(sel->homings & 0xFF) : 0);
  const float nitroFrac = sel ? sel->nitro / 3000.0f : 0;
  w.u8(static_cast<uint8_t>(std::floor(nitroFrac * 100)));
  w.u8(static_cast<uint8_t>(teamList_.size()));
  for (Team* t : teamList_) {
    w.str(t->name);
    w.f32(t->points);
    w.f32(t->kills);
    w.f32(t->hillMs);
    w.f32(t->timeMs);
  }
  std::vector<SpaceShip*> ships;
  for (Abstract3D* o : g.map.live) {
    SpaceShip* s = dynamic_cast<SpaceShip*>(o);
    if (s && s->active) ships.push_back(s);
  }
  w.u8(static_cast<uint8_t>(ships.size()));
  for (SpaceShip* s : ships) {
    w.u32(idOf(s));
    float pct = s->lifePercentage();
    if (!(pct > 0)) pct = 0;
    if (pct > 1) pct = 1;
    w.u8(static_cast<uint8_t>(std::lround(pct * 100.0f)));
  }
  w.u32(sel ? view.shipId : 0);
  w.u8(g.finished ? 1 : 0);
  return w.data();
}

std::vector<uint8_t> MatchStream::result() {
  proto::Writer w;
  w.u8(game_.resultWon ? 1 : 0);
  w.str(game_.resultReward);
  w.str(game_.resultMessage);
  return w.data();
}

}  // namespace ie
