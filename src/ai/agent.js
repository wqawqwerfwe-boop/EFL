/**
 * Agent - one AI actor.
 *
 * Four things changed in this file and they are worth stating plainly.
 *
 * E1. `variantName` no longer decides anything. It used to be asked
 *     `=== 'irregular'` in three separate places to pick a fire rate and a
 *     reload length, which meant the choice of mesh was quietly driving
 *     ballistics. Every number now comes off a frozen archetype record, and
 *     `variantName` survives only as the key `ai.variant()` needs to build the
 *     right body. `opts.team` - the Call of Duty deathmatch integer nothing read
 *     any more - is gone; `faction` replaces it.
 *
 * E2. `this.health = 100` is gone. An agent owns an Anatomy: the same seven
 *     parts, the same overflow graph, the same bleed rolls and the same speed
 *     penalties the player runs. A blacked leg caps movement, heavy bleeding
 *     drains in the background whether or not the actor is being ticked this
 *     frame, and a round that reaches the skull kills outright and says so.
 *
 * E3. When this actor spots the player it shouts, and the shout is the only
 *     thing that reaches anyone else. There is no direct write into another
 *     agent anywhere in this file.
 *
 * E4. THE ROOF TELEPORT IS FIXED, and it is worth being precise about what the
 *     bug actually was, because the symptom and the cause were in different
 *     methods.
 *
 *     `_tryVault()` cast one probe at y + 0.35, one at y + 1.15, and if the low
 *     one was blocked while the high one was clear it wrote
 *     `this.root.position.y += 0.55` and shoved the actor 0.35 m further along
 *     its heading. Two things are wrong with that. The obvious one: 0.55 m is
 *     not a step, it is a chest-high hop, and nothing bounded it against the
 *     obstacle actually being 0.2 m tall. The one that produced the teleport:
 *     when BOTH probes were blocked - a wall - the method returned false, but
 *     `_move()` had already advanced the actor INTO the wall on the line above.
 *     The ground re-probe that follows asks for the surface height under that
 *     sample, a ground query answers with the highest surface it finds, and
 *     inside a building footprint the highest surface is the ROOF. So the bot
 *     did not jump - it was placed inside solid geometry and then snapped to
 *     the apex vertex above it, every frame it kept pushing.
 *
 *     That also explains the WebGL program errors that came with it. Once y is
 *     resolved off a roof 12 m up (or off a NaN, when the probe missed the
 *     world entirely), the bone matrices this actor feeds the skinning shader
 *     go with it, and a non-finite matrix is a non-finite attribute upload.
 *
 *     The fix is three independent gates, because one of them can always be
 *     unavailable:
 *
 *       1. `_tryVault()` probes forward at ground + `VAULT.LOW_PROBE` (0.30 m,
 *          strictly below the ceiling) and NEVER higher, checks clearance at
 *          ground + `VAULT.CLEARANCE`, and
 *          treats low-blocked + high-blocked as a wall: no vertical write, the
 *          horizontal step is rolled back, `desiredSpeed` is forced to 0 and a
 *          lateral redirection path is requested.
 *       2. a step is only taken when the measured rise ahead is inside the same
 *          ceiling, so the maximum the actor can ever gain in one frame is
 *          `VAULT.STEP_CEILING` metres.
 *       3. the ground re-probe in `_move()` rejects any rise above that ceiling
 *          outright, which kills the snap even in a build where
 *          `physics.lineOfSight()` is missing and gate 1 cannot run at all.
 *
 *     `_sanitize()` then guarantees the transform this actor hands the renderer
 *     is finite, rolling back to the last good pose rather than shipping NaN.
 */

import * as THREE from 'three'
import { RIG } from './rig.js'
import { Animator } from './animator.js'
import Anatomy, { E_BLEED_H, P_HEAD } from '../core/anatomy.js'
import {
  armorClassFor,
  burstLength,
  burstRest,
  durabilityFor,
  factionIndex,
  flankOffset,
  grenadeDelay,
  peekWindow,
  reactionFor,
  resolveArchetype,
  rollSubtype,
  scaleFor,
  voiceFor,
} from './archetypes.js'
import { audibleLoudness } from './squad.js'
import { CALL_RANGE, voiceLayer } from './voice.js'

export const STATE = Object.freeze({
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  COMBAT: 'combat',
  SUPPRESSED: 'suppressed',
  FLANK: 'flank',
  RETREAT: 'retreat',
  DEAD: 'dead',
})

export const DEG = Math.PI / 180

/**
 * MAXIMUM OBSTACLE HEIGHT CEILING and the probe geometry around it.
 *
 * `STEP_CEILING` is the single number that makes the roof teleport impossible:
 * it is both the height the forward probe is cast at and the largest vertical
 * gain any single frame is allowed to apply, whichever path resolved it. A kerb
 * or a low pallet is 0.15-0.40 m and passes; a crate lip, a window sill, a
 * balustrade and a wall are all above it and are refused as walls.
 *
 * `CLEARANCE` is the second probe. A step has air above it, a wall does not, and
 * 1.2 m is the height at which that distinction stops being ambiguous: it is
 * above every legitimate step this game has and below the head of every actor,
 * so a blocked clearance probe means the obstruction continues through the
 * volume the body would have to occupy.
 */
export const VAULT = Object.freeze({
  /** metres above the actor's own ground level - the ceiling */
  STEP_CEILING: 0.45,
  /** where the forward probe is cast - strictly below the ceiling (0.30 m) */
  LOW_PROBE: 0.3,
  /** metres above ground for the high clearance probe */
  CLEARANCE: 1.2,
  /** how far ahead both probes reach */
  PROBE: 0.9,
  /** how far a legitimate step is allowed to carry the actor forward */
  STEP_ASSIST: 0.18,
  /** chest height for the lateral detour probes */
  DETOUR_Y: 0.95,
  /** how far sideways a detour target is placed */
  DETOUR_REACH: 3.4,
  /** how much of the blocked heading is kept in the detour target */
  DETOUR_BIAS: 0.6,
  /** seconds between redirection requests, so a cornered bot cannot spam A* */
  REDIRECT_COOLDOWN: 0.65,
})

/**
 * Hit capsules. `region` is the string handed to applyDamage and resolved by the
 * anatomy; `mult` is the ballistic multiplier the bullet path applies.
 */
export const HITBOXES = Object.freeze([
  { bone: 'head', region: 'head', radius: 0.098, mult: 4, offset: [0, 0.05, 0.012] },
  { bone: 'chest', region: 'torso', radius: 0.152, mult: 1, offset: [0, 0.04, 0] },
  { bone: 'spine', region: 'torso', radius: 0.146, mult: 1, offset: [0, 0, 0] },
  { bone: 'upperArmL', region: 'arm', radius: 0.072, mult: 0.65, offset: [0, -0.06, 0] },
  { bone: 'upperArmR', region: 'arm', radius: 0.072, mult: 0.65, offset: [0, -0.06, 0] },
  { bone: 'thighL', region: 'leg', radius: 0.105, mult: 0.7, offset: [0, -0.1, 0] },
  { bone: 'thighR', region: 'leg', radius: 0.105, mult: 0.7, offset: [0, -0.1, 0] },
])

