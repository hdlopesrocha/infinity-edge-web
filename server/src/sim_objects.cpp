// Object hierarchy + GameMap: verbatim port of src/game/objects.ts and
// src/game/map.ts with every draw/audio call replaced by an event.
#include <algorithm>
#include <cstdlib>

#include "ai.h"
#include "sim.h"

namespace ie {

// ----------------------------------------------------------------- physics
const Physics& physicsPreset(const std::string& name) {
  static const Physics SSTT{128, 32, 0.1f, false, true, ObKind::Interactive};
  static const Physics SS1{128, 64, 0.05f, false, true, ObKind::Interactive};
  static const Physics SS1R{128, 64, 0.05f, true, true, ObKind::Interactive};
  static const Physics FRAG{0, 30, 0, false, false, ObKind::Uncollidable};
  static const Physics STATIC{0, 0, 0, false, false, ObKind::Environment};
  static const Physics ISTATIC{0, 0, 0, false, false, ObKind::Interactive};
  static const Physics BULLET{1024, 256, 0, false, false, ObKind::Uncollidable};
  static const Physics MISSILE{512, 1024, 0.1f, false, false, ObKind::Uncollidable};
  static const Physics EMPTY{0, 0, 0, false, false, ObKind::Uncollidable};
  if (name == "SSTT") return SSTT;
  if (name == "SS1") return SS1;
  if (name == "SS1R") return SS1R;
  if (name == "FRAG") return FRAG;
  if (name == "STATIC") return STATIC;
  if (name == "ISTATIC") return ISTATIC;
  if (name == "BULLET") return BULLET;
  if (name == "MISSILE") return MISSILE;
  return EMPTY;
}

void nextPosition(BodyState& b, float dtMs) {
  const float dt = dtMs / 1000.0f;
  const float m = b.multiplier;
  b.vel->x += (b.accel->x * m - b.friction * b.vel->x) * dt;
  b.vel->y += (b.accel->y * m - b.friction * b.vel->y) * dt;
  b.vel->z += (b.accel->z * m - b.friction * b.vel->z) * dt;
  const float len = vlen(*b.vel);
  const float max = b.physics->velMax * m;
  if (len > 0) {
    if (len > max) *b.vel = vscale(*b.vel, max / len);
    b.pos->x += b.vel->x * dt;
    b.pos->y += b.vel->y * dt;
    b.pos->z += b.vel->z * dt;
  }
  b.multiplier = b.multiplier + (1 - b.multiplier) * 0.2f;
}

Vec3 previewDirection(const Vec3& fromPos, const Vec3& fromDir, const Vec3& targetPos, const Vec3& targetVel) {
  const Vec3 t = vsub(targetPos, fromPos);
  const float tl = vlen(t) == 0 ? 1 : vlen(t);
  const float dot = vdot(t, fromDir) / tl;
  if (dot > 0.985f) {
    const float tv2 = vsqlen(targetVel);
    const float bulletMax = physicsPreset("BULLET").velMax;
    const float a = tv2 - bulletMax * bulletMax;
    const float b = 2 * vdot(targetVel, t);
    const float c = vsqlen(t);
    const float p = -b / (2 * a);
    const float disc = b * b - 4 * a * c;
    const float q = std::sqrt(disc) / (2 * a);
    const float t1 = p - q;
    const float t2 = p + q;
    const float tt = (t1 > t2 && t2 > 0) ? t2 : t1;
    return vnormalize(vadd(t, vscale(targetVel, tt)));
  }
  return fromDir;
}

static Vec3 randomTumble(const std::function<float()>& r) {
  auto c = [&]() { return (std::floor(r() * 3000) / 1000) * 3.14159265358979323846f / 180.0f; };
  return v3(c(), c(), c());
}

static bool teamIn(const std::vector<Team*>& list, const Team* t) {
  return std::find(list.begin(), list.end(), t) != list.end();
}

void spawnExplosion(Game& gi, const Vec3& pos, float scale, const ExplosionOpts& opts) {
  ExplosionEvent ev;
  ev.pos = pos;
  ev.scale = scale;
  ev.life = opts.life;
  ev.smoke = opts.smoke >= 0 ? opts.smoke
                             : std::max(2, static_cast<int>(std::lround(2 + scale * 2)));
  ev.debris = opts.debris;
  ev.debrisModel = opts.debrisModel;
  ev.debrisScale = opts.debrisScale;
  gi.explosions.push_back(ev);
}

// ---------------------------------------------------------------- Object3D
Object3D::Object3D(const Physics* p, const Vec3& position, const ModelData* model, float scale)
    : Abstract3D(p), model(model) {
  multiplier = 1;
  this->scale = scale;
  pos = position;
  lastPos = position;
  insideMap = true;
  prevPos = pos;
  prevRot = rot;
  hasPrev = true;
}

void Object3D::setBoundingSphere() {
  float r = 1;
  if (model) r = model->radius;
  sx = pos.x;
  sy = pos.y;
  sz = pos.z;
  sradius = r * scale;
}

void Object3D::update() {
  dir = dirFromQuat(rot);
  up = upFromQuat(rot);
  side = sideFromQuat(rot);
  setBoundingSphere();
}

void Object3D::automaticAction(Game& gi, float dtMs) {
  if (intelligence && active) intelligence->execute(gi);
  (void)dtMs;
}

bool Object3D::step(float dtMs) {
  lastPos = pos;
  markPrev();
  // `model.friction` is always 1 in the client's resource loader.
  BodyState b{&pos, &vel, &accel, multiplier, 1.0f, physics};
  nextPosition(b, dtMs);
  // Object3D.step decays the multiplier a second time (nextPosition already
  // did once); verbatim.
  multiplier = multiplier + (1 - multiplier) * 0.2f;
  return vlen(vel) > 0;
}

// --------------------------------------------------------------- SpaceObject
SpaceObject::SpaceObject(const Physics* p, Team* team, const Vec3& position, const ModelData* model,
                         std::unique_ptr<Life> life, float scale)
    : Object3D(p, position, model, scale), life(std::move(life)), team(team) {}

void SpaceObject::receiveDamage(Game& gi, float amount, const Vec3& direction, SpaceObject* attacker) {
  hitAge = 0;
  if (!life) return;
  life->receiveDamage(amount, direction, up, dir, [this, &gi, attacker]() { destroyObject(gi, attacker); });
}

void SpaceObject::move(Game& gi, float dtMs) {
  GameMap& map = gi.map;
  if (active) {
    if (step(dtMs)) map.refreshObject(this);
  }
  map.refreshObject(this);
  if (physics->objectType != ObKind::Uncollidable) {
    std::vector<OctItem*> stack;
    map.octree->sphereSelect(sx, sy, sz, sradius, stack);
    for (OctItem* o : stack) {
      SpaceObject* obj = dynamic_cast<SpaceObject*>(o);
      if (!obj || obj == this) continue;
      const ObKind t = obj->physics->objectType;
      if (t == ObKind::Uncollidable || dynamic_cast<Flag*>(obj) || dynamic_cast<Base*>(obj)) continue;
      if (Addon* addon = dynamic_cast<Addon*>(obj)) {
        gi.shipSfx(this, "addonSound", 1, 0);
        addon->doThings(*this);
        addon->destroyObject(gi);
        continue;
      }
      if (Ark* ark = dynamic_cast<Ark*>(obj)) {
        if (!map.path.empty() && ark == map.path.front() && ark->team != team) {
          ark->destroyObject(gi);
          map.path.erase(map.path.begin());
        }
        continue;
      }
      if (obj->team != team) {
        const float a = totalLife();
        const float b = obj->totalLife();
        const Vec3 d = vnormalize(vsub(obj->pos, pos));
        receiveDamage(gi, b, d, obj);
        const Vec3 d2 = vnormalize(vsub(pos, obj->pos));
        obj->receiveDamage(gi, a, d2, this);
        const Vec3 hit = vscale(vadd(pos, obj->pos), 0.5f);
        const bool heavy = std::max(a, b) > 0;
        spawnExplosion(gi, hit, heavy ? 2.2f : 1.5f, ExplosionOpts{heavy ? 6 : 4, 0, nullptr, 1, 540});
      }
    }
  }
}

void SpaceObject::destroyObject(Game& gi, SpaceObject* attacker) {
  if (destroyed) return;
  destroyed = true;
  gi.recordDeath(this, attacker);
  GameMap& map = gi.map;
  if (attacker && attacker != this && attacker->team != team && isShip()) attacker->team->kills++;
  if (flag) flag->setOwner(nullptr);
  if (physics->reSpawns) {
    map.respawned.push_back(OutsideTimer{this, 0, 10000});
    map.removeObject(this);
  } else {
    auto& objs = team->objects;
    objs.erase(std::remove(objs.begin(), objs.end(), this), objs.end());
    map.removeObject(this);
  }
  // A time-trial checkpoint (Ark) is *collected*, not destroyed: no fireball.
  if (!dynamic_cast<Ark*>(this)) {
    const float exScale = isShip() ? 4.0f : 3.0f;
    spawnExplosion(gi, pos, exScale, ExplosionOpts{12, 6, model, scale, 750});
  }
  gi.explosionSfx(this);
}

void SpaceObject::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  if (intelligence) intelligence->execute(gi);
  move(gi, dtMs);
}

