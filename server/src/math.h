// Math primitives for the 37_T simulation.
//
// The browser stores vectors in Float32Array (gl-matrix) and computes in
// doubles; this port stores in `float` and computes in `float`/`double` the
// same way. The functions mirror gl-matrix exactly where the game depends on
// the convention (quat multiply order, fromEuler = qx*qy*qz, transformQuat),
// so a pose produced here matches the pose the browser would have produced.
#pragma once

#include <cmath>
#include <algorithm>

namespace ie {

struct Vec3 {
  float x = 0, y = 0, z = 0;
};

struct Quat {
  float x = 0, y = 0, z = 0, w = 1;
};

inline Vec3 v3(float x, float y, float z) { return Vec3{x, y, z}; }

inline Vec3 vadd(const Vec3& a, const Vec3& b) { return v3(a.x + b.x, a.y + b.y, a.z + b.z); }
inline Vec3 vsub(const Vec3& a, const Vec3& b) { return v3(a.x - b.x, a.y - b.y, a.z - b.z); }
inline Vec3 vscale(const Vec3& a, float s) { return v3(a.x * s, a.y * s, a.z * s); }
inline Vec3 vscaleAndAdd(const Vec3& a, const Vec3& b, float s) {
  return v3(a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
}
inline float vdot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 vcross(const Vec3& a, const Vec3& b) {
  return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
inline float vlen(const Vec3& a) { return std::sqrt(vdot(a, a)); }
inline float vsqlen(const Vec3& a) { return vdot(a, a); }
inline Vec3 vnormalize(const Vec3& a) {
  const float l = vlen(a);
  if (l == 0) return a;
  return vscale(a, 1.0f / l);
}
inline Vec3 vnegate(const Vec3& a) { return v3(-a.x, -a.y, -a.z); }

inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** gl-matrix vec3.transformQuat. */
inline Vec3 vtransformQuat(const Vec3& v, const Quat& q) {
  const float x = v.x, y = v.y, z = v.z;
  const float tx = 2.0f * (q.y * z - q.z * y);
  const float ty = 2.0f * (q.z * x - q.x * z);
  const float tz = 2.0f * (q.x * y - q.y * x);
  return v3(
    x + q.w * tx + (q.y * tz - q.z * ty),
    y + q.w * ty + (q.z * tx - q.x * tz),
    z + q.w * tz + (q.x * ty - q.y * tx));
}

/** gl-matrix quat.multiply: a * b. */
inline Quat qmul(const Quat& a, const Quat& b) {
  return Quat{
    a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

inline Quat qnormalize(const Quat& q) {
  const float l = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (l == 0) return Quat{0, 0, 0, 1};
  const float s = 1.0f / l;
  return Quat{q.x * s, q.y * s, q.z * s, q.w * s};
}

/** Axis-angle rotation; the axis is normalised like gl-matrix does. */
inline Quat qfromAxisAngle(const Vec3& axis, float rad) {
  const float len = vlen(axis);
  if (len < 1e-8f) return Quat{0, 0, 0, 1};
  const float s = 1.0f / len, half = rad * 0.5f, c = std::sin(half);
  return Quat{axis.x * s * c, axis.y * s * c, axis.z * s * c, std::cos(half)};
}

/**
 * gl-matrix quat.fromEuler (degrees): q = qx * qy * qz with half-angle
 * conversion, the composition YPR relies on.
 */
inline Quat qfromEulerDeg(float xd, float yd, float zd) {
  const float halfToRad = 3.14159265358979323846f / 360.0f;
  const float x = xd * halfToRad, y = yd * halfToRad, z = zd * halfToRad;
  const float sx = std::sin(x), cx = std::cos(x);
  const float sy = std::sin(y), cy = std::cos(y);
  const float sz = std::sin(z), cz = std::cos(z);
  return Quat{
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  };
}

inline Quat qidentity() { return Quat{0, 0, 0, 1}; }

/** GetH (Atan2(d.X, d.Z)). */
inline float getH(const Vec3& d) { return std::atan2(d.x, d.z); }

/** GetV (Acos(y/|d|) - Pi/2; the original divides by |d| without a zero guard). */
inline float getV(const Vec3& d) {
  const float len = vlen(d);
  return std::acos(clampf(d.y / (len == 0 ? 1.0f : len), -1.0f, 1.0f)) -
         1.57079632679489661923f;
}

/** GameMath YPR: fromEuler(pitch, yaw, roll) in degrees. */
inline Quat ypr(float yaw, float pitch, float roll) {
  const float d = 180.0f / 3.14159265358979323846f;
  return qfromEulerDeg(pitch * d, yaw * d, roll * d);
}

/** Model3D.ProjectDirection/GameMath helper: getH/getV of a direction. */
inline Vec3 dirFromQuat(const Quat& q) { return vtransformQuat(v3(0, 0, 1), q); }
inline Vec3 sideFromQuat(const Quat& q) { return vtransformQuat(v3(1, 0, 0), q); }
inline Vec3 upFromQuat(const Quat& q) { return vtransformQuat(v3(0, 1, 0), q); }

/** memcpy-compatible view of a pose, for the wire codec. */
struct Pose {
  Vec3 pos;
  Quat rot;
};

/** AIPoint steering (angle unclamped acos, verbatim; guarded only post-hoc).
 *  Port of steerToward in src/engine/math.ts, including the ill-conditioned
 *  cross-product fallback. */
inline void steerToward(Quat& rot, const Vec3& currentDir, const Vec3& desiredDir,
                        const Vec3& side, float maxAngle) {
  const Vec3 t = vnormalize(desiredDir);
  const Vec3 o = vnormalize(currentDir);
  float dot = vdot(t, o);
  dot = clampf(dot, -1.0f, 1.0f);  // float-error guard (else NaN)
  const float angle = std::acos(dot);
  if (angle > 0.0001f) {
    Vec3 ortho = vcross(o, t);
    if (vlen(ortho) < 0.05f) {
      ortho = side;
      const float along = vdot(ortho, o);
      ortho = vscaleAndAdd(ortho, o, -along);
      if (vlen(ortho) < 1e-6f) ortho = v3(0, 1, 0);
    }
    ortho = vnormalize(ortho);
    const Quat step = qfromAxisAngle(ortho, std::min(angle, maxAngle));
    rot = qnormalize(qmul(step, rot));
  }
}

}  // namespace ie
