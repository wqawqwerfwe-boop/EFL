/**
 * PLAYER — movement state machine, camera feel, tactical health bridge.
 *
 * WHAT LIVES HERE
 *   movement.js   the state machine: stand/crouch/prone/sprint/tacsprint/slide/
 *                 jump/fall/mantle/vault (+ lean). 120 Hz, fully interruptible.
 *   camera.js     bob, landing dip, step shift, strafe/turn roll, breathing
 *                 sway, recoil + weapon kick channels, trauma shake, FOV.
 *   mantle.js     ledge detection via physics capsule sweeps + the rooted climb.
 *   lowhealth.js  the low-health screen treatment, registered with `render`.
 *   tuning.js     every number, with the CoD values it was calibrated against.
 *   springs.js    spring/damper + easing maths.
 *
 * Collision is *never* computed here — everything goes through
 * `physics.createCharacter()` capsule sweeps.
 *
 * HEALTH LIVES IN src/health/index.js — NOT HERE.
 *
 * There used to be a second, player-local model: ./health.js, a single 0..100
 * arcade pool with a passive CoD regeneration loop. It is gone, and with it the
 * situation where two independent models both believed they owned the player's
 * HP — one of them quietly handing it back a few seconds after every firefight.
 * `HealthSystem` is the single authority: seven limbs, each with its own HP and
 * effect bitfield, no passive regen, HP returned only by meds. THIS FILE OWNS
 * NO HP.
 *
 * What it still owns is the *view* half of being shot — suppression, the
 * directional damage arcs, trauma and the flinch — because that is all camera
 * and screen space, and a simulation system has no business holding it.
 *
 * The system is resolved LAZILY through ctx.peek('health') and cached. 'health'
 * is deliberately absent from static deps: the dev harnesses (feeltest.mjs, the
 * shot harness) boot `player` with no HealthSystem registered at all, and
 * ctx.get() throws for an unregistered id. Every read below therefore tolerates
 * a missing system.
 *
 * PUBLIC API — `const p = ctx.get('player')`
 *
 * TRANSFORM
 *   p.position        Vector3, FEET (bottom of the capsule), interpolated
 *   p.eyePosition     Vector3, the composed camera position
 *   p.velocity        Vector3, m/s
 *   p.forward         Vector3, unit view forward
 *   p.yaw / p.pitch   radians (yaw is the movement basis, camera adds feel)
 *   p.speed / p.horizontalSpeed
 *   p.character       the physics CharacterController (read-only)
 *   p.height          capsule height of the current stance
 *   p.hitbox          physics collider on LAYER.PLAYER
 *
 * STATE
 *   p.state           'stand'|'crouch'|'prone'|'sprint'|'tacsprint'|'slide'|
 *                     'jump'|'fall'|'mantle'|'vault'|'lean'
 *   p.stance          'stand'|'crouch'|'prone'
 *   p.sprinting  p.tacticalSprint  p.sliding  p.grounded  p.airborne
 *   p.mantling   p.leanAmount (-1..1)   p.slideProgress (0..1)
 *
 * AIM
 *   p.adsRequested            true while the aim button is held
 *   p.adsProgress             0..1 blend actually in use
 *   p.setAdsProgress(v)       `weapons` owns the real curve
 *
 * CAMERA FEEL (for `weapons`, `fx`, `ai`)
 *   p.addRecoil(pitch, yaw, roll, punch)   camera-owned recoil impulse (radians)
 *   p.addKick(pitch, yaw, roll)            independent weapon kick channel
 *   p.addTrauma(a)                         0..1 noise shake
 *   p.viewKick                             { pitch, yaw, roll, punch }
 *   p.cameraRig                            the rig, for the raw springs
 *
 * HEALTH — every one of these forwards to `HealthSystem`
 *   p.health              the HealthSystem itself, or null in a harness
 *   p.healthTotal  p.maxHealth  p.healthFraction  p.lowHealth  p.dead
 *   p.getHudState()       seven-limb arrays; see below
 *   p.applyDamage(amount, partOrFromVector3, opts)
 *   p.heal(amount, part)
 *   p.suppression  p.damageIndicators  p.heartbeatPulse  p.addSuppression(a)
 *
 * CONTROL
 *   p.setControlEnabled(bool)     shot harness / cutscenes
 *   p.teleport(eyePosition, rotationEulerOrYaw)
 *   p.respawn(index)
 *   p.debugState(name)            'sprint'|'slide'|'crouch'|'hurt'|'critical'|
 *                                 'air'|'reset'
 *
 * EVENTS EMITTED
 *   player:state      { stance, sprinting, sliding, ads, state, grounded, ... }
 *   player:land       { velocity, surface, position }
 *   player:footstep   { position, surface, running, left, speed, stance }
 *   damage:taken      { amount, from, part, partIndex, health, direction }
 *   player:death      { position, by }   bridged from HealthSystem's health:death
 *   player:mantle     { kind, height }
 *   player:jump       { position }
 *   player:heartbeat  emitted by lowhealth.js, not here
 *   The old player:health is gone: subscribe to health:tick / health:changed /
 *   health:damage on the health bus instead.
 */