bool SpaceObject::bulletHit(const Bullet& b, float* t) const {
  const Vec3 d = b.dir;
  float best = INFINITY;
  bool any = false;
  auto test = [&](const std::vector<MeshSphere>& meshes) {
    for (const MeshSphere& m : meshes) {
      const Vec3 wc = vadd(pos, vscale(vtransformQuat(m.center, rot), scale));
      const float wr = m.radius * scale;
      float hit;
      if (raySphere(b.lastPos.x, b.lastPos.y, b.lastPos.z, d.x, d.y, d.z, wc.x, wc.y, wc.z, wr, &hit)) {
        if (hit < best) {
          best = hit;
          any = true;
        }
      }
    }
  };
  if (model && model->hasSolid) test(model->solidMeshes);
  if (model && model->hasColor) test(model->colorMeshes);
  if (!any) return false;
  const float range = vlen(vsub(b.pos, b.lastPos));
  if (best < range) {
    *t = best;
    return true;
  }
  return false;
}

bool SpaceObject::isShip() const { return dynamic_cast<const SpaceShip*>(this) != nullptr; }

// ---------------------------------------------------------------- SpaceShip
SpaceShip::SpaceShip(const Physics* p, Game& gi, Team* team, const Vec3& position, const ModelData* model,
                     std::unique_ptr<Life> life, const ModelData* shieldModel)
    : SpaceObject(p, team, position, model, std::move(life), 1), shieldModel(shieldModel) {
  shield = 0;
  nitro = 0;
  launchs = 0;
  launchSpan = 0;
  glow = 0;
  homings = 2;
  team->objects.push_back(this);
  gi.map.insertObject(this);
}

