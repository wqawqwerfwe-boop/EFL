/**
 * Shared anatomical damage model - the seven-part body the whole game agrees on.
 *
 * One body, two owners. `src/health/index.js` drives the player through these
 * parts, this overflow graph and these effect bitflags; this module lifts that
 * arithmetic out of the subsystem so an AI actor can run the identical maths
 * without dragging the profile, the inventory or the HUD in with it.
 *
 * The part list, the effect bitflags and PAIN_DECAY are imported from the health
 * subsystem on purpose. They are the contract the rest of the game already
 * speaks (`health:effect`, `bullet:impact`, `actor:death`), so re-declaring them
 * here would be exactly the drift this refactor exists to kill. MAXHP, the
 * armour resistance table and the overflow graph are private inside the
 * subsystem, so they are declared here and are canonical from now on.
 *
 * Nothing in here touches the DOM, the event bus or another subsystem: it is
 * pure state plus arithmetic, so a bot can own one per actor and tick it from a
 * time-sliced loop that only runs a few actors per frame.
 *
 * THIS FILE HAS TWO HALVES AND NEEDS BOTH.
 *   1. the damage model below (Anatomy, MAXHP, the overflow graph)
 *   2. the tactical zone authority further down (ARMOR_ZONES, coversZone,
 *      zoneForPartIndex, pickHeadSubZone, healthPartOf, ...)
 * The second half was added on its own and then lost when a bulk upload
 * replaced this module with the damage model alone. That is what made the
 * engine unbootable:
 *   armor.js:8 Uncaught SyntaxError: The requested module
 *   '/src/core/anatomy.js' does not provide an export named 'coversZone'
 * src/physics/armor.js and src/physics/penetration.js both import from the
 * zone half. Do not overwrite one half with the other again.
 */

import { EFL } from './config.js'
import { clamp } from './tarkovUtils.js'
import {
  E_BLEED_H,
  E_BLEED_L,
  E_FRACTURE,
  E_HEALING,
  E_PAIN,
  PAIN_DECAY,
  PARTS,
} from '../health/index.js'

export { E_BLEED_H, E_BLEED_L, E_FRACTURE, E_HEALING, E_PAIN, PAIN_DECAY, PARTS }

export const PART_COUNT = PARTS.length

export const P_HEAD = 0
export const P_THORAX = 1
export const P_STOMACH = 2
export const P_LARM = 3
export const P_RARM = 4
export const P_LLEG = 5
export const P_RLEG = 6

/** Base pool per part. Identical to the player's private table. */
export const MAXHP = Object.freeze([35, 85, 70, 60, 60, 65, 65])

/** Armour resistance by class 0..6, same curve the player's plates use. */
export const ARMOR_RES = Object.freeze([0, 14, 22, 32, 44, 58, 74])

/** Blacking one of these out is death, not a fracture. */
export const VITAL = Object.freeze([true, true, false, false, false, false, false])

/**
 * Overflow graph. Damage past a part's remaining pool does not evaporate: it
 * runs up the body the way the player's does. -1 terminates the chain.
 *   arms    -> thorax  * 0.7
 *   legs    -> stomach * 0.8
 *   stomach -> thorax  * 1.0
 */
export const OVERFLOW_TO = Object.freeze([-1, -1, P_THORAX, P_THORAX, P_THORAX, P_STOMACH, P_STOMACH])
export const OVERFLOW_K = Object.freeze([0, 0, 1, 0.7, 0.7, 0.8, 0.8])

export const ARMS = Object.freeze([P_LARM, P_RARM])
export const LEGS = Object.freeze([P_LLEG, P_RLEG])

/**
 * Every spelling of a part the codebase actually produces. The bullet path
 * reports collider regions ('torso', 'arm', 'leg'), the health bus reports
 * canonical part names, the armour layer reports zone ids ('arm_right'), and
 * older call sites used indices - all four land here.
 *
 * Keys are stored pre-normalised: resolvePart strips everything outside a-z,
 * so the zone id 'arm_right' is looked up as 'armright'. Without those four
 * entries every limb hit named by zone fell through to the thorax.
 */
