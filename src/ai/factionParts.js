/**
 * AI — faction-specific procedural parts.
 *
 * `parts.js` builds exactly one soldier: high-cut ballistic helmet, plate
 * carrier, knee pads, gloves. It is a good soldier, and it is the reason every
 * actor in a raid reads as the same operator with a different tint — a scav in
 * a tracksuit and a Killa are not "the vanguard mesh, browner".
 *
 * So this file adds the geometry the other three archetypes need. It does NOT
 * replace anything in `parts.js`; it extends the same vocabulary, in the same
 * bind space (metres, feet on y = 0, facing +Z, character's right at -X),
 * returning the same mesh records, so `soldier.js` can mix parts from both
 * files into one CharacterBuilder pass.
 *
 * WHY SEPARATE MESHES PER PIECE. Several builders return an object of records
 * rather than one merged mesh (`{ shell, stripes, visor }`). Vertex colour and
 * material are per-part in the builder, so a fur brim that needs a different
 * tint and grime from the crown it sits on, or a visor that needs the glass
 * material, has to arrive as its own record. Merging them would force one tint
 * across the whole hat and put smoked polycarbonate on the cloth set.
 *
 * ANCHOR REFERENCE (from parts.js, so the two agree):
 *   head-local  crown +0.244 · brow +0.113 · eye line +0.098 · ear ±0.083
 *   helmet      shell centre cy = head.y + 0.100
 *   torso       hem 0.865 → neck 1.505, half-width 0.150-0.198
 *   carrier     front plate y 1.298 z 0.126 · cummerbund y 1.152 · straps y 1.418
 *
 * Nothing here runs per frame; it is all boot-time work.
 */

import * as THREE from 'three'
import {
  appendMesh,
  boxRound,
  computeNormals,
  displace,
  ellipseProfile,
  ellipsoid,
  emptyMesh,
  loft,
  ribbon,
  superEllipse,
  tube,
  warp,
} from './geo.js'
import { bendY, place, pouch } from './parts.js'

/* ================================================================== */
/* shared helpers                                                     */
/* ================================================================== */

/**
 * A curved armour / cloth panel: rounded slab, tapered toward the waist, then
 * wrapped around the body on a cylinder.
 *
 * This is the same construction `parts.js` uses for its plates, exposed with
 * the taper and the corner sharpness open so a 17 mm soft-armour panel and a
 * 40 mm ceramic plate can both come out of it.
 */
export function curvedPanel(hx, hy, hz, y, z, tilt, radius, opts = {}) {
  const m = boxRound(hx, hy, hz, {
    n: opts.n ?? 3.6,
    seg: opts.seg ?? 22,
    rows: opts.rows ?? 11,
    roundY: opts.roundY ?? 0.24,
  })
  const tx = opts.taperX ?? 0.2
  const tz = opts.taperZ ?? 0.35
  warp(m, (v) => {
    const t = Math.max(0, -v.y / hy)
    v.x *= 1 - tx * t * t
    v.z *= 1 - tz * t * t
  })
  computeNormals(m)
  place(m, 0, y, z, tilt, 0, 0)
  bendY(m, radius, z)
  computeNormals(m)
  return m
}

/** A closed ring of points around the Y axis — belts, hems, brims, cuffs. */
function ringPath(y, rx, rz, zo = 0, n = 26, fn = null) {
  const pts = []
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    const sx = Math.sin(a)
    const sz = Math.cos(a)
    const dy = fn ? fn(a, sx, sz) : 0
    pts.push([sx * rx, y + dy, zo + sz * rz])
  }
  return pts
}

function radiusAt(radius, t) {
  if (typeof radius === 'number') return radius
  const n = radius.length - 1
  const s = Math.max(0, Math.min(1, t)) * n
  const i = Math.min(n - 1, Math.floor(s))
  return radius[i] + (radius[i + 1] - radius[i]) * (s - i)
}

/* ================================================================== */
/* civilian headgear                                                   */
/* ================================================================== */

/**
 * Ushanka. The single most legible "this is not a soldier" cue in the game:
 * fur, not ballistic nylon, and a silhouette that is wider than the skull.
 *
 * The crown is a cloth dome; the brim is a fat rolled ribbon with aggressive
 * ridged displacement standing in for fur (real fur needs shells, and this has
 * to survive at 35 m in a vertex-coloured single draw call). Flaps roll either
 * up onto the crown or hang beside the jaw — `p.flapsUp` decides, and the two
 * silhouettes are different enough to break up a crowd on their own.
 *
 * @returns { crown, fur, flaps }
 */