void SpaceShip::launchBullet(Game& gi, const Vec3& direction) {
  const ModelData* mdl = gi.models->get("Bullet");
  if (!mdl || !mdl->hasSolid) return;
  const float s = (launchs % 2 == 0) ? 1.0f : -1.0f;
  Bullet* b = new Bullet(gi, mdl, this,
                         v3(pos.x + s * side.x / 2, pos.y + s * side.y / 2, pos.z + s * side.z / 2),
                         direction);
  gi.own(b);
  launchs++;
  launchSpan = std::fmod(launchSpan, 200.0f);
  gi.shipSfx(this, "bulletSound", 0.2f, 0);
}

void SpaceShip::launchNitro(float dtMs) {
  if (nitro > 0) {
    multiplier = 7.5f;
    nitro -= dtMs;
    if (nitro < 0) nitro = 0;
  }
}

void SpaceShip::launchHoming(Game& gi) {
  if (launchSpan < 200 || homings <= 0) return;
  SpaceObject* target = nullptr;
  float maxDot = 0.75f;
  std::vector<OctItem*> stack;
  gi.map.octree->sphereSelectInteractive(pos.x, pos.y, pos.z, 256, stack);
  for (OctItem* o : stack) {
    SpaceObject* so = dynamic_cast<SpaceObject*>(o);
    if (!so) continue;
    if (!teamIn(team->enemys, so->team)) continue;
    const Vec3 d = vsub(so->pos, pos);
    const float l = vlen(d) == 0 ? 1 : vlen(d);
    const float dot = vdot(dir, d) / l;
    if (dot > maxDot) {
      target = so;
      maxDot = dot;
    }
  }
  const ModelData* mdl = gi.models->get("HomingMissile2");
  if (!mdl || !mdl->hasSolid) return;
  const float s = (launchs % 2 == 0) ? 1.0f : -1.0f;
  HomingMissile* missile = new HomingMissile(
      gi, mdl, this,
      v3(pos.x + (s * side.x * 2) / 3 - up.x / 3 - dir.x / 3,
         pos.y + (s * side.y * 2) / 3 - up.y / 3 - dir.y / 3,
         pos.z + (s * side.z * 2) / 3 - up.z / 3 - dir.z / 3),
      2000);
  gi.own(missile);
  homings--;
  launchs++;
  missile->intelligence = makeAIHoming(gi, target, missile);
  launchSpan = std::fmod(launchSpan, 200.0f);
  gi.shipSfx(this, "missileSound", 1, 0);
}