const ALIAS = Object.freeze({
  head: P_HEAD,
  skull: P_HEAD,
  helmet: P_HEAD,
  thorax: P_THORAX,
  chest: P_THORAX,
  torso: P_THORAX,
  body: P_THORAX,
  spine: P_THORAX,
  stomach: P_STOMACH,
  belly: P_STOMACH,
  gut: P_STOMACH,
  pelvis: P_STOMACH,
  hips: P_STOMACH,
  larm: P_LARM,
  arml: P_LARM,
  leftarm: P_LARM,
  armleft: P_LARM,
  rarm: P_RARM,
  armr: P_RARM,
  rightarm: P_RARM,
  armright: P_RARM,
  lleg: P_LLEG,
  legl: P_LLEG,
  leftleg: P_LLEG,
  legleft: P_LLEG,
  rleg: P_RLEG,
  legr: P_RLEG,
  rightleg: P_RLEG,
  legright: P_RLEG,
})

/**
 * Resolve any part spelling to an index.
 *
 * `side` matters only for the region names the hit capsules report: they say
 * 'arm' and 'leg' without a side, and the caller knows which side of the body
 * the round landed on. Negative is right, matching Agent._sideOf.
 */
export function resolvePart(part, side) {
  if (typeof part === 'number') {
    const i = Math.trunc(part)
    return i >= 0 && i < PART_COUNT ? i : P_THORAX
  }
  if (!part) return P_THORAX
  const key = String(part).toLowerCase().replace(/[^a-z]/g, '')
  if (key === 'arm') return side < 0 ? P_RARM : P_LARM
  if (key === 'leg') return side < 0 ? P_RLEG : P_LLEG
  const hit = ALIAS[key]
  return hit === undefined ? P_THORAX : hit
}

export function partName(i) {
  return PARTS[i] === undefined ? 'thorax' : PARTS[i]
}

/* Bleed rates come from the same survival block the player reads, so tuning one
 * number retunes both bodies. Cached object: bleeding ticks once a second per
 * actor and must not allocate. */
const RATES = { heavy: 4.5, light: 1.1 }

function bleedRates() {
  const s = EFL && EFL.survival ? EFL.survival : null
  RATES.heavy = s && Number.isFinite(s.bleedHeavy) ? s.bleedHeavy : 4.5
  RATES.light = s && Number.isFinite(s.bleedLight) ? s.bleedLight : 1.1
  return RATES
}

/**
 * A single actor's body.
 *
 * `apply()` is the only way damage gets in and it returns what happened, so the
 * caller can drive a hit reaction, a death or a loot drop off one call instead
 * of re-deriving state afterwards.
 */
export class Anatomy {
  constructor(opts = {}) {
    this.hp = new Float32Array(PART_COUNT)
    this.max = new Float32Array(PART_COUNT)
    this.effects = new Uint8Array(PART_COUNT)
    this.armor = new Uint8Array(PART_COUNT)

    this.hpScale = 1
    this.armorClass = 0
    this.armorParts = null
    this.helmetDrop = 2
    /** A head hit is fatal outright rather than 35 points of pool. */
    this.lethalHead = false
    this.bleedChance = 0.32
    this.heavyChance = 0.3
    this.rng = null

    this.alive = true
    this.painT = 0
    this.lastHitPart = -1
    this.lastBlackedPart = -1
    this._acc = 0

    this.reset(opts)
  }