export function ushanka(nz, base, p = {}) {
  const bx = base[0]
  const by = base[1]
  const bz = base[2]
  const up = p.flapsUp ?? false

  const crown = ellipsoid(0.106, 0.132, 0.116, { seg: 22, rows: 12, v0: 0.36, v1: 1 })
  computeNormals(crown)
  place(crown, bx, by + 0.106, bz - 0.006)
  displace(crown, (x, y, z) => {
    const f = nz.fbm3(x * 24, y * 20, z * 24, 3)
    return f * 0.005 + Math.sin(y * 62 + f * 3.6) * 0.0018
  })

  // fur brim: thick, and deliberately noisy at two frequencies so the edge
  // silhouette breaks up instead of reading as a moulded rim
  const brim = ribbon(
    ringPath(by + 0.112, 0.108, 0.118, bz - 0.006, 28, (a, sx, sz) => Math.max(0, sz) * 0.004),
    0.052,
    0.040,
    { seg: 9, up: [0, 1, 0], upright: true }
  )
  computeNormals(brim)
  displace(brim, (x, y, z) => {
    const coarse = nz.ridge3(x * 30, y * 30, z * 30, 3)
    const fine = nz.fbm3(x * 90, y * 90, z * 90, 2)
    return coarse * 0.0055 + fine * 0.0022
  })

  const flaps = emptyMesh()
  for (const side of [-1, 1]) {
    const flap = boxRound(0.034, 0.062, 0.028, { n: 3.0, seg: 14, rows: 7, roundY: 0.44 })
    if (up) place(flap, bx + side * 0.086, by + 0.196, bz - 0.012, 0.1, 0, side * 0.5)
    else place(flap, bx + side * 0.098, by + 0.052, bz - 0.006, 0.06, 0, side * 0.16)
    computeNormals(flap)
    displace(flap, (x, y, z) => nz.ridge3(x * 34, y * 34, z * 34, 3) * 0.005)
    appendMesh(flaps, flap)
  }
  // rear neck flap, always down
  const rear = boxRound(0.060, 0.030, 0.022, { n: 3.2, seg: 14, rows: 6, roundY: 0.5 })
  place(rear, bx, by + 0.062, bz - 0.098, 0.34, 0, 0)
  computeNormals(rear)
  displace(rear, (x, y, z) => nz.ridge3(x * 34, y * 34, z * 34, 3) * 0.005)
  appendMesh(flaps, rear)
  computeNormals(flaps)

  return { crown, fur: brim, flaps }
}

/**
 * Knitted beanie. Hugs the skull, so the silhouette cue is not width but the
 * ribbed roll at the hem and the vertical knit banding — both built as
 * displacement at a frequency that survives mipping.
 */
export function beanie(nz, base, p = {}) {
  const out = emptyMesh()
  const bx = base[0]
  const by = base[1]
  const bz = base[2]

  const dome = ellipsoid(0.099, 0.134, 0.107, { seg: 22, rows: 12, v0: 0.38, v1: 1 })
  computeNormals(dome)
  place(dome, bx, by + 0.108, bz - 0.006)
  displace(dome, (x, y, z) => {
    // vertical knit ribs, plus slack over the crown
    const ang = Math.atan2(x - bx, z - bz)
    const rib = Math.sin(ang * 26) * 0.5 + 0.5
    const slack = Math.max(0, (y - (by + 0.16)) / 0.09)
    return rib * 0.0016 + nz.fbm3(x * 30, y * 26, z * 30, 3) * 0.004 + slack * 0.004
  })
  appendMesh(out, dome)

  const cuff = ribbon(ringPath(by + 0.100, 0.101, 0.109, bz - 0.006, 26), 0.038, 0.020, {
    seg: 8,
    up: [0, 1, 0],
    upright: true,
  })
  computeNormals(cuff)
  displace(cuff, (x, y, z) => {
    const ang = Math.atan2(x - bx, z - bz)
    return (Math.sin(ang * 30) * 0.5 + 0.5) * 0.0026 + nz.fbm3(x * 44, y * 44, z * 44, 2) * 0.002
  })
  appendMesh(out, cuff)

  if (p.bobble) {
    const b = ellipsoid(0.026, 0.026, 0.026, { seg: 14, rows: 10 })
    computeNormals(b)
    place(b, bx, by + 0.252, bz - 0.008)
    displace(b, (x, y, z) => nz.ridge3(x * 60, y * 60, z * 60, 3) * 0.005)
    appendMesh(out, b)
  }

  computeNormals(out)
  return out
}

/**
 * Flat cap / civilian ball cap. The peak is the whole point: a hard horizontal
 * shadow line across the brow that no helmet in the game casts.
 *
 * @returns { crown, peak }
 */
export function civCap(nz, base, p = {}) {
  const bx = base[0]
  const by = base[1]
  const bz = base[2]

  const crown = ellipsoid(0.097, 0.092, 0.104, { seg: 22, rows: 11, v0: 0.44, v1: 1 })
  computeNormals(crown)
  place(crown, bx, by + 0.132, bz - 0.008)
  if (p.flat) {
    // flat cap: pull the crown forward and squash it over the peak
    warp(crown, (v) => {
      const t = Math.max(0, (v.y - (by + 0.13)) / 0.07)
      v.z += t * 0.026
      v.y -= t * 0.016
    })
    computeNormals(crown)
  }
  displace(crown, (x, y, z) => nz.fbm3(x * 34, y * 28, z * 34, 3) * 0.0035)

  const peak = boxRound(0.078, 0.008, 0.052, { n: 3.0, seg: 18, rows: 4, roundY: 0.6 })
  warp(peak, (v) => {
    // narrow the tip, so it is a peak and not a shelf
    const t = Math.max(0, v.z / 0.052)
    v.x *= 1 - 0.26 * t * t
  })
  computeNormals(peak)
  place(peak, bx, by + 0.118, bz + 0.098, p.flat ? -0.34 : -0.22, 0, 0)
  bendY(peak, 0.30, 0.098)
  computeNormals(peak)

  return { crown, peak }
}

