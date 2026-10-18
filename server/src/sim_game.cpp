// Model/level tables + the Game class (src/game/instance.ts, team.ts,
// levels.ts, config.ts): build order, update order, goals, teams.
#include <algorithm>
#include <cstdio>
#include <cstdlib>

#include "ai.h"
#include "sim.h"

namespace ie {

// -------------------------------------------------------------------- life
static int parseInt(const std::string& s) {
  return static_cast<int>(std::strtol(s.c_str(), nullptr, 10));
}

std::unique_ptr<Life> stringToLife(const std::string& s) {
  if (s.empty()) return std::make_unique<Life1>(10);
  std::vector<std::string> words;
  size_t start = 0;
  for (;;) {
    const size_t bar = s.find('|', start);
    words.push_back(s.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
    if (bar == std::string::npos) break;
    start = bar + 1;
  }
  if (words.size() == 3) return std::make_unique<Life3>(parseInt(words[0]), parseInt(words[1]), parseInt(words[2]));
  return std::make_unique<Life1>(parseInt(words[0]));
}

// ----------------------------------------------------------------- models
bool ModelTable::load(const std::string& path, std::string* err) {
  std::string text;
  {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
      if (err) *err = "cannot open " + path;
      return false;
    }
    char buf[8192];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, n);
    std::fclose(f);
  }
  Json root;
  try {
    root = Json::parse(text);
  } catch (const std::exception& e) {
    if (err) *err = std::string("SIM.json: ") + e.what();
    return false;
  }
  const Json& models = root["models"];
  for (const auto& kv : root["aliases"].fields()) {
    const std::string& alias = kv.first;
    const std::string base = kv.second.asString();
    const Json& m = models[base];
    ModelData md;
    md.name = base;
    md.alias = alias;
    auto readMeshes = [](const Json& lod, std::vector<MeshSphere>* out) -> bool {
      if (!lod.isObject()) return false;
      for (const Json& mesh : lod["meshes"].items()) {
        MeshSphere ms;
        const Json& c = mesh["c"];
        ms.center = v3(static_cast<float>(c.items().size() > 0 ? c.items()[0].asNumber() : 0),
                       static_cast<float>(c.items().size() > 1 ? c.items()[1].asNumber() : 0),
                       static_cast<float>(c.items().size() > 2 ? c.items()[2].asNumber() : 0));
        ms.radius = static_cast<float>(mesh["r"].asNumber(1));
        out->push_back(ms);
      }
      return true;
    };
    md.hasSolid = readMeshes(m["solid"], &md.solidMeshes);
    md.hasColor = readMeshes(m["color"], &md.colorMeshes);
    md.radius = 1;
    if (md.hasSolid) md.radius = static_cast<float>(m["solid"]["radius"].asNumber(1));
    else if (md.hasColor) md.radius = static_cast<float>(m["color"]["radius"].asNumber(1));
    models_[alias] = md;
    aliasByBase_.emplace(base, alias);
  }
  return true;
}

const ModelData* ModelTable::get(const std::string& alias) const {
  auto it = models_.find(alias);
  return it == models_.end() ? nullptr : &it->second;
}

std::vector<std::string> ModelTable::aliases() const {
  std::vector<std::string> out;
  out.reserve(models_.size());
  for (const auto& kv : models_) out.push_back(kv.first);
  return out;
}

const std::string& ModelTable::aliasForFileBase(const std::string& base) const {
  static const std::string kEmpty;
  auto it = aliasByBase_.find(base);
  return it == aliasByBase_.end() ? kEmpty : it->second;
}

// ------------------------------------------------------------------ teams
static const struct {
  const char* name;
  Vec3 color;
} kTeams[] = {
    {"human", v3(64 / 255.0f, 224 / 255.0f, 208 / 255.0f)},
    {"ambient", v3(50 / 255.0f, 205 / 255.0f, 50 / 255.0f)},
    {"alien", v3(1, 0, 0)},
    {"falcon", v3(1, 0.78f, 0.24f)},
    {"viper", v3(0.72f, 0.45f, 1)},
    {"raptor", v3(0.35f, 0.62f, 1)},
    {"comet", v3(1, 0.45f, 0.25f)},
    {"nova", v3(0.45f, 1, 0.75f)},
};