  /**
   * Fill the body back up. Every option is sticky: pass it once at construction
   * (or at spawn) and a later bare `reset()` keeps it, which is what an actor
   * pool needs.
   */
  reset(opts = {}) {
    if (Number.isFinite(opts.hpScale)) this.hpScale = clamp(opts.hpScale, 0.2, 4)
    if (Number.isFinite(opts.bleedChance)) this.bleedChance = clamp(opts.bleedChance, 0, 1)
    if (Number.isFinite(opts.heavyChance)) this.heavyChance = clamp(opts.heavyChance, 0, 1)
    if (Number.isFinite(opts.helmetDrop)) this.helmetDrop = clamp(opts.helmetDrop, 0, 6)
    if (opts.lethalHead !== undefined) this.lethalHead = !!opts.lethalHead
    if (opts.rng) this.rng = opts.rng

    for (let i = 0; i < PART_COUNT; i++) {
      const m = MAXHP[i] * this.hpScale
      this.max[i] = m
      this.hp[i] = m
      this.effects[i] = 0
    }

    if (opts.armorClass !== undefined || opts.armorParts !== undefined) {
      this.setArmor(
        opts.armorClass === undefined ? this.armorClass : opts.armorClass,
        opts.armorParts === undefined ? this.armorParts : opts.armorParts
      )
    } else if (this.armorClass > 0) {
      this.setArmor(this.armorClass, this.armorParts)
    } else {
      this.armor.fill(0)
    }

    this.alive = true
    this.painT = 0
    this.lastHitPart = -1
    this.lastBlackedPart = -1
    this._acc = 0
    return this
  }

  /**
   * Strap plates on. The head never gets the rig's full class - a class 6 chest
   * plate and a class 6 helmet are not the same purchase - so it drops by
   * `helmetDrop` classes.
   */
  setArmor(cls, parts) {
    const c = Math.round(clamp(Number.isFinite(cls) ? cls : 0, 0, 6))
    this.armorClass = c
    this.armorParts = Array.isArray(parts) && parts.length ? parts.slice() : null
    this.armor.fill(0)
    if (c <= 0) return this
    const list = this.armorParts ? this.armorParts : ['thorax', 'stomach']
    for (let i = 0; i < list.length; i++) {
      const p = resolvePart(list[i])
      this.armor[p] = p === P_HEAD ? Math.round(clamp(c - this.helmetDrop, 0, 6)) : c
    }
    return this
  }

  _rand() {
    const r = this.rng
    if (r && typeof r.float === 'function') return r.float()
    return Math.random()
  }

  /* ---------------- queries ---------------- */

  get total() {
    let t = 0
    for (let i = 0; i < PART_COUNT; i++) t += this.hp[i]
    return t
  }

  get totalMax() {
    let t = 0
    for (let i = 0; i < PART_COUNT; i++) t += this.max[i]
    return t
  }

  get fraction() {
    const m = this.totalMax
    return m > 0 ? clamp(this.total / m, 0, 1) : 0
  }

  blacked(part) {
    return this.hp[resolvePart(part)] <= 0
  }

  has(part, flag) {
    return (this.effects[resolvePart(part)] & flag) !== 0
  }

  /** Any part carrying the flag, which is how the bleed check reads. */
  any(flag) {
    for (let i = 0; i < PART_COUNT; i++) if (this.effects[i] & flag) return true
    return false
  }

  get bleedingHeavy() {
    return this.any(E_BLEED_H)
  }

  get bleedingLight() {
    return this.any(E_BLEED_L)
  }

  get blackedLegs() {
    return (this.hp[P_LLEG] <= 0 ? 1 : 0) + (this.hp[P_RLEG] <= 0 ? 1 : 0)
  }

  get blackedArms() {
    return (this.hp[P_LARM] <= 0 ? 1 : 0) + (this.hp[P_RARM] <= 0 ? 1 : 0)
  }

  /* ---------------- effects ---------------- */

  addEffect(part, flag) {
    const i = resolvePart(part)
    this.effects[i] |= flag
    if (flag & E_PAIN) this.painT = Math.max(this.painT, 120)
    return i
  }

  clearEffect(part, flag) {
    const i = resolvePart(part)
    this.effects[i] &= ~flag
    return i
  }

  addBleed(part, heavy) {
    const i = resolvePart(part)
    if (heavy) {
      this.effects[i] |= E_BLEED_H
      this.effects[i] &= ~E_BLEED_L
    } else if (!(this.effects[i] & E_BLEED_H)) {
      this.effects[i] |= E_BLEED_L
    }
    return i
  }