/* ================================================================== */
/* civilian layers                                                     */
/* ================================================================== */

/**
 * Civilian jacket furniture: centre zip placket, open lapels, hem band.
 *
 * `jacketTorso` from `parts.js` is a shell with no closure, which is why it
 * reads as a base layer under armour. Add a placket and a hem and the same
 * shell reads as a coat — that is the cheapest civilian conversion available.
 *
 * @returns { placket, lapels, hem }
 */
export function jacketPlacket(nz, p = {}) {
  const top = p.top ?? 1.446
  const bottom = p.bottom ?? 0.878
  const zFront = p.z ?? 0.106

  const spine = []
  const rows = 8
  for (let i = 0; i <= rows; i++) {
    const t = i / rows
    const y = top + (bottom - top) * t
    // follow the torso's own depth curve: deepest at the chest, tucked at waist
    const chest = Math.exp(-((y - 1.33) ** 2) / 0.02)
    const waist = Math.exp(-((y - 1.06) ** 2) / 0.012)
    spine.push([0, y, zFront + chest * 0.012 - waist * 0.008])
  }
  const placket = ribbon(spine, p.width ?? 0.032, 0.009, { seg: 7, up: [0, 0, 1] })
  computeNormals(placket)
  displace(placket, (x, y, z) => nz.fbm3(x * 46, y * 30, z * 46, 2) * 0.0016)

  const lapels = emptyMesh()
  for (const side of [-1, 1]) {
    const lap = boxRound(0.044, 0.086, 0.010, { n: 3.0, seg: 14, rows: 7, roundY: 0.3 })
    warp(lap, (v) => {
      // taper to a point at the bottom, like a real notch lapel
      const t = Math.max(0, -v.y / 0.086)
      v.x *= 1 - 0.55 * t
    })
    computeNormals(lap)
    place(lap, side * 0.062, 1.372, zFront + 0.016, -0.12, side * -0.42, side * 0.30)
    computeNormals(lap)
    displace(lap, (x, y, z) => nz.fbm3(x * 40, y * 34, z * 40, 3) * 0.0022)
    appendMesh(lapels, lap)
  }
  computeNormals(lapels)

  const hem = ribbon(
    ringPath(bottom - 0.004, 0.156, 0.112, -0.006, 26, (a, sx, sz) => Math.cos(a * 2) * 0.003),
    0.034,
    0.019,
    { seg: 8, up: [0, 1, 0], upright: true }
  )
  computeNormals(hem)
  displace(hem, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0026)

  return { placket, lapels, hem }
}

/**
 * Hood bunched down behind the neck.
 *
 * A hoodie is instantly civilian, and the down-hood mass is what sells it from
 * behind — which is the angle a player most often sees a scav from.
 */
export function hoodDown(nz, p = {}) {
  const cy = p.y ?? 1.360
  const cz = p.z ?? -0.104
  const pts = []
  for (let i = 0; i <= 6; i++) {
    const t = i / 6
    const a = (t - 0.5) * 2.3
    pts.push([Math.sin(a) * 0.104, cy + 0.058 - Math.cos(a) * 0.030 - t * 0.026, cz - Math.cos(a) * 0.034])
  }
  const m = tube(pts, (t) => superEllipse(0.052 + Math.sin(t * Math.PI) * 0.016, 0.038, 3.0, 14), {
    capStart: true,
    capEnd: true,
    up: [0, 1, 0],
  })
  computeNormals(m)
  displace(m, (x, y, z) => {
    const f = nz.fbm3(x * 20, y * 17, z * 20, 3)
    return f * 0.008 + Math.sin(y * 54 + f * 4.2) * 0.003
  })
  computeNormals(m)
  return m
}

/**
 * THREE-STRIPE TRACKSUIT RIBBONS.
 *
 * Three parallel ribbons laid on the outer face of a limb, offset radially so
 * they sit proud of the sleeve rather than intersecting it. This is the motif
 * the boss profile reuses on Killa's helmet crown, which is why it takes an
 * arbitrary chain and lateral axis instead of hard-coding a limb.
 *
 * @param chain   polyline the stripes run along, in bind space
 * @param opts.out      unit vector pushing the stripes out to the limb surface
 * @param opts.lateral  unit vector the three stripes are spaced along
 * @param opts.radius   number or per-point array: how far out the surface is
 */