import * as THREE from 'three'
import { Movement } from './movement.js'
import { CameraRig } from './camera.js'
import { LowHealthPass } from './lowhealth.js'
import { STANCE, MOVE, CAMERA, HEALTH, FOOTSTEP, JUMP_SPEED } from './tuning.js'
import { clamp, clamp01, lerp, approach, DEG } from './springs.js'
import { PARTS, PART_INDEX, partIndexOf, E_BLEED_L, E_BLEED_H, E_FRACTURE } from '../health/index.js'

export class PlayerSystem {
  static id = 'player'
  static deps = ['physics', 'world', 'render']

  constructor() {
    /** Lets `ai` / `physics` recognise the local player from an owner pointer. */
    this.isPlayer = true
    this.movement = null
    this.rig = null
    this.lowHealthPass = null
    this.hitbox = null
    /** Cached HealthSystem. Never assigned directly — see the `health` getter. */
    this._health = null

    this.controlEnabled = true
    this.adsAmount = 0
    this._adsExternal = false
    this._adsExternalAge = 0
    this.adsRequested = false

    this._lookFrame = -1
    this._prevYaw = 0

    /* ---- the view half of being shot, owned here --------------------------
     * Suppression is a camera-sway and reticle input, and the indicators are a
     * screen-space arc. Neither is limb state, so neither lives in
     * HealthSystem. Fixed-size ring, sized by tuning, never reallocated. */
    this.suppression = 0
    this.indicators = []
    for (let i = 0; i < HEALTH.indicatorMax; i++) {
      this.indicators.push({ active: false, angle: 0, strength: 0, time: -99 })
    }
    this._lastIndicatorAngle = 0

    // preallocated event payloads
    this._statePayload = {
      stance: 'stand', sprinting: false, sliding: false, ads: false,
      state: 'stand', grounded: true, airborne: false, mantling: false,
      lean: 0, speed: 0, health: 0, healthFraction: 1, crouched: false,
    }
    this._landPayload = { velocity: 0, surface: 'concrete', position: new THREE.Vector3() }
    this._stepPayload = {
      position: new THREE.Vector3(), surface: 'concrete', running: false,
      left: false, speed: 0, stance: 'stand',
    }
    this._mantlePayload = { kind: 'none', height: 0 }
    this._jumpPayload = { position: new THREE.Vector3() }
    this._damagePayload = {
      amount: 0, from: null, part: 'thorax', partIndex: 1,
      health: 0, fraction: 1, direction: 0,
    }
    this._deathPayload = { position: new THREE.Vector3(), by: null }

    /* The three fields camera.js reads off a "health" argument. Filled from the
     * limb model every frame so camera.js needs no change. */
    this._camHealth = { fraction: 1, low: false, suppression: 0 }

    /* Bone capsule handed to the tactical skeleton by _syncHitbox(). */
    this._boneCapsule = {
      x0: 0, y0: 0, z0: 0, x1: 0, y1: 0, z1: 0,
      radius: 0.3, base: 0, height: STANCE.stand.height, stance: 'stand',
    }

    /* Preallocated HUD snapshot polled by `ui`. Seven-limb arrays, index
     * aligned with PARTS — no arcade health/maxHealth/regen triple. */
    this._hudState = {
      parts: PARTS,
      hp: new Float32Array(PARTS.length),
      max: new Float32Array(PARTS.length),
      ratio: new Float32Array(PARTS.length),
      effects: new Uint8Array(PARTS.length),
      blacked: 0, fractures: 0, bleedLight: 0, bleedHeavy: 0,
      health: 0, maxHealth: 0, fraction: 1, dead: false,
      energy: 100, hydration: 100, stamina: 100, pain: 0,
      move: 0, sprint: false, crouch: false, ads: false, airborne: false,
      suppression: 0, position: null,
    }

    this._tmp = new THREE.Vector3()
    /** Last emitted discrete state, compared field-wise so no string is built. */
    this._prev = {
      state: '', stance: '', sprinting: false, tacticalSprint: false,
      sliding: false, grounded: true, ads: false, mantling: false,
    }
    this._offEvents = []
  }

  /* ==================================================================== */
  /* health resolution                                                    */
  /* ==================================================================== */

  /**
   * The tactical health system, or null.
   *
   * Lazy and cached: HealthSystem declares deps ['items', 'inventory'] and this
   * system declares neither it nor them, so registry order is not guaranteed to
   * have built it by the time player.init() runs. peek() never throws, get()
   * would.
   */
  get health() {
    if (this._health) return this._health
    const ctx = this.ctx
    if (!ctx) return null
    this._health = (typeof ctx.peek === 'function' ? ctx.peek('health') : null) ?? null
    return this._health
  }

  /* ==================================================================== */
  /* init                                                                 */
  /* ==================================================================== */

