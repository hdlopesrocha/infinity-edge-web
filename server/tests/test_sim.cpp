// Smoke tests for the server-side simulation core: frame codec, tables, and a
// few thousand ticks of every level type. Run from the build tree:
//
//   ./test_sim [repo-root]     (default: the working directory)
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "ai.h"
#include "gzip.h"
#include "proto.h"
#include "sim.h"

namespace {

int g_failures = 0;

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);                \
      g_failures++;                                                              \
    }                                                                            \
  } while (0)

#define CHECK_NEAR(a, b, eps) CHECK(std::fabs((a) - (b)) <= (eps))

bool finite(const ie::Vec3& v) { return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z); }

void testProto() {
  using namespace ie;
  proto::Writer w;
  w.u8(7);
  w.u16(0xBEEF);
  w.u32(0xDEADBEEF);
  w.i16(-1234);
  w.f32(1.5f);
  w.str("hello");
  const std::vector<uint8_t> small = proto::encodeFrame(proto::Ping, w.data().data(), w.size());
  CHECK(small.size() == proto::HEADER_SIZE + w.size());  // below the gzip threshold
  CHECK(small[1] == 0);                                  // raw flag
  const proto::DecodedFrame dec = proto::decodeFrame(small.data(), small.size());
  CHECK(dec.type == proto::Ping);
  proto::Reader r(dec.payload.data(), dec.payload.size());
  CHECK(r.u8() == 7);
  CHECK(r.u16() == 0xBEEF);
  CHECK(r.u32() == 0xDEADBEEF);
  CHECK(r.i16() == -1234);
  CHECK(r.f32() == 1.5f);
  CHECK(r.str() == "hello");
  CHECK(r.eof());

  // Large payloads gzip when that shrinks them.
  proto::Writer big;
  for (int i = 0; i < 4096; i++) big.u32(42);
  const std::vector<uint8_t> gz = proto::encodeFrame(proto::Snapshot, big.data().data(), big.size());
  CHECK(gz.size() < big.size());
  CHECK((gz[1] & proto::FLAG_GZIP) != 0);
  const proto::DecodedFrame gdec = proto::decodeFrame(gz.data(), gz.size());
  CHECK(gdec.payload == big.data());

  // Truncated and bad-version frames are rejected.
  bool threw = false;
  try {
    proto::decodeFrame(small.data(), 4);
  } catch (const std::exception&) {
    threw = true;
  }
  CHECK(threw);
  std::vector<uint8_t> bad = small;
  bad[0] = 99;
  threw = false;
  try {
    proto::decodeFrame(bad.data(), bad.size());
  } catch (const std::exception&) {
    threw = true;
  }
  CHECK(threw);

  // Quantisation: a position inside the half-extent round-trips within a step.
  const float half = 1024;
  for (float v : {-1023.0f, -3.5f, 0.0f, 7.25f, 1023.0f}) {
    CHECK_NEAR(proto::dequantPos(proto::quantPos(v, half), half), v, 0.05f);
  }
}

void testTables(const std::string& root) {
  using namespace ie;
  ModelTable models;
  std::string err;
  CHECK(models.load(root + "/public/assets/models/SIM.json", &err));
  if (!err.empty()) std::printf("  (%s)\n", err.c_str());
  CHECK(models.aliases().size() == 16);
  CHECK(models.get("Fighter3") != nullptr);
  CHECK(models.get("adRepair") != nullptr);
  const ModelData* fighter = models.get("Fighter3");
  if (fighter) {
    CHECK(fighter->hasSolid);
    CHECK(!fighter->solidMeshes.empty());
    CHECK(fighter->radius > 0);
  }

  LevelTable levels;
  CHECK(levels.load(root + "/public/assets/levels", &err));
  CHECK(levels.get("ctf-easy") != nullptr);
  CHECK(levels.get("tt-easy-01") != nullptr);
  CHECK(levels.get("kots-solo-easy") != nullptr);
  CHECK(levels.keys().size() == 26);
}