export function trackStripes(chain, opts = {}) {
  const out = emptyMesh()
  if (!chain || chain.length < 2) return out
  const push = new THREE.Vector3(...(opts.out ?? [0, 0, 1])).normalize()
  const lat = new THREE.Vector3(...(opts.lateral ?? [1, 0, 0])).normalize()
  const count = opts.count ?? 3
  const gap = opts.gap ?? 0.019
  const width = opts.width ?? 0.012
  const thick = opts.thick ?? 0.004
  const lift = opts.lift ?? 0.001
  const radius = opts.radius ?? 0.05

  for (let s = 0; s < count; s++) {
    const off = (s - (count - 1) * 0.5) * gap
    const pts = []
    for (let i = 0; i < chain.length; i++) {
      const t = i / (chain.length - 1)
      const r = radiusAt(radius, t) + lift
      pts.push([
        chain[i][0] + push.x * r + lat.x * off,
        chain[i][1] + push.y * r + lat.y * off,
        chain[i][2] + push.z * r + lat.z * off,
      ])
    }
    const rb = ribbon(pts, width, thick, {
      seg: opts.seg ?? 6,
      up: opts.up ?? [lat.x, lat.y, lat.z],
      upright: true,
    })
    computeNormals(rb)
    appendMesh(out, rb)
  }
  computeNormals(out)
  return out
}

/**
 * Denim cuff stacked on the boot.
 *
 * Trousers that end in a clean tube read as combat trousers bloused into the
 * boot. Jeans do not blouse — they stack, and the stack is a fat ring of
 * horizontal folds sitting on the laces.
 */
export function jeanCuffs(nz, ankle, side) {
  const ax = ankle[0]
  const ay = ankle[1]
  const az = ankle[2]
  const m = tube(
    [
      [ax, ay + 0.042, az - 0.006],
      [ax, ay + 0.098, az - 0.002],
      [ax, ay + 0.152, az + 0.002],
    ],
    (t) => ellipseProfile(0.074 - t * 0.010, 0.066 - t * 0.008, 16),
    { capStart: false, capEnd: false }
  )
  computeNormals(m)
  displace(m, (x, y, z) => {
    // horizontal stacked folds, tightest at the bottom where the fabric piles
    const stack = Math.max(0, 1 - (y - (ay + 0.042)) / 0.075)
    const band = Math.abs(Math.sin((y - ay) * 105))
    const f = nz.fbm3(x * 24, y * 20, z * 24, 3)
    return (1 - band ** 0.6) * stack * 0.0055 + f * 0.0028
  })
  // hem seam so the cuff edge is a line, not a fade
  const seam = ribbon(
    ringPath(ay + 0.044, 0.075, 0.067, az - 0.006, 20),
    0.012,
    0.006,
    { seg: 6, up: [0, 1, 0], upright: true }
  )
  computeNormals(seam)
  appendMesh(m, seam)
  computeNormals(m)
  return m
}

/**
 * Scav bandolier: a canvas strap over one shoulder with a few mismatched
 * pouches. Load-bearing without being load-bearing GEAR — no plates, no PALS,
 * nothing that implies a quartermaster.
 */
export function bandolier(nz, side = 1) {
  const out = emptyMesh()
  const strap = ribbon(
    [
      [side * 0.096, 1.436, -0.040],
      [side * 0.104, 1.406, 0.060],
      [side * 0.052, 1.278, 0.126],
      [-side * 0.036, 1.150, 0.130],
      [-side * 0.128, 1.076, 0.048],
      [-side * 0.136, 1.088, -0.062],
    ],
    0.048,
    0.014,
    { seg: 7, up: [0, 1, 0] }
  )
  computeNormals(strap)
  displace(strap, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0022)
  appendMesh(out, strap)

  const spots = [
    { x: side * 0.030, y: 1.238, z: 0.132, hx: 0.030, hy: 0.042, hz: 0.024 },
    { x: -side * 0.048, y: 1.160, z: 0.130, hx: 0.034, hy: 0.036, hz: 0.026 },
    { x: -side * 0.112, y: 1.086, z: 0.078, hx: 0.026, hy: 0.032, hz: 0.022 },
  ]
  for (let i = 0; i < spots.length; i++) {
    const s = spots[i]
    const pch = pouch(nz, {
      hx: s.hx,
      hy: s.hy,
      hz: s.hz,
      x: s.x,
      y: s.y,
      z: s.z,
      rz: -side * 0.18,
      bend: 0.22,
    })
    appendMesh(out, pch)
  }
  computeNormals(out)
  return out
}

/* ================================================================== */
/* soft armour                                                        */
/* ================================================================== */

/**
 * PACA-class soft armour vest.
 *
 * The ONLY armour a scav is allowed to show, and the construction is the whole
 * argument: two thin flexible panels and a shoulder yoke. No cummerbund, no
 * PALS ladders, no side plates, no drag handle. If any of those appear the
 * actor stops reading as a scav who found a vest and starts reading as an
 * operator, which is exactly the failure this file exists to fix.
 */
