// The 37_T simulation, server side.
//
// This is the verbatim port of src/game/{physics,life,objects,map,team,ai}.ts
// with the rendering removed: same update order, same octree, same object
// hierarchy, same AI table, same goals. Everything that used to be a draw call
// or an audio call becomes an *event* the session forwards to the client; the
// client owns all visuals (models, smoke, explosions, HUD projection).
//
// Differences that are deliberate, and why:
//  * `Map.update` used to run asteroid/addon `automaticAction` over
//    `map.visible` (the last *drawn* list). The server has no camera, so it
//    walks every live asteroid/addon instead: the only effect is the cosmetic
//    tumble (and a Life3 hit direction in an edge case).
//  * `createSmoke` (engine trails) is frustum-gated in the original and runs on
//    the client; the server never spawns smoke.
//  * Fragments/debris and explosions are visual: `destroyObject` emits an
//    explosion event and the client rebuilds smoke + debris locally.
#pragma once

#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "json.h"
#include "math.h"

namespace ie {

class Game;
class Team;
class SpaceObject;
class SpaceShip;
class GameMap;

// ---------------------------------------------------------------- physics
enum class ObKind { Uncollidable = 0, Environment = 1, Interactive = 2 };

struct Physics {
  float accelMax;
  float velMax;
  float maxAngular;
  bool reSpawns;
  bool collector;
  ObKind objectType;
};

const Physics& physicsPreset(const std::string& name);  // SSTT/SS1/SS1R/FRAG/STATIC/ISTATIC/BULLET/MISSILE/EMPTY

struct BodyState {
  Vec3* pos;
  Vec3* vel;
  Vec3* accel;
  float multiplier;
  float friction;
  const Physics* physics;
};

void nextPosition(BodyState& b, float dtMs);
Vec3 previewDirection(const Vec3& fromPos, const Vec3& fromDir, const Vec3& targetPos, const Vec3& targetVel);

// ------------------------------------------------------------------- life
class Life {
 public:
  virtual ~Life() = default;
  virtual void restore() = 0;
  virtual void receiveDamage(float amount, const Vec3& direction, const Vec3& ownerUp, const Vec3& ownerDir,
                              const std::function<void()>& destroy) = 0;
  virtual float percentage() const = 0;
  virtual float total() const = 0;
};

class Life1 : public Life {
 public:
  explicit Life1(float center) : maxCenter_(center), center_(center) {}
  void restore() override { center_ = maxCenter_; }
  void receiveDamage(float amount, const Vec3&, const Vec3&, const Vec3&,
                     const std::function<void()>& destroy) override {
    center_ -= amount;
    if (center_ < 0) destroy();
  }
  float percentage() const override { return maxCenter_ == 0 ? 0 : center_ / maxCenter_; }
  float total() const override { return center_; }
  float maxCenter() const { return maxCenter_; }
  float center() const { return center_; }

 private:
  float maxCenter_;
  float center_;
};

/** Three-pool life (left/centre/right), the shipped CTF ship layout. */
class Life3 : public Life {
 public:
  Life3(float l, float c, float r) : maxLeft_(l), maxCenter_(c), maxRight_(r), left_(l), center_(c), right_(r) {}
  void restore() override {
    left_ = maxLeft_;
    center_ = maxCenter_;
    right_ = maxRight_;
  }
  void receiveDamage(float amount, const Vec3& direction, const Vec3& ownerUp, const Vec3& ownerDir,
                     const std::function<void()>& destroy) override {
    const Vec3 v = vcross(ownerUp, ownerDir);
    const float l = vlen(v) == 0 ? 1 : vlen(v);
    const float dot = vdot(v, direction) / l;
    if (dot > 0.2f && left_ > 0) {
      left_ -= amount;
      if (left_ < 0) center_ += left_;
    }
    if (dot < -0.2f && right_ > 0) {
      right_ -= amount;
      if (right_ < 0) center_ += right_;
    } else {
      center_ -= amount;
    }
    if (center_ <= 0) destroy();
  }
  float percentage() const override { return maxCenter_ == 0 ? 0 : center_ / maxCenter_; }
  float total() const override { return left_ + center_ + right_; }
  float left() const { return left_; }
  float center() const { return center_; }
  float right() const { return right_; }
  float maxLeft() const { return maxLeft_; }
  float maxCenter() const { return maxCenter_; }
  float maxRight() const { return maxRight_; }