void SpaceShip::receiveDamage(Game& gi, float amount, const Vec3& direction, SpaceObject* attacker) {
  if (!life) return;
  hitAge = 0;
  if (shield <= 0) {
    life->receiveDamage(amount, direction, up, dir, [this, &gi, attacker]() { destroyObject(gi, attacker); });
    gi.shipSfx(this, "hitSound", 1, 0);
  } else {
    shield--;
    gi.shipSfx(this, "absorbSound", 1, 0);
  }
}

void SpaceShip::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  if (intelligence) intelligence->execute(gi);
  if (!isPlayer) arenaGuard(gi);
  hitAge += dtMs / 1000.0f;
  launchSpan += dtMs;
  move(gi, dtMs);
  // Decayed once per drawn frame in the client (alphaDraw); once per tick here.
  if (glow > 0) glow -= 0.03f;
}

void SpaceShip::arenaGuard(Game& gi) {
  const float half = gi.map.size / 2;
  const float margin = 64;
  const Vec3& p = pos;
  const float over = std::max(std::max(std::fabs(p.x), std::fabs(p.y)), std::fabs(p.z)) - (half - margin);
  if (over <= 0) return;
  steerToward(rot, dir, v3(-p.x, -p.y, -p.z), side, physics->maxAngular * 2);
  update();
  accel = vscale(dir, physics->accelMax);
  markPrev();
  const float wall = half - 8;
  float* pp[3] = {&pos.x, &pos.y, &pos.z};
  float* vv[3] = {&vel.x, &vel.y, &vel.z};
  for (int i = 0; i < 3; i++) {
    if (*pp[i] > wall) {
      *pp[i] = wall;
      if (*vv[i] > 0) *vv[i] = 0;
    } else if (*pp[i] < -wall) {
      *pp[i] = -wall;
      if (*vv[i] < 0) *vv[i] = 0;
    }
  }
  update();
}

// ----------------------------------------------------------------- Asteroid
Asteroid::Asteroid(GameMap& map, Team* team, const Vec3& position, const ModelData* model,
                   std::unique_ptr<Life> life)
    : SpaceObject(&physicsPreset("STATIC"), team, position, model, std::move(life), 1) {
  tumble = randomTumble(map.rng);
  map.insertObject(this);
}

void Asteroid::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  const float d = 180.0f / 3.14159265358979323846f;
  const Quat e = qfromEulerDeg(tumble.x * d, tumble.y * d, tumble.z * d);
  rot = qnormalize(qmul(rot, e));
  if (step(dtMs)) gi.map.refreshObject(this);
  update();
}

void Asteroid::destroyObject(Game& gi, SpaceObject* attacker) {
  if (destroyed) return;
  SpaceObject::destroyObject(gi, attacker);
  const float perc = gi.rng();
  const ModelData* mdl = nullptr;
  AddonKind kind = AddonKind::Homing;
  Vec3 color{1, 0, 0};
  if (perc < 0.12f) {
    mdl = gi.models->get("adHomingMissile");
    kind = AddonKind::Homing;
    color = v3(1, 0, 0);
  } else if (perc < 0.24f) {
    mdl = gi.models->get("adRepair");
    kind = AddonKind::Life;
    color = v3(0.2f, 1, 0.2f);
  } else if (perc < 0.36f) {
    mdl = gi.models->get("adShield");
    kind = AddonKind::Shield;
    color = v3(0.4f, 0.6f, 1);
  } else if (perc < 0.48f) {
    mdl = gi.models->get("adNitro");
    kind = AddonKind::Nitro;
    color = v3(1, 0.55f, 0);
  }
  if (mdl) gi.own(new Addon(gi, team, pos, mdl, color, kind, gi.map));
}

// -------------------------------------------------------------------- Addon
Addon::Addon(Game& gi, Team* team, const Vec3& position, const ModelData* model, const Vec3& color,
             AddonKind kind, GameMap& map)
    : SpaceObject(&physicsPreset("STATIC"), team, position, model, nullptr, 1),
      addonKind(kind), glowColor(color) {
  tumble = randomTumble(gi.rng);
  map.insertObject(this);
}

void Addon::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  const float d = 180.0f / 3.14159265358979323846f;
  const Quat e = qfromEulerDeg(tumble.x * d, tumble.y * d, tumble.z * d);
  rot = qnormalize(qmul(rot, e));
  update();
  (void)gi;
  (void)dtMs;
}

void Addon::doThings(SpaceObject& obj) {
  SpaceShip* ship = dynamic_cast<SpaceShip*>(&obj);
  if (!ship) return;
  ship->glow = 1;
  ship->glowColor = glowColor;
  switch (addonKind) {
    case AddonKind::Homing: ship->homings += 2; break;
    case AddonKind::Life: ship->restoreLife(); break;
    case AddonKind::Nitro: ship->nitro = 3000; break;
    case AddonKind::Shield: ship->shield = 10; break;
  }
}