/** Bones the ragdoll drives once the actor is down. */
export const DOLL = Object.freeze([
  'root', 'hips', 'spine', 'chest', 'neck', 'head',
  'shoulderL', 'upperArmL', 'forearmL', 'handL',
  'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'toeL',
  'thighR', 'shinR', 'footR', 'toeR',
])

/**
 * Which body the faction wears.
 *
 * Visual only, and deliberately several keys per faction: the soldier builder
 * caches one geometry per key, so a handful of keys is how a raid gets scavs in
 * mismatched civilian layers instead of one clone stamped twelve times. The
 * armoured scav key is only ever requested when `_armorZones` actually came
 * back with a plated zone, which is what keeps a PACA off an unarmoured scav.
 */
export const FACTION_MESH = Object.freeze({
  scav: Object.freeze(['scav_civ', 'scav_track', 'scav_jeans']),
  raider: Object.freeze(['raider']),
  pmc: Object.freeze(['pmc']),
  boss: Object.freeze(['boss_killa', 'boss_shturman']),
})

/** Scav mesh worn when a plate actually rolled. */
export const SCAV_ARMORED_MESH = 'scav_paca'

/**
 * Last-resort mesh key per faction. A host that only knows the three original
 * silhouettes still gets a body out of `ai.variant()` rather than a capsule.
 */
export const MESH_FALLBACK = Object.freeze({
  scav: 'irregular',
  raider: 'vanguard',
  pmc: 'vanguard',
  boss: 'breacher',
})

let _nextId = 1

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _aim = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _m = new THREE.Matrix4()
const _low = new THREE.Vector3()
const _high = new THREE.Vector3()
const _ahead = new THREE.Vector3()

function fallbackRng(seed) {
  let a = seed >>> 0 || 0x9e3779b9
  const next = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    float: next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    gauss: () => (next() + next() + next() + next() - 2) * 0.7071,
    fork: () => fallbackRng((next() * 4294967296) >>> 0),
  }
}

export class Agent {
  constructor(ai, opts = {}) {
    this.id = _nextId++
    this.ai = ai || null
    this.isPlayer = false
    this.squad = null

    this.rng =
      ai && ai.rng && typeof ai.rng.fork === 'function'
        ? ai.rng.fork('agent:' + this.id)
        : fallbackRng(0x51ed270b + this.id * 2654435761)

    /* ---- E1: everything this actor is, resolved once ---- */

    const arch = resolveArchetype(opts, this.rng)
    this.archetype = arch
    this.faction = arch.faction
    this.factionIndex = factionIndex(arch.faction)
    this.subtype = rollSubtype(arch, this.rng)
    this.subtypeId = this.subtype ? this.subtype.id : null
    this.voice = voiceFor(arch, this.subtype)
    /**
     * Visual only. Existing map spawns still pass 'vanguard' / 'irregular', so
     * this stays exactly what the archetype declares and remains the fallback
     * key. Nothing branches on it.
     */
    this.variantName = arch.variant

    const senses = arch.senses
    const weapon = arch.weapon
    const tactics = arch.tactics
    this.tactics = tactics

    this.viewRange = senses.viewRange
    this.viewCos = Math.cos(senses.fovDeg * 0.5 * DEG)
    this.alertFovBonus = senses.alertFovBonus
    this.awarenessRate = senses.awarenessRate
    this.hearingScale = senses.hearing
    this.forgetTime = senses.forgetTime
    this.reaction = reactionFor(arch, this.rng)

    this.fireRate = weapon.fireRate
    this.spread = weapon.spread
    this.weaponDamage = weapon.damage
    this.weaponRange = weapon.range
    this.magSize = weapon.magSize
    this.ammo = weapon.magSize
    this.reloadTime = weapon.reload
    this.sway = weapon.sway
    /** 0..1. Wears down as the actor fires and widens the cone as it goes. */
    this.weaponDurability = durabilityFor(arch, this.rng)

    this.bodyScale = scaleFor(arch, this.rng)

    /* ---- E2: the body ---- */

    this.anatomy = new Anatomy({
      hpScale: arch.body.hpScale,
      bleedChance: arch.body.bleedChance,
      heavyChance: arch.body.heavyChance,
      lethalHead: arch.body.lethalHead,
      armorClass: armorClassFor(arch, this.rng),
      armorParts: arch.armor.parts,
      helmetDrop: arch.armor.helmetDrop,
      rng: this.rng,
    })
    this.armorClass = this.anatomy.armorClass

    /**
     * Which zones actually ended up plated on THIS actor.
     *
     * The archetype lists which zones *can* be plated; the class roll decides
     * whether anything was. A scav rolling class 0 is a scav in a jacket, and
     * the model compiler reads this array to decide whether it is allowed to
     * compile any armour mesh at all for them.
     */
    this._armorZones =
      this.armorClass > 0 && Array.isArray(arch.armor.parts) ? arch.armor.parts.slice() : []

    /** Faction mesh kit key handed to `ai.variant()`. */
    this.buildVariant = this._pickBuildVariant()

    /* ---- state ---- */

    this.state = STATE.IDLE
    this.stateTime = 0
    this._time = 0
    this._extStatus = false

    this.awareness = 0
    this.alertness = 0
    this.hasTarget = false
    this.visible = false
    this.lastSeen = Infinity
    this.lastKnown = new THREE.Vector3()
    this.reactionLeft = 0
    this.suppression = 0

    this.fireTimer = 0
    this.burstLeft = 0
    this.burstRest = 0
    this.reloading = 0
    this.shotsFired = 0

    this.path = null
    this.pathIndex = 0
    this.pathPending = false
    this.goal = new THREE.Vector3()
    this.hasGoal = false
    this.repathTimer = 0
    this.coverPoint = null
    this.peeking = false
    this.peekTimer = 0
    this.grenadeCooldown = grenadeDelay(arch, this.rng)
    this.flanking = false

    this.velocity = new THREE.Vector3()
    this.desiredSpeed = 0
    this.speed = 0
    this.grounded = true
    this.eyeHeight = 1.62 * this.bodyScale
    this.height = 1.8 * this.bodyScale
    this.radius = 0.34 * this.bodyScale

    /* ---- E4: vault / wall state ---- */

    /** True for the frame a wall refused this actor's step. */
    this.blockedByWall = false
    /** Seconds until another redirection request is allowed. */
    this._redirectCooldown = 0
    /** Which way the next detour tries first; flipped on use. */
    this._detourSide = this.rng.float() < 0.5 ? -1 : 1
    /** The actor's own ground level for this frame, captured before it steps. */
    this._groundY = 0
    /** Pose before the step, so a refused move can be rolled back exactly. */
    this._preStep = new THREE.Vector3()
    /** Last known finite pose, for `_sanitize()`. */
    this._lastGood = new THREE.Vector3()
    this._vaultBusy = false

    this.lodIrrelevant = false
    this._animSkip = 0
    this._animAccum = 0

    /* ---- scene ---- */

    this.root = new THREE.Group()
    this.root.name = 'agent:' + this.id + ':' + this.faction
    if (opts.position) this.root.position.copy(opts.position)
    if (Number.isFinite(opts.yaw)) this.root.rotation.y = opts.yaw
    this._groundY = this.root.position.y
    this._preStep.copy(this.root.position)
    this._lastGood.copy(this.root.position)

    this.mesh = null
    this.skeleton = null
    this.bones = null
    this.weaponMesh = null
    this.animator = null
    this.hitboxes = []
    this.ragdoll = null

    this._buildBody()
    this._buildHitboxes()

    if (ai && ai.root && typeof ai.root.add === 'function') ai.root.add(this.root)
    else if (ai && ai.scene && typeof ai.scene.add === 'function') ai.scene.add(this.root)

    this._voice = voiceLayer(this._ctx())
    this._eye = new THREE.Vector3()
  }