export function pacaVest(nz, p = {}) {
  const out = emptyMesh()
  const soft = { n: 2.8, roundY: 0.36, taperX: 0.10, taperZ: 0.20, rows: 11, seg: 20 }

  const front = curvedPanel(0.145, 0.150, 0.017, 1.272, 0.114, -0.04, 0.21, soft)
  displace(front, (x, y, z) => {
    // soft armour drapes: broad sag plus a slump over the belt line
    const sag = Math.exp(-((y - 1.16) ** 2) / 0.010)
    return nz.fbm3(x * 26, y * 22, z * 26, 3) * 0.0034 + sag * 0.0022
  })
  appendMesh(out, front)

  const back = curvedPanel(0.147, 0.156, 0.015, 1.276, -0.104, 0.04, 0.22, soft)
  displace(back, (x, y, z) => nz.fbm3(x * 26, y * 22, z * 26, 3) * 0.0032)
  appendMesh(out, back)

  // shoulder yoke: narrow, and it sits ON the shoulder rather than clamping it
  for (const side of [-1, 1]) {
    const yoke = ribbon(
      [
        [side * 0.072, 1.412, 0.126],
        [side * 0.090, 1.452, 0.030],
        [side * 0.092, 1.448, -0.036],
        [side * 0.080, 1.410, -0.104],
      ],
      0.054,
      0.017,
      { seg: 7, up: [0, 1, 0] }
    )
    computeNormals(yoke)
    displace(yoke, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.002)
    appendMesh(out, yoke)
  }

  // side straps: two short velcro tabs, deliberately not a wrap
  for (const side of [-1, 1]) {
    const tab = boxRound(0.010, 0.030, 0.044, { n: 3.0, seg: 10, rows: 5, roundY: 0.5 })
    place(tab, side * 0.146, 1.212, 0.004, 0, 0, 0)
    computeNormals(tab)
    appendMesh(out, tab)
  }

  // front velcro flap, the one bit of hardware a PACA does have
  const flap = boxRound(0.052, 0.022, 0.006, { n: 3.0, seg: 12, rows: 4, roundY: 0.5 })
  place(flap, 0, 1.352, 0.132, -0.06, 0, 0)
  bendY(flap, 0.22, 0.132)
  computeNormals(flap)
  appendMesh(out, flap)

  computeNormals(out)
  return out
}

/* ================================================================== */
/* raider kit                                                          */
/* ================================================================== */

/**
 * Full-cut visored combat helmet.
 *
 * Deliberately NOT the high-cut shell in `parts.js`. That one is scalloped up
 * over the ears so a headset fits; this one comes down over them, adds ear
 * cups and a mandible bar, and carries a flip-down visor. At silhouette range
 * the difference between a high-cut and a full-cut with a mandible is the
 * difference between "soldier" and "assaulter", which is the read a raider
 * needs.
 *
 * @returns { shell, cups, mandible, visor }
 */
export function visorHelmet(nz, base, p = {}) {
  const bx = base[0]
  const by = base[1]
  const bz = base[2]
  const cy = by + 0.100

  const shell = ellipsoid(0.124, 0.164, 0.139, { seg: 26, rows: 13, v0: 0.40, v1: 1 })
  computeNormals(shell)
  place(shell, bx, cy, bz - 0.006)
  // squash the crown very slightly and pull the occiput back — a full-cut shell
  // is not a hemisphere, it overhangs the nape
  warp(shell, (v) => {
    const dz = v.z - (bz - 0.006)
    const dy = v.y - cy
    if (dz < 0) v.z -= Math.max(0, -dz / 0.14) * 0.012
    if (dy > 0.10) v.y -= (dy - 0.10) * 0.14
  })
  computeNormals(shell)
  displace(shell, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 3) * 0.0014)

  // rim: a hard lip all the way round, no ear scallop
  const rim = ribbon(
    ringPath(cy - 0.030, 0.121, 0.135, bz - 0.006, 30, (a, sx, sz) => Math.max(0, sz) * -0.008),
    0.014,
    0.008,
    { seg: 6, up: [0, 1, 0], upright: true }
  )
  computeNormals(rim)

  const cups = emptyMesh()
  appendMesh(cups, rim)
  for (const side of [-1, 1]) {
    const cup = boxRound(0.014, 0.046, 0.040, { n: 3.0, seg: 14, rows: 7, roundY: 0.55 })
    place(cup, bx + side * 0.116, cy - 0.046, bz - 0.014, 0, 0, side * 0.08)
    computeNormals(cup)
    appendMesh(cups, cup)
  }
  computeNormals(cups)

  // mandible guard: ear to ear, passing in front of the jaw
  const mandible = ribbon(
    [
      [bx - 0.110, cy - 0.052, bz - 0.006],
      [bx - 0.098, cy - 0.098, bz + 0.048],
      [bx - 0.048, cy - 0.122, bz + 0.086],
      [bx + 0.048, cy - 0.122, bz + 0.086],
      [bx + 0.098, cy - 0.098, bz + 0.048],
      [bx + 0.110, cy - 0.052, bz - 0.006],
    ],
    0.040,
    0.014,
    { seg: 8, up: [0, 1, 0], upright: true }
  )
  computeNormals(mandible)

  const visor = boxRound(0.098, 0.030, 0.009, { n: 3.0, seg: 20, rows: 5, roundY: 0.6 })
  if (p.visorUp) place(visor, bx, cy + 0.098, bz + 0.096, -1.02, 0, 0)
  else place(visor, bx, by + 0.104, bz + 0.088, -0.08, 0, 0)
  bendY(visor, 0.115, p.visorUp ? 0.096 : 0.088)
  computeNormals(visor)

  return { shell, cups, mandible, visor }
}