  async init(ctx) {
    this.ctx = ctx
    this.physics = ctx.get('physics')
    this.rng = ctx.rng.fork()

    this.movement = new Movement(ctx, this)
    this.rig = new CameraRig(ctx)
    // Warm the cache if the health system is already up; the getter retries.
    this._health = (typeof ctx.peek === 'function' ? ctx.peek('health') : null) ?? null

    // ---- spawn -----------------------------------------------------------
    const spawn = this._resolveSpawn()
    this.movement.init(this.physics, spawn.feet)
    this.movement.yaw = spawn.yaw
    this.movement.pitch = 0
    this._prevYaw = spawn.yaw
    this.rig.reset(STANCE.stand.eye)
    this.rig.update(1 / 60, this.movement, this._syncCamHealth())
    this.rig.applyTo(ctx.camera)

    // ---- hitbox ----------------------------------------------------------
    // A capsule on the PLAYER layer so `ai` has something to shoot at. PLAYER is
    // deliberately absent from MASK.BULLET and MASK.CHARACTER, so it can never
    // be hit by the player's own muzzle ray and never blocks the player's own
    // movement sweeps: an AI that wants to hit us traces with
    //   phys.MASK.BULLET | phys.LAYER.PLAYER
    this.hitbox = this.physics.addCollider({
      shape: 'capsule',
      layer: this.physics.LAYER.PLAYER,
      surface: 'flesh',
      owner: this,
      part: 'torso',
      radius: 0.3,
    })
    this._syncHitbox()

    // ---- low-health treatment -------------------------------------------
    const render = ctx.peek('render')
    if (render?.registerPass) {
      this.lowHealthPass = new LowHealthPass()
      this._unregisterPass = render.registerPass(this.lowHealthPass)
    }

    // ---- incoming damage / suppression / death --------------------------
    const on = (type, fn) => this._offEvents.push(ctx.events.on(type, fn))
    on('damage:dealt', (e) => this._onDamageDealt(e))
    on('explosion', (e) => this._onExplosion(e))
    on('bullet:impact', (e) => this._onBulletImpact(e))
    on('health:death', (e) => this._onHealthDeath(e))

    console.info(
      `[player] spawn ${spawn.feet.x.toFixed(1)}, ${spawn.feet.y.toFixed(2)}, ` +
      `${spawn.feet.z.toFixed(1)} · walk ${STANCE.stand.speed} sprint ${MOVE.sprintSpeed} ` +
      `tac ${MOVE.tacSprintSpeed} m/s · jump ${JUMP_SPEED.toFixed(2)} m/s (apex 0.60 m) · ` +
      `health ${this._health ? 'limb model' : 'unattached'}`
    )
  }

  _resolveSpawn() {
    const world = this.ctx.peek('world')
    const out = { feet: new THREE.Vector3(0, 0.2, 0), yaw: 0 }
    const sp = world?.spawn?.(0)
    if (sp?.position) {
      out.feet.copy(sp.position)
      out.yaw = sp.yaw ?? 0
    }
    // Physics owns the exact floor; drop onto it so we never start embedded.
    const gy = this.physics.groundHeight(out.feet.x, out.feet.z, out.feet.y + 6)
    out.feet.y = Number.isFinite(gy) ? gy + 0.03 : out.feet.y + 0.2
    return out
  }

  /* ==================================================================== */
  /* look                                                                 */
  /* ==================================================================== */

  /**
   * Mouse/stick look is consumed once per rendered frame. It happens in the
   * first fixed step when there is one (so movement uses this frame's yaw with
   * zero latency) and in update() otherwise — above 120 fps a frame can contain
   * no fixed step at all and dropping the delta there would feel like a hitch.
   */
  _consumeLook(dt) {
    const frame = this.ctx.time.frame
    if (frame === this._lookFrame) return
    this._lookFrame = frame
    const m = this.movement
    if (!this.controlEnabled) {
      m.yawRate = 0
      return
    }
    const input = this.ctx.input
    const cfg = this.ctx.config
    const sens = lerp(1, cfg.adsSensScale, clamp01(this.adsAmount))

    let dYaw = -input.look.x * sens
    let dPitch = -input.look.y * sens

    // Gamepad: rate-based, already curved by Input.
    const stick = input.stick
    if (stick.lookX || stick.lookY) {
      const rate = 3.1 * sens // rad/s at full deflection
      dYaw -= stick.lookX * rate * dt
      dPitch -= stick.lookY * rate * dt
    }
    // Mantles are rooted: you keep your head, but the shoulders are committed.
    if (m.mantleMotion.active) {
      dYaw *= 0.55
      dPitch *= 0.55
    }

    m.yaw += dYaw
    m.pitch = clamp(m.pitch + dPitch, -CAMERA.pitchLimit, CAMERA.pitchLimit)
    // Keep yaw bounded so long sessions never lose float precision.
    if (m.yaw > Math.PI) m.yaw -= Math.PI * 2
    else if (m.yaw < -Math.PI) m.yaw += Math.PI * 2

    m.yawRate = dt > 1e-5 ? dYaw / dt : 0
    this._prevYaw = m.yaw
  }

  /* ==================================================================== */
  /* frame                                                                */
  /* ==================================================================== */

  fixedUpdate(h, ctx) {
    if (!this.movement) return
    this._consumeLook(ctx.time.dt > 1e-5 ? ctx.time.dt : h)
    this.movement.latchInput(ctx.time.frame)
    if (!this.controlEnabled) return
    this.movement.adsAmount = this.adsAmount
    this.movement.step(h)
  }