void Team::manage(Game& gi, SpaceObject* controlled) {
  if (controlled && this == controlled->team) {
    while (!sounds.empty()) {
      gi.setNotification(sounds.front());
      sounds.erase(sounds.begin());
    }
  }
  sounds.clear();
}

// -------------------------------------------------------------- conditions
namespace {

class CondDestroyed : public Condition {
 public:
  explicit CondDestroyed(SpaceObject* obj) : obj(obj) {}
  bool check(Game&) override { return obj && !obj->active; }

 private:
  SpaceObject* obj;
};

class CondMoreTime : public Condition {
 public:
  explicit CondMoreTime(float timeMs) : timeMs(timeMs) {}
  bool check(Game& gi) override { return gi.selected && gi.selected->team->timeMs >= timeMs; }

 private:
  float timeMs;
};

class CondLessTime : public Condition {
 public:
  explicit CondLessTime(float timeMs) : timeMs(timeMs) {}
  bool check(Game& gi) override { return gi.selected && gi.selected->team->timeMs <= timeMs; }

 private:
  float timeMs;
};

class CondMorePoints : public Condition {
 public:
  explicit CondMorePoints(Team* team) : team(team) {}
  bool check(Game& gi) override {
    float minP = 99999;
    for (auto& kv : gi.teams) minP = std::min(minP, kv.second->points);
    return team->points > minP;
  }

 private:
  Team* team;
};

class CondTopScore : public Condition {
 public:
  explicit CondTopScore(std::function<float(Team*)> metric) : metric(std::move(metric)) {}
  bool check(Game& gi) override {
    SpaceObject* sel = gi.selected;
    if (!sel) return false;
    const float mine = metric(sel->team);
    for (auto& kv : gi.teams) {
      Team* t = kv.second.get();
      if (t == sel->team || t->name == "ambient" || t->objects.empty()) continue;
      if (metric(t) > mine) return false;
    }
    return true;
  }

