// OcTree + primitive tests: verbatim port of src/engine/octree.ts and the
// ray/sphere helpers of src/engine/frustum.ts.
#include "sim.h"

namespace ie {

// ------------------------------------------------------------------ geometry
bool raySphere(float ox, float oy, float oz, float dx, float dy, float dz,
               float cx, float cy, float cz, float r, float* t) {
  const float ocx = cx - ox, ocy = cy - oy, ocz = cz - oz;
  const float tca = ocx * dx + ocy * dy + ocz * dz;
  const float d2 = ocx * ocx + ocy * ocy + ocz * ocz - tca * tca;
  if (d2 > r * r) return false;
  const float hit = tca - std::sqrt(std::max(0.0f, r * r - d2));
  if (hit < 0) return false;
  *t = hit;
  return true;
}

bool rayBox(float ox, float oy, float oz, float dx, float dy, float dz,
            float minx, float miny, float minz, float maxx, float maxy, float maxz, float* t) {
  float tmin = 0, tmax = INFINITY;
  const float o[3] = {ox, oy, oz};
  const float d[3] = {dx, dy, dz};
  const float mn[3] = {minx, miny, minz};
  const float mx[3] = {maxx, maxy, maxz};
  for (int i = 0; i < 3; i++) {
    if (std::fabs(d[i]) < 1e-12f) {
      if (o[i] < mn[i] || o[i] > mx[i]) return false;
    } else {
      float t1 = (mn[i] - o[i]) / d[i];
      float t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) std::swap(t1, t2);
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return false;
    }
  }
  *t = tmin;
  return true;
}

bool spheresIntersect(float ax, float ay, float az, float ar, float bx, float by, float bz, float br) {
  const float dx = ax - bx, dy = ay - by, dz = az - bz;
  const float rr = ar + br;
  return dx * dx + dy * dy + dz * dz <= rr * rr;
}

