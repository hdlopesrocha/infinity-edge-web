// Intelligence 37_T verbatim (src/game/ai.ts), plus HILocal reading the
// session's PlayerInput instead of a Control object.
#include "ai.h"

#include <algorithm>

namespace ie {

namespace {

bool teamIn(const std::vector<Team*>& list, const Team* t) {
  return std::find(list.begin(), list.end(), t) != list.end();
}

/** Steer toward a world *point* (obj.pos + desiredDir * 100 in HILocal). */
void steerTo(SpaceObject* obj, const Vec3& target, float maxAngular) {
  const Vec3 desired = vsub(target, obj->pos);
  steerToward(obj->rot, obj->dir, desired, obj->side, maxAngular);
  obj->update();
}

class AIGoRandom;
class AIGoSphere;

// AIFreePath (defined after the classes that call it).
void aiFreePathImpl(Game& gi, SpaceObject* obj, float radius);

// ------------------------------------------------------------------ AIPoint
class AIPoint : public Command {
 public:
  AIPoint(Game& gi, SpaceObject* obj, SpaceObject* target) : gi(gi), obj(obj), target(target) {}
  void execute(Game&) override {
    steerTo(obj, target->pos, obj->physics->maxAngular);
  }

 private:
  Game& gi;
  SpaceObject* obj;
  SpaceObject* target;
};

// ---------------------------------------------------------------- AIGoPoint
class AIGoPoint : public Command {
 public:
  AIGoPoint(Game& gi, SpaceObject* obj, SpaceObject* target) : gi(gi), obj(obj), target(target) {}
  void execute(Game&) override {
    AIPoint(gi, obj, target).execute(gi);
    obj->accel = vscale(obj->dir, obj->physics->accelMax);
    const Vec3 d = vsub(obj->pos, target->pos);
    const float dist = vlen(d);
    if (dist < 32) {
      obj->accel = vscale(obj->accel, std::max(0.01f, std::min(0.3f, dist / 32)));
    }
    obj->update();
  }

 private:
  Game& gi;
  SpaceObject* obj;
  SpaceObject* target;
};

// --------------------------------------------------------------- AIGoRandom
class AIGoRandom : public Command {
 public:
  AIGoRandom(Game& gi, SpaceObject* obj) : gi(gi), obj(obj), target(gi.map.randomPosition()) {}
  void execute(Game&) override {
    steerTo(obj, target, obj->physics->maxAngular);
    obj->update();
    const Vec3 d = vsub(target, obj->pos);
    if (vlen(d) > 32) {
      obj->accel = vscale(obj->dir, obj->physics->accelMax);
    } else {
      target = gi.map.randomPosition();
    }
    obj->update();
    aiFreePathImpl(gi, obj, 64);
  }

 private:
  Game& gi;
  SpaceObject* obj;
  Vec3 target;
};

// --------------------------------------------------------------- AIGoSphere
class AIGoSphere : public Command {
 public:
  AIGoSphere(Game& gi, SpaceObject* obj, SpaceObject* target, float radius)
      : gi(gi), obj(obj), target(target), radius(radius) {}
  void execute(Game&) override {
    AIPoint(gi, obj, target).execute(gi);
    obj->accel = vscale(obj->dir, obj->physics->accelMax);
    const Vec3 d = vsub(target->pos, obj->pos);
    if (vlen(d) > radius) {
      obj->accel = vscale(obj->dir, obj->physics->accelMax);
    } else {
      obj->accel = Vec3{};
    }
    obj->update();
    aiFreePathImpl(gi, obj, 64);
  }