 private:
  std::function<float(Team*)> metric;
};

class CondNoPath : public Condition {
 public:
  bool check(Game& gi) override { return gi.map.path.empty(); }
};

float parseTimeSpan(const std::string& s) {
  std::vector<float> parts;
  size_t start = 0;
  for (;;) {
    const size_t colon = s.find(':', start);
    parts.push_back(std::strtof(s.substr(start, colon == std::string::npos ? std::string::npos : colon - start).c_str(), nullptr));
    if (colon == std::string::npos) break;
    start = colon + 1;
  }
  if (parts.size() == 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.size() == 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

}  // namespace

bool Reward::check(Game& gi) {
  if (conditions.empty()) return false;
  for (auto& c : conditions) {
    if (!c->check(gi)) return false;
  }
  return true;
}

// ------------------------------------------------------------- level table
static const std::pair<const char*, const char*> kLevelFiles[] = {
    {"background", "Background.json"},
    {"tt-easy-01", "SinglePlayer_TT_Easy_01_Level.json"},
    {"tt-easy-02", "SinglePlayer_TT_Easy_02_Level.json"},
    {"tt-easy-03", "SinglePlayer_TT_Easy_03_Level.json"},
    {"tt-easy-04", "SinglePlayer_TT_Easy_04_Level.json"},
    {"tt-easy-05", "SinglePlayer_TT_Easy_05_Level.json"},
    {"tt-normal-01", "SinglePlayer_TT_Normal_01_Level.json"},
    {"tt-normal-02", "SinglePlayer_TT_Normal_02_Level.json"},
    {"tt-normal-03", "SinglePlayer_TT_Normal_03_Level.json"},
    {"tt-normal-04", "SinglePlayer_TT_Normal_04_Level.json"},
    {"tt-hard-01", "SinglePlayer_TT_Hard_01_Level.json"},
    {"ctf-easy", "SinglePlayer_CTF_Easy_Level.json"},
    {"ctf-normal", "SinglePlayer_CTF_Normal_Level.json"},
    {"ctf-hard", "SinglePlayer_CTF_Hard_Level.json"},
    {"kots-teams-easy", "kots-teams-easy.json"},
    {"kots-teams-normal", "kots-teams-normal.json"},
    {"kots-teams-hard", "kots-teams-hard.json"},
    {"kots-solo-easy", "kots-solo-easy.json"},
    {"kots-solo-normal", "kots-solo-normal.json"},
    {"kots-solo-hard", "kots-solo-hard.json"},
    {"surv-teams-easy", "surv-teams-easy.json"},
    {"surv-teams-normal", "surv-teams-normal.json"},
    {"surv-teams-hard", "surv-teams-hard.json"},
    {"surv-solo-easy", "surv-solo-easy.json"},
    {"surv-solo-normal", "surv-solo-normal.json"},
    {"surv-solo-hard", "surv-solo-hard.json"},
};

bool LevelTable::load(const std::string& dir, std::string* err) {
  for (const auto& kv : kLevelFiles) {
    const std::string path = dir + "/" + kv.second;
    std::string text;
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) {
      if (err) *err = "cannot open " + path;
      return false;
    }
    char buf[8192];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), f)) > 0) text.append(buf, n);
    std::fclose(f);
    Json j;
    try {
      j = Json::parse(text);
    } catch (const std::exception& e) {
      if (err) *err = path + ": " + e.what();
      return false;
    }
    Level lv;
    lv.key = kv.first;
    lv.file = kv.second;
    const Json& desc = j["description"];
    lv.type = desc["type"].asString("BACK");
    lv.name = desc["name"].asString();
    lv.save = desc["save"].asString();
    lv.sky = desc["sky"].asString("Sky1");
    lv.size = static_cast<float>(desc["size"].asNumber(2048));
    if (lv.size == 0) lv.size = 2048;
    lv.text = desc["text"].asString();
    for (const Json& o : j["objects"].items()) {
      LevelObject lo;
      lo.team = o["team"].asString();
      lo.type = o["type"].asString();
      lo.model = o["model"].asString();
      lo.position = o["position"].asString();
      lo.name = o["name"].asString();
      lo.life = o["life"].asString();
      if (o["amount"].isNumber()) {
        lo.amount = o["amount"].asInt();
        lo.hasAmount = true;
      }
      lv.objects.push_back(lo);
    }
    lv.camaraName = j["camara"]["name"].asString();
    lv.camaraValue = j["camara"]["value"].asString();
    for (const Json& a : j["actions"].items()) {
      LevelAction la;
      la.name = a["name"].asString();
      la.from = a["from"].asString();
      la.to = a["to"].asString();
      lv.actions.push_back(la);
    }
    for (const Json& g : j["goals"].items()) {
      LevelGoalSet gs;
      gs.reward = g["reward"].asString("None");
      gs.message = g["message"].asString();
      for (const Json& goal : g["goals"].items()) {
        LevelGoal lg;
        lg.name = goal["name"].asString();
        lg.value = goal["value"].asString();
        gs.goals.push_back(lg);
      }
      lv.goals.push_back(gs);
    }
    lv.importGhost = j["importGhost"].asString();
    levels_[lv.key] = std::move(lv);
  }
  return true;
}

const Level* LevelTable::get(const std::string& key) const {
  auto it = levels_.find(key);
  return it == levels_.end() ? nullptr : &it->second;
}

std::vector<std::string> LevelTable::keys() const {
  std::vector<std::string> out;
  for (const auto& kv : levels_) out.push_back(kv.first);
  return out;
}

// -------------------------------------------------------------------- game
static GameType parseGameType(const std::string& t) {
  if (t == "CTF") return GameType::CTF;
  if (t == "TT") return GameType::TT;
  if (t == "KOTS") return GameType::KOTS;
  if (t == "SURV") return GameType::SURV;
  return GameType::BACK;
}

static std::string killerText(SpaceObject* a) {
  if (!a) return "cause unknown";
  const std::string who = a->team ? a->team->name : "";
  const std::string suffix = who.empty() ? "" : " (" + who + ")";
  if (dynamic_cast<HomingMissile*>(a)) return "homing missile" + suffix;
  if (dynamic_cast<Bullet*>(a)) return "cannon fire" + suffix;
  if (a->isShip()) return "rammed by " + (who.empty() ? "another ship" : who);
  if (dynamic_cast<Asteroid*>(a)) return "asteroid collision";
  return who.empty() ? "cause unknown" : "destroyed by " + who;
}