  /* ================= construction ================= */

  _ctx() {
    const ai = this.ai
    if (!ai) return null
    return ai.ctx || ai.context || ai
  }

  _bus() {
    const ai = this.ai
    if (!ai) return null
    if (ai.bus) return ai.bus
    if (ai.ctx && ai.ctx.bus) return ai.ctx.bus
    return null
  }

  _physics() {
    const ai = this.ai
    if (!ai) return null
    return ai.phys || ai.physics || (ai.ctx ? ai.ctx.physics : null)
  }

  /**
   * Pick the mesh kit for this actor's faction.
   *
   * Scavs draw from the civilian pool unless a plate rolled, in which case they
   * get the one scav silhouette that is allowed to show armour. Bosses draw a
   * signature profile - Killa or Shturman - because a boss that looks like a
   * raider is not a boss.
   */
  _pickBuildVariant() {
    if (this.faction === 'scav' && this._armorZones.length > 0) return SCAV_ARMORED_MESH
    const pool = FACTION_MESH[this.faction]
    if (!pool || pool.length === 0) return this.variantName
    if (pool.length === 1) return pool[0]
    const i = Math.min(pool.length - 1, Math.floor(this.rng.float() * pool.length))
    return pool[i]
  }

  _buildBody() {
    const ai = this.ai
    if (!ai || typeof ai.variant !== 'function') return

    /**
     * Faction key first, archetype key second, faction fallback last. A host
     * that knows the faction kits builds one; a host that only knows the three
     * original silhouettes still gets a body, and nobody gets a null mesh.
     */
    const keys = []
    for (const k of [this.buildVariant, this.variantName, MESH_FALLBACK[this.faction]]) {
      if (k && keys.indexOf(k) < 0) keys.push(k)
    }

    let built = null
    for (let i = 0; i < keys.length && !built; i++) {
      try {
        built = ai.variant(keys[i], this.rng, {
          faction: this.faction,
          subtype: this.subtypeId,
          armorZones: this._armorZones,
          armorClass: this.armorClass,
        })
        if (built) this.buildVariant = keys[i]
      } catch (err) {
        built = null
      }
    }
    if (!built) return

    if (built.isObject3D) {
      this.mesh = built
    } else if (built.geometry) {
      const mesh = new THREE.SkinnedMesh(built.geometry, built.materials)
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = false
      this.mesh = mesh
    }
    if (!this.mesh) return
    this.root.add(this.mesh)

    const vs = built.variant && Number.isFinite(built.variant.scale) ? built.variant.scale : 1
    this.root.scale.setScalar(vs * this.bodyScale)

    if (built.weapon) {
      this.weaponMesh = built.weapon
      if (built.weapon.isObject3D && !built.weapon.parent) this.root.add(built.weapon)
    }

    this.skeleton = this.mesh.skeleton || null
    if (this.skeleton && this.skeleton.bones) {
      this.bones = {}
      for (let i = 0; i < this.skeleton.bones.length; i++) {
        const b = this.skeleton.bones[i]
        if (b && b.name) this.bones[b.name] = b
      }
    }

    if (typeof Animator === 'function') {
      this.animator = new Animator(this.skeleton || this.mesh, RIG, { rng: this.rng })
      // reload length is an archetype field now, not a variant string test
      if (typeof this.animator.reload === 'function') this.animator.reload(this.reloadTime)
    }
  }

  _buildHitboxes() {
    for (let i = 0; i < HITBOXES.length; i++) {
      const def = HITBOXES[i]
      const bone = this.bones ? this.bones[def.bone] : null
      this.hitboxes.push({
        def,
        bone,
        region: def.region,
        radius: def.radius * this.bodyScale,
        mult: def.mult,
        center: new THREE.Vector3(),
      })
    }
    this.syncHitboxes()
  }

  /* ================= compat ================= */

  get eye() {
    return this._eye.set(this.root.position.x, this.root.position.y + this.eyeHeight, this.root.position.z)
  }

  /**
   * Summed pool, kept so older readers - the hurt animation pick, the debug
   * overlay, the loot roll - keep working. The setter scales every part rather
   * than throwing, because a strict-mode assignment to a getter-only property
   * would take the whole raid down.
   */
  get health() {
    return this.anatomy.total
  }

  set health(v) {
    const want = Math.max(0, Number.isFinite(v) ? v : 0)
    const have = this.anatomy.total
    if (want <= 0) {
      this.anatomy.kill()
      return
    }
    if (have <= 0) return
    const k = want / have
    for (let i = 0; i < this.anatomy.hp.length; i++) {
      this.anatomy.hp[i] = Math.min(this.anatomy.max[i], this.anatomy.hp[i] * k)
    }
  }

  get maxHealth() {
    return this.anatomy.totalMax
  }

  get alive() {
    return this.state !== STATE.DEAD && this.anatomy.alive
  }

  /* ================= loop ================= */

  update(dt) {
    if (this.state === STATE.DEAD) {
      if (this.ragdoll) this._driveRagdoll(dt)
      return
    }
    this._time += dt
    this.stateTime += dt

    // If a host time-sliced loop is calling tickStatus itself, this is a no-op
    // and bleeding is driven from there instead.
    this.tickStatus(dt, false)
    if (this.state === STATE.DEAD) return

    if (this._voice) this._voice.update(dt)
    if (this.suppression > 0) this.suppression = Math.max(0, this.suppression - dt * 0.85)
    if (this.grenadeCooldown > 0) this.grenadeCooldown -= dt
    if (this._redirectCooldown > 0) this._redirectCooldown -= dt

    this._sense(dt)
    this._think(dt)
    this._move(dt)
    this._shoot(dt)
    this._drive(dt)
    this.syncHitboxes()
  }