  update(dt, ctx) {
    if (!this.movement) return
    this._consumeLook(dt)
    this.movement.latchInput(ctx.time.frame)

    this._updateAds(dt)
    this._drainMovementEvents()
    /* HealthSystem is engine-registered and ticks itself — do NOT call its
     * update() from here. The old arcade pool was driven by this file, which is
     * precisely how it ended up owning HP nobody else could see. */
    this._decayViewDamage(dt)

    this.rig.update(dt, this.movement, this._syncCamHealth())
    if (this.controlEnabled) this.rig.applyTo(ctx.camera)
    else this.rig.forward.set(0, 0, -1).applyQuaternion(ctx.camera.quaternion)

    /* The pass pulls HealthSystem.vitals() itself; hand it the system (it also
     * accepts any ctx holder, hence the `?? this` fallback) plus this dt. */
    this.lowHealthPass?.sync(this.health ?? this, dt)
    this._syncHitbox()
    this._publishState()
  }

  /** Suppression bleed-off and indicator ageing. Screen state, not limb state. */
  _decayViewDamage(dt) {
    const S = HEALTH.suppression
    if (this.suppression > 0) this.suppression = Math.max(0, this.suppression - S.decay * dt)
    const now = this.ctx.time.elapsed
    const life = HEALTH.indicatorTime
    for (const ind of this.indicators) {
      if (!ind.active) continue
      const age = now - ind.time
      if (age >= life) {
        ind.active = false
        ind.strength = 0
        continue
      }
      ind.strength = 1 - age / life
    }
  }

  /** camera.js reads { fraction, low, suppression } off its health argument. */
  _syncCamHealth() {
    const h = this.health
    const c = this._camHealth
    c.fraction = h ? h.fraction : 1
    c.low = h ? h.low : false
    c.suppression = this.suppression
    return c
  }

  /**
   * Keep the AI-facing hitbox on the interpolated capsule — and hand that same
   * capsule to the tactical skeleton.
   *
   * HealthSystem resolves an unsolved hit from a world-space height, so it needs
   * the LIVE capsule: a stance change moves the head/thorax/stomach/leg splits
   * by more than half a metre, and resolving against a standing skeleton would
   * put a head shot in the stomach. One preallocated struct, copied in place, no
   * per-frame garbage.
   */
  _syncHitbox() {
    if (!this.hitbox) return
    const m = this.movement
    const p = m.renderPosition
    const r = 0.3
    const h = STANCE[m.stance].height
    const y0 = p.y + r
    const y1 = p.y + Math.max(r, h - r)
    this.hitbox.setSegment(p.x, y0, p.z, p.x, y1, p.z, r)
    this.hitbox.enabled = !this.dead

    const health = this.health
    if (typeof health?.syncSkeleton !== 'function') return
    const c = this._boneCapsule
    c.x0 = p.x
    c.y0 = y0
    c.z0 = p.z
    c.x1 = p.x
    c.y1 = y1
    c.z1 = p.z
    c.radius = r
    c.base = p.y
    c.height = h
    c.stance = m.stance
    health.syncSkeleton(c)
  }

  _updateAds(dt) {
    const input = this.ctx.input
    const m = this.movement
    this.adsRequested =
      this.controlEnabled && input.ads && !m.mantleMotion.active && !m.sliding && !this.dead

    if (this._adsExternal) {
      // `weapons` is driving the blend; stop trusting it if it goes quiet.
      this._adsExternalAge += dt
      if (this._adsExternalAge > 0.6) this._adsExternal = false
    }
    if (!this._adsExternal) {
      this.adsAmount = approach(this.adsAmount, this.adsRequested ? 1 : 0, 0.075, dt)
    }
    m.adsAmount = this.adsAmount
  }

  /** Turn the movement machine's one-shot flags into events + camera impulses. */
  _drainMovementEvents() {
    const m = this.movement

    if (m.landEvent.pending) {
      m.landEvent.pending = false
      const speed = m.landEvent.speed
      const mag = this.rig.onLand(speed)
      this._landPayload.velocity = speed
      this._landPayload.surface = m.landEvent.surface
      this._landPayload.position.copy(m.position)
      this.ctx.events.emit('player:land', this._landPayload)
      /* Fall damage lands on the LEGS, split between them, as it does in Tarkov:
       * a bad drop blacks a leg and costs you your sprint, it does not shave a
       * slice off a global pool. noBleed — a drop breaks bones, it does not
       * open an arterial bleed. */
      const L = CAMERA.land
      if (speed > L.damageSpeed) {
        const fall = (speed - L.damageSpeed) * L.damagePerSpeed
        this.applyDamage(fall * 0.5, 'lleg', { type: 'fall', noBleed: true })
        this.applyDamage(fall * 0.5, 'rleg', { type: 'fall', noBleed: true })
      }
      if (mag > 0.35) this.movement._footHold = FOOTSTEP.landHold
    }

    if (m.stepEvent.pending) {
      m.stepEvent.pending = false
      const e = this._stepPayload
      e.position.set(m.stepEvent.x, m.stepEvent.y, m.stepEvent.z)
      e.surface = m.stepEvent.surface
      e.running = m.stepEvent.running
      e.left = m.stepEvent.left
      e.speed = m.horizontalSpeed
      e.stance = m.stance
      this.rig.onFootstep(e.running, m.stance)
      this.ctx.events.emit('player:footstep', e)
    }

    if (m.jumped) {
      m.jumped = false
      this.rig.addRecoil(-0.35 * DEG, 0, 0, 0.004)
      this._jumpPayload.position.copy(m.position)
      this.ctx.events.emit('player:jump', this._jumpPayload)
    }

    if (m.slideStarted) {
      m.slideStarted = false
      this.rig.onSlideStart(m._slideSide)
    }
    if (m.slideEnded) m.slideEnded = false

    if (m.mantleEvent.pending) {
      m.mantleEvent.pending = false
      this._mantlePayload.kind = m.mantleEvent.kind
      this._mantlePayload.height = m.mantleEvent.height
      this.rig.addTrauma(m.mantleEvent.kind === 'vault' ? 0.08 : 0.14)
      this.ctx.events.emit('player:mantle', this._mantlePayload)
    }
  }