  /** Bandage: kills both bleed grades on one part, or on the whole body. */
  stopBleed(part) {
    if (part === undefined || part === null) {
      for (let i = 0; i < PART_COUNT; i++) this.effects[i] &= ~(E_BLEED_H | E_BLEED_L)
      return -1
    }
    const i = resolvePart(part)
    this.effects[i] &= ~(E_BLEED_H | E_BLEED_L)
    return i
  }

  heal(part, amount) {
    if (!this.alive) return 0
    const i = resolvePart(part)
    const before = this.hp[i]
    this.hp[i] = Math.min(this.max[i], before + Math.max(0, amount))
    return this.hp[i] - before
  }

  /* ---------------- damage ---------------- */

  /**
   * Take a hit.
   *
   * @param amount post-falloff damage
   * @param part   part index, canonical name, or a collider region
   * @param opts.side        <0 right, >0 left - only read for 'arm' / 'leg'
   * @param opts.penetrated  false means the plate stopped the round, so the
   *                         armour soak is the heavy one
   * @param opts.ignoreArmor true for bleeds, falls and anything already inside
   * @param opts.noBleed     true suppresses the bleed roll
   * @param opts.lethalHead  overrides the per-body setting for this hit
   * @returns what happened, ready to drive a reaction or a death
   */
  apply(amount, part, opts = {}) {
    const out = {
      part: -1,
      dealt: 0,
      absorbed: 0,
      overflow: 0,
      blacked: false,
      blackedPart: -1,
      killed: false,
      headshot: false,
      bleed: 0,
    }
    if (!this.alive) return out

    let amt = Number.isFinite(amount) ? Math.max(0, amount) : 0
    const i = resolvePart(part, opts.side)
    out.part = i
    this.lastHitPart = i
    if (amt <= 0) return out

    const cls = this.armor[i]
    if (cls > 0 && opts.ignoreArmor !== true) {
      // A round the plate stopped dumps almost everything into the plate; one
      // that punched through only loses the ceramic's bite. Same table the
      // player's plates use, so a class 5 rig means the same thing on a bot.
      const res = ARMOR_RES[cls]
      const soak = opts.penetrated === false ? res / (res + 26) : res / (res + 190)
      const absorbed = amt * soak
      out.absorbed = absorbed
      amt -= absorbed
    }
    if (amt <= 0) return out

    const lethalHead = opts.lethalHead === undefined ? this.lethalHead : !!opts.lethalHead
    if (i === P_HEAD && lethalHead) {
      // guaranteed: a round that reaches the skull ends the actor, it does not
      // shave a 35 point pool
      this.hp[P_HEAD] = 0
      this.alive = false
      this.lastBlackedPart = P_HEAD
      out.dealt = amt
      out.blacked = true
      out.blackedPart = P_HEAD
      out.headshot = true
      out.killed = true
      return out
    }

    this._deal(amt, i, out, 0)
    if (out.killed) return out

    // Same roll and the same thresholds the player gets, so a chest hit that
    // opens an artery does it for both bodies at the same rate.
    if (opts.noBleed !== true && out.dealt > 4 && this._rand() < this.bleedChance) {
      const heavy = this._rand() < this.heavyChance
      this.addBleed(i, heavy)
      out.bleed = heavy ? E_BLEED_H : E_BLEED_L
    }
    return out
  }

  /** Drain one part and run the remainder up the overflow graph. */
  _deal(amount, i, out, depth) {
    if (amount <= 0 || depth > 4) return
    const before = this.hp[i]
    const dmg = Math.min(before, amount)
    this.hp[i] = before - dmg
    out.dealt += dmg
    if (this.hp[i] <= 0 && before > 0) this._blackout(i, out)
    if (out.killed) return
    const over = amount - dmg
    if (over <= 0) return
    out.overflow += over
    const to = OVERFLOW_TO[i]
    if (to < 0) return
    this._deal(over * OVERFLOW_K[i], to, out, depth + 1)
  }

