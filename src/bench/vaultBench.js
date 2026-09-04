/**
 * Bench - AI vault physics regression course.
 *
 * Four lanes, each with a different obstacle class, run in both directions by
 * a squad of faction actors. `mode = 'fixed'` runs `Agent._move()`; `mode =
 * 'legacy'` runs the old advance-then-resolve locomotion in-bench (advance,
 * ask ground for the highest surface, snap y to it) so the roof teleport can
 * be reproduced against the exact same geometry and compared frame by frame.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createCtx } from '../core/ctx.js'
import { PhysicsWorld } from '../physics/world.js'
import { Agent, VAULT } from '../ai/agent.js'
import { buildActor, disposeActor } from '../ai/parts.js'
import { rollArmorZones } from '../ai/archetypes.js'

export const LANES = Object.freeze([
  { x: -7.5, label: 'kerb 0.20 m + step 0.40 m', expect: 'steps over both' },
  { x: -2.5, label: 'crate 0.70 m', expect: 'wall - refused, detour' },
  { x: 2.5, label: 'building 3.5 m (roofed)', expect: 'wall - no roof snap' },
  { x: 7.5, label: 'low wall 1.00 m', expect: 'wall - refused, detour' },
])

const COURSE = [
  // lane 0 - passable
  { min: [-9, 0, -5], max: [-6, 0.2, -4], color: 0x5c6b4a, tag: 'kerb' },
  { min: [-9, 0, 2], max: [-6, 0.4, 3.2], color: 0x6b6350, tag: 'step' },
  // lane 1 - crate
  { min: [-3.4, 0, -0.5], max: [-1.6, 0.7, 1.3], color: 0x8a6a3a, tag: 'crate' },
  // lane 2 - building with roof
  { min: [0.5, 0, -2], max: [4.5, 3.5, 3], color: 0x7d7a72, tag: 'building' },
  // lane 3 - low wall
  { min: [6, 0, 0], max: [9, 1.0, 0.35], color: 0x8b8378, tag: 'wall' },
]

const FACTION_LANE = ['scav', 'raider', 'pmc', 'boss']
const PROFILE_LANE = ['track', 'black', 'usec', 'killa']

export class VaultBench {
  constructor(container) {
    this.container = container
    this.mode = 'fixed'
    this.paused = false
    this.events = []
    this.frame = 0

    this.ctx = createCtx()
    this.physics = this.ctx.set('physics', new PhysicsWorld())
    this.ctx.set('world', { mapId: 'factory' })
    this.ctx.on('ai:redirect', (e) => this._event(`#${e.id} ${e.faction} redirect -> (${e.target.x.toFixed(1)}, ${e.target.z.toFixed(1)})`))

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0c1210)
    this.scene.fog = new THREE.Fog(0x0c1210, 30, 70)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200)
    this.camera.position.set(14, 11, -18)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1, 0)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI * 0.49

    this._lights()
    this._course()
    this.agents = []
    this.shadows = []
    this.reset()

    this.clock = new THREE.Clock()
    this._raf = 0
    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()
    this._loop()
  }

  _lights() {
    const hemi = new THREE.HemisphereLight(0x9fb8c8, 0x2a2418, 0.9)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xffe2b8, 2.2)
    sun.position.set(10, 18, -8)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.left = -20
    sun.shadow.camera.right = 20
    sun.shadow.camera.top = 20
    sun.shadow.camera.bottom = -20
    sun.shadow.camera.far = 60
    sun.shadow.bias = -0.0005
    this.scene.add(sun)
  }

  _course() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x353a2f, roughness: 1 }),
    )
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)
    const grid = new THREE.GridHelper(60, 60, 0x2e4a3a, 0x1e2c24)
    grid.position.y = 0.002
    this.scene.add(grid)

    for (const b of COURSE) {
      this.physics.addBox(b.min, b.max, b.tag)
      const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(...size),
        new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.9 }),
      )
      mesh.position.set(b.min[0] + size[0] / 2, b.min[1] + size[1] / 2, b.min[2] + size[2] / 2)
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.scene.add(mesh)
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x9fd8b8, transparent: true, opacity: 0.5 }),
      )
      edges.position.copy(mesh.position)
      this.scene.add(edges)
    }

    // lane markers
    for (const lane of LANES) {
      for (const z of [-12, 12]) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.35, 0.45, 24),
          new THREE.MeshBasicMaterial({ color: 0x37e07a, side: THREE.DoubleSide }),
        )
        ring.rotation.x = -Math.PI / 2
        ring.position.set(lane.x, 0.01, z)
        this.scene.add(ring)
      }
    }
    // ceiling reference plane at STEP_CEILING (visual only)
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 28),
      new THREE.MeshBasicMaterial({ color: 0xf4d03f, transparent: true, opacity: 0.06, side: THREE.DoubleSide }),
    )
    ceil.rotation.x = -Math.PI / 2
    ceil.position.y = VAULT.STEP_CEILING
    this.scene.add(ceil)
  }

  reset() {
    for (const a of this.agents) {
      this.scene.remove(a.root)
      disposeActor(a.root)
    }
    this.agents = []
    this.events = []
    this.frame = 0
    LANES.forEach((lane, i) => {
      const faction = FACTION_LANE[i]
      const profile = PROFILE_LANE[i]
      const agent = new Agent(this.ctx, {
        faction,
        profile,
        armorZones: rollArmorZones(faction, () => 0),
        position: new THREE.Vector3(lane.x, 0, -12),
      })
      agent.lane = i
      agent.legacyGround = 0
      const actor = buildActor({ faction, profile, armorZones: agent._armorZones, seed: 7 + i })
      agent.root.add(actor.group)
      // heading marker
      const arrow = new THREE.Mesh(
        new THREE.ConeGeometry(0.12, 0.35, 8),
        new THREE.MeshBasicMaterial({ color: 0x9fe8ff }),
      )
      arrow.rotation.x = Math.PI / 2
      arrow.position.set(0, 0.08, 0.5)
      agent.root.add(arrow)
      agent.setPatrol([[lane.x, 0, 12], [lane.x, 0, -12]], true)
      this.scene.add(agent.root)
      this.agents.push(agent)
    })
  }

  setMode(mode) {
    this.mode = mode
    this.reset()
  }

  /**
   * The ORIGINAL locomotion, reproduced verbatim in spirit: advance along the
   * heading, then ask the ground query for the surface under the new sample
   * with no ceiling. Inside a building footprint that surface is the roof.
   */
  _legacyMove(agent, dt) {
    const p = agent.root.position
    const a = agent.archetype
    agent.speed += Math.max(-14 * dt, Math.min(9 * dt, agent.desiredSpeed - agent.speed))
    const fx = Math.sin(agent.heading)
    const fz = Math.cos(agent.heading)
    // old vault: low 0.35 / high 1.15, +0.55 hop when low blocked & high clear
    const ph = this.physics
    const lo = new THREE.Vector3(p.x, p.y + 0.35, p.z)
    const lo2 = lo.clone().add(new THREE.Vector3(fx * 0.9, 0, fz * 0.9))
    const hi = new THREE.Vector3(p.x, p.y + 1.15, p.z)
    const hi2 = hi.clone().add(new THREE.Vector3(fx * 0.9, 0, fz * 0.9))
    const lowClear = ph.lineOfSight(lo, lo2)
    const highClear = ph.lineOfSight(hi, hi2)
    // the bug: the horizontal advance happens regardless of the vault result
    p.x += fx * agent.speed * dt
    p.z += fz * agent.speed * dt
    if (!lowClear && highClear) {
      p.y += 0.55
      p.x += fx * 0.35
      p.z += fz * 0.35
    }
    // ground re-probe without a ceiling -> highest surface -> roof
    const g = ph.groundHeight(p.x, p.z)
    p.y = g
    agent.groundY = g
    agent.speed = Math.min(agent.speed, a.speed)
  }

  _event(msg) {
    this.events.unshift({ frame: this.frame, msg })
    if (this.events.length > 40) this.events.pop()
  }

  step(dt) {
    this.frame++
    for (const agent of this.agents) {
      if (this.mode === 'legacy') {
        agent._think(dt)
        this._legacyMove(agent, dt)
        agent.root.rotation.y = agent.heading
        if (agent.root.position.y > VAULT.STEP_CEILING + 0.01 && !agent._warned) {
          agent._warned = true
          this._event(`#${agent.id} ${agent.faction} WARPED to y=${agent.root.position.y.toFixed(2)} (legacy)`)
        }
        if (agent.root.position.y <= 0.01) agent._warned = false
      } else {
        const before = agent.log.length ? agent.log[agent.log.length - 1] : null
        agent.update(dt)
        const after = agent.log.length ? agent.log[agent.log.length - 1] : null
        if (after && after !== before) this._event(`#${agent.id} ${agent.faction}: ${after.msg}`)
      }
    }
  }

  stats() {
    return this.agents.map((a) => ({
      ...a.stats(),
      lane: LANES[a.lane].label,
      expect: LANES[a.lane].expect,
      x: a.root.position.x,
      z: a.root.position.z,
      overCeiling: a.root.position.y > VAULT.STEP_CEILING + 1e-3,
    }))
  }

  resize() {
    const w = this.container.clientWidth || 800
    const h = this.container.clientHeight || 500
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop())
    const dt = Math.min(this.clock.getDelta(), 0.05)
    if (!this.paused) this.step(dt)
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    this.controls.dispose()
    for (const a of this.agents) disposeActor(a.root)
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
  }
}
