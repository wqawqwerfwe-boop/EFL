/**
 * TACTICAL ANATOMY — the single authority for hit zones and armour coverage.
 *
 * WHY THIS FILE EXISTS
 *   Three subsystems each carried their own idea of what a body "part" was:
 *     src/ai/agent.js              HITBOXES: head, chest, pelvis, arms, legs
 *     src/health/index.js          PARTS:    head, thorax, stomach, larm, ...
 *     src/physics/penetration.js   a hard-coded "partIndex 1 or 2 wears the vest"
 *   Armour needs one shared vocabulary, so every hit capsule now publishes a
 *   named zone on its userData and every ballistics, audio, UI and repair
 *   lookup resolves through the tables below.
 *
 * PART INDEX IS THE COLLIDER INDEX. It is NOT the health part index: agent.js
 * builds the RIGHT arm at 3 while health lists 'larm' at 3. That silent
 * left/right swap is exactly what this file exists to kill — cross over with
 * HEALTH_PART_BY_ZONE / healthIndex instead of assuming the two orders agree.
 *
 * Everything exported here is frozen. The tables are read on every bullet
 * impact, so they are plain objects with no accessors and no allocation.
 */

/* Helmet sub-zones, in the order the character screen paints them. */
export const HEAD_SUB_ZONES = Object.freeze(['top', 'nape', 'ears', 'jaws', 'eyes'])

/*
 * Share of the head each sub-zone owns. Used when a helmet lists sub-zones but
 * the impact carries no usable local geometry — a bot shooting a bot at 200 m
 * has no reason to pay for a bone-space transform. Sums to 1.
 */
export const HEAD_SUB_ZONE_WEIGHTS = Object.freeze({
  top: 0.26,
  nape: 0.2,
  ears: 0.16,
  jaws: 0.21,
  eyes: 0.17
})

const HEAD_SUB_ZONE_CUM = Object.freeze(HEAD_SUB_ZONES.reduce(function accumulate(acc, id) {
  const prev = acc.length > 0 ? acc[acc.length - 1] : 0
  acc.push(prev + (HEAD_SUB_ZONE_WEIGHTS[id] || 0))
  return acc
}, []))

const makeZone = (id, partIndex, label, side, healthPart, healthIndex, subZones) => Object.freeze({
  id,
  partIndex,
  label,
  side,
  healthPart,
  healthIndex,
  subZones: Object.freeze(subZones.slice())
})

/*
 * THE MAP. Collider part index -> named armour zone.
 *   0 head (top / nape / ears / jaws / eyes)
 *   1 thorax        2 stomach
 *   3 arm_right     4 arm_left
 *   5 leg_right     6 leg_left
 */
export const ARMOR_ZONES = Object.freeze({
  head: makeZone('head', 0, 'Head', 'center', 'head', 0, HEAD_SUB_ZONES),
  thorax: makeZone('thorax', 1, 'Thorax', 'center', 'thorax', 1, []),
  stomach: makeZone('stomach', 2, 'Stomach', 'center', 'stomach', 2, []),
  arm_right: makeZone('arm_right', 3, 'Right arm', 'right', 'rarm', 4, []),
  arm_left: makeZone('arm_left', 4, 'Left arm', 'left', 'larm', 3, []),
  leg_right: makeZone('leg_right', 5, 'Right leg', 'right', 'rleg', 6, []),
  leg_left: makeZone('leg_left', 6, 'Left leg', 'left', 'lleg', 5, [])
})

export const ZONE_IDS = Object.freeze(Object.keys(ARMOR_ZONES))

export const ZONE_BY_PART_INDEX = Object.freeze([
  'head',
  'thorax',
  'stomach',
  'arm_right',
  'arm_left',
  'leg_right',
  'leg_left'
])

export const PART_INDEX_BY_ZONE = Object.freeze({
  head: 0,
  thorax: 1,
  stomach: 2,
  arm_right: 3,
  arm_left: 4,
  leg_right: 5,
  leg_left: 6
})

/* Armour zone -> health part id (src/health/index.js PARTS). */
export const HEALTH_PART_BY_ZONE = Object.freeze({
  head: 'head',
  thorax: 'thorax',
  stomach: 'stomach',
  arm_right: 'rarm',
  arm_left: 'larm',
  leg_right: 'rleg',
  leg_left: 'lleg'
})

/* ...and back again, for the medical screen and the repair UI. */
export const ZONE_BY_HEALTH_PART = Object.freeze({
  head: 'head',
  thorax: 'thorax',
  stomach: 'stomach',
  rarm: 'arm_right',
  larm: 'arm_left',
  rleg: 'leg_right',
  lleg: 'leg_left'
})

/*
 * Rig bone names, so a capsule can still name its zone when it is built
 * outside the canonical HITBOXES order. Drawn from the same set as RIG and the
 * ragdoll DOLL spec in src/ai/agent.js.
 */