/** Creates a level and runs it for `ticks` at 30 Hz with throttle+fire held. */
int runLevel(const std::string& root, const std::string& key, int ticks, bool joinInput) {
  using namespace ie;
  ModelTable models;
  LevelTable levels;
  std::string err;
  if (!models.load(root + "/public/assets/models/SIM.json", &err)) {
    std::printf("FAIL models: %s\n", err.c_str());
    return 1;
  }
  if (!levels.load(root + "/public/assets/levels", &err)) {
    std::printf("FAIL levels: %s\n", err.c_str());
    return 1;
  }
  const Level* level = levels.get(key);
  if (!level) {
    std::printf("FAIL level %s missing\n", key.c_str());
    return 1;
  }
  Game game(&models, 123456789u);
  if (!game.create(*level)) {
    std::printf("FAIL create %s\n", key.c_str());
    return 1;
  }
  CHECK(game.selected != nullptr);
  if (joinInput) {
    game.input.throttle = 1;
    game.input.fire = true;
    game.input.stickX = 0.25f;
  }
  const float dt = 1000.0f / 30.0f;
  int bulletsSeen = 0;
  for (int i = 0; i < ticks; i++) {
    game.update(dt);
    for (Abstract3D* o : game.map.live) {
      if (dynamic_cast<Bullet*>(o)) bulletsSeen++;
    }
    for (Abstract3D* o : game.map.live) {
      SpaceObject* so = dynamic_cast<SpaceObject*>(o);
      if (!so) continue;
      if (!finite(so->pos) || !finite(so->vel)) {
        std::printf("FAIL %s: non-finite state for %s at tick %d\n", key.c_str(), so->model ? so->model->name.c_str() : "?", i);
        return 1;
      }
    }
  }
  if (joinInput) {
    CHECK(bulletsSeen > 0);
  }
  std::printf("  %-18s ticks=%d live=%zu objects=%zu bullets=%d\n", key.c_str(), ticks, game.map.live.size(),
              game.objects.size(), bulletsSeen);
  return 0;
}

void testSim(const std::string& root) {
  using namespace ie;
  ModelTable models;
  LevelTable levels;
  std::string err;
  CHECK(models.load(root + "/public/assets/models/SIM.json", &err));
  CHECK(levels.load(root + "/public/assets/levels", &err));

  // Determinism: same seed, same RNG stream.
  Game a(&models, 7);
  Game b(&models, 7);
  Game c(&models, 8);
  CHECK(a.rng() == b.rng());
  CHECK(a.rng() == b.rng());
  CHECK(a.rng() != c.rng());

  // Spawner sanity on CTF: two bases, two flags, one player ship.
  if (const Level* level = levels.get("ctf-easy")) {
    Game g(&models, 123456789u);
    CHECK(g.create(*level));
    CHECK(g.gameType == GameType::CTF);
    int bases = 0, flags = 0, ships = 0;
    for (Abstract3D* o : g.map.live) {
      if (dynamic_cast<Base*>(o)) bases++;
      if (dynamic_cast<Flag*>(o)) flags++;
      if (dynamic_cast<SpaceShip*>(o)) ships++;
    }
    CHECK(bases == 2);
    CHECK(flags == 2);
    CHECK(ships >= 2);
    CHECK(g.selected != nullptr);
    if (g.selected) CHECK(g.selected->team != nullptr);
  }

  // KOTS: the sun and the scoring region are parsed out of the level.
  if (const Level* level = levels.get("kots-solo-easy")) {
    Game g(&models, 123456789u);
    CHECK(g.create(*level));
    CHECK(g.map.hasSun);
    CHECK(g.map.hasRegion);
    CHECK(g.map.sunRadius > 0);
    CHECK(g.map.regionRadius > 0);
  }
}

}  // namespace

int main(int argc, char** argv) {
  const std::string root = argc > 1 ? argv[1] : ".";
  std::printf("test_sim: root=%s\n", root.c_str());
  testProto();
  testTables(root);
  testSim(root);
  if (runLevel(root, "ctf-easy", 900, true) != 0) g_failures++;
  if (runLevel(root, "tt-easy-01", 900, true) != 0) g_failures++;
  if (runLevel(root, "kots-solo-easy", 900, true) != 0) g_failures++;
  if (runLevel(root, "surv-teams-normal", 900, true) != 0) g_failures++;
  if (g_failures == 0) {
    std::printf("test_sim: all tests passed\n");
    return 0;
  }
  std::printf("test_sim: %d failure(s)\n", g_failures);
  return 1;
}