 private:
  float maxLeft_, maxCenter_, maxRight_;
  float left_, center_, right_;
};

std::unique_ptr<Life> stringToLife(const std::string& s);  // null/"" -> Life1(10)

// ----------------------------------------------------------------- models
struct MeshSphere {
  Vec3 center;
  float radius = 1;
};

struct ModelData {
  std::string name;   // file base (e.g. "Fighter3")
  std::string alias;  // rc.model() alias (e.g. "adRepair" -> "AddonRepair")
  float radius = 1;                      // boundingSphere.radius of solid[0] ?? color[0]
  std::vector<MeshSphere> solidMeshes;   // mesh spheres of solid[0]
  std::vector<MeshSphere> colorMeshes;   // mesh spheres of color[0]
  bool hasSolid = false;
  bool hasColor = false;
};

/** Model table loaded from public/assets/models/SIM.json + the alias list. */
class ModelTable {
 public:
  bool load(const std::string& simManifestPath, std::string* err);
  const ModelData* get(const std::string& alias) const;
  /** Every alias, in table order (the wire model table indexes by position). */
  std::vector<std::string> aliases() const;
  /** Alias the level/AI code uses for a given file base, if any. */
  const std::string& aliasForFileBase(const std::string& base) const;

 private:
  std::map<std::string, ModelData> models_;           // keyed by alias
  std::map<std::string, std::string> aliasByBase_;    // file base -> alias
};

// ----------------------------------------------------------------- octree
class OctNode;

struct OctItem {
  OctNode* octNode = nullptr;
  ObKind kind = ObKind::Uncollidable;
  bool active = true;
  float sx = 0, sy = 0, sz = 0, sradius = 1;
  virtual ~OctItem() = default;
};

class OctNode {
 public:
  explicit OctNode(float size) : minx_(-size / 2), miny_(-size / 2), minz_(-size / 2),
                                 maxx_(size / 2), maxy_(size / 2), maxz_(size / 2) {}
  OctNode(OctNode* parent, int index);

  bool canFrag() const { return maxx_ - minx_ > 32; }
  bool containsSphere(float sx, float sy, float sz, float r) const {
    return sx - r >= minx_ && sx + r <= maxx_ && sy - r >= miny_ && sy + r <= maxy_ &&
           sz - r >= minz_ && sz + r <= maxz_;
  }
  static bool nodeContains(const OctNode& n, float sx, float sy, float sz, float r) {
    return sx - r >= n.minx_ && sx + r <= n.maxx_ && sy - r >= n.miny_ && sy + r <= n.maxy_ &&
           sz - r >= n.minz_ && sz + r <= n.maxz_;
  }

  void insert(OctItem* obj);
  void remove(OctItem* obj);
  void refresh(OctItem* obj);

  void sphereSelect(float sx, float sy, float sz, float r, std::vector<OctItem*>& out) const;
  void sphereSelectInteractive(float sx, float sy, float sz, float r, std::vector<OctItem*>& out) const;
  void raySelect(float ox, float oy, float oz, float dx, float dy, float dz, float d,
                 std::vector<OctItem*>& out) const;

  float minx() const { return minx_; } float miny() const { return miny_; } float minz() const { return minz_; }
  float maxx() const { return maxx_; } float maxy() const { return maxy_; } float maxz() const { return maxz_; }
  int count() const { return count_; }
  int interactiveCount() const { return interactiveCount_; }

 private:
  bool childContains(float sx, float sy, float sz, float r) const;
  static bool childBoxContains(const OctNode& p, int i, float sx, float sy, float sz, float r);
  static void removeFrom(OctNode* ptr, OctItem* obj);
  OctNode* fragment(int index);