void Addon::destroyObject(Game& gi, SpaceObject*) {
  if (destroyed) return;
  destroyed = true;
  auto& objs = team->objects;
  objs.erase(std::remove(objs.begin(), objs.end(), this), objs.end());
  gi.map.removeObject(this);
}

// --------------------------------------------------------------------- Base
Base::Base(GameMap& map, Team* team, const Vec3& position, const ModelData* model, float scale)
    : SpaceObject(&physicsPreset("ISTATIC"), team, position, model, nullptr, 1) {
  team->objects.push_back(this);
  this->scale = scale;
  team->base = this;
  update();
  map.insertObject(this);
}

Vec3 Base::randomAround(std::function<float()> rng) {
  const float a = std::floor(rng() * 3.14159265358979323846f * 1000) / 1000;
  const float b = std::floor(rng() * 2 * 3.14159265358979323846f * 1000) / 1000;
  const float radius = sradius * 4;
  return v3(pos.x + std::sin(a) * std::cos(b) * radius,
            pos.y + std::sin(a) * std::sin(b) * radius,
            pos.z + std::cos(a) * radius);
}

// --------------------------------------------------------------------- Flag
Flag::Flag(Game& gi, Base& base, const ModelData* model)
    : SpaceObject(&physicsPreset("ISTATIC"), base.team, base.pos, model, nullptr, 1) {
  tumble = randomTumble(gi.rng);
  sideRot = 0;
  team->objects.push_back(this);
  team->flag = this;
  setOwner(&base);
  gi.map.insertObject(this);
}

void Flag::setOwner(SpaceObject* o) {
  if (owner_ != o) {
    if (owner_) owner_->flag = nullptr;
    if (!o) timeLost_ = 0;
    else o->flag = this;
    owner_ = o;
  }
}

void Flag::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  GameMap& map = gi.map;
  std::vector<OctItem*> stack;
  float bsR = sradius;
  if (owner_) bsR = owner_->sradius;
  map.octree->sphereSelectInteractive(sx, sy, sz, bsR, stack);
  bool scored = false;
  for (OctItem* o : stack) {
    SpaceObject* co = dynamic_cast<SpaceObject*>(o);
    if (!co) continue;
    if (co->team != team && dynamic_cast<Base*>(co) && co->flag != nullptr) {
      for (Team* t : team->enemys) t->sounds.push_back("objectiveCompleted");
      for (Team* t : team->allies) t->sounds.push_back("youLost");
      co->team->points++;
      scored = true;
      setOwner(team->base);
      break;
    }
  }
  if (!scored && (owner_ == nullptr || dynamic_cast<Base*>(owner_) != nullptr)) {
    for (OctItem* o : stack) {
      SpaceObject* co = dynamic_cast<SpaceObject*>(o);
      if (!co) continue;
      if (co->physics->collector && co->active) {
        if (co->team == team && owner_ != team->base) {
          for (Team* t : team->enemys) t->sounds.push_back("enemyTeamRecoveredTheFlag");
          for (Team* t : team->allies) t->sounds.push_back("ourTeamRecoveredTheFlag");
          setOwner(team->base);
          break;
        } else if (co->team != team) {
          for (Team* t : team->enemys) t->sounds.push_back("ourTeamHasTheFlag");
          for (Team* t : team->allies) t->sounds.push_back("ourFlagWasStolen");
          setOwner(co);
          break;
        }
      }
    }
  }
  if (owner_ == nullptr) {
    timeLost_ += dtMs;
    if (timeLost_ >= timeToLive_) {
      setOwner(team->base);
      timeLost_ = 0;
      for (Team* t : team->enemys) t->sounds.push_back("enemyTeamRecoveredTheFlag");
      for (Team* t : team->allies) t->sounds.push_back("ourTeamRecoveredTheFlag");
    }
  }
  if (owner_) {
    pos = owner_->pos;
    map.refreshObject(this);
  }
  if (owner_ == nullptr || dynamic_cast<Base*>(owner_) != nullptr) {
    const float d = 180.0f / 3.14159265358979323846f;
    const Quat e = qfromEulerDeg(tumble.x * d, tumble.y * d, tumble.z * d);
    rot = qnormalize(qmul(rot, e));
    step(dtMs);
    scale = 1;
    if (owner_) pos = owner_->pos;
  } else {
    const Quat e = ypr(sideRot, 0, 0);
    rot = qnormalize(qmul(owner_->rot, e));
    sideRot += 0.1f;
    scale = 0.1f;
    pos = vadd(pos, vscale(owner_->up, 0.5f));
  }
  map.refreshObject(this);
}