  _publishState() {
    const m = this.movement
    const s = this._statePayload
    const h = this.health
    const leaning = Math.abs(m.leanAmount) > 0.35
    const state = leaning && (m.state === 'stand' || m.state === 'crouch') ? 'lean' : m.state
    s.state = state
    s.stance = m.stance
    s.crouched = m.stance !== 'stand'
    s.sprinting = m.sprinting
    s.tacticalSprint = m.tacticalSprint
    s.sliding = m.sliding
    s.ads = this.adsAmount > 0.5
    s.adsProgress = this.adsAmount
    s.grounded = m.grounded
    s.airborne = !m.grounded
    s.mantling = m.mantleMotion.active
    s.lean = m.leanAmount
    s.speed = m.horizontalSpeed
    // Summed limb HP, so a listener that only knows the documented fields still
    // gets a number it can render.
    s.health = h ? h.total() : 0
    s.healthFraction = h ? h.fraction : 1
    // Emit only when something discrete actually changed. Field-wise compare,
    // because building a key string every frame would be a per-frame allocation.
    const q = this._prev
    if (
      q.state !== s.state || q.stance !== s.stance || q.sprinting !== s.sprinting ||
      q.tacticalSprint !== s.tacticalSprint || q.sliding !== s.sliding ||
      q.grounded !== s.grounded || q.ads !== s.ads || q.mantling !== s.mantling
    ) {
      q.state = s.state
      q.stance = s.stance
      q.sprinting = s.sprinting
      q.tacticalSprint = s.tacticalSprint
      q.sliding = s.sliding
      q.grounded = s.grounded
      q.ads = s.ads
      q.mantling = s.mantling
      this.ctx.events.emit('player:state', s)
    }
  }

  /* ==================================================================== */
  /* incoming damage                                                      */
  /* ==================================================================== */

  /**
   * Generic "something hurt the player" event, for sources with no ballistics:
   * scripted damage, traps, the dev console.
   *
   * Bullets do NOT arrive here. `ai` emits damage:dealt only for kills it
   * scored, with the BOT as target, and real rounds reach the player through
   * bullet:impact, which HealthSystem owns. The guard drops anything not aimed
   * at us, those bot-death receipts included.
   */
  _onDamageDealt(e) {
    if (!e) return
    const t = e.target
    if (t !== this && t !== 'player' && t?.isPlayer !== true) return
    // Somebody already applied it (e.g. a system that called damage() direct).
    if (e.applied) return
    // Direction indicators need the *shooter*, not the impact point: `ai` sets
    // `point` to where the round landed (which is the player), and `from` to the
    // muzzle. Using `point` pinned every arc to dead ahead.
    const from = e.from ?? e.source?.position ?? e.point ?? null
    this.applyDamage(e.amount ?? 0, e.part ?? e.partIndex ?? null, {
      type: e.type ?? 'bullet',
      from,
      source: e.source ?? null,
    })
  }

  _onExplosion(e) {
    if (!e?.position) return
    const eye = this.ctx.camera.position
    const r = e.radius ?? 5
    const d = this._tmp.copy(e.position).distanceTo(eye)
    if (d > r * 1.6) return
    // Occluded blasts still shake you, they just do not wound you.
    const clear = this.physics.lineOfSight(e.position, eye, this.physics.MASK.EXPLOSION)
    const falloff = Math.pow(clamp01(1 - d / r), 1.6)
    this.rig.addTrauma(clamp01(falloff * 1.4))
    this.addSuppression(HEALTH.suppression.perExplosion * falloff)
    if (clear && falloff > 0.02) {
      // No solved part: the limb is resolved from the blast height against the
      // live skeleton, so a charge at ankle height takes a leg.
      this.applyDamage((e.damage ?? 90) * falloff, null, {
        type: 'explosion',
        from: e.position,
      })
    }
  }