  float minx_, miny_, minz_, maxx_, maxy_, maxz_;
  OctNode* parent_ = nullptr;
  int index_ = 0;
  std::unique_ptr<OctNode> childs_[8];
  std::vector<OctItem*> environment_;
  std::vector<OctItem*> uncollidable_;
  std::vector<OctItem*> interactive_;
  int count_ = 0;
  int interactiveCount_ = 0;
};

// ------------------------------------------------------------- geometry
bool raySphere(float ox, float oy, float oz, float dx, float dy, float dz,
               float cx, float cy, float cz, float r, float* t);
bool rayBox(float ox, float oy, float oy2, float oz, float dx, float dy, float dz,
            float minx, float miny, float minz, float maxx, float maxy, float maxz, float* t);
bool spheresIntersect(float ax, float ay, float az, float ar, float bx, float by, float bz, float br);
bool sphereBoxIntersect(float sx, float sy, float sz, float r,
                        float minx, float miny, float minz, float maxx, float maxy, float maxz);

// ---------------------------------------------------------------- objects
class Command {
 public:
  virtual ~Command() = default;
  virtual void execute(Game& gi) = 0;
  /** Homing missiles expose their locked target for the HUD warning. */
  virtual SpaceObject* lockedTarget() const { return nullptr; }
};

class Abstract3D : public OctItem {
 public:
  explicit Abstract3D(const Physics* p) : physics(p) {}
  virtual void setBoundingSphere() = 0;
  virtual void update() = 0;
  float alpha = 1;
  float multiplier = 1;
  float scale = 1;
  Vec3 color{0.2f, 0.2f, 0.2f};
  bool insideMap = true;
  int id = 0;                 // network id (assigned by the session)
  bool destroyed = false;     // destroyObject ran; never re-enters the lists
  const Physics* physics;
};

class Object3D : public Abstract3D {
 public:
  Object3D(const Physics* p, const Vec3& position, const ModelData* model, float scale);
  std::unique_ptr<Command> intelligence;
  const ModelData* model = nullptr;
  Vec3 pos, lastPos, vel, accel;
  Vec3 dir{0, 0, 1}, up{0, 1, 0}, side{1, 0, 0};
  Quat rot;  // identity
  Vec3 prevPos;
  Quat prevRot;
  bool hasPrev = false;

  void markPrev() {
    prevPos = pos;
    prevRot = rot;
    hasPrev = true;
  }
  virtual void automaticAction(Game& gi, float dtMs);
  /** Integrates one fixed step; returns true when the object moved (the
   *  original called its refresh callback only then). */
  bool step(float dtMs);
  void setBoundingSphere() override;
  void update() override;
};

class SpaceObject : public Object3D {
 public:
  SpaceObject(const Physics* p, Team* team, const Vec3& position, const ModelData* model,
              std::unique_ptr<Life> life, float scale);
  std::unique_ptr<Life> life;
  Team* team = nullptr;
  class Flag* flag = nullptr;
  bool teleported = false;
  float hitAge = 99;

  virtual void receiveDamage(Game& gi, float amount, const Vec3& direction, SpaceObject* attacker);
  void restoreLife() { if (life) life->restore(); }
  float lifePercentage() const { return life ? life->percentage() : 1; }
  float totalLife() const { return life ? life->total() : 0; }
  virtual bool canLaunchBullet() const { return false; }
  virtual void launchBullet(Game&, const Vec3&) {}
  virtual void launchHoming(Game&) {}
  virtual void launchNitro(float) {}
  void move(Game& gi, float dtMs);
  virtual void destroyObject(Game& gi, SpaceObject* attacker = nullptr);
  void automaticAction(Game& gi, float dtMs) override;
  /** Model3D.Intersects ray test (mesh spheres of solid[0] and color[0]).
   *  Returns true and writes the hit distance when the ray from `b.lastPos`
   *  along `b.dir` hits a mesh sphere within |b.pos - b.lastPos|. */
  bool bulletHit(const class Bullet& b, float* t) const;
  bool isShip() const;
};

class SpaceShip : public SpaceObject {
 public:
  SpaceShip(const Physics* p, Game& gi, Team* team, const Vec3& position, const ModelData* model,
            std::unique_ptr<Life> life, const ModelData* shieldModel);
  const ModelData* shieldModel = nullptr;
  float glow = 0;
  Vec3 glowColor{1, 1, 1};
  float launchSpan = 0;
  int launchs = 0;
  int homings = 0;
  float nitro = 0;
  int shield = 0;
  bool isPlayer = false;