 private:
  Game& gi;
  SpaceObject* obj;
  SpaceObject* target;
  float radius;
};

// --------------------------------------------------------------- AIFreePath
void aiFreePathImpl(Game& gi, SpaceObject* obj, float radius) {
  if (!obj->canLaunchBullet()) return;
  std::vector<OctItem*> found;
  gi.map.octree->raySelect(obj->pos.x, obj->pos.y, obj->pos.z, obj->dir.x, obj->dir.y, obj->dir.z, radius,
                           found);
  for (OctItem* o : found) {
    SpaceObject* so = dynamic_cast<SpaceObject*>(o);
    if (!so) continue;
    if (so->team != obj->team) {
      obj->launchBullet(gi, obj->dir);
      break;
    }
  }
}

// ------------------------------------------------------------- AIOffensive
class AIOffensive : public Command {
 public:
  bool executed = false;
  AIOffensive(Game& gi, SpaceObject* obj, float radius) : gi(gi), obj(obj), radius(radius) {}
  void execute(Game&) override {
    executed = false;
    if (obj->canLaunchBullet()) {
      std::vector<OctItem*> found;
      gi.map.octree->sphereSelectInteractive(obj->sx, obj->sy, obj->sz, radius, found);
      target = nullptr;
      for (OctItem* o : found) {
        SpaceObject* t = dynamic_cast<SpaceObject*>(o);
        if (!t) continue;
        if (!dynamic_cast<Base*>(t) && !dynamic_cast<Flag*>(t) && teamIn(obj->team->enemys, t->team)) {
          target = t;
          break;
        }
      }
    }
    if (target) {
      executed = true;
      AIGoPoint(gi, obj, target).execute(gi);
      if (obj->canLaunchBullet()) {
        const Vec3 dir = previewDirection(obj->pos, obj->dir, target->pos, target->vel);
        obj->launchBullet(gi, dir);
      }
    }
  }

 private:
  Game& gi;
  SpaceObject* obj;
  float radius;
  SpaceObject* target = nullptr;
};

// ---------------------------------------------------------------- AIFollow
class AIFollow : public Command {
 public:
  AIFollow(Game& gi, SpaceObject* obj, SpaceObject* who, float offensiveRadius, float targetRadius)
      : gi(gi), obj(obj), who(who), targetRadius(targetRadius), aio(gi, obj, offensiveRadius) {}
  void execute(Game&) override {
    aio.execute(gi);
    if (!aio.executed) {
      if (obj->flag && obj->team->base) {
        AIGoPoint(gi, obj, obj->team->base).execute(gi);
      } else {
        AIGoSphere(gi, obj, who, targetRadius).execute(gi);
      }
    }
  }

 private:
  Game& gi;
  SpaceObject* obj;
  SpaceObject* who;
  float targetRadius;
  AIOffensive aio;
};

// -------------------------------------------------------------- AIFlagCap
class AIFlagCap : public Command {
 public:
  AIFlagCap(Game& gi, SpaceObject* obj, float offensiveRadius)
      : gi(gi), obj(obj), aio(gi, obj, offensiveRadius) {}
  void execute(Game&) override {
    aio.execute(gi);
    if (!aio.executed) {
      Flag* target = nullptr;
      for (Team* t : obj->team->enemys) {
        if (t->flag) target = t->flag;
      }
      if (target) {
        SpaceObject* owner = target->getOwner();
        if (owner == nullptr || owner->team != obj->team) {
          AIGoPoint(gi, obj, target).execute(gi);
        } else if (owner == obj) {
          if (obj->team->base) AIGoPoint(gi, obj, obj->team->base).execute(gi);
        } else {
          if (target->team->base) AIGoPoint(gi, obj, target->team->base).execute(gi);
        }
      }
    }
  }

 private:
  Game& gi;
  SpaceObject* obj;
  AIOffensive aio;
};

// ---------------------------------------------------- AIGoRandomOffensive
class AIGoRandomOffensive : public Command {
 public:
  AIGoRandomOffensive(Game& gi, SpaceObject* obj)
      : gi(gi), obj(obj), goOffensive(gi, obj, 128), goRandom(gi, obj) {}
  void execute(Game&) override {
    if (obj->flag) {
      AIFlagCap(gi, obj, 128).execute(gi);
    } else {
      goOffensive.execute(gi);
      if (!goOffensive.executed) goRandom.execute(gi);
    }
  }