// ------------------------------------------------------------------- Bullet
Bullet::Bullet(Game& gi, const ModelData* model, SpaceObject* launcher, const Vec3& position,
               const Vec3& direction, float ttl)
    : SpaceObject(&physicsPreset("BULLET"), launcher->team, position, model,
                  std::make_unique<Life1>(10), 1),
      launcher(launcher) {
  rot = ypr(getH(direction), getV(direction), 0);
  update();
  gi.map.insertObject(this);
  gi.map.allBullets.push_back(BulletTimer{this, 0, ttl});
  accel = vscale(dir, physics->accelMax);
  vel = vscale(dir, physics->velMax);
}

void Bullet::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  if (step(dtMs)) gi.map.refreshObject(this);
  gi.map.refreshObject(this);
}

void Bullet::setBoundingSphere() {
  sx = (pos.x + lastPos.x) / 2;
  sy = (pos.y + lastPos.y) / 2;
  sz = (pos.z + lastPos.z) / 2;
  const bool moved = pos.x != lastPos.x || pos.y != lastPos.y || pos.z != lastPos.z;
  sradius = moved ? vlen(vsub(lastPos, pos)) / 2 : 1;
}

// ------------------------------------------------------------ HomingMissile
HomingMissile::HomingMissile(Game& gi, const ModelData* model, SpaceObject* launcher, const Vec3& position,
                             float ttl)
    : Bullet(gi, model, launcher, position, launcher->dir, ttl) {
  physics = &physicsPreset("MISSILE");
  life = std::make_unique<Life1>(500);
  accel = vscale(dir, physics->accelMax);
  vel = launcher->vel;
  update();
  gi.map.refreshObject(this);
}

void HomingMissile::automaticAction(Game& gi, float dtMs) {
  if (!active) return;
  if (intelligence) intelligence->execute(gi);
  move(gi, dtMs);
}

// ---------------------------------------------------------------------- Ark
Ark::Ark(GameMap& map, Team* team, const Vec3& position, const ModelData* model)
    : SpaceObject(&physicsPreset("STATIC"), team, position, model, nullptr, 1) {
  alpha = 0.2f;
  color = v3(1, 1, 1);
  map.insertObject(this);
}

// ------------------------------------------------------------------ GameMap
static void refreshSpaceObject(GameMap& map, SpaceObject* obj) {
  OctNode* node = obj->octNode;
  OctNode* box = map.octree.get();
  const bool intersectsBox =
      obj->sx + obj->sradius >= box->minx() && obj->sx - obj->sradius <= box->maxx() &&
      obj->sy + obj->sradius >= box->miny() && obj->sy - obj->sradius <= box->maxy() &&
      obj->sz + obj->sradius >= box->minz() && obj->sz - obj->sradius <= box->maxz();
  if (node == box && !intersectsBox) {
    if (obj->insideMap == true && obj->physics->objectType != ObKind::Uncollidable) {
      obj->insideMap = false;
      if (!dynamic_cast<Flag*>(obj)) {
        map.outsideObjects.push_back(OutsideTimer{obj, 0, 10000});
      }
    }
  } else {
    obj->insideMap = true;
  }
}

void GameMap::insertObject(Abstract3D* obj) {
  obj->update();
  octree->insert(obj);
  obj->active = true;
  live.push_back(obj);
  if (SpaceObject* so = dynamic_cast<SpaceObject*>(obj)) {
    if (dynamic_cast<Asteroid*>(so) || dynamic_cast<Addon*>(so)) autos.push_back(so);
  }
}

void GameMap::removeObject(Abstract3D* obj) {
  octree->remove(obj);
  obj->active = false;
  live.erase(std::remove(live.begin(), live.end(), obj), live.end());
  if (SpaceObject* so = dynamic_cast<SpaceObject*>(obj)) {
    autos.erase(std::remove(autos.begin(), autos.end(), so), autos.end());
  }
}

void GameMap::refreshObject(Abstract3D* obj) {
  obj->update();
  octree->refresh(obj);
  if (SpaceObject* so = dynamic_cast<SpaceObject*>(obj)) refreshSpaceObject(*this, so);
}

Vec3 GameMap::randomPosition() {
  const float border = 20;
  const float h = size / 2 - border;
  auto c = [&]() { return std::floor(rng() * (h * 2 + 1)) - h; };
  return v3(c(), c(), c());
}