/**
 * Heavy modular plate carrier.
 *
 * Thicker front and back plates than the standard carrier, real side plates,
 * a deep cummerbund and shoulder pauldrons. The pauldrons are the silhouette
 * cue — they widen and square off the shoulder line, which is what makes a
 * raider read as armoured from any angle even before the tint lands.
 *
 * @returns { plates, pauldrons, webbing }
 */
export function heavyCarrier(nz, p = {}) {
  const plates = emptyMesh()
  const hard = { n: 3.8, roundY: 0.22, taperX: 0.18, taperZ: 0.32 }

  const front = curvedPanel(0.158, 0.148, 0.040, 1.300, 0.134, -0.05, 0.20, hard)
  displace(front, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0024)
  appendMesh(plates, front)

  const back = curvedPanel(0.160, 0.156, 0.036, 1.302, -0.124, 0.05, 0.21, hard)
  displace(back, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0024)
  appendMesh(plates, back)

  // side plates in their pockets on the cummerbund
  for (const side of [-1, 1]) {
    const sp = boxRound(0.022, 0.078, 0.058, { n: 3.6, seg: 14, rows: 8, roundY: 0.3 })
    place(sp, side * 0.156, 1.212, 0.002, 0, 0, side * 0.05)
    computeNormals(sp)
    displace(sp, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 2) * 0.002)
    appendMesh(plates, sp)
  }

  // deep cummerbund
  const band = ribbon(
    ringPath(1.150, 0.176, 0.128, -0.004, 28, (a) => Math.cos(a * 2) * 0.005),
    0.116,
    0.030,
    { seg: 9, up: [0, 1, 0], upright: true }
  )
  computeNormals(band)
  displace(band, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0022)
  appendMesh(plates, band)

  // wide shoulder straps
  for (const side of [-1, 1]) {
    const s = ribbon(
      [
        [side * 0.084, 1.416, 0.150],
        [side * 0.104, 1.472, 0.040],
        [side * 0.108, 1.466, -0.038],
        [side * 0.094, 1.416, -0.128],
      ],
      0.092,
      0.038,
      { seg: 8, up: [0, 1, 0] }
    )
    computeNormals(s)
    displace(s, (x, y, z) => nz.fbm3(x * 34, y * 34, z * 34, 3) * 0.0022)
    appendMesh(plates, s)
  }
  computeNormals(plates)

  // pauldrons
  const pauldrons = emptyMesh()
  for (const side of [-1, 1]) {
    const pd = ellipsoid(0.064, 0.052, 0.072, { seg: 18, rows: 10, v0: 0.30, v1: 0.86 })
    computeNormals(pd)
    warp(pd, (v) => {
      if (v.y < 0) v.x *= 0.86
    })
    computeNormals(pd)
    place(pd, side * 0.118, 1.394, 0.002, 0, 0, -side * 0.20)
    computeNormals(pd)
    displace(pd, (x, y, z) => nz.fbm3(x * 40, y * 40, z * 40, 3) * 0.002)
    appendMesh(pauldrons, pd)
    // segment seam so the pauldron reads as layered lames
    const lame = ribbon(
      [
        [side * 0.062, 1.372, 0.062],
        [side * 0.132, 1.378, 0.010],
        [side * 0.126, 1.372, -0.058],
      ],
      0.026,
      0.009,
      { seg: 6, up: [0, 1, 0], upright: true }
    )
    computeNormals(lame)
    appendMesh(pauldrons, lame)
  }
  computeNormals(pauldrons)

  // PALS ladders + drag handle
  const webbing = emptyMesh()
  for (let r = 0; r < 3; r++) {
    const y = 1.306 + r * 0.048
    const pts = []
    for (let i = 0; i <= 8; i++) {
      const t = i / 8
      const x = (t - 0.5) * 0.166
      pts.push([x, y, 0.160 - (x * x) / 0.19])
    }
    const row = ribbon(pts, 0.014, 0.004, { seg: 5, up: [0, 1, 0], upright: true })
    computeNormals(row)
    appendMesh(webbing, row)
  }
  const drag = ribbon(
    [
      [-0.056, 1.436, -0.140],
      [-0.024, 1.464, -0.162],
      [0.024, 1.464, -0.162],
      [0.056, 1.436, -0.140],
    ],
    0.030,
    0.011,
    { seg: 6, up: [0, 1, 0], upright: true }
  )
  computeNormals(drag)
  appendMesh(webbing, drag)
  computeNormals(webbing)

  return { plates, pauldrons, webbing }
}

/* ================================================================== */
/* boss signatures                                                     */
/* ================================================================== */

/**
 * KILLA. Full-face Maska-class shell with the three raised crown stripes.
 *
 * The stripes are the entire point: they are a tracksuit motif welded onto
 * ballistic steel, they run front-to-back over the crown, and they are built as
 * geometry (three proud ribbons) rather than as a texture, so they survive to
 * any mip and read at any distance. Combined with a visor that covers the whole
 * face rather than just the eye line, the silhouette is unmistakable from
 * across Interchange — which is what a boss encounter needs.
 *
 * @returns { shell, stripes, visor }
 */