  bool canLaunchBullet() const override { return launchSpan >= 200; }
  void launchBullet(Game& gi, const Vec3& direction) override;
  void launchNitro(float dtMs) override;
  void launchHoming(Game& gi) override;
  void receiveDamage(Game& gi, float amount, const Vec3& direction, SpaceObject* attacker) override;
  void automaticAction(Game& gi, float dtMs) override;
  void arenaGuard(Game& gi);
};

class Asteroid : public SpaceObject {
 public:
  Asteroid(GameMap& map, Team* team, const Vec3& position, const ModelData* model, std::unique_ptr<Life> life);
  Vec3 tumble;

  void automaticAction(Game& gi, float dtMs) override;
  void destroyObject(Game& gi, SpaceObject* attacker = nullptr) override;
};

enum class AddonKind { Homing, Life, Nitro, Shield };

class Addon : public SpaceObject {
 public:
  Addon(Game& gi, Team* team, const Vec3& position, const ModelData* model,
        const Vec3& color, AddonKind kind, GameMap& map);
  Vec3 tumble;
  AddonKind addonKind;
  Vec3 glowColor;

  void automaticAction(Game& gi, float dtMs) override;
  void doThings(SpaceObject& obj);
  void destroyObject(Game& gi, SpaceObject* attacker = nullptr) override;
};

class Base : public SpaceObject {
 public:
  Base(GameMap& map, Team* team, const Vec3& position, const ModelData* model, float scale);
  Vec3 randomAround(std::function<float()> rng);
  void automaticAction(Game&, float) override {}
};

class Flag : public SpaceObject {
 public:
  Flag(Game& gi, Base& base, const ModelData* model);
  Vec3 tumble;
  float sideRot = 0;
  SpaceObject* getOwner() const { return owner_; }
  void setOwner(SpaceObject* o);
  void automaticAction(Game& gi, float dtMs) override;

 private:
  float timeLost_ = 0;
  float timeToLive_ = 20000;
  SpaceObject* owner_ = nullptr;
};

class Bullet : public SpaceObject {
 public:
  Bullet(Game& gi, const ModelData* model, SpaceObject* launcher,
         const Vec3& position, const Vec3& direction, float ttl = 3000);
  SpaceObject* launcher = nullptr;
  void automaticAction(Game& gi, float dtMs) override;
  void setBoundingSphere() override;
};

class HomingMissile : public Bullet {
 public:
  HomingMissile(Game& gi, const ModelData* model, SpaceObject* launcher, const Vec3& position, float ttl);
  void automaticAction(Game& gi, float dtMs) override;
};

class Ark : public SpaceObject {
 public:
  Ark(GameMap& map, Team* team, const Vec3& position, const ModelData* model);
  void automaticAction(Game&, float) override {}
};

/** Non-simulated scenery the level places (miniStar billboards): only its pose
 *  matters; the client draws it with its own billboard renderer. */
class Decor : public Abstract3D {
 public:
  Decor(const Vec3& position, float scale) : Abstract3D(&physicsPreset("EMPTY")) {
    pos = position;
    this->scale = scale;
    update();
  }
  Vec3 pos;
  void setBoundingSphere() override {
    sx = pos.x; sy = pos.y; sz = pos.z;
    sradius = scale;
  }
  void update() override { setBoundingSphere(); }
};

// ------------------------------------------------------------------ teams
class Team {
 public:
  Team(std::string name, Vec3 color) : name(std::move(name)), color(color) { allies.push_back(this); }
  float points = 0;
  float timeMs = 0;
  float kills = 0;
  float hillMs = 0;
  std::string name;
  Vec3 color;
  Base* base = nullptr;
  Flag* flag = nullptr;
  std::vector<SpaceObject*> objects;
  std::vector<std::string> sounds;
  std::vector<Team*> allies;
  std::vector<Team*> enemys;
  void manage(Game& gi, SpaceObject* controlled);
};

class Condition {
 public:
  virtual ~Condition() = default;
  virtual bool check(Game& gi) = 0;
};

class Reward {
 public:
  Reward(std::string reward, std::string message) : reward(std::move(reward)), message(std::move(message)) {}
  std::string reward;
  std::string message;
  std::vector<std::unique_ptr<Condition>> conditions;
  bool check(Game& gi);
};

enum class GameType { CTF, TT, BACK, KOTS, SURV };

// ------------------------------------------------------------------- map
struct BulletTimer {
  Bullet* obj;
  float elapsed;
  float max;
};
struct OutsideTimer {
  SpaceObject* obj;
  float elapsed;
  float max;
};

class GameMap {
 public:
  GameMap(std::string skyName, float size)
      : octree(new OctNode(size)), size(size), skyName(std::move(skyName)) {}