bool GameMap::positionInside(const Vec3& p) const {
  const float h = size / 2;
  return !(p.x < -h || p.y < -h || p.z < -h || p.x > h || p.y > h || p.z > h);
}

void GameMap::setRotationPath() {
  Ark* prev = nullptr;
  for (Ark* ark : path) {
    if (prev) {
      const Vec3 d = vnormalize(vsub(ark->pos, prev->pos));
      ark->rot = ypr(getH(d), getV(d), 0);
      ark->update();
      prev->rot = ypr(getH(d), getV(d), 0);
      prev->update();
    }
    prev = ark;
  }
}

/** StringToVector3: null -> zero, comma -> THROW in the original (browsers
 *  only; here a malformed component reads as 0 like Number() did). */
static Vec3 parseVec3String(const std::string& s) {
  Vec3 out;
  float* comp[3] = {&out.x, &out.y, &out.z};
  size_t start = 0;
  for (int i = 0; i < 3 && start <= s.size(); i++) {
    const size_t bar = s.find('|', start);
    const std::string part = s.substr(start, bar == std::string::npos ? std::string::npos : bar - start);
    *comp[i] = part.empty() ? 0 : std::strtof(part.c_str(), nullptr);
    if (bar == std::string::npos) break;
    start = bar + 1;
  }
  return out;
}

Vec3 GameMap::parsePosition(const std::string& str, Team* team) {
  if (str.empty()) return Vec3{};
  if (str == "random") return randomPosition();
  if (str == "around") return team->base ? team->base->randomAround(rng) : Vec3{};
  return parseVec3String(str);
}

SpaceObject* GameMap::buildObject(const LevelObject& def, Game& gi) {
  Team* team = gi.team(def.team);
  if (!team) return nullptr;
  const Vec3 pos = parsePosition(def.position, team);
  const std::string& t = def.type;
  const int amount = def.hasAmount ? def.amount : 0;
  SpaceObject* obj = nullptr;
  if (t == "sun") {
    hasSun = true;
    sunPos = pos;
    sunRadius = def.hasAmount ? amount : 60;
    return nullptr;
  }
  if (t == "region") {
    hasRegion = true;
    regionPos = pos;
    regionRadius = def.hasAmount ? amount : 300;
    return nullptr;
  }
  if (t == "spaceShip") {
    const ModelData* mdl = gi.models->get(def.model);
    if (mdl) {
      obj = gi.own(new SpaceShip(&physicsPreset("SS1"), gi, team, pos, mdl, stringToLife(def.life),
                                 gi.models->get("Base")));
    }
  } else if (t == "spaceShipRespawn") {
    const ModelData* mdl = gi.models->get(def.model);
    if (mdl) {
      obj = gi.own(new SpaceShip(&physicsPreset("SS1R"), gi, team, pos, mdl, stringToLife(def.life),
                                 gi.models->get("Base")));
    }
  } else if (t == "ark") {
    const ModelData* mdl = gi.models->get(def.model);
    if (mdl) {
      Ark* ark = gi.own(new Ark(*this, team, pos, mdl));
      path.push_back(ark);
      obj = ark;
    }
  } else if (t == "base") {
    const ModelData* mdl = gi.models->get(def.model);
    if (mdl) obj = gi.own(new Base(*this, team, pos, mdl, 1));
  } else if (t == "flag") {
    const ModelData* mdl = gi.models->get(def.model);
    if (mdl && team->base) obj = gi.own(new Flag(gi, *team->base, mdl));
  } else if (t == "addonHoming" || t == "addonRepair" || t == "addonNitro" || t == "addonShield") {
    std::string model;
    Vec3 color;
    AddonKind kind = AddonKind::Homing;
    if (t == "addonHoming") {
      model = "adHomingMissile"; color = v3(1, 0, 0); kind = AddonKind::Homing;
    } else if (t == "addonRepair") {
      model = "adRepair"; color = v3(0.2f, 1, 0.2f); kind = AddonKind::Life;
    } else if (t == "addonNitro") {
      model = "adNitro"; color = v3(1, 0.55f, 0); kind = AddonKind::Nitro;
    } else {
      model = "adShield"; color = v3(0.4f, 0.6f, 1); kind = AddonKind::Shield;
    }
    const ModelData* mdl = gi.models->get(model);
    if (mdl) {
      obj = gi.own(new Addon(gi, team, parseVec3String(def.position), mdl, color, kind, *this));
    }
  } else if (t == "asteroid") {
    const ModelData* mdl = gi.models->get(def.model);
    const int qtt = def.hasAmount ? amount : 1;
    if (mdl) {
      for (int i = 0; i < qtt; i++) {
        gi.own(new Asteroid(*this, team, parsePosition(def.position, team), mdl, stringToLife(def.life)));
      }
    }
    obj = nullptr;
  } else if (t == "miniStar") {
    const int qtt = def.hasAmount ? amount : 1;
    for (int i = 0; i < qtt; i++) {
      gi.own(new Decor(parsePosition(def.position, team), 2));
    }
    obj = nullptr;
  }
  // 'cloud': client-only scenery; the web renderer regenerates the deleted
  // holoSmoke billboards from procedural Perlin sprites.
  if (obj && !def.name.empty()) gi.objects[def.name] = obj;
  return obj;
}