export function killaHelmet(nz, base, p = {}) {
  const bx = base[0]
  const by = base[1]
  const bz = base[2]
  const cy = by + 0.098

  const shell = ellipsoid(0.130, 0.170, 0.144, { seg: 28, rows: 14, v0: 0.36, v1: 1 })
  computeNormals(shell)
  place(shell, bx, cy, bz - 0.008)
  warp(shell, (v) => {
    const dy = v.y - cy
    const dz = v.z - (bz - 0.008)
    // heavy, blunt, slightly conical crown; deep nape
    if (dy > 0.08) {
      v.y -= (dy - 0.08) * 0.10
      v.x *= 1 - Math.max(0, (dy - 0.08) / 0.09) * 0.08
    }
    if (dz < 0) v.z -= Math.max(0, -dz / 0.145) * 0.016
  })
  computeNormals(shell)
  displace(shell, (x, y, z) => nz.fbm3(x * 36, y * 36, z * 36, 3) * 0.0016)

  // rim + jaw skirt: the shell wraps under the jaw, so the head is fully caged
  const rim = ribbon(
    ringPath(cy - 0.052, 0.127, 0.140, bz - 0.008, 30, (a, sx, sz) => Math.max(0, sz) * -0.016),
    0.020,
    0.011,
    { seg: 7, up: [0, 1, 0], upright: true }
  )
  computeNormals(rim)
  appendMesh(shell, rim)
  computeNormals(shell)

  // ---- THE THREE STRIPES -------------------------------------------------
  const crown = []
  const rows = 11
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1)
    // sweep front to back over the dome, in the sagittal plane
    const a = -0.62 + t * 2.44
    crown.push([bx, cy + Math.cos(a) * 0.168, bz - 0.008 + Math.sin(a) * 0.142])
  }
  const stripes = trackStripes(crown, {
    out: [0, 0, 0],
    lateral: [1, 0, 0],
    radius: 0,
    count: 3,
    gap: 0.046,
    width: 0.026,
    thick: 0.009,
    lift: 0,
    seg: 7,
    up: [1, 0, 0],
  })
  computeNormals(stripes)

  // ---- full-face visor ---------------------------------------------------
  const visor = boxRound(0.106, 0.054, 0.011, { n: 2.9, seg: 22, rows: 7, roundY: 0.42 })
  warp(visor, (v) => {
    // narrow toward the chin, like a real Maska faceplate
    const t = Math.max(0, -v.y / 0.054)
    v.x *= 1 - 0.16 * t * t
  })
  computeNormals(visor)
  place(visor, bx, by + 0.082, bz + 0.092, -0.10, 0, 0)
  bendY(visor, 0.118, 0.092)
  computeNormals(visor)

  return { shell, stripes, visor }
}

/**
 * SHTURMAN. Open camo coat.
 *
 * A long coat worn open is a completely different silhouette from a fitted
 * jacket: it hangs to mid-thigh, it swings clear of the legs, and the open
 * front leaves a vertical gap down the middle of the torso. Three bent slabs
 * (two front flaps and a back skirt) plus folded-open lapels, so the gap is
 * real geometry and the hem breaks the leg line.
 *
 * @returns { skirt, lapels }
 */
export function openCoat(nz, p = {}) {
  const skirt = emptyMesh()
  const drop = p.drop ?? 0.300
  const midY = 1.000

  // front flaps, hanging either side of an open front and swung outward
  for (const side of [-1, 1]) {
    const flap = boxRound(0.082, drop, 0.017, { n: 2.8, seg: 16, rows: 13, roundY: 0.10 })
    warp(flap, (v) => {
      // flare toward the hem, and let it swing away from the body
      const t = Math.max(0, -v.y / drop)
      v.x *= 1 + 0.22 * t
      v.z += t * t * 0.030
    })
    computeNormals(flap)
    place(flap, side * 0.092, midY, 0.104, 0, side * -0.16, side * 0.05)
    bendY(flap, 0.205, 0.104)
    computeNormals(flap)
    displace(flap, (x, y, z) => {
      const f = nz.fbm3(x * 18, y * 13, z * 18, 3)
      const hang = Math.max(0, 1 - (y - (midY - drop)) / (drop * 1.6))
      return f * 0.005 + Math.sin(x * 46 + f * 3.2) * hang * 0.0032
    })
    appendMesh(skirt, flap)
  }

  // back skirt, one wide panel
  const back = boxRound(0.168, drop, 0.019, { n: 2.9, seg: 22, rows: 13, roundY: 0.10 })
  warp(back, (v) => {
    const t = Math.max(0, -v.y / drop)
    v.x *= 1 + 0.16 * t
    v.z -= t * t * 0.022
  })
  computeNormals(back)
  place(back, 0, midY, -0.108, 0, 0, 0)
  bendY(back, 0.225, -0.108)
  computeNormals(back)
  displace(back, (x, y, z) => {
    const f = nz.fbm3(x * 18, y * 13, z * 18, 3)
    return f * 0.005 + Math.sin(x * 40 + f * 3) * 0.0026
  })
  appendMesh(skirt, back)

  // hem edge, so the bottom of the coat is a drawn line
  for (const side of [-1, 1]) {
    const edge = ribbon(
      [
        [side * 0.030, midY - drop + 0.004, 0.128],
        [side * 0.108, midY - drop + 0.002, 0.106],
        [side * 0.156, midY - drop - 0.004, 0.020],
        [side * 0.150, midY - drop - 0.006, -0.086],
      ],
      0.026,
      0.012,
      { seg: 7, up: [0, 1, 0], upright: true }
    )
    computeNormals(edge)
    appendMesh(skirt, edge)
  }
  computeNormals(skirt)

  // wide folded-open lapels
  const lapels = emptyMesh()
  for (const side of [-1, 1]) {
    const lap = boxRound(0.058, 0.132, 0.013, { n: 2.8, seg: 16, rows: 9, roundY: 0.24 })
    warp(lap, (v) => {
      const t = Math.max(0, -v.y / 0.132)
      v.x *= 1 - 0.48 * t
    })
    computeNormals(lap)
    place(lap, side * 0.078, 1.352, 0.118, -0.16, side * -0.55, side * 0.34)
    computeNormals(lap)
    displace(lap, (x, y, z) => nz.fbm3(x * 34, y * 28, z * 34, 3) * 0.003)
    appendMesh(lapels, lap)
  }
  // storm collar standing at the neck
  const collar = ribbon(
    ringPath(1.474, 0.104, 0.096, -0.008, 22, (a, sx, sz) => Math.max(0, sz) * 0.014),
    0.052,
    0.016,
    { seg: 8, up: [0, 1, 0], upright: true }
  )
  computeNormals(collar)
  displace(collar, (x, y, z) => nz.fbm3(x * 34, y * 30, z * 34, 3) * 0.0026)
  appendMesh(lapels, collar)
  computeNormals(lapels)

  return { skirt, lapels }
}