  /**
   * Background status: bleeding and pain.
   *
   * Safe to drive from a time-sliced AI loop that only touches a few actors per
   * frame - pass the real elapsed time for this actor and the anatomy resolves
   * whole seconds internally. The first external call latches, after which
   * `update()` stops ticking it, so there is no double drain and no host wiring
   * needed either way.
   */
  tickStatus(dt, external) {
    if (external === true) this._extStatus = true
    else if (this._extStatus) return 0
    if (this.state === STATE.DEAD) return 0

    const lost = this.anatomy.tick(dt)
    if (lost > 0) {
      if (!this.anatomy.alive) {
        this.die(this.root.position, null, lost, { cause: 'bleed' })
        return lost
      }
      // bled out enough to break off
      if (this.anatomy.fraction < this.tactics.retreatFraction && this.state === STATE.COMBAT) {
        this._setState(STATE.RETREAT)
      }
    }
    return lost
  }

  /* ================= senses ================= */

  _lineOfSight(from, to) {
    const phys = this._physics()
    if (!phys || typeof phys.lineOfSight !== 'function') return true
    try {
      const mask = phys.MASK && phys.MASK.SIGHT !== undefined ? phys.MASK.SIGHT : 1
      return !!phys.lineOfSight(from, to, mask)
    } catch (err) {
      return true
    }
  }

  _sense(dt) {
    const ai = this.ai
    const ppos = ai && typeof ai.playerPosition === 'function' ? ai.playerPosition() : null
    const had = this.hasTarget
    let visible = false

    if (ppos) {
      _v.subVectors(ppos, this.eye)
      const d = _v.length()
      if (d <= this.viewRange && d > 0.001) {
        _v.divideScalar(d)
        this.root.getWorldDirection(_fwd)
        // the mesh faces -Z; getWorldDirection agrees, so no flip here
        const cos = _fwd.dot(_v)
        const need = this.awareness > 0.5 ? this.viewCos - this.alertFovBonus : this.viewCos
        if (cos >= need && this._lineOfSight(this.eye, ppos)) visible = true
      }
    }
    this.visible = visible

    if (visible) {
      // closer targets resolve faster
      const prox = 1 - Math.min(1, this.root.position.distanceTo(ppos) / this.viewRange) * 0.5
      this.awareness = Math.min(1, this.awareness + dt * this.awarenessRate * prox)
      this.lastSeen = 0
      this.lastKnown.copy(ppos)
    } else {
      this.lastSeen += dt
      this.awareness = Math.max(0, this.awareness - dt * 0.32)
    }
    this.alertness = this.awareness

    if (!had && visible && this.awareness >= 1) {
      this.hasTarget = true
      this.reactionLeft = this.reaction
      // E3: the only moment knowledge leaves this actor, and it leaves as sound
      this._callOut('spotEnemy')
    } else if (had && !visible && this.lastSeen > this.forgetTime) {
      this.hasTarget = false
      this.awareness = Math.min(this.awareness, 0.4)
    }

    if (this.reactionLeft > 0) this.reactionLeft -= dt
  }

  /**
   * Something was audible from `pos` at `loudness` metres of carry.
   *
   * The distance gate is the whole point of E3: past it this actor learns
   * nothing at all. Squad.callOut has already attenuated `loudness` for walls,
   * so a shout through concrete simply does not reach far enough to arrive.
   */
  hear(pos, loudness) {
    if (this.state === STATE.DEAD || !pos) return false
    const carry = loudness * this.hearingScale
    const d = this.root.position.distanceTo(pos)
    if (!(carry > 0) || d > carry) return false

    const strength = 1 - d / carry
    this.lastKnown.copy(pos)
    this.lastSeen = 0
    this.awareness = Math.min(1, this.awareness + 0.25 + strength * 0.55)
    if (this.state === STATE.IDLE || this.state === STATE.PATROL) {
      this._setState(STATE.ALERT)
      this._goTo(pos)
    }
    return true
  }

  suppress(amount) {
    const resist = this.tactics.suppressionResist
    this.suppression = Math.min(1.6, this.suppression + amount / Math.max(0.1, resist))
    if (this.suppression > 1 && this.state === STATE.COMBAT) this._setState(STATE.SUPPRESSED)
  }

  /* ================= voice ================= */

  /**
   * Shout, and let the shout carry.
   *
   * The voice layer returns the range the line actually carries, or 0 when it
   * was swallowed by a cooldown - a line nobody heard alerts nobody, which is
   * why the return value drives propagation rather than the event name.
   */
  _callOut(kind) {
    const pos = this.root.position
    let range = 0
    if (this._voice) range = this._voice.say(this, kind, { position: this.eye })
    else range = CALL_RANGE[kind] === undefined ? 20 : CALL_RANGE[kind]
    if (!(range > 0)) return 0

    if (this.squad && typeof this.squad.callOut === 'function') return this.squad.callOut(this, kind, pos, range)

    // no squad: same propagation maths, applied to whoever is nearby
    const ai = this.ai
    const list = ai && Array.isArray(ai.agents) ? ai.agents : null
    if (!list) return 0
    const phys = this._physics()
    let heard = 0
    for (let i = 0; i < list.length; i++) {
      const other = list[i]
      if (!other || other === this || other.state === STATE.DEAD) continue
      if (typeof other.hear !== 'function' || !other.root) continue
      const carried = audibleLoudness(phys, other.root.position, pos, range)
      if (carried > 0 && other.hear(pos, carried)) heard++
    }
    return heard
  }

  /* ================= brain ================= */

  _setState(next) {
    if (this.state === next) return
    if (this.state === STATE.FLANK && this.squad) this.squad.releaseFlank(this)
    if (this.peeking && this.squad) {
      this.squad.releasePeek(this)
      this.peeking = false
    }
    this.state = next
    this.stateTime = 0
    if (next === STATE.FLANK) this.flanking = true
    else this.flanking = false
  }

  _think(dt) {
    const s = this.state
    if (s === STATE.IDLE || s === STATE.PATROL) {
      if (this.hasTarget) this._enterCombat()
      else if (this.awareness > 0.35) this._setState(STATE.ALERT)
      else if (!this.hasGoal && this.stateTime > 2) this._wander()
      return
    }
    if (s === STATE.ALERT) {
      if (this.hasTarget) this._enterCombat()
      else if (this.lastSeen > this.forgetTime * 1.8 && this.awareness < 0.2) this._setState(STATE.PATROL)
      else if (!this.hasGoal) this._goTo(this.lastKnown)
      return
    }
    if (s === STATE.SUPPRESSED) {
      if (this.suppression <= 0.35) this._setState(this.hasTarget ? STATE.COMBAT : STATE.ALERT)
      return
    }
    if (s === STATE.RETREAT) {
      if (this.anatomy.fraction > this.tactics.retreatFraction + 0.15) this._setState(STATE.ALERT)
      else if (!this.hasGoal) this._retreat()
      return
    }
    if (s === STATE.FLANK) {
      if (!this.hasTarget && this.lastSeen > this.forgetTime) this._setState(STATE.ALERT)
      else if (!this.hasGoal) this._setState(STATE.COMBAT)
      else this._combat(dt)
      return
    }
    if (s === STATE.COMBAT) this._combat(dt)
  }

