/**
 * Bench - faction model compiler lineup.
 *
 * Compiles one actor per (faction, profile) through `buildActor()` and lines
 * them up on a turntable so the silhouettes can be compared side by side.
 * Clicking an actor exposes its compiled part manifest.
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildActor, disposeActor } from '../ai/parts.js'

export const LINEUP = Object.freeze([
  { faction: 'scav', profile: 'civ', armorZones: [], name: 'Scav — civil layers' },
  { faction: 'scav', profile: 'track', armorZones: [], name: 'Scav — tracksuit' },
  { faction: 'scav', profile: 'jeans', armorZones: ['thorax'], name: 'Scav — jeans + PACA roll' },
  { faction: 'raider', profile: 'black', armorZones: ['thorax', 'stomach', 'head'], name: 'Raider' },
  { faction: 'pmc', profile: 'usec', armorZones: ['thorax', 'stomach'], name: 'PMC — USEC' },
  { faction: 'pmc', profile: 'bear', armorZones: ['thorax', 'stomach'], name: 'PMC — BEAR' },
  { faction: 'boss', profile: 'killa', armorZones: ['thorax', 'stomach', 'head'], name: 'Boss — Killa' },
  { faction: 'boss', profile: 'shturman', armorZones: ['thorax'], name: 'Boss — Shturman' },
])

export class FactionBench {
  constructor(container, onSelect) {
    this.container = container
    this.onSelect = onSelect
    this.seed = 1
    this.spin = true
    this.selected = -1

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0e1214)
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
    this.camera.position.set(0, 2.2, 11)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 1, 0)
    this.controls.enableDamping = true
    this.controls.maxPolarAngle = Math.PI * 0.5

    const hemi = new THREE.HemisphereLight(0xcfd8e0, 0x2a2622, 0.8)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xfff0dc, 2.4)
    key.position.set(4, 8, 6)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -8
    key.shadow.camera.right = 8
    key.shadow.camera.top = 6
    key.shadow.camera.bottom = -2
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0x8fb8ff, 1.1)
    rim.position.set(-6, 5, -6)
    this.scene.add(rim)

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x23282b, roughness: 0.95 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    this.scene.add(floor)

    this.actors = []
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.build()

    this._onClick = (e) => this._pick(e)
    this.renderer.domElement.addEventListener('pointerdown', this._onClick)
    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()
    this.clock = new THREE.Clock()
    this._loop()
  }

  build() {
    for (const a of this.actors) {
      this.scene.remove(a.pivot)
      disposeActor(a.group)
    }
    this.actors = []
    const n = LINEUP.length
    const spacing = 1.35
    LINEUP.forEach((spec, i) => {
      const r = buildActor({ ...spec, seed: this.seed * 31 + i })
      const pivot = new THREE.Group()
      pivot.position.x = (i - (n - 1) / 2) * spacing
      pivot.add(r.group)
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 0.5, 0.04, 32),
        new THREE.MeshStandardMaterial({ color: 0x33393d, roughness: 0.8 }),
      )
      disc.position.y = 0.02
      disc.receiveShadow = true
      pivot.add(disc)
      this.scene.add(pivot)
      this.actors.push({ pivot, group: r.group, parts: r.parts, meta: r.meta, spec, disc })
    })
    if (this.selected >= 0) this.select(this.selected)
  }

  reroll() {
    this.seed++
    this.build()
  }

  select(i) {
    this.selected = i
    this.actors.forEach((a, k) => {
      a.disc.material.color.set(k === i ? 0x37e07a : 0x33393d)
      a.disc.material.emissive.set(k === i ? 0x0f4a26 : 0x000000)
    })
    if (this.onSelect && i >= 0) this.onSelect({ index: i, ...this.actors[i].spec, parts: this.actors[i].parts, meta: this.actors[i].meta })
  }

  _pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.actors.map((a) => a.group), true)
    if (!hits.length) return
    const obj = hits[0].object
    const idx = this.actors.findIndex((a) => {
      let o = obj
      while (o) {
        if (o === a.group) return true
        o = o.parent
      }
      return false
    })
    if (idx >= 0) this.select(idx)
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
    const dt = this.clock.getDelta()
    if (this.spin) for (const a of this.actors) a.group.rotation.y += dt * 0.5
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  dispose() {
    cancelAnimationFrame(this._raf)
    window.removeEventListener('resize', this._onResize)
    this.renderer.domElement.removeEventListener('pointerdown', this._onClick)
    this.controls.dispose()
    for (const a of this.actors) disposeActor(a.group)
    this.renderer.dispose()
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
  }
}
