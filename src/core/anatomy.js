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
 * canonical part names, and older call sites used indices - all three land here.
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
  rarm: P_RARM,
  armr: P_RARM,
  rightarm: P_RARM,
  lleg: P_LLEG,
  legl: P_LLEG,
  leftleg: P_LLEG,
  rleg: P_RLEG,
  legr: P_RLEG,
  rightleg: P_RLEG,
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

export default Anatomy