 private:
  Game& gi;
  SpaceObject* obj;
  AIOffensive goOffensive;
  AIGoRandom goRandom;
};

// ----------------------------------------------------------------- AIBreak
class AIBreak : public Command {
 public:
  AIBreak(Game& gi, SpaceObject* obj, std::unique_ptr<Command> intelligence)
      : gi(gi), intelligence(std::move(intelligence)), dummy(gi, obj) {}
  void execute(Game&) override {
    timeMs += gi.dtMs;
    const int seconds = static_cast<int>(std::floor(timeMs / 1000)) % 60;
    if (intel) {
      intelligence->execute(gi);
      if (seconds >= 10 + waitOffset) {
        waitOffset = static_cast<int>(gi.rng() * 5);
        timeMs = 0;
        intel = !intel;
      }
    } else {
      dummy.execute(gi);
      if (seconds >= 5 + waitOffset) {
        waitOffset = static_cast<int>(gi.rng() * 10);
        timeMs = 0;
        intel = !intel;
      }
    }
  }

 private:
  Game& gi;
  std::unique_ptr<Command> intelligence;
  AIGoRandom dummy;
  bool intel = true;
  float timeMs = 0;
  int waitOffset = 0;
};

// ---------------------------------------------------------------- AIHoming
class AIHoming : public Command {
 public:
  AIHoming(Game& gi, SpaceObject* obj, SpaceObject* target) : gi(gi), obj(obj), target(target) {}
  SpaceObject* lockedTarget() const override { return target; }
  void execute(Game&) override {
    SpaceObject* o = obj;
    if (target && target->active) {
      SpaceObject* t = target;
      const float speed = o->physics->velMax ? o->physics->velMax : 1;
      float lead = 0;
      for (int i = 0; i < 3; i++) {
        const Vec3 p = vsub(vadd(t->pos, vscale(t->vel, lead)), o->pos);
        lead = vlen(p) / speed;
      }
      const float turn = 0.35f * (gi.dtMs / (1000.0f / 60));
      steerTo(o, vadd(t->pos, vscale(t->vel, lead)), turn);
    }
    o->accel = vscale(o->dir, o->physics->accelMax);
    o->update();
  }

 private:
  Game& gi;
  SpaceObject* obj;
  SpaceObject* target;
};

// -------------------------------------------------------------- AITimeTrial
class AITimeTrial : public Command {
 public:
  AITimeTrial(Game& gi, SpaceObject* obj) : gi(gi), obj(obj) {}
  void execute(Game&) override {
    if (!gi.map.path.empty()) AIGoPoint(gi, obj, gi.map.path[0]).execute(gi);
  }

 private:
  Game& gi;
  SpaceObject* obj;
};

// ------------------------------------------------------------ AIKingOfHill
class AIKingOfHill : public Command {
 public:
  AIKingOfHill(Game& gi, SpaceObject* obj, float radius = 200) : gi(gi), obj(obj), aio(gi, obj, radius) {}
  void execute(Game&) override {
    GameMap& map = gi.map;
    if (!map.hasRegion) {
      aio.execute(gi);
      return;
    }
    aio.execute(gi);
    if (aio.executed) return;
    SpaceObject* o = obj;
    const Vec3& rp = map.regionPos;
    const float rr = map.regionRadius;
    const Vec3 d = vsub(o->pos, rp);
    const float dist = vlen(d);
    if (dist > rr * 0.65f) {
      steerTo(o, rp, o->physics->maxAngular);
      o->accel = vscale(o->dir, o->physics->accelMax);
      o->update();
      return;
    }
    orbit += 0.6f * (gi.dtMs / 1000.0f);
    const float r = std::max(40.0f, rr * 0.45f);
    const Vec3 target = v3(rp.x + std::cos(orbit) * r - d.x * 0.5f,
                           rp.y + std::sin(orbit * 0.7f) * r * 0.4f,
                           rp.z + std::sin(orbit) * r - d.z * 0.5f);
    steerTo(o, target, o->physics->maxAngular);
    o->accel = vscale(o->dir, o->physics->accelMax * 0.85f);
    o->update();
  }

 private:
  Game& gi;
  SpaceObject* obj;
  AIOffensive aio;
  float orbit = 0;
};

// ------------------------------------------------------------------ AIHunt
class AIHunt : public Command {
 public:
  AIHunt(Game& gi, SpaceObject* obj, float radius = 4096) : gi(gi), obj(obj), radius(radius), aio(gi, obj, 300) {}
  void execute(Game&) override {
    SpaceObject* o = obj;
    aio.execute(gi);
    if (aio.executed) return;
    retarget -= gi.dtMs;
    if (retarget <= 0 || !target || !target->active) {
      target = nearestEnemy();
      retarget = 1500;
    }
    if (!target) {
      steerTo(o, v3(0, 0, 0), o->physics->maxAngular);
      o->accel = vscale(o->dir, o->physics->accelMax * 0.8f);
      o->update();
      return;
    }
    AIGoPoint(gi, o, target).execute(gi);
    if (o->canLaunchBullet()) {
      const Vec3 dir = previewDirection(o->pos, o->dir, target->pos, target->vel);
      o->launchBullet(gi, dir);
    }
  }

 private:
  SpaceObject* nearestEnemy() {
    SpaceObject* o = obj;
    std::vector<OctItem*> found;
    gi.map.octree->sphereSelectInteractive(o->sx, o->sy, o->sz, radius, found);
    SpaceObject* best = nullptr;
    float bestD = INFINITY;
    for (OctItem* f : found) {
      SpaceObject* so = dynamic_cast<SpaceObject*>(f);
      if (!so || so == o || !so->active) continue;
      if (dynamic_cast<Base*>(so) || dynamic_cast<Flag*>(so)) continue;
      if (!teamIn(o->team->enemys, so->team)) continue;
      const float d = vlen(vsub(so->pos, o->pos));
      if (d < bestD) {
        bestD = d;
        best = so;
      }
    }
    return best;
  }

  Game& gi;
  SpaceObject* obj;
  float radius;
  AIOffensive aio;
  SpaceObject* target = nullptr;
  float retarget = 0;
};

// ----------------------------------------------------------------- HILocal
class HILocal : public Command {
 public:
  bool warning = false;
  bool inside = true;
  HILocal(Game& gi, SpaceObject* obj) : gi(gi), obj(obj) {}
  void execute(Game&) override {
    SpaceObject* o = obj;
    const PlayerInput& c = gi.input;
    o->accel = vscale(o->dir, o->physics->accelMax * c.throttle);
    const Quat q = ypr(-c.stickX * (gi.axisX ? -1.0f : 1.0f) * 1.57079632679489661923f,
                       -c.stickY * (gi.axisY ? -1.0f : 1.0f) * 1.57079632679489661923f, 0);
    const Quat qq = qmul(o->rot, q);
    const Vec3 want = vnormalize(vtransformQuat(v3(0, 0, 1), qq));
    const float stickLen = std::hypot(c.stickX, c.stickY);
    steerTo(o, vadd(o->pos, vscale(want, 100)), o->physics->maxAngular * stickLen);
    o->update();
    if (!o->insideMap) {
      if (!warning) gi.setNotification("leavingFieldOfBattle");
      warning = true;
    } else {
      warning = false;
    }
    if (o->teleported) {
      o->teleported = false;
      gi.setNotification("youWereTeleported");
    }
    inside = o->insideMap;
    if (c.fire && o->canLaunchBullet()) {
      bool executed = false;
      std::vector<OctItem*> found;
      gi.map.octree->sphereSelectInteractive(o->sx, o->sy, o->sz, gi.playerDistance, found);
      for (OctItem* it : found) {
        SpaceObject* t = dynamic_cast<SpaceObject*>(it);
        if (!t) continue;
        if (!dynamic_cast<Base*>(t) && !dynamic_cast<Flag*>(t) && teamIn(o->team->enemys, t->team)) {
          const Vec3 dir = previewDirection(o->pos, o->dir, t->pos, t->vel);
          o->launchBullet(gi, dir);
          executed = true;
          break;
        }
      }
      if (!executed) o->launchBullet(gi, o->dir);
    }
    if (c.homing) o->launchHoming(gi);
  }