  _blackout(i, out) {
    out.blacked = true
    out.blackedPart = i
    this.lastBlackedPart = i
    if (VITAL[i]) {
      this.alive = false
      out.killed = true
      if (i === P_HEAD) out.headshot = true
      return
    }
    // a blacked limb is a fracture plus the pain that comes with it, exactly as
    // the player's blackout branch does it
    this.effects[i] |= E_FRACTURE | E_PAIN
    this.painT = Math.max(this.painT, 240)
  }

  /** Force death without a hit location - falls, scripts, despawns. */
  kill() {
    if (!this.alive) return false
    this.alive = false
    this.hp[P_THORAX] = 0
    this.lastBlackedPart = P_THORAX
    return true
  }

  /* ---------------- background ---------------- */

  /**
   * Advance bleeds and pain by `dt` seconds and return the damage taken.
   *
   * Accumulates to whole seconds internally, so it is correct whether it is
   * called every frame or four times a second from a time-sliced loop - hand it
   * the real elapsed time either way. The catch-up is capped at eight seconds so
   * an actor that was frozen out by LOD does not resolve a minute of arterial
   * bleed in one frame.
   */
  tick(dt) {
    if (!this.alive) return 0
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0
    if (step === 0) return 0
    if (this.painT > 0) this.painT = Math.max(0, this.painT - PAIN_DECAY * step)

    this._acc += step
    if (this._acc < 1) return 0
    let seconds = Math.floor(this._acc)
    this._acc -= seconds
    if (seconds > 8) seconds = 8

    let heavy = 0
    let light = 0
    for (let i = 0; i < PART_COUNT; i++) {
      const e = this.effects[i]
      if (e & E_HEALING) continue
      if (e & E_BLEED_H) heavy++
      else if (e & E_BLEED_L) light++
    }
    if (heavy === 0 && light === 0) return 0

    const rates = bleedRates()
    const perSecond = heavy * rates.heavy + light * rates.light
    if (perSecond <= 0) return 0

    let total = 0
    for (let s = 0; s < seconds; s++) {
      // blood leaves the core, not the limb that is leaking it
      const sink = this.hp[P_THORAX] > 0 ? P_THORAX : P_STOMACH
      const r = this.apply(perSecond, sink, {
        noBleed: true,
        ignoreArmor: true,
        lethalHead: false,
      })
      total += r.dealt
      if (!this.alive) break
    }
    return total
  }

  /* ---------------- penalties ---------------- */

  /**
   * Movement cap. Identical curve to the player's: one blacked leg is a limp,
   * two is a crawl, fractures stack on top, and trying to sprint on a dead leg
   * is worse than walking on it.
   */
  speedMultiplier(sprinting) {
    let m = 1
    const dead = this.blackedLegs
    if (dead >= 2) m *= 0.28
    else if (dead === 1) m *= 0.62
    const fr =
      ((this.effects[P_LLEG] & E_FRACTURE) ? 1 : 0) + ((this.effects[P_RLEG] & E_FRACTURE) ? 1 : 0)
    if (fr >= 2) m *= 0.68
    else if (fr === 1) m *= 0.82
    if (sprinting && dead > 0) m *= 0.45
    return clamp(m, 0.12, 1)
  }

  /** Weapon handling penalty: a wrecked arm and pain both widen the cone. */
  armPenalty() {
    let m = 1
    if (this.blackedArms > 0) m *= 0.6
    if ((this.effects[P_LARM] | this.effects[P_RARM]) & E_FRACTURE) m *= 0.75
    if (this.painT > 0) m *= 0.85
    return clamp(m, 0.2, 1)
  }

  legPenalty() {
    let m = 1
    const dead = this.blackedLegs
    if (dead >= 2) m *= 0.42
    else if (dead === 1) m *= 0.68
    if (this.effects[P_LLEG] & E_FRACTURE) m *= 0.7
    if (this.effects[P_RLEG] & E_FRACTURE) m *= 0.7
    return clamp(m, 0.1, 1)
  }