  std::function<float()> rng = [] { return 0.5f; };
  std::unique_ptr<OctNode> octree;
  float size;
  std::string skyName;
  std::vector<BulletTimer> allBullets;
  std::vector<OutsideTimer> respawned;
  std::vector<OutsideTimer> outsideObjects;
  std::vector<Ark*> path;
  /** Every object currently in the octree (server replacement for the drawn
   *  `visible` list; the session enumerates it for snapshots). */
  std::vector<Abstract3D*> live;
  /** Live asteroids + addons, in insertion order: the AUTOMATIC_ACTION loop
   *  (`visible` in the original, every live one on the server). */
  std::vector<SpaceObject*> autos;
  bool hasSun = false;
  Vec3 sunPos;
  float sunRadius = 0;
  bool hasRegion = false;
  Vec3 regionPos;
  float regionRadius = 0;

  void insertObject(Abstract3D* obj);
  void removeObject(Abstract3D* obj);
  void refreshObject(Abstract3D* obj);
  Vec3 randomPosition();
  bool positionInside(const Vec3& p) const;
  void setRotationPath();
  Vec3 parsePosition(const std::string& str, Team* team);
  SpaceObject* buildObject(const class LevelObject& def, Game& gi);
  void update(Game& gi, float dtMs);
  /** Live objects of a kind (server stand-in for the drawn list). */
  template <typename T, typename F>
  void forEachLive(F fn) {
    for (Abstract3D* o : live) {
      if (auto* t = dynamic_cast<T*>(o)) fn(t);
    }
  }
};

// ------------------------------------------------------------------ events
struct SfxEvent {
  std::string name;
  float volume = 1;
  float pan = 0;
};
struct ExplosionEvent {
  Vec3 pos;
  float scale = 1;
  float life = 650;
  int smoke = 0;
  int debris = 0;
  const ModelData* debrisModel = nullptr;
  float debrisScale = 1;
};

/** Fireball + smoke burst (+ optional debris) at a world position: pushes an
 *  ExplosionEvent the session forwards; the client owns the visuals. */
struct ExplosionOpts {
  int smoke = -1;                  // -1 = max(2, round(2 + scale * 2))
  int debris = 0;
  const ModelData* debrisModel = nullptr;
  float debrisScale = 1;
  float life = 650;
};
void spawnExplosion(Game& gi, const Vec3& pos, float scale, const ExplosionOpts& opts = {});

/**
 * Dedicated multiplayer hooks: when installed, player-scoped sounds and voices
 * are routed per ship instead of the single-player queues (the room maps a
 * ship to its guest's stream). With no hooks the single-player behaviour is
 * exactly the original one.
 */
struct PlayerHooks {
  std::function<void(SpaceObject*, const std::string&, float volume, float pan)> shipSfx;
  std::function<void(SpaceObject*, const std::string&)> shipNotification;
  std::function<void(SpaceObject*)> explosionSfx;
};

/** Player input (mirror of the client Control fields the simulation reads). */
struct PlayerInput {
  float stickX = 0;
  float stickY = 0;
  float throttle = 0;
  bool fire = false;
  bool homing = false;
  bool nitro = false;
  bool axisX = false;
  bool axisY = false;
};

// -------------------------------------------------------------- level data
struct LevelObject {
  std::string team;
  std::string type;
  std::string model;
  std::string position;
  std::string name;
  std::string life;
  int amount = 0;
  bool hasAmount = false;
};

struct LevelGoal {
  std::string name;
  std::string value;
};

struct LevelGoalSet {
  std::string reward;
  std::string message;
  std::vector<LevelGoal> goals;
};

struct LevelAction {
  std::string name;
  std::string from;
  std::string to;
};

struct Level {
  std::string key;
  std::string file;
  std::string type;      // CTF / TT / BACK / KOTS / SURV
  std::string name;
  std::string save;
  std::string sky;
  float size = 2048;
  std::string text;
  std::vector<LevelObject> objects;
  std::string camaraName;
  std::string camaraValue;
  std::vector<LevelAction> actions;
  std::vector<LevelGoalSet> goals;
  std::string importGhost;
};

/** Level catalogue over public/assets/levels/INDEX.json + LEVEL_FILES. */
class LevelTable {
 public:
  bool load(const std::string& levelsDir, std::string* err);
  const Level* get(const std::string& key) const;
  std::vector<std::string> keys() const;