  /**
   * Near-miss suppression ONLY.
   *
   * HealthSystem subscribes to this same event and is the one that applies the
   * wound — it gets the partIndex the penetration solver already resolved.
   * Applying anything here as well would double every round that hits us, which
   * is exactly the trap the two-model split used to hide.
   */
  _onBulletImpact(e) {
    if (!e?.point || this.dead) return
    const eye = this.ctx.camera.position
    const dx = e.point.x - eye.x, dy = e.point.y - eye.y, dz = e.point.z - eye.z
    const d2 = dx * dx + dy * dy + dz * dz
    const R = HEALTH.suppression.radius
    if (d2 > R * R) return
    // Heuristic: rounds we fired land where we are looking. Anything cracking in
    // beside or behind us is somebody shooting at us.
    const d = Math.sqrt(d2) || 1e-4
    const f = this.rig.forward
    if ((dx * f.x + dy * f.y + dz * f.z) / d > 0.55) return
    this.addSuppression(HEALTH.suppression.perNearMiss * (1 - d / R))
  }

  /** HealthSystem owns dying; player:death is the documented event. */
  _onHealthDeath(e) {
    if (!this.movement) return
    this._deathPayload.position.copy(this.movement.position)
    this._deathPayload.by = e?.by ?? null
    this.ctx.events.emit('player:death', this._deathPayload)
  }

  /** Directional damage arc, in view space. Fixed ring, oldest slot recycled. */
  _pushIndicator(from) {
    const now = this.ctx.time.elapsed
    const angle = this._indicatorAngle(from)
    this._lastIndicatorAngle = angle
    let slot = null
    for (const ind of this.indicators) {
      if (!ind.active || now - ind.time > HEALTH.indicatorTime) {
        slot = ind
        break
      }
    }
    if (!slot) {
      slot = this.indicators[0]
      for (const ind of this.indicators) if (ind.time < slot.time) slot = ind
    }
    slot.active = true
    slot.time = now
    slot.angle = angle
    slot.strength = 1
    return slot
  }

  /**
   * Bearing of `from` relative to where the player is FACING: 0 dead ahead,
   * +pi/2 to the right. Projected onto the yaw basis rather than subtracted
   * from a world atan2, which is only correct at yaw 0.
   */
  _indicatorAngle(from) {
    if (!from) return 0
    const m = this.movement
    const p = m.renderPosition
    const dx = from.x - p.x
    const dz = from.z - p.z
    if (dx * dx + dz * dz < 1e-8) return 0
    const sy = Math.sin(m.yaw)
    const cy = Math.cos(m.yaw)
    // forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
    const right = dx * cy - dz * sy
    const ahead = -dx * sy - dz * cy
    return Math.atan2(right, ahead)
  }

  /** Which limb eats a hit that arrived with no solved part. */
  _partFromHeight(from) {
    const health = this.health
    if (from && Number.isFinite(from.y) && typeof health?.partIndexAtHeight === 'function') {
      return health.partIndexAtHeight(from.y)
    }
    return PART_INDEX.thorax
  }

  /* ==================================================================== */
  /* public API                                                           */
  /* ==================================================================== */

  /**
   * HUD adapter polled by `ui`. Preallocated and mutated in place.
   *
   * The arcade triple (health / maxHealth / regen) is gone. What ships instead
   * is the seven-limb status, index-aligned with PARTS, plus the whole-body
   * roll-up and the controller flags the reticle needs.
   */
  getHudState() {
    const h = this._hudState
    const m = this.movement
    const sys = this.health

    if (sys) {
      let blacked = 0
      let fractures = 0
      let light = 0
      let heavy = 0
      for (let i = 0; i < PARTS.length; i++) {
        const hp = sys.hp[i]
        const max = sys.max[i]
        const fx = sys.fx[i]
        h.hp[i] = hp
        h.max[i] = max
        h.ratio[i] = max > 0 ? clamp01(hp / max) : 0
        h.effects[i] = fx
        if (hp <= 0) blacked++
        if (fx & E_FRACTURE) fractures++
        if (fx & E_BLEED_L) light++
        if (fx & E_BLEED_H) heavy++
      }
      h.blacked = blacked
      h.fractures = fractures
      h.bleedLight = light
      h.bleedHeavy = heavy
      h.health = sys.total()
      h.maxHealth = sys.totalMax()
      h.fraction = sys.fraction
      h.dead = sys.dead
      h.energy = sys.energy
      h.hydration = sys.hydration
      h.stamina = sys.stamina
      h.pain = sys._painT ?? 0
    }

    h.suppression = this.suppression
    // 0..1 against tactical sprint, which is the fastest the player can move —
    // `ui` uses this directly as the reticle-bloom weight.
    h.move = Math.min(1, m.horizontalSpeed / MOVE.tacSprintSpeed)
    h.sprint = m.sprinting || m.tacticalSprint
    h.crouch = m.stance === 'crouch' || m.stance === 'prone'
    h.ads = this.adsAmount > 0.5
    h.airborne = !m.grounded
    h.position = this.position
    return h
  }