Game::Game(ModelTable* models, uint32_t seed) : models(models), map("Sky1", 2048) {
  auto state = std::make_shared<uint32_t>(seed);
  rng = [state]() {
    *state = *state * 1664525u + 1013904223u;
    return static_cast<float>(static_cast<double>(*state) / 4294967296.0);
  };
  map.rng = rng;
}

Game::~Game() = default;

Team* Game::team(const std::string& name) {
  auto it = teams.find(name);
  return it == teams.end() ? nullptr : it->second.get();
}

SpaceObject* Game::object(const std::string& name) const {
  auto it = objects.find(name);
  return it == objects.end() ? nullptr : it->second;
}

void Game::setNotification(const std::string& voiceField) { voices.push_back(voiceField); }

void Game::shipSfx(SpaceObject* ship, const std::string& name, float volume, float pan) {
  if (hooks) {
    if (hooks->shipSfx) hooks->shipSfx(ship, name, volume, pan);
    return;
  }
  if (ship == selected) sfx.push_back(SfxEvent{name, volume, pan});
}

void Game::shipNotification(SpaceObject* ship, const std::string& field) {
  if (hooks) {
    if (hooks->shipNotification) hooks->shipNotification(ship, field);
    return;
  }
  if (ship == selected || !selected) setNotification(field);
}

void Game::explosionSfx(SpaceObject* obj) {
  if (hooks) {
    if (hooks->explosionSfx) hooks->explosionSfx(obj);
    return;
  }
  SpaceShip* sel = selected;
  if (sel && static_cast<SpaceObject*>(obj) != static_cast<SpaceObject*>(sel)) {
    const Vec3 v = vsub(obj->pos, sel->pos);
    const float dist = vlen(v) == 0 ? 1 : vlen(v);
    const float pan = clampf(-8 * vdot(sel->side, vscale(v, 1.0f / dist)), -1, 1);
    const float volume = clampf(1 - dist / playerDistance, 0, 1);
    if (volume > 0) {
      if (dynamic_cast<Ark*>(obj)) sfx.push_back(SfxEvent{"addonSound", 1, 0});
      else if (dist < playerDistance / 2) sfx.push_back(SfxEvent{"closeExplosion", volume, pan});
      else if (dist < playerDistance) sfx.push_back(SfxEvent{"farExplosion", volume, pan});
    }
  } else if (dynamic_cast<Ark*>(obj)) {
    sfx.push_back(SfxEvent{"addonSound", 1, 0});
  }
}

void Game::recordDeath(SpaceObject* victim, SpaceObject* attacker) {
  const std::string cause = nextDeathCause.empty() ? killerText(attacker) : nextDeathCause;
  nextDeathCause.clear();
  deathCauses[victim] = cause;
  if (victim != selected) return;
  deathCause = cause;
}