 private:
  Game& gi;
  SpaceObject* obj;
};

// ---------------------------------------------------------------- AISmart
class AISmart : public Command {
 public:
  AISmart(Game& gi, SpaceObject* obj, std::unique_ptr<Command> inner)
      : gi(gi), obj(obj), inner(std::move(inner)) {}
  void execute(Game&) override {
    SpaceObject* o = obj;
    Base* base = o->team->base;
    const float life = o->lifePercentage();
    if (life < 0.35f && base) {
      AIGoPoint(gi, o, base).execute(gi);
      return;
    }
    if (evade()) return;
    inner->execute(gi);
  }

 private:
  bool evade() {
    SpaceObject* o = obj;
    if (jinkTime > 0) {
      jinkTime -= gi.dtMs / 1000.0f;
      const Vec3 side = jinkSign >= 0 ? o->side : vnegate(o->side);
      steerTo(o, v3(o->pos.x + o->dir.x * 200 + side.x * 160, o->pos.y + o->dir.y * 200 + side.y * 160,
                    o->pos.z + o->dir.z * 200 + side.z * 160),
              o->physics->maxAngular);
      o->accel = vscale(o->dir, o->physics->accelMax);
      o->update();
      return true;
    }
    if (o->hitAge > 1.2f) return false;
    std::vector<OctItem*> found;
    gi.map.octree->sphereSelectInteractive(o->sx, o->sy, o->sz, 220, found);
    for (OctItem* it : found) {
      SpaceObject* f = dynamic_cast<SpaceObject*>(it);
      if (!f || f == o || dynamic_cast<Base*>(f) || dynamic_cast<Flag*>(f)) continue;
      if (!teamIn(o->team->enemys, f->team) || !f->active) continue;
      const Vec3 d = vsub(f->pos, o->pos);
      const float l = vlen(d) == 0 ? 1 : vlen(d);
      const float behind = vdot(d, o->dir) / l;
      if (behind < -0.35f && l < 200) {
        jinkTime = 0.9f;
        jinkSign = gi.rng() < 0.5f ? -1 : 1;
        return evade();
      }
    }
    return false;
  }

  Game& gi;
  SpaceObject* obj;
  std::unique_ptr<Command> inner;
  float jinkTime = 0;
  int jinkSign = 1;
};

// ------------------------------------------------------------ AIAddonSeek
class AIAddonSeek : public Command {
 public:
  AIAddonSeek(Game& gi, SpaceShip* obj, std::unique_ptr<Command> inner)
      : gi(gi), obj(obj), inner(std::move(inner)) {}
  void execute(Game&) override {
    useWeapons();
    if (!grabAddon()) inner->execute(gi);
  }

 private:
  void useWeapons() {
    SpaceShip* o = obj;
    if (o->homings > 0 && enemyAhead(256, 0.75f)) o->launchHoming(gi);
    if (o->nitro > 0 && (!enemyAhead(350, -1) || o->lifePercentage() < 0.35f)) {
      o->launchNitro(gi.dtMs);
    }
  }

  bool enemyAhead(float range, float minDot) {
    SpaceObject* o = obj;
    std::vector<OctItem*> found;
    gi.map.octree->sphereSelectInteractive(o->sx, o->sy, o->sz, range, found);
    for (OctItem* it : found) {
      SpaceObject* t = dynamic_cast<SpaceObject*>(it);
      if (!t || t == o || !t->active) continue;
      if (dynamic_cast<Base*>(t) || dynamic_cast<Flag*>(t)) continue;
      if (!teamIn(o->team->enemys, t->team)) continue;
      if (minDot <= -1) return true;
      const Vec3 d = vsub(t->pos, o->pos);
      const float l = vlen(d) == 0 ? 1 : vlen(d);
      const float dot = vdot(o->dir, d) / l;
      if (dot > minDot) return true;
    }
    return false;
  }