  get position() {
    return this.movement.renderPosition
  }
  get feetPosition() {
    return this.movement.position
  }
  get eyePosition() {
    return this.rig.eyePosition
  }
  get velocity() {
    return this.movement.velocity
  }
  get forward() {
    return this.rig.forward
  }
  get yaw() {
    return this.movement.yaw
  }
  get pitch() {
    return this.movement.pitch
  }
  get speed() {
    return this.movement.speed
  }
  get horizontalSpeed() {
    return this.movement.horizontalSpeed
  }
  get character() {
    return this.movement.character
  }
  get state() {
    return this._statePayload.state
  }
  get stance() {
    return this.movement.stance
  }
  get sprinting() {
    return this.movement.sprinting
  }
  get tacticalSprint() {
    return this.movement.tacticalSprint
  }
  get sliding() {
    return this.movement.sliding
  }
  get slideProgress() {
    return this.movement.slideProgress
  }
  get grounded() {
    return this.movement.grounded
  }
  get airborne() {
    return !this.movement.grounded
  }
  get mantling() {
    return this.movement.mantleMotion.active
  }
  get leanAmount() {
    return this.movement.leanAmount
  }
  get eyeHeight() {
    return this.rig.eye
  }
  get adsProgress() {
    return this.adsAmount
  }
  get viewKick() {
    return this.rig.viewKick
  }
  get cameraRig() {
    return this.rig
  }
  get height() {
    return STANCE[this.movement.stance].height
  }

  /* ---- health, all forwarded ------------------------------------------- */

  /** Summed limb HP. `health` itself is the system, not a number. */
  get healthTotal() {
    return this.health?.total() ?? 0
  }
  get maxHealth() {
    return this.health?.totalMax() ?? 0
  }
  get healthFraction() {
    return this.health?.fraction ?? 1
  }
  get lowHealth() {
    return this.health?.low ?? false
  }
  get dead() {
    return this.health?.dead ?? false
  }
  get damageIndicators() {
    return this.indicators
  }
  /** The beat is owned by the low-health pass, which drives it off vitals(). */
  get heartbeatPulse() {
    return this.lowHealthPass?.pulse ?? 0
  }
  get bobPhase() {
    return this.rig.bobPhase
  }

  /** `weapons` owns the ADS curve; hand it over and everything else follows. */
  setAdsProgress(v) {
    this.adsAmount = clamp01(v)
    this._adsExternal = true
    this._adsExternalAge = 0
    this.movement.adsAmount = this.adsAmount
  }

  addRecoil(pitch, yaw, roll, punch) {
    this.rig.addRecoil(pitch, yaw, roll, punch)
  }
  addKick(pitch, yaw, roll) {
    this.rig.addKick(pitch, yaw, roll)
  }
  addTrauma(a) {
    this.rig.addTrauma(a)
  }
  /** Alias some subsystems may reach for. */
  addCameraShake(a) {
    this.rig.addTrauma(a)
  }

  /**
   * The one way anything wounds the player.
   *
   * Accepts either shape, because both are in the tree:
   *   applyDamage(45, 'lleg')                  part name, or a partIndex
   *   applyDamage(45, muzzleVec3, { ... })     legacy: the shooter's position
   *
   * A part is mapped through partIndexOf() — the shared anatomy map exported by
   * src/health/index.js. There is deliberately no local copy of the limb order
   * in this file: two copies of it are how the models drifted apart before.
   *
   * @returns {number} HP actually dealt.
   */
  applyDamage(amount, partOrFrom, opts = {}) {
    if (!(amount > 0)) return 0
    let part = opts.part ?? null
    let from = opts.from ?? null

    if (typeof partOrFrom === 'string' || typeof partOrFrom === 'number') {
      part = partOrFrom
    } else if (partOrFrom && Number.isFinite(partOrFrom.x) && Number.isFinite(partOrFrom.z)) {
      from = partOrFrom
    }

    /* View half first, so a harness with no health system still flinches. */
    this._pushIndicator(from)
    this.rig.addTrauma(clamp01(0.05 + amount / 220))
    this.addSuppression(HEALTH.suppression.perHit * clamp01(amount / 40))

    const health = this.health
    if (!health) return 0

    const partIndex = part == null ? this._partFromHeight(from) : partIndexOf(part)
    const dealt = health.damage(partIndex, amount, {
      source: opts.source ?? null,
      noBleed: !!opts.noBleed,
      type: opts.type ?? 'generic',
    })

    const d = this._damagePayload
    d.amount = dealt
    d.from = from
    d.part = PARTS[partIndex]
    d.partIndex = partIndex
    d.health = health.total()
    d.fraction = health.fraction
    d.direction = this._lastIndicatorAngle
    this.ctx.events.emit('damage:taken', d)
    return dealt
  }

  /**
   * Give HP back. Routed to HealthSystem.heal(), which spends it on the target
   * limb first and then on whatever is worst hurt, and refuses blacked limbs.
   */
  heal(amount, part) {
    return this.health?.heal(amount, part) ?? 0
  }

  addSuppression(a) {
    if (!(a > 0)) return this.suppression
    this.suppression = clamp01(this.suppression + a)
    return this.suppression
  }

  setControlEnabled(on) {
    this.controlEnabled = !!on
    this.movement.controlEnabled = this.controlEnabled
    if (!on) {
      this.movement.latchInput(-2) // flush held keys
      this.movement.velocity.set(0, 0, 0)
      this.movement.sprinting = false
      this.movement.tacticalSprint = false
      this.movement.sliding = false
      this.movement.cancelMantle()
      this.adsAmount = 0
      this._adsExternal = false
    } else {
      this.movement._cmdFrame = -1
    }
  }