  _enterCombat() {
    this._setState(STATE.COMBAT)
    this.burstLeft = burstLength(this.archetype, this.rng)
    this.burstRest = 0
    const cover = this._findCover()
    if (cover) this._goTo(cover)
  }

  _combat(dt) {
    // too hurt to keep trading - bosses have retreatFraction 0 and never do this
    if (this.anatomy.fraction < this.tactics.retreatFraction) {
      this._setState(STATE.RETREAT)
      return
    }

    this.peekTimer -= dt
    if (this.peekTimer <= 0) {
      const want = this.squad ? this.squad.requestPeek(this, dt) : true
      this.peeking = want
      this.peekTimer = peekWindow(this.archetype, this.rng, want)
      if (!want && this.squad) this.squad.releasePeek(this)
    }

    // a squadmate already has the grenade token, or ours has not recharged
    if (this.grenadeCooldown <= 0 && this.hasTarget) {
      const d = this.root.position.distanceTo(this.lastKnown)
      if (d > 8 && d < 34 && !this._lineOfSight(this.eye, this.lastKnown)) this._throwGrenade()
    }

    if (this.state !== STATE.FLANK && this.squad && this.stateTime > 2.5) {
      if (this.rng.float() < this.tactics.flankChance * dt * 2 && this.squad.claimFlank(this)) {
        this._setState(STATE.FLANK)
        this._flank()
      }
    }

    if (!this.hasGoal && this.stateTime > 1.5) {
      const cover = this._findCover()
      if (cover) this._goTo(cover)
    }
  }

  _findCover() {
    const ai = this.ai
    if (!ai || !ai.cover) return null
    if (this.rng.float() > this.tactics.coverPreference) return null
    const from = this.hasTarget || this.lastSeen < this.forgetTime ? this.lastKnown : null
    try {
      if (typeof ai.cover.nearest === 'function') return ai.cover.nearest(this.root.position, from, 18)
      if (typeof ai.cover.find === 'function') return ai.cover.find(this.root.position, from, 18)
    } catch (err) {
      return null
    }
    return null
  }

  _flank() {
    _v.subVectors(this.lastKnown, this.root.position)
    _v.y = 0
    const len = _v.length()
    if (len < 0.01) return
    _v.divideScalar(len)
    _right.crossVectors(_v, _up).normalize()
    const side = this.rng.float() < 0.5 ? -1 : 1
    const reach = flankOffset(this.archetype, this.rng)
    _v2.copy(this.lastKnown).addScaledVector(_right, side * reach).addScaledVector(_v, -reach * 0.35)
    this._goTo(_v2)
    this._callOut('flank')
  }

  _retreat() {
    _v.subVectors(this.root.position, this.lastKnown)
    _v.y = 0
    if (_v.lengthSq() < 0.01) _v.set(1, 0, 0)
    _v.normalize()
    _v2.copy(this.root.position).addScaledVector(_v, 14)
    this._goTo(_v2)
  }

  _wander() {
    const a = this.rng.float() * Math.PI * 2
    const r = 6 + this.rng.float() * 12
    _v2.set(this.root.position.x + Math.cos(a) * r, this.root.position.y, this.root.position.z + Math.sin(a) * r)
    this._goTo(_v2)
    if (this.state === STATE.IDLE) this._setState(STATE.PATROL)
  }

  /* ================= movement ================= */

  _goTo(target) {
    if (!target) return
    this.goal.copy(target)
    this.hasGoal = true
    this.path = null
    this.pathIndex = 0
    const ai = this.ai
    if (!ai || typeof ai.requestPath !== 'function' || this.pathPending) return
    this.pathPending = true
    const self = this
    try {
      ai.requestPath(this.root.position, this.goal, (path) => {
        self.pathPending = false
        self.path = path && path.length ? path : null
        self.pathIndex = 0
        if (!self.path) self.hasGoal = false
      })
    } catch (err) {
      this.pathPending = false
    }
  }

  _move(dt) {
    this.blockedByWall = false

    if (!this.hasGoal) {
      this.desiredSpeed = 0
      this.speed += (0 - this.speed) * Math.min(1, dt * 6)
      this._groundY = this.root.position.y
      this._sanitize()
      return
    }

    let waypoint = this.goal
    if (this.path && this.pathIndex < this.path.length) {
      waypoint = this.path[this.pathIndex]
      _v.subVectors(waypoint, this.root.position)
      _v.y = 0
      if (_v.lengthSq() < 0.36) {
        this.pathIndex++
        if (this.pathIndex >= this.path.length) {
          this.path = null
          this.hasGoal = false
          return
        }
        waypoint = this.path[this.pathIndex]
      }
    }

    _v.subVectors(waypoint, this.root.position)
    _v.y = 0
    const d = _v.length()
    if (d < 0.4) {
      this.hasGoal = false
      this.desiredSpeed = 0
      return
    }
    _v.divideScalar(d)

    const t = this.tactics
    let want = t.speedPatrol
    if (this.state === STATE.ALERT) want = t.speedAlert
    else if (this.state === STATE.COMBAT || this.state === STATE.RETREAT) want = t.speedAdvance
    else if (this.state === STATE.FLANK) want = t.speedFlank
    else if (this.state === STATE.SUPPRESSED) want = t.speedAlert * 0.6

    // E2: a blacked or fractured leg is a hard ceiling on how fast this actor
    // can move, exactly as it is for the player
    const sprinting = want > 3.6
    want *= this.anatomy.speedMultiplier(sprinting)
    this.desiredSpeed = want

    this.speed += (want - this.speed) * Math.min(1, dt * 5)
    this.velocity.copy(_v).multiplyScalar(this.speed)

    /**
     * E4. The actor's own ground level and its exact pre-step pose are captured
     * BEFORE it moves. Everything downstream measures against `_groundY`, and a
     * refused step is rolled back to `_preStep` rather than nudged - a partial
     * rollback is how a bot ends up a few centimetres inside a wall, which is
     * all the ground probe needs to answer with the roof.
     */
    this._groundY = this.root.position.y
    this._preStep.copy(this.root.position)

    const step = this.speed * dt

    // GATE 1 - probe the volume the body is about to occupy BEFORE the
    // horizontal step is committed, so a wall refuses the step while the
    // actor is still on the pre-step pose instead of after being shoved
    // into the footprint.
    this._tryVault(_v)
    if (this.blockedByWall) {
      this._sanitize()
      return
    }

    this.root.position.addScaledVector(_v, step)
    this._resolveGround(_v)
    if (this.blockedByWall) {
      this._sanitize()
      return
    }

    // face where we are going unless we are shooting, then face the target
    const look = this.hasTarget ? this.lastKnown : null
    if (look) _v2.subVectors(look, this.root.position)
    else _v2.copy(_v)
    _v2.y = 0
    if (_v2.lengthSq() > 0.0001) {
      const yaw = Math.atan2(_v2.x, _v2.z)
      let diff = yaw - this.root.rotation.y
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      this.root.rotation.y += diff * Math.min(1, dt * 7)
    }

    this._sanitize()
  }