 private:
  std::map<std::string, Level> levels_;
};

// ------------------------------------------------------------------- game
class Game {
 public:
  Game(ModelTable* models, uint32_t seed = 123456789u);
  ~Game();

  ModelTable* models = nullptr;
  GameMap map;
  std::map<std::string, std::unique_ptr<Team>> teams;
  std::map<std::string, SpaceObject*> objects;
  SpaceShip* selected = nullptr;
  std::vector<std::unique_ptr<Reward>> goals;
  float matchTimeMs = 0;
  GameType gameType = GameType::BACK;
  std::string savefile;
  std::string levelKey;
  std::string levelTitle;
  std::string levelText;
  float dtMs = 16;
  float notificationTime = 0;
  std::string notificationText;
  std::string notificationField;
  bool finished = false;
  float startCountdownMs = 5000;
  std::string deathCause;
  std::string nextDeathCause;
  /** How each ship died (the dedicated room reports it per guest ship). */
  std::map<SpaceObject*, std::string> deathCauses;
  bool resultSet = false;
  bool resultWon = false;
  std::string resultReward;
  std::string resultMessage;
  PlayerInput input;
  std::function<float()> rng;
  std::vector<SfxEvent> sfx;
  std::vector<ExplosionEvent> explosions;
  std::vector<std::string> voices;
  /** Owns every object in the world; destroyed objects stay allocated until
   *  the match ends (goals/AI may still hold pointers into them). */
  std::vector<std::unique_ptr<Abstract3D>> owned;
  /** Player view settings the simulation reads (mirror of rc.options). */
  float playerDistance = 192;
  bool axisX = false;
  bool axisY = false;
  /** `?ai=smart` (Join flag): upgrade AI ships before the match starts. */
  bool smartAI = false;
  /** Dedicated room hooks (null in the single-player WebSocket session). */
  PlayerHooks* hooks = nullptr;

  bool create(const Level& def);
  void update(float dtMs);
  void updateRegion(float dtMs);
  void setNotification(const std::string& voiceField);
  /** Sfx heard by whoever flies `ship` (local player or a remote guest). */
  void shipSfx(SpaceObject* ship, const std::string& name, float volume = 1, float pan = 0);
  /** A voice line that belongs to whoever flies `ship` (HILocal warnings). */
  void shipNotification(SpaceObject* ship, const std::string& field);
  /** Distance sfx of a destroyed object, per viewpoint (hooks) or the
   *  single selected player. */
  void explosionSfx(SpaceObject* obj);
  void recordDeath(SpaceObject* victim, SpaceObject* attacker);
  Team* team(const std::string& name);
  SpaceObject* object(const std::string& name) const;
  /** Register a freshly built object; the game takes ownership. */
  template <typename T>
  T* own(T* obj) {
    owned.emplace_back(obj);
    return obj;
  }
};

/** AI factories live in ai.h/ai.cpp. */
void applyAction(Game& gi, const std::string& name, const std::string& from, const std::string& to);
void upgradeAIShips(Game& gi, bool smart);

}  // namespace ie