  /**
   * Move the player. `eyeOrPos` is the EYE position (that is what the shot
   * harness hands us — it passes the camera transform); `rot` may be a
   * THREE.Euler, an object with `.y`, or a yaw in radians.
   */
  teleport(eyeOrPos, rot) {
    if (!eyeOrPos) return
    const eyeH = STANCE.stand.eye
    const feetY = eyeOrPos.y - eyeH
    if (typeof rot === 'number') {
      this.movement.yaw = rot
    } else if (rot) {
      this.movement.yaw = rot.y ?? this.movement.yaw
      this.movement.pitch = clamp(rot.x ?? 0, -CAMERA.pitchLimit, CAMERA.pitchLimit)
    }
    this.movement.teleport(eyeOrPos.x, feetY, eyeOrPos.z)
    this.rig.reset(eyeH)
    this.rig.eyePosition.set(eyeOrPos.x, eyeOrPos.y, eyeOrPos.z)
    this.rig.fov = this.ctx.config.fov
    this._lookFrame = this.ctx.time.frame
    this._prev.state = ''
  }

  /** Clear the screen-space wound state. Limb HP is HealthSystem.reset(). */
  _resetViewDamage() {
    this.suppression = 0
    this._lastIndicatorAngle = 0
    for (const ind of this.indicators) {
      ind.active = false
      ind.strength = 0
      ind.angle = 0
      ind.time = -99
    }
    this.lowHealthPass?.idle()
  }

  respawn(index = 0) {
    const world = this.ctx.peek('world')
    const sp = world?.spawn?.(index)
    this.health?.reset(true)
    this._resetViewDamage()
    if (!sp?.position) return
    const gy = this.physics.groundHeight(sp.position.x, sp.position.z, sp.position.y + 6)
    const feetY = Number.isFinite(gy) ? gy + 0.03 : sp.position.y
    this.movement.yaw = sp.yaw ?? 0
    this.movement.pitch = 0
    this.movement.teleport(sp.position.x, feetY, sp.position.z)
    this.rig.reset(STANCE.stand.eye)
  }

  /** Named states for dev overlays and future shots. */
  debugState(name) {
    const m = this.movement
    const health = this.health
    switch (name) {
      case 'sprint':
        m.stanceWant = 'stand'
        m.sprinting = true
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed)
        break
      case 'tacsprint':
        m.sprinting = true
        m.tacticalSprint = true
        break
      case 'crouch':
        m.stanceWant = 'crouch'
        break
      case 'prone':
        m.stanceWant = 'prone'
        break
      case 'slide':
        m.sprinting = true
        m.velocity.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)).multiplyScalar(MOVE.sprintSpeed)
        m._beginSlide(m.cmd, m._wish.set(-Math.sin(m.yaw), 0, -Math.cos(m.yaw)), 1, MOVE.sprintSpeed)
        m.slideStarted = false
        this.rig.onSlideStart(1)
        break
      case 'air':
        m.velocity.y = JUMP_SPEED
        m.grounded = false
        break
      case 'hurt':
        /* A wounded PMC, not a dented pool: chew the chest and open a bleed in
         * a leg, which is what the screen treatment and the HUD react to. */
        if (health) {
          this.applyDamage(health.max[PART_INDEX.thorax] * 0.55, 'thorax', { noBleed: true })
          health.addEffect('lleg', 'light')
        }
        break
      case 'critical':
        if (health) {
          this.applyDamage(health.max[PART_INDEX.thorax] * 0.86, 'thorax', { noBleed: true })
          this.applyDamage(health.max[PART_INDEX.lleg] * 1.2, 'lleg', { noBleed: true })
          health.addEffect('thorax', 'heavy')
        }
        break
      case 'reset':
        health?.reset(true)
        this._resetViewDamage()
        break
      default:
        break
    }
    return {
      state: this.state, stance: m.stance, speed: m.horizontalSpeed,
      health: this.healthTotal, ads: this.adsAmount,
    }
  }

  /** Snapshot for the dev HUD / debugging. */
  get stats() {
    const m = this.movement
    const health = this.health
    return {
      state: this.state,
      stance: m.stance,
      speed: m.horizontalSpeed,
      vertical: m.velocity.y,
      grounded: m.grounded,
      lean: m.leanAmount,
      fov: this.rig.fov,
      health: this.healthTotal,
      maxHealth: this.maxHealth,
      blacked: health ? health.blackedLegs() + health.blackedArms() : 0,
      bleeds: health ? health.bleedCount() : { light: 0, heavy: 0 },
      suppression: this.suppression,
    }
  }

  dispose() {
    for (const off of this._offEvents) off?.()
    this._offEvents.length = 0
    if (this.hitbox) {
      this.physics?.removeCollider(this.hitbox)
      this.hitbox = null
    }
    this._unregisterPass?.()
    this.lowHealthPass?.dispose()
    this.lowHealthPass = null
    this.movement?.dispose()
    /* Drop the borrowed reference — this system never owned it. */
    this._health = null
  }
}