void GameMap::update(Game& gi, float dtMs) {
  // MANAGE RESPAWNS
  {
    std::vector<OutsideTimer> keep;
    for (OutsideTimer& timer : respawned) {
      timer.elapsed += dtMs;
      if (timer.elapsed >= timer.max) {
        SpaceObject* obj = timer.obj;
        obj->restoreLife();
        obj->destroyed = false;
        if (obj->team->base) obj->pos = obj->team->base->randomAround(gi.rng);
        obj->markPrev();
        obj->vel = Vec3{};
        bool foundLookAt = false;
        for (Team* t : obj->team->enemys) {
          if (t->base) {
            const Vec3 d = vnormalize(vsub(t->base->pos, obj->pos));
            obj->rot = ypr(getH(d), getV(d), 0);
            foundLookAt = true;
            break;
          }
        }
        if (!foundLookAt && obj->team->base) {
          Base* b = obj->team->base;
          const Vec3 d = vnormalize(vsub(b->pos, obj->pos));
          obj->rot = ypr(getH(d), getV(d), 0);
        }
        obj->update();
        insertObject(obj);
      } else {
        keep.push_back(timer);
      }
    }
    respawned = std::move(keep);
  }
  // SET_COLOR_OF_PATH
  if (!path.empty()) {
    path[0]->alpha = 1;
    path[0]->color = v3(0.2f, 1, 0.2f);
  }
  // MOVE_BULLETS (first hit only, no shield branch)
  {
    std::vector<BulletTimer> keep;
    for (BulletTimer& timer : allBullets) {
      Bullet* bullet = timer.obj;
      bool collide = false;
      timer.elapsed += dtMs;
      bullet->automaticAction(gi, dtMs);
      std::vector<OctItem*> collisions;
      std::vector<SpaceObject*> found;
      octree->sphereSelect(bullet->sx, bullet->sy, bullet->sz, bullet->sradius, collisions);
      for (OctItem* o : collisions) {
        SpaceObject* obj = dynamic_cast<SpaceObject*>(o);
        if (!obj) continue;
        if (obj->team == bullet->launcher->team || dynamic_cast<Ark*>(obj)) continue;
        float inter;
        if (obj->bulletHit(*bullet, &inter)) {
          found.push_back(obj);
          const Vec3 hp = vadd(bullet->pos, vscale(bullet->dir, -inter));
          spawnExplosion(gi, hp, 1.7f, ExplosionOpts{4, 0, nullptr, 1, 520});
          collide = true;
          break;
        }
      }
      for (SpaceObject* obj : found) {
        obj->receiveDamage(gi, bullet->totalLife(), bullet->dir, bullet->launcher);
      }
      if (timer.elapsed < timer.max && !collide) keep.push_back(timer);
      else removeObject(bullet);
    }
    allBullets = std::move(keep);
  }
  // MANAGE_OUTSIDERS (only while !insideMap)
  {
    std::vector<OutsideTimer> keep;
    for (OutsideTimer& timer : outsideObjects) {
      SpaceObject* obj = timer.obj;
      timer.elapsed += dtMs;
      if (!obj->insideMap) {
        if (timer.elapsed < timer.max) {
          keep.push_back(timer);
        } else {
          gi.nextDeathCause = "left the field of battle";
          obj->destroyObject(gi);
          refreshObject(obj);
        }
      }
    }
    outsideObjects = std::move(keep);
  }
  // AUTOMATIC_ACTION (asteroids + addons; the original's `visible` list)
  const std::vector<SpaceObject*> snapshot = autos;
  for (SpaceObject* obj : snapshot) {
    if (obj->destroyed) continue;
    if (obj->active && (dynamic_cast<Asteroid*>(obj) || dynamic_cast<Addon*>(obj))) {
      obj->automaticAction(gi, dtMs);
    }
  }
}

}  // namespace ie