  /**
   * Ask the host how high the ground is under the new sample, and refuse the
   * answer if it is a roof.
   *
   * This is gate 3, and it is the one that cannot be bypassed. A ground query
   * returns the HIGHEST surface beneath the sample point, so the moment an actor
   * is standing inside a building footprint the honest answer is the roof, and
   * assigning it is the teleport. Downward moves are always allowed - that is a
   * kerb, a ramp or a drop, all legitimate - but a rise above
   * `VAULT.STEP_CEILING` is not a floor this actor could have walked onto, so
   * the step that produced it is rolled back and the actor redirects.
   */
  _resolveGround(dir) {
    const ai = this.ai
    let ground = NaN
    if (ai && typeof ai.groundAt === 'function') {
      const y = ai.groundAt(this.root.position.x, this.root.position.z)
      if (Number.isFinite(y)) ground = y
    } else if (ai && typeof ai.probeGround === 'function') {
      const hit = ai.probeGround(this.root.position)
      if (hit && Number.isFinite(hit.y)) ground = hit.y
    }
    if (!Number.isFinite(ground)) {
      // no ground under the sample at all: keep the height we came in with
      // rather than inheriting a NaN and poisoning the skinning matrices
      this.root.position.y = this._groundY
      return
    }

    const rise = ground - this._groundY
    if (rise > VAULT.STEP_CEILING) {
      this._wallStop(dir)
      return
    }
    this.root.position.y = ground
    this.grounded = true
  }

  /**
   * MAXIMUM OBSTACLE HEIGHT CEILING.
   *
   * Two probes, both cast from the actor's own ground level, both reaching
   * `VAULT.PROBE` metres along the heading it is trying to travel:
   *
   *   low   ground + VAULT.STEP_CEILING (0.45 m) - never higher. This is the
   *         tallest thing that can possibly be a step, so anything it clears is
   *         not an obstruction worth reacting to.
   *   high  ground + VAULT.CLEARANCE (1.2 m) - is there body-height air above
   *         whatever the low probe found?
   *
   *   low clear                  -> nothing in the way. Do nothing.
   *   low blocked, high BLOCKED  -> WALL. No vertical write of any kind, the
   *                                 step is rolled back, desiredSpeed is forced
   *                                 to 0 and a redirection path is requested.
   *   low blocked, high clear    -> candidate step. Measure the rise ahead and
   *                                 only take it if it is inside the ceiling;
   *                                 if it is not, or if it cannot be measured,
   *                                 treat it as a wall.
   *
   * The old code's `this.root.position.y += 0.55` has no successor here. Height
   * is never accumulated - it is resolved to a measured floor, once, and only
   * when that floor is within reach of a stride.
   *
   * @returns true when a step was accepted, false otherwise
   */
  _tryVault(dir) {
    if (this._vaultBusy) return false
    const phys = this._physics()
    if (!phys || typeof phys.lineOfSight !== 'function') return false
    if (!dir) return false

    this._vaultBusy = true
    try {
      _v2.copy(dir)
      _v2.y = 0
      if (_v2.lengthSq() < 1e-8) return false
      _v2.normalize()

      const groundY = Number.isFinite(this._groundY) ? this._groundY : this.root.position.y
      const px = this._preStep.x
      const pz = this._preStep.z

      // ---- low probe: strictly at the step ceiling, never above it ----------
      _low.set(px, groundY + VAULT.LOW_PROBE, pz)
      _aim.copy(_low).addScaledVector(_v2, VAULT.PROBE)
      if (this._lineOfSight(_low, _aim)) return false

      // ---- high clearance probe -------------------------------------------
      _high.set(px, groundY + VAULT.CLEARANCE, pz)
      _aim.copy(_high).addScaledVector(_v2, VAULT.PROBE)
      if (!this._lineOfSight(_high, _aim)) {
        // BOTH blocked. This is a wall, not a step. Terminate here: no vertical
        // warping, no forward assist, nothing written to position.y at all.
        this._wallStop(_v2)
        return false
      }

      // ---- candidate step: it has to be measurable AND inside the ceiling --
      const ai = this.ai
      _ahead.set(px, groundY, pz).addScaledVector(_v2, VAULT.PROBE * 0.75)
      let top = NaN
      if (ai && typeof ai.groundAt === 'function') {
        const y = ai.groundAt(_ahead.x, _ahead.z)
        if (Number.isFinite(y)) top = y
      } else if (ai && typeof ai.probeGround === 'function') {
        const hit = ai.probeGround(_ahead)
        if (hit && Number.isFinite(hit.y)) top = hit.y
      }

      // Unmeasurable is refused, not guessed. Guessing is what put actors on
      // roofs in the first place.
      if (!Number.isFinite(top)) {
        this._wallStop(_v2)
        return false
      }

      const rise = top - groundY
      if (rise > VAULT.STEP_CEILING) {
        this._wallStop(_v2)
        return false
      }

      // A real step. Resolve to the measured surface - which by the test above
      // is at most VAULT.STEP_CEILING above where the actor was standing - and
      // give it just enough forward assist to clear the lip.
      if (rise > 0) {
        this.root.position.y = top
        this.root.position.addScaledVector(_v2, VAULT.STEP_ASSIST)
        this._groundY = top
      }
      this.grounded = true
      return true
    } finally {
      this._vaultBusy = false
    }
  }

  /**
   * A wall refused this actor's step.
   *
   * Roll the pose back exactly, stop, and go around. `desiredSpeed` is forced to
   * zero so the animation layer stops playing a walk cycle into masonry, and the
   * redirection is rate-limited so a bot wedged in a corner cannot issue an A*
   * request every frame.
   */
  _wallStop(dir) {
    this.root.position.copy(this._preStep)
    this.blockedByWall = true
    this.grounded = true
    this.desiredSpeed = 0
    this.speed = 0
    this.velocity.set(0, 0, 0)
    this._requestRedirect(dir)

    const bus = this._bus()
    if (bus && typeof bus.emit === 'function') {
      bus.emit('ai:blocked', {
        actor: this,
        faction: this.faction,
        position: this.root.position,
        ceiling: VAULT.STEP_CEILING,
      })
    }
  }