  bool grabAddon() {
    SpaceShip* o = obj;
    std::vector<OctItem*> found;
    gi.map.octree->sphereSelect(o->sx, o->sy, o->sz, 320, found);
    Addon* best = nullptr;
    float bestD = INFINITY;
    for (OctItem* it : found) {
      Addon* f = dynamic_cast<Addon*>(it);
      if (!f || !f->active || !wants(f)) continue;
      const float d = vlen(vsub(f->pos, o->pos));
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) return false;
    if (o->flag && best->addonKind != AddonKind::Life) return false;
    if (enemyAhead(180, -1)) return false;
    AIGoPoint(gi, o, best).execute(gi);
    return true;
  }

  bool wants(Addon* a) {
    SpaceShip* o = obj;
    const float life = o->lifePercentage();
    if (life < 0.35f) return a->addonKind == AddonKind::Life;
    switch (a->addonKind) {
      case AddonKind::Life: return life < 0.99f;
      case AddonKind::Nitro: return o->nitro <= 0;
      case AddonKind::Homing: return o->homings < 4;
      case AddonKind::Shield: return o->shield <= 0;
    }
    return false;
  }

  Game& gi;
  SpaceShip* obj;
  std::unique_ptr<Command> inner;
};

}  // namespace

std::unique_ptr<Command> makeAIHoming(Game& gi, SpaceObject* target, SpaceObject* self) {
  return std::make_unique<AIHoming>(gi, self, target);
}

// ------------------------------------------------------------- applyAction
void applyAction(Game& gi, const std::string& name, const std::string& fromId, const std::string& toId) {
  SpaceShip* from = dynamic_cast<SpaceShip*>(gi.object(fromId));
  if (!from) return;
  SpaceObject* to = toId.empty() ? nullptr : gi.object(toId);
  if (name == "HILocal") {
    from->intelligence = std::make_unique<HILocal>(gi, from);
    from->isPlayer = true;
  } else if (name == "AIBodyGuard" && to) {
    from->intelligence = std::make_unique<AIBreak>(
        gi, from, std::make_unique<AIFollow>(gi, from, to, 128, 32));
  } else if (name == "AIFlagCap") {
    from->intelligence =
        std::make_unique<AIBreak>(gi, from, std::make_unique<AIFlagCap>(gi, from, 128));
  } else if (name == "AIFlagProt" && from->team->flag) {
    from->intelligence = std::make_unique<AIBreak>(
        gi, from, std::make_unique<AIFollow>(gi, from, from->team->flag, 128, 32));
  } else if (name == "AISpawnKiller" && to) {
    from->intelligence = std::make_unique<AIBreak>(
        gi, from, std::make_unique<AIFollow>(gi, from, to, 128, 32));
  } else if (name == "AIGoRandomOffensive") {
    from->intelligence =
        std::make_unique<AIBreak>(gi, from, std::make_unique<AIGoRandomOffensive>(gi, from));
  } else if (name == "AIKingOfHill") {
    from->intelligence = std::make_unique<AIKingOfHill>(gi, from);
  } else if (name == "AIHunt") {
    from->intelligence = std::make_unique<AIHunt>(gi, from);
  } else if (name == "AITimeTrial") {
    from->intelligence = std::make_unique<AITimeTrial>(gi, from);
  }
}

void upgradeAIShips(Game& gi, bool smart) {
  for (auto& kv : gi.objects) {
    SpaceShip* ship = dynamic_cast<SpaceShip*>(kv.second);
    if (!ship || !ship->intelligence || ship->isPlayer) continue;
    std::unique_ptr<Command> inner = std::move(ship->intelligence);
    if (smart) inner = std::make_unique<AISmart>(gi, ship, std::move(inner));
    ship->intelligence = std::make_unique<AIAddonSeek>(gi, ship, std::move(inner));
  }
}

}  // namespace ie
