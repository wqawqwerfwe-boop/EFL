/**
 * Physics - AABB world used by the AI test bench.
 *
 * The surface exposed here is the subset of the engine physics contract that
 * `Agent` depends on:
 *
 *   lineOfSight(a, b)          -> true when the segment a->b touches nothing
 *   raycast(origin, dir, max)  -> { hit, point, distance, normal, box } | null
 *   groundHeight(x, z, fromY)  -> highest solid top face at/below fromY, or null
 *
 * `groundHeight` deliberately keeps the "answer with the highest surface" rule
 * of the production BVH query. Inside a building footprint that surface is the
 * roof. That is the behaviour the old vault code was tripping over, and the
 * agent has to be correct against it rather than against a friendlier stub.
 */

import * as THREE from 'three'

const _tmp = new THREE.Vector3()

export class Box {
  constructor(min, max, tag = 'solid') {
    this.min = new THREE.Vector3(...min)
    this.max = new THREE.Vector3(...max)
    this.tag = tag
  }

  containsXZ(x, z) {
    return x >= this.min.x && x <= this.max.x && z >= this.min.z && z <= this.max.z
  }
}

export class PhysicsWorld {
  constructor() {
    this.boxes = []
    this.groundY = 0
  }

  addBox(min, max, tag) {
    const b = new Box(min, max, tag)
    this.boxes.push(b)
    return b
  }

  clear() {
    this.boxes.length = 0
  }

  /** Slab test against one AABB. Returns entry distance or Infinity. */
  _slab(box, o, d, maxDist) {
    let tmin = 0
    let tmax = maxDist
    let nAxis = -1
    let nSign = 0
    for (let a = 0; a < 3; a++) {
      const k = a === 0 ? 'x' : a === 1 ? 'y' : 'z'
      const od = o[k]
      const dd = d[k]
      if (Math.abs(dd) < 1e-9) {
        if (od < box.min[k] || od > box.max[k]) return { t: Infinity }
        continue
      }
      const inv = 1 / dd
      let t1 = (box.min[k] - od) * inv
      let t2 = (box.max[k] - od) * inv
      let sign = -1
      if (t1 > t2) {
        const s = t1
        t1 = t2
        t2 = s
        sign = 1
      }
      if (t1 > tmin) {
        tmin = t1
        nAxis = a
        nSign = sign
      }
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return { t: Infinity }
    }
    return { t: tmin, nAxis, nSign }
  }

  raycast(origin, dir, maxDist = 100) {
    let best = null
    for (const box of this.boxes) {
      const r = this._slab(box, origin, dir, maxDist)
      if (r.t === Infinity) continue
      if (!best || r.t < best.distance) {
        const normal = new THREE.Vector3()
        if (r.nAxis === 0) normal.x = r.nSign
        else if (r.nAxis === 1) normal.y = r.nSign
        else if (r.nAxis === 2) normal.z = r.nSign
        best = {
          hit: true,
          distance: r.t,
          point: _tmp.copy(dir).multiplyScalar(r.t).add(origin).clone(),
          normal,
          box,
        }
      }
    }
    // infinite ground plane
    if (dir.y < -1e-9) {
      const t = (this.groundY - origin.y) / dir.y
      if (t >= 0 && t <= maxDist && (!best || t < best.distance)) {
        best = {
          hit: true,
          distance: t,
          point: _tmp.copy(dir).multiplyScalar(t).add(origin).clone(),
          normal: new THREE.Vector3(0, 1, 0),
          box: null,
        }
      }
    }
    return best
  }

  lineOfSight(a, b) {
    const d = _tmp.copy(b).sub(a)
    const len = d.length()
    if (len < 1e-6) return true
    d.divideScalar(len)
    const hit = this.raycast(a, d.clone(), len)
    return !hit
  }

  /**
   * Highest solid top face under (x, z) that is at or below fromY.
   * Returns null when nothing but the void is below the sample.
   */
  groundHeight(x, z, fromY = 1e9) {
    let best = null
    for (const box of this.boxes) {
      if (!box.containsXZ(x, z)) continue
      if (box.max.y <= fromY + 1e-6) {
        if (best === null || box.max.y > best) best = box.max.y
      }
    }
    if (best === null || this.groundY > best) best = this.groundY
    return best
  }

  /** True when the point sits inside any solid volume. */
  inside(p) {
    for (const box of this.boxes) {
      if (
        p.x > box.min.x && p.x < box.max.x &&
        p.y > box.min.y && p.y < box.max.y &&
        p.z > box.min.z && p.z < box.max.z
      ) return true
    }
    return false
  }
}