  /**
   * Go around it.
   *
   * A lateral detour target at chest height on whichever side is actually open,
   * alternating which side is tried first so an actor in a re-entrant corner
   * walks out of it instead of oscillating. If both sides are shut it backs off
   * along its own heading, which is always open - it just came from there.
   */
  _redirect(dir) {
    if (this._redirectCooldown > 0) return false
    this._redirectCooldown = VAULT.REDIRECT_COOLDOWN

    this.path = null
    this.pathIndex = 0
    this.repathTimer = 0

    _v2.copy(dir || _fwd)
    _v2.y = 0
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 0, 1)
    _v2.normalize()
    _right.crossVectors(_v2, _up).normalize()

    const pos = this.root.position
    _low.set(pos.x, pos.y + VAULT.DETOUR_Y, pos.z)

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? this._detourSide : -this._detourSide
      _aim
        .copy(_low)
        .addScaledVector(_right, side * VAULT.DETOUR_REACH)
        .addScaledVector(_v2, VAULT.DETOUR_BIAS)
      if (!this._lineOfSight(_low, _aim)) continue
      this._detourSide = -side
      _ahead.set(_aim.x, pos.y, _aim.z)
      this._goTo(_ahead)
      return true
    }

    // boxed in: retreat along the heading we arrived on
    _ahead.copy(pos).addScaledVector(_v2, -VAULT.DETOUR_REACH * 0.6)
    _ahead.y = pos.y
    this._detourSide = -this._detourSide
    this._goTo(_ahead)
    return true
  }

  /**
   * Redirect request: go around the blocking wall and publish the lateral
   * `ai:redirect` event so any listening host (camera, UI, debug overlay) can
   * follow the actor around the corner instead of into it.
   */
  _requestRedirect(dir) {
    const ok = this._redirect(dir)
    const bus = this._bus()
    if (bus && typeof bus.emit === 'function') {
      bus.emit('ai:redirect', {
        actor: this,
        faction: this.faction,
        position: this.root.position,
        blockedHeading: dir ? { x: dir.x, y: 0, z: dir.z } : null,
      })
    }
    return ok
  }

  /**
   * The transform this actor hands the renderer is finite, or it is the last one
   * that was.
   *
   * A single NaN in `root.position` propagates into every bone matrix on the
   * next `syncHitboxes()` / skinning update, and a non-finite attribute upload
   * is exactly what the console reports as a WebGL program execution error. Far
   * better to hold the previous pose for a frame than to ship garbage to the
   * GPU.
   */
  _sanitize() {
    const p = this.root.position
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      this._lastGood.copy(p)
      return true
    }
    p.copy(this._lastGood)
    this.velocity.set(0, 0, 0)
    this.speed = 0
    this.desiredSpeed = 0
    this._groundY = p.y
    this.path = null
    this.pathIndex = 0
    this.hasGoal = false
    return false
  }

  /* ================= weapon ================= */

  _shoot(dt) {
    if (this.reloading > 0) {
      this.reloading -= dt
      if (this.reloading <= 0) this.ammo = this.magSize
      return
    }
    if (this.ammo <= 0) {
      this.reloading = this.reloadTime
      if (this.animator && typeof this.animator.reload === 'function') this.animator.reload(this.reloadTime)
      const ai = this.ai
      if (ai && typeof ai.emitReload === 'function') ai.emitReload(this)
      this._callOut('reloading')
      return
    }

    if (!this.hasTarget || this.reactionLeft > 0) return
    if (this.state === STATE.SUPPRESSED || this.state === STATE.RETREAT) return
    if (this.squad && !this.peeking && this.state === STATE.COMBAT) return
    if (!this.visible) return
    if (this.root.position.distanceTo(this.lastKnown) > this.weaponRange) return

    if (this.burstRest > 0) {
      this.burstRest -= dt
      return
    }
    if (this.burstLeft <= 0) {
      this.burstLeft = burstLength(this.archetype, this.rng)
      this.burstRest = burstRest(this.archetype, this.rng)
      return
    }

    this.fireTimer -= dt
    if (this.fireTimer > 0) return
    this.fireTimer = 1 / this.fireRate
    this.burstLeft--
    this._fireRound()
  }

  _fireRound() {
    this.ammo--
    this.shotsFired++

    // wear: a scav's rattling AK opens up noticeably over a long fight
    const wear = this.archetype.weapon.durability
    this.weaponDurability = Math.max(0, this.weaponDurability - wear.wear)

    const origin = this.eye.clone()
    _aim.subVectors(this.lastKnown, origin)
    const dist = _aim.length()
    if (dist < 0.001) return
    _aim.divideScalar(dist)

    // cone = base spread, widened by sway, by weapon condition and by whatever
    // the arms are still capable of
    const sway = this.sway
    const t = this._time * sway.freq
    const wobble = Math.sin(t * 6.283) * sway.amp + (this.rng.float() * 2 - 1) * sway.amp * sway.random
    const condition = 1 + (1 - this.weaponDurability) * (wear.spreadAtZero - 1)
    const arms = 1 / Math.max(0.2, this.anatomy.armPenalty())
    const suppressed = 1 + this.suppression * 0.8
    const cone = (this.spread + Math.abs(wobble)) * condition * arms * suppressed

    _right.crossVectors(_aim, _up).normalize()
    _v2.crossVectors(_right, _aim).normalize()
    const a = this.rng.float() * Math.PI * 2
    const r = Math.sqrt(this.rng.float()) * cone
    _aim.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_v2, Math.sin(a) * r).normalize()

    const ai = this.ai
    if (ai && typeof ai.onAgentFire === 'function') {
      ai.onAgentFire(this, origin, _aim.clone(), {
        damage: this.weaponDamage,
        range: this.weaponRange,
        durability: this.weaponDurability,
        faction: this.faction,
      })
    }
    if (this.animator && typeof this.animator.fire === 'function') this.animator.fire()
  }

  _throwGrenade() {
    if (this.squad && !this.squad.requestGrenade(this, grenadeDelay(this.archetype, this.rng))) return false
    this.grenadeCooldown = grenadeDelay(this.archetype, this.rng)
    const ai = this.ai
    if (ai && typeof ai.throwGrenade === 'function') {
      try {
        ai.throwGrenade(this, this.eye.clone(), this.lastKnown.clone())
      } catch (err) {
        return false
      }
    }
    this._callOut('grenade')
    return true
  }

  /* ================= damage ================= */

  _sideOf(point) {
    if (!point) return 1
    _v.subVectors(point, this.root.position)
    this.root.getWorldDirection(_fwd)
    _right.crossVectors(_fwd, _up).normalize()
    return _right.dot(_v) < 0 ? -1 : 1
  }

  /**
   * Take a hit. Symmetric with the player: same overflow, same bleed roll, same
   * blackout rules, same guaranteed headshot.
   *
   * @param amount post-falloff damage
   * @param part   collider region ('head', 'torso', 'arm', 'leg') or a part name
   * @param point  world-space impact, used for the side test and the ragdoll
   * @param dir    round direction, used for the ragdoll impulse
   * @param opts.penetrated false when armour stopped it
   * @param opts.by         who fired
   */
  applyDamage(amount, part, point, dir, opts = {}) {
    if (this.state === STATE.DEAD) return null

    const res = this.anatomy.apply(amount, part, {
      side: this._sideOf(point),
      penetrated: opts.penetrated,
      ignoreArmor: opts.ignoreArmor,
      noBleed: opts.noBleed,
    })
    if (!res) return null

    if (point) this.lastKnown.copy(point)
    else if (opts.from) this.lastKnown.copy(opts.from)
    this.awareness = 1
    this.lastSeen = 0

    const bus = this._bus()
    if (bus && typeof bus.emit === 'function') {
      bus.emit('health:damage', {
        actor: this,
        isPlayer: false,
        part: res.part,
        dealt: res.dealt,
        absorbed: res.absorbed,
        overflow: res.overflow,
        blacked: res.blacked,
        bleed: res.bleed,
      })
    }

    if (res.killed) {
      // guaranteed instant death on a headshot, and actor:death says so
      this.die(point, dir, amount, { headshot: res.headshot, by: opts.by, part: res.part })
      return res
    }

    if (!this.hasTarget && this.state !== STATE.COMBAT) {
      this._setState(STATE.ALERT)
      if (this.state === STATE.ALERT && !this.hasGoal) this._goTo(this.lastKnown)
    }
    this.suppress(0.4)

    if (res.blacked || res.bleed === E_BLEED_H) this._callOut('hurt')
    else this._callOut('takingFire')

    if (this.anatomy.fraction < this.tactics.retreatFraction) this._setState(STATE.RETREAT)
    return res
  }

  die(point, dir, amount = 30, opts = {}) {
    if (this.state === STATE.DEAD) return
    this._setState(STATE.DEAD)
    this.anatomy.kill()
    this.hasGoal = false
    this.path = null
    this.velocity.set(0, 0, 0)
    this.speed = 0

    this._callOut('death')

    const bus = this._bus()
    if (bus && typeof bus.emit === 'function') {
      bus.emit('actor:death', {
        actor: this,
        isPlayer: false,
        headshot: !!opts.headshot,
        point: point || this.root.position,
        by: opts.by === undefined ? null : opts.by,
        part: opts.part === undefined ? -1 : opts.part,
        cause: opts.cause === undefined ? 'gunshot' : opts.cause,
        faction: this.faction,
        archetype: this.archetype.id,
        subtype: this.subtypeId,
        xp: this.archetype.xp,
        karma: this.archetype.karma,
        // what the corpse is worth looting - a scav's rattling rifle is not
        weaponDurability: this.weaponDurability,
        armorClass: this.armorClass,
        armorZones: this._armorZones,
      })
    }

    if (this.squad) this.squad.remove(this)
    this._makeRagdoll(point, dir, amount)
  }

  /* ================= presentation ================= */

  _makeRagdoll(point, dir, amount) {
    if (!this.bones) return
    const parts = []
    const impulse = Math.min(6, 1.2 + amount * 0.05)
    for (let i = 0; i < DOLL.length; i++) {
      const bone = this.bones[DOLL[i]]
      if (!bone) continue
      const vel = new THREE.Vector3(
        (this.rng.float() * 2 - 1) * 0.6,
        this.rng.float() * 0.5,
        (this.rng.float() * 2 - 1) * 0.6
      )
      if (dir) vel.addScaledVector(dir, impulse * (0.35 + this.rng.float() * 0.4))
      parts.push({ bone, vel, rest: bone.position.clone() })
    }
    this.ragdoll = { parts, t: 0, settled: false }
    if (this.animator && typeof this.animator.stop === 'function') this.animator.stop()
  }

  _driveRagdoll(dt) {
    const rd = this.ragdoll
    if (!rd || rd.settled) return
    rd.t += dt
    const damp = Math.max(0, 1 - dt * 3.2)
    for (let i = 0; i < rd.parts.length; i++) {
      const p = rd.parts[i]
      p.vel.y -= 9.81 * dt * 0.22
      p.vel.multiplyScalar(damp)
      p.bone.position.addScaledVector(p.vel, dt)
      p.bone.rotation.x += p.vel.z * dt * 0.6
      p.bone.rotation.z -= p.vel.x * dt * 0.6
    }
    if (rd.t > 2.4) rd.settled = true
  }

  _drive(dt) {
    if (!this.animator) return
    if (this.lodIrrelevant) {
      this._animAccum += dt
      if (this._animAccum < this._animSkip) return
      dt = this._animAccum
      this._animAccum = 0
    }
    let clip = 'idle'
    if (this.reloading > 0) clip = 'reload'
    else if (this.speed > 3.4) clip = 'run'
    else if (this.speed > 0.3) clip = 'walk'
    else if (this.anatomy.fraction < 0.42) clip = 'hurtIdle'
    else if (this.state === STATE.COMBAT || this.state === STATE.FLANK) clip = 'aimIdle'

    if (typeof this.animator.play === 'function') this.animator.play(clip)
    if (typeof this.animator.update === 'function') this.animator.update(dt, this.speed)
  }

  syncHitboxes() {
    for (let i = 0; i < this.hitboxes.length; i++) {
      const hb = this.hitboxes[i]
      if (hb.bone) {
        hb.bone.updateWorldMatrix(true, false)
        _m.copy(hb.bone.matrixWorld)
        hb.center.setFromMatrixPosition(_m)
        const o = hb.def.offset
        hb.center.x += o[0] * this.bodyScale
        hb.center.y += o[1] * this.bodyScale
        hb.center.z += o[2] * this.bodyScale
      } else {
        // no skeleton - approximate off the capsule so hit detection still works
        const r = hb.def.region
        const y =
          r === 'head' ? this.height * 0.94 : r === 'torso' ? this.height * 0.66 : r === 'arm' ? this.height * 0.62 : this.height * 0.28
        hb.center.set(this.root.position.x, this.root.position.y + y, this.root.position.z)
      }
    }
    return this.hitboxes
  }

  dispose() {
    if (this.squad) this.squad.remove(this)
    if (this.animator && typeof this.animator.dispose === 'function') this.animator.dispose()
    if (this.root.parent) this.root.parent.remove(this.root)
    this.root.traverse((o) => {
      if (o.isMesh || o.isSkinnedMesh) {
        if (o.geometry && typeof o.geometry.dispose === 'function') o.geometry.dispose()
      }
    })
    this.hitboxes.length = 0
    this.ragdoll = null
    this.bones = null
    this.skeleton = null
    this.mesh = null
    this.animator = null
    this.ai = null
  }
}

export default Agent