  /** Worst surviving part, for the "where do I bandage" style of AI decision. */
  worst() {
    let at = P_THORAX
    let f = Infinity
    for (let i = 0; i < PART_COUNT; i++) {
      const m = this.max[i]
      if (m <= 0) continue
      const frac = this.hp[i] / m
      if (frac < f) {
        f = frac
        at = i
      }
    }
    return at
  }

  /** Flat snapshot for the HUD, the debug overlay and the corpse record. */
  snapshot(out = {}) {
    out.alive = this.alive
    out.total = this.total
    out.max = this.totalMax
    out.fraction = this.fraction
    out.pain = this.painT
    out.parts = out.parts && out.parts.length === PART_COUNT ? out.parts : new Array(PART_COUNT)
    for (let i = 0; i < PART_COUNT; i++) {
      const row = out.parts[i] && typeof out.parts[i] === 'object' ? out.parts[i] : {}
      row.name = PARTS[i]
      row.hp = this.hp[i]
      row.max = this.max[i]
      row.effects = this.effects[i]
      row.armor = this.armor[i]
      out.parts[i] = row
    }
    return out
  }
}

/* ==================================================================== *
 *  TACTICAL ANATOMY - the single authority for hit zones and armour
 *  coverage.
 *
 *  WHY THIS SECTION EXISTS
 *    Three subsystems each carried their own idea of what a body "part" was:
 *      src/ai/agent.js              HITBOXES: head, chest, pelvis, arms, legs
 *      src/health/index.js          PARTS:    head, thorax, stomach, larm, ...
 *      src/physics/penetration.js   a hard-coded "partIndex 1 or 2 wears the vest"
 *    Armour needs one shared vocabulary, so every hit capsule publishes a named
 *    zone on its userData and every ballistics, audio, UI and repair lookup
 *    resolves through the tables below.
 *
 *  PART INDEX IS THE COLLIDER INDEX. It is NOT the health part index: agent.js
 *  builds the RIGHT arm at 3 while health lists 'larm' at 3. That silent
 *  left/right swap is exactly what this section exists to kill - cross over
 *  with HEALTH_PART_BY_ZONE / healthIndex instead of assuming the two orders
 *  agree.
 *
 *  Everything exported here is frozen. The tables are read on every bullet
 *  impact, so they are plain objects with no accessors and no allocation.
 * ==================================================================== */

/* Helmet sub-zones, in the order the character screen paints them. */
export const HEAD_SUB_ZONES = Object.freeze(['top', 'nape', 'ears', 'jaws', 'eyes'])

/*
 * Share of the head each sub-zone owns. Used when a helmet lists sub-zones but
 * the impact carries no usable local geometry - a bot shooting a bot at 200 m
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
 *
 * healthIndex crosses back over to the damage model above: P_LARM is 3 and
 * P_RARM is 4, which is the opposite of the collider order on purpose.
 */
export const ARMOR_ZONES = Object.freeze({
  head: makeZone('head', 0, 'Head', 'center', 'head', P_HEAD, HEAD_SUB_ZONES),
  thorax: makeZone('thorax', 1, 'Thorax', 'center', 'thorax', P_THORAX, []),
  stomach: makeZone('stomach', 2, 'Stomach', 'center', 'stomach', P_STOMACH, []),
  arm_right: makeZone('arm_right', 3, 'Right arm', 'right', 'rarm', P_RARM, []),
  arm_left: makeZone('arm_left', 4, 'Left arm', 'left', 'larm', P_LARM, []),
  leg_right: makeZone('leg_right', 5, 'Right leg', 'right', 'rleg', P_RLEG, []),
  leg_left: makeZone('leg_left', 6, 'Left leg', 'left', 'lleg', P_LLEG, [])
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
 * outside the HITBOXES order, and the coarse `part` tag is the last resort -
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
 * time by Agent and by PlayerSystem - never in the frame.
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
 * sub-zones - an SSH-68 stops a round to the crown and does nothing at all for
 * the jaw. A definition with no `zones` covers nothing, which is the honest
 * answer for a rig that is pure storage.
 *
 * THIS is the export src/physics/armor.js imports. It has always been called
 * coversZone; there has never been a covers() in this module.
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

export default Anatomy