bool sphereBoxIntersect(float sx, float sy, float sz, float r,
                        float minx, float miny, float minz, float maxx, float maxy, float maxz) {
  const float nx = std::max(minx, std::min(sx, maxx));
  const float ny = std::max(miny, std::min(sy, maxy));
  const float nz = std::max(minz, std::min(sz, maxz));
  const float dx = nx - sx, dy = ny - sy, dz = nz - sz;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

// -------------------------------------------------------------------- octree
OctNode::OctNode(OctNode* parent, int index) {
  const float sx = (parent->maxx_ - parent->minx_) * 0.5f;
  const float sy = (parent->maxy_ - parent->miny_) * 0.5f;
  const float sz = (parent->maxz_ - parent->minz_) * 0.5f;
  const int bx = (index & 4) != 0 ? 1 : 0;
  const int by = (index & 2) != 0 ? 1 : 0;
  const int bz = (index & 1) != 0 ? 1 : 0;
  const float mnx = parent->minx_ + bx * sx;
  const float mny = parent->miny_ + by * sy;
  const float mnz = parent->minz_ + bz * sz;
  minx_ = std::max(mnx - sx * 0.1f, parent->minx_);
  miny_ = std::max(mny - sy * 0.1f, parent->miny_);
  minz_ = std::max(mnz - sz * 0.1f, parent->minz_);
  maxx_ = std::min(mnx + sx * 1.1f, parent->maxx_);
  maxy_ = std::min(mny + sy * 1.1f, parent->maxy_);
  maxz_ = std::min(mnz + sz * 1.1f, parent->maxz_);
  parent_ = parent;
  index_ = index;
}

bool OctNode::childContains(float sx, float sy, float sz, float r) const {
  if (!canFrag()) return false;
  for (int i = 0; i < 8; i++) {
    if (childBoxContains(*this, i, sx, sy, sz, r)) return true;
  }
  return false;
}

bool OctNode::childBoxContains(const OctNode& p, int i, float sx, float sy, float sz, float r) {
  if (p.childs_[i]) return p.childs_[i]->containsSphere(sx, sy, sz, r);
  const float size[3] = {(p.maxx_ - p.minx_) * 0.5f, (p.maxy_ - p.miny_) * 0.5f, (p.maxz_ - p.minz_) * 0.5f};
  const int bit[3] = {(i & 4) != 0 ? 1 : 0, (i & 2) != 0 ? 1 : 0, (i & 1) != 0 ? 1 : 0};
  const float mn[3] = {
      p.minx_ + bit[0] * size[0],
      p.miny_ + bit[1] * size[1],
      p.minz_ + bit[2] * size[2],
  };
  const float lox = std::max(mn[0] - size[0] * 0.1f, p.minx_);
  const float loy = std::max(mn[1] - size[1] * 0.1f, p.miny_);
  const float loz = std::max(mn[2] - size[2] * 0.1f, p.minz_);
  const float hix = std::min(mn[0] + size[0] * 1.1f, p.maxx_);
  const float hiy = std::min(mn[1] + size[1] * 1.1f, p.maxy_);
  const float hiz = std::min(mn[2] + size[2] * 1.1f, p.maxz_);
  return sx - r >= lox && sx + r <= hix && sy - r >= loy && sy + r <= hiy &&
         sz - r >= loz && sz + r <= hiz;
}

OctNode* OctNode::fragment(int index) {
  childs_[index] = std::make_unique<OctNode>(this, index);
  return childs_[index].get();
}

void OctNode::insert(OctItem* obj) {
  OctNode* ptr = this;
  ptr->count_++;
  if (obj->kind == ObKind::Interactive) ptr->interactiveCount_++;
  for (;;) {
    bool contains = false;
    if (ptr->canFrag()) {
      for (int i = 0; i < 8; i++) {
        const bool has = ptr->childs_[i] != nullptr;
        const bool ok = has
            ? ptr->childs_[i]->containsSphere(obj->sx, obj->sy, obj->sz, obj->sradius)
            : childBoxContains(*ptr, i, obj->sx, obj->sy, obj->sz, obj->sradius);
        if (ok) {
          if (!has) ptr->fragment(i);
          contains = true;
          ptr = ptr->childs_[i].get();
          ptr->count_++;
          if (obj->kind == ObKind::Interactive) ptr->interactiveCount_++;
          break;
        }
      }
    } else {
      break;
    }
    if (!contains) break;
  }
  if (obj->kind == ObKind::Interactive) ptr->interactive_.push_back(obj);
  else if (obj->kind == ObKind::Environment) ptr->environment_.push_back(obj);
  else ptr->uncollidable_.push_back(obj);
  obj->octNode = ptr;
}

void OctNode::removeFrom(OctNode* ptr, OctItem* obj) {
  std::vector<OctItem*>* arr = obj->kind == ObKind::Interactive ? &ptr->interactive_
                              : obj->kind == ObKind::Environment ? &ptr->environment_
                                                                 : &ptr->uncollidable_;
  for (size_t i = 0; i < arr->size(); i++) {
    if ((*arr)[i] == obj) {
      arr->erase(arr->begin() + static_cast<long>(i));
      break;
    }
  }
}
void OctNode::remove(OctItem* obj) {
  OctNode* ptr = obj->octNode;
  if (!ptr) return;
  removeFrom(ptr, obj);
  obj->octNode = nullptr;
  OctNode* p = ptr;
  while (p) {
    // Read the parent *before* the node may be freed by the reset below.
    OctNode* parent = p->parent_;
    p->count_--;
    if (obj->kind == ObKind::Interactive) p->interactiveCount_--;
    if (p->count_ == 0 && parent) parent->childs_[p->index_].reset();
    p = parent;
  }
}

void OctNode::refresh(OctItem* obj) {
  OctNode* ptr = obj->octNode;
  if (!ptr) return;
  const bool chCon = ptr->childContains(obj->sx, obj->sy, obj->sz, obj->sradius);
  const bool thisCon = ptr->containsSphere(obj->sx, obj->sy, obj->sz, obj->sradius);
  if (!thisCon || chCon) {
    removeFrom(ptr, obj);
    if (chCon) {
      ptr->count_--;
      if (obj->kind == ObKind::Interactive) ptr->interactiveCount_--;
      ptr->insert(obj);
    } else {
      OctNode* p = ptr;
      while (p && !nodeContains(*p, obj->sx, obj->sy, obj->sz, obj->sradius)) {
        // Read the parent before the reset below may free this node.
        OctNode* parent = p->parent_;
        p->count_--;
        if (obj->kind == ObKind::Interactive) p->interactiveCount_--;
        if (p->count_ == 0 && parent) parent->childs_[p->index_].reset();
        p = parent;
      }
      if (!p) {
        this->insert(obj);
      } else {
        p->count_--;
        if (obj->kind == ObKind::Interactive) p->interactiveCount_--;
        p->insert(obj);
      }
    }
  }
}

void OctNode::sphereSelectInteractive(float sx, float sy, float sz, float r, std::vector<OctItem*>& out) const {
  for (OctItem* o : interactive_) {
    if (o->active && spheresIntersect(sx, sy, sz, r, o->sx, o->sy, o->sz, o->sradius)) out.push_back(o);
  }
  for (int i = 0; i < 8; i++) {
    const OctNode* ch = childs_[i].get();
    if (ch && ch->interactiveCount_ > 0 &&
        sphereBoxIntersect(sx, sy, sz, r, ch->minx_, ch->miny_, ch->minz_, ch->maxx_, ch->maxy_, ch->maxz_)) {
      ch->sphereSelectInteractive(sx, sy, sz, r, out);
    }
  }
}

void OctNode::sphereSelect(float sx, float sy, float sz, float r, std::vector<OctItem*>& out) const {
  for (OctItem* o : interactive_) {
    if (o->active && spheresIntersect(sx, sy, sz, r, o->sx, o->sy, o->sz, o->sradius)) out.push_back(o);
  }
  for (OctItem* o : environment_) {
    if (o->active && spheresIntersect(sx, sy, sz, r, o->sx, o->sy, o->sz, o->sradius)) out.push_back(o);
  }
  for (int i = 0; i < 8; i++) {
    const OctNode* ch = childs_[i].get();
    if (ch && sphereBoxIntersect(sx, sy, sz, r, ch->minx_, ch->miny_, ch->minz_, ch->maxx_, ch->maxy_, ch->maxz_)) {
      ch->sphereSelect(sx, sy, sz, r, out);
    }
  }
}

void OctNode::raySelect(float ox, float oy, float oz, float dx, float dy, float dz, float d,
                        std::vector<OctItem*>& out) const {
  for (OctItem* o : interactive_) {
    float t;
    if (o->active && raySphere(ox, oy, oz, dx, dy, dz, o->sx, o->sy, o->sz, o->sradius, &t) && t <= d) {
      out.push_back(o);
    }
  }
  for (OctItem* o : environment_) {
    float t;
    if (o->active && raySphere(ox, oy, oz, dx, dy, dz, o->sx, o->sy, o->sz, o->sradius, &t) && t <= d) {
      out.push_back(o);
    }
  }
  for (int i = 0; i < 8; i++) {
    const OctNode* ch = childs_[i].get();
    if (!ch) continue;
    float t;
    if (rayBox(ox, oy, oz, dx, dy, dz, ch->minx_, ch->miny_, ch->minz_, ch->maxx_, ch->maxy_, ch->maxz_, &t) &&
        t <= d) {
      ch->raySelect(ox, oy, oz, dx, dy, dz, d, out);
    }
  }
}

}  // namespace ie