bool Game::create(const Level& def) {
  levelKey = def.key;
  gameType = parseGameType(def.type);
  levelTitle = def.name;
  levelText = def.text;
  savefile = def.save;
  map = GameMap(def.sky.empty() ? "Sky1" : def.sky, def.size > 0 ? def.size : 2048);
  map.rng = rng;
  for (const auto& cfg : kTeams) {
    teams.emplace(cfg.name, std::make_unique<Team>(cfg.name, cfg.color));
  }
  // Every team that fields objects fights every other one.
  std::vector<std::string> combatants;
  for (const LevelObject& o : def.objects) {
    if (o.team == "ambient") continue;
    if (std::find(combatants.begin(), combatants.end(), o.team) == combatants.end()) {
      combatants.push_back(o.team);
    }
  }
  for (const std::string& a : combatants) {
    Team* ta = team(a);
    if (!ta) continue;
    for (const std::string& b : combatants) {
      if (a == b) continue;
      Team* tb = team(b);
      if (tb) ta->enemys.push_back(tb);
    }
  }
  for (const LevelObject& o : def.objects) map.buildObject(o, *this);
  map.setRotationPath();
  if (def.camaraName == "LookAtObject") {
    selected = dynamic_cast<SpaceShip*>(object(def.camaraValue));
  }
  for (const LevelAction& a : def.actions) applyAction(*this, a.name, a.from, a.to);
  upgradeAIShips(*this, smartAI);
  for (const LevelGoalSet& g : def.goals) {
    const std::string& r = g.reward;
    const bool known = r == "Gold" || r == "Silver" || r == "Bronze" || r == "Victory" || r == "Defeat";
    auto reward = std::make_unique<Reward>(known ? r : "None", g.message);
    for (const LevelGoal& goal : g.goals) {
      if (goal.name == "NoPath") {
        reward->conditions.push_back(std::make_unique<CondNoPath>());
      } else if (goal.name == "LessTime") {
        reward->conditions.push_back(std::make_unique<CondLessTime>(parseTimeSpan(goal.value)));
      } else if (goal.name == "MoreTime") {
        const float limit = parseTimeSpan(goal.value);
        matchTimeMs = std::max(matchTimeMs, limit);
        reward->conditions.push_back(std::make_unique<CondMoreTime>(limit));
      } else if (goal.name == "MoreHillTime") {
        reward->conditions.push_back(
            std::make_unique<CondTopScore>([](Team* t) { return t->hillMs; }));
      } else if (goal.name == "MoreKills") {
        reward->conditions.push_back(
            std::make_unique<CondTopScore>([](Team* t) { return t->kills; }));
      } else if (goal.name == "Destroyed") {
        reward->conditions.push_back(
            std::make_unique<CondDestroyed>(dynamic_cast<SpaceObject*>(object(goal.value))));
      } else if (goal.name == "MorePoints") {
        Team* t = team(goal.value);
        if (t) reward->conditions.push_back(std::make_unique<CondMorePoints>(t));
      }
    }
    goals.push_back(std::move(reward));
  }
  return true;
}

void Game::update(float dtMs) {
  // Pre-match hold: the world stands still for a few seconds.
  if (gameType != GameType::BACK && startCountdownMs > 0) {
    startCountdownMs -= dtMs;
    if (startCountdownMs < 0) startCountdownMs = 0;
    return;
  }
  this->dtMs = dtMs;
  if (gameType == GameType::BACK) {
    map.update(*this, dtMs);
    return;
  }
  if (finished) return;
  // updateObjectUI: notifications, nitro button (the input arrived over the WS)
  for (auto& kv : teams) kv.second->manage(*this, selected);
  if (input.nitro && selected) selected->launchNitro(dtMs);
  for (auto& kv : teams) {
    Team* t = kv.second.get();
    if (t->base) {
      std::vector<OctItem*> found;
      map.octree->sphereSelect(t->base->sx, t->base->sy, t->base->sz, t->base->sradius, found);
      if (found.size() == 1 || gameType != GameType::TT) t->timeMs += dtMs;
    }
    const std::vector<SpaceObject*> list = t->objects;
    for (SpaceObject* ob : list) {
      if (!dynamic_cast<Flag*>(ob)) ob->automaticAction(*this, dtMs);
    }
  }
  map.update(*this, dtMs);
  updateRegion(dtMs);
  notificationTime -= dtMs;
  if (notificationTime < 0) {
    notificationTime = 0;
    notificationText.clear();
  }
  for (auto& kv : teams) {
    if (kv.second->flag) kv.second->flag->automaticAction(*this, dtMs);
  }
  for (auto& r : goals) {
    if (r->check(*this)) {
      if (r->reward != "Defeat") {
        resultSet = true;
        resultWon = true;
        resultReward = r->reward;
        resultMessage = r->message;
        voices.push_back("objectiveCompleted");
      } else {
        resultSet = true;
        resultWon = false;
        resultReward = r->reward;
        resultMessage = r->message;
        voices.push_back("youLost");
      }
      finished = true;
      break;
    }
  }
}

void Game::updateRegion(float dtMs) {
  if (!map.hasRegion) return;
  const float r2 = map.regionRadius * map.regionRadius;
  for (auto& kv : teams) {
    Team* t = kv.second.get();
    if (t->name == "ambient") continue;
    for (SpaceObject* o : t->objects) {
      SpaceShip* ship = dynamic_cast<SpaceShip*>(o);
      if (!ship || !ship->active) continue;
      const Vec3 d = vsub(ship->pos, map.regionPos);
      if (vsqlen(d) <= r2) {
        t->hillMs += dtMs;
        break;
      }
    }
  }
}

}  // namespace ie