const ZONE_BY_BONE = Object.freeze({
  Head: 'head',
  HeadTop: 'head',
  Neck: 'head',
  Spine: 'thorax',
  Spine1: 'thorax',
  Spine2: 'thorax',
  Hips: 'stomach',
  UpperArmR: 'arm_right',
  ForearmR: 'arm_right',
  HandR: 'arm_right',
  FingersR: 'arm_right',
  UpperArmL: 'arm_left',
  ForearmL: 'arm_left',
  HandL: 'arm_left',
  FingersL: 'arm_left',
  UpLegR: 'leg_right',
  LegR: 'leg_right',
  FootR: 'leg_right',
  ToeR: 'leg_right',
  UpLegL: 'leg_left',
  LegL: 'leg_left',
  FootL: 'leg_left',
  ToeL: 'leg_left'
})

/* A round that hit an actor but named no zone is a chest hit. */
export const DEFAULT_ZONE = 'thorax'

export function zoneForPartIndex(partIndex) {
  const id = ZONE_BY_PART_INDEX[partIndex]
  return id === undefined ? DEFAULT_ZONE : id
}

export function zoneForBone(bone) {
  const id = ZONE_BY_BONE[bone]
  return id === undefined ? null : id
}

/** Zone descriptor, never null: an unknown id reads as the chest. */
export function zoneOf(zoneId) {
  const z = ARMOR_ZONES[zoneId]
  return z === undefined ? ARMOR_ZONES.thorax : z
}

/**
 * The zone string a hit capsule publishes on `userData.zone`.
 *
 * Collider index wins. The bone name is the fallback for a capsule built
 * outside the HITBOXES order, and the coarse `part` tag is the last resort —
 * the player carries exactly one capsule and it is tagged 'torso'.
 */
export function resolveZone(partIndex, bone, part) {
  if (typeof partIndex === 'number' && partIndex >= 0) {
    const byIndex = ZONE_BY_PART_INDEX[partIndex]
    if (byIndex !== undefined) return byIndex
  }
  if (bone) {
    const byBone = ZONE_BY_BONE[bone]
    if (byBone !== undefined) return byBone
  }
  if (part === 'head') return 'head'
  if (part === 'arm') return 'arm_right'
  if (part === 'leg') return 'leg_right'
  return DEFAULT_ZONE
}

/**
 * Stamp the resolved zone onto a hit capsule. Called once per collider at build
 * time by Agent and by PlayerSystem — never in the frame.
 */
export function tagColliderZone(collider, partIndex, bone, part) {
  const zoneId = resolveZone(partIndex, bone, part)
  if (!collider) return zoneId
  if (!collider.userData) collider.userData = {}
  collider.userData.zone = zoneId
  collider.userData.zonePartIndex = typeof partIndex === 'number' ? partIndex : PART_INDEX_BY_ZONE[zoneId]
  return zoneId
}

export function isHeadZone(zoneId) {
  return zoneId === 'head'
}

export function healthPartOf(zoneId) {
  const p = HEALTH_PART_BY_ZONE[zoneId]
  return p === undefined ? 'thorax' : p
}

export function healthIndexOf(zoneId) {
  return zoneOf(zoneId).healthIndex
}

/**
 * Which part of the head took the round.
 *
 * @param heightRatio 0 at the chin, 1 at the crown
 * @param dotForward  incident direction against the target's facing: positive
 *                    when the round arrives from behind the target
 * @param lateral     sideways offset in head radii, 0 centre .. 1 edge
 */
export function resolveHeadSubZone(heightRatio, dotForward, lateral) {
  const h = heightRatio >= 0 && heightRatio <= 1 ? heightRatio : 0.5
  if (h > 0.7) return 'top'
  if (dotForward > 0.25) return 'nape'
  if (lateral > 0.55) return 'ears'
  if (h > 0.44) return 'eyes'
  return 'jaws'
}

/**
 * Weighted sub-zone pick for when there is no geometry worth reading.
 * `unit` must be a [0,1) draw from a lockstep stream, so a replay lands on the
 * same slice of skull it did the first time.
 */
export function pickHeadSubZone(unit) {
  const r = unit >= 0 && unit < 1 ? unit : 0
  for (let i = 0; i < HEAD_SUB_ZONES.length; i++) {
    if (r < HEAD_SUB_ZONE_CUM[i]) return HEAD_SUB_ZONES[i]
  }
  return HEAD_SUB_ZONES[HEAD_SUB_ZONES.length - 1]
}

/**
 * Does this armour definition cover `zoneId`?
 *
 * `zones` is the plate's coverage list. `headZones` narrows a helmet to named
 * sub-zones — an SSH-68 stops a round to the crown and does nothing at all for
 * the jaw. A definition with no `zones` covers nothing, which is the honest
 * answer for a rig that is pure storage.
 */
export function coversZone(def, zoneId, subZone) {
  if (!def) return false
  const zones = def.zones
  if (!Array.isArray(zones) || zones.length === 0) return false
  if (zones.indexOf(zoneId) < 0) return false
  if (zoneId !== 'head') return true
  const sub = def.headZones
  if (!Array.isArray(sub) || sub.length === 0) return true
  if (!subZone) return true
  return sub.indexOf(subZone) >= 0
}

/**
 * Fraction of a zone the plate actually spans. Anything below 1 can be missed
 * outright, which is how a side-on hit slips past a front plate.
 */
export function coverageOf(def, zoneId) {
  if (!def) return 0
  const c = def.coverage
  if (c && typeof c[zoneId] === 'number') return Math.max(0, Math.min(1, c[zoneId]))
  return coversZone(def, zoneId) ? 1 : 0
}