/* ================================================================== */
/* shared civilian / gear extras                                      */
/* ================================================================== */

/**
 * Chest pocket patch — a flat pocket with a flap. Cheap, and a couple of them
 * scattered at different heights does a lot to break up a plain jacket front.
 */
export function chestPocket(nz, x, y, z, side = 1, size = 1) {
  const out = emptyMesh()
  const body = boxRound(0.038 * size, 0.044 * size, 0.011, { n: 3.2, seg: 14, rows: 6, roundY: 0.3 })
  place(body, x, y, z, 0, 0, side * 0.06)
  bendY(body, 0.22, z)
  computeNormals(body)
  displace(body, (px, py, pz) => nz.fbm3(px * 40, py * 40, pz * 40, 3) * 0.0018)
  appendMesh(out, body)
  const flap = boxRound(0.040 * size, 0.011, 0.010, { n: 3.2, seg: 12, rows: 4, roundY: 0.5 })
  place(flap, x, y + 0.040 * size, z + 0.004, -0.12, 0, side * 0.06)
  bendY(flap, 0.22, z + 0.004)
  computeNormals(flap)
  appendMesh(out, flap)
  computeNormals(out)
  return out
}

/**
 * Elbow / shoulder patch on a worn civilian jacket. Reads as a repair, and
 * repairs are the fastest way to say "this was not issued".
 */
export function clothPatch(nz, centre, normal, size = 0.048) {
  const n = new THREE.Vector3(...normal).normalize()
  const m = boxRound(size, size * 0.82, 0.006, { n: 2.6, seg: 12, rows: 6, roundY: 0.5 })
  computeNormals(m)
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
  const sx = new THREE.Vector3().crossVectors(up, n).normalize()
  const sy = new THREE.Vector3().crossVectors(n, sx).normalize()
  const mat = new THREE.Matrix4().makeBasis(sx, sy, n)
  mat.setPosition(new THREE.Vector3(centre[0], centre[1], centre[2]).addScaledVector(n, 0.002))
  const v = new THREE.Vector3()
  warp(m, (vec) => {
    v.copy(vec).applyMatrix4(mat)
    vec.copy(v)
  })
  computeNormals(m)
  displace(m, (x, y, z) => nz.fbm3(x * 44, y * 44, z * 44, 3) * 0.0016)
  return m
}

/**
 * Loose trouser cuff for a tracksuit — an elasticated hem that grips the ankle
 * instead of stacking like denim. Same anchor as `jeanCuffs` so the two are
 * interchangeable per roll.
 */
export function trackCuffs(nz, ankle) {
  const ax = ankle[0]
  const ay = ankle[1]
  const az = ankle[2]
  const m = tube(
    [
      [ax, ay + 0.060, az - 0.004],
      [ax, ay + 0.104, az - 0.001],
      [ax, ay + 0.148, az + 0.002],
    ],
    (t) => ellipseProfile(0.058 + t * 0.012, 0.052 + t * 0.010, 16),
    { capStart: false, capEnd: false }
  )
  computeNormals(m)
  displace(m, (x, y, z) => {
    const grip = Math.max(0, 1 - (y - (ay + 0.060)) / 0.045)
    const rib = Math.abs(Math.sin((y - ay) * 150))
    return (1 - rib ** 0.5) * grip * 0.0038 + nz.fbm3(x * 26, y * 22, z * 26, 3) * 0.0024
  })
  computeNormals(m)
  return m
}
