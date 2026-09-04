/**
 * Agent - one AI actor.
 *
 * Three things changed in this file and they are worth stating plainly.
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

let _nextId = 1

const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _aim = new THREE.Vector3()
const _up = new THREE.Vector3(0, 1, 0)
const _m = new THREE.Matrix4()

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
     * Visual only. `ai.variant()` keys the soldier build off this string and
     * existing map spawns still pass 'vanguard' / 'irregular', so the mesh a
     * spawn point produces is unchanged. Nothing branches on it.
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

    this.lodIrrelevant = false
    this._animSkip = 0
    this._animAccum = 0

    /* ---- scene ---- */

    this.root = new THREE.Group()
    this.root.name = 'agent:' + this.id + ':' + this.faction
    if (opts.position) this.root.position.copy(opts.position)
    if (Number.isFinite(opts.yaw)) this.root.rotation.y = opts.yaw

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

  _buildBody() {
    const ai = this.ai
    const built = ai && typeof ai.variant === 'function' ? ai.variant(this.variantName, this.rng) : null
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
    if (!this.hasGoal) {
      this.desiredSpeed = 0
      this.speed += (0 - this.speed) * Math.min(1, dt * 6)
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

    const step = this.speed * dt
    this.root.position.addScaledVector(_v, step)
    this._tryVault(_v)

    const ai = this.ai
    if (ai && typeof ai.groundAt === 'function') {
      const y = ai.groundAt(this.root.position.x, this.root.position.z)
      if (Number.isFinite(y)) this.root.position.y = y
    } else if (ai && typeof ai.probeGround === 'function') {
      const hit = ai.probeGround(this.root.position)
      if (hit && Number.isFinite(hit.y)) this.root.position.y = hit.y
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
  }

  _tryVault(dir) {
    const phys = this._physics()
    if (!phys || typeof phys.lineOfSight !== 'function') return false
    _v2.copy(this.root.position)
    _v2.y += 0.35
    _aim.copy(_v2).addScaledVector(dir, 0.9)
    if (this._lineOfSight(_v2, _aim)) return false
    // low obstruction, clear above it - step up rather than stall
    _v2.y = this.root.position.y + 1.15
    _aim.copy(_v2).addScaledVector(dir, 0.9)
    if (!this._lineOfSight(_v2, _aim)) return false
    this.root.position.y += 0.55
    this.root.position.addScaledVector(dir, 0.35)
    return true
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