/**
 * Low-health screen treatment, registered with `render` as a post pass.
 *
 * Runs in the HDR/linear domain *before* tonemapping, which is the only place
 * this can go without fighting the film curve: desaturating after AgX crushes
 * the highlights instead of draining the colour.
 *
 * The data source is `HealthSystem.vitals()` (src/health/index.js) - segmented
 * limb data, not a single arcade HP pool. Nothing here reads a global health
 * variable and nothing imports the player-local health model.
 *
 *   vignette   rises once THORAX drops below 50% of its own max. Thorax is
 *              deliberately not the total: a summed pool hides a chest wound
 *              behind four healthy limbs, and the chest is what kills you.
 *   heartbeat  accelerates when TOTAL LIVE HP falls below 40%, or whenever any
 *              limb carries a heavy bleed - a bleed-out at a comfortable
 *              looking total is precisely the case the player must hear.
 *   hit flash  driven from HealthSystem.tremor, which the damage path already
 *              sets and decays, so no extra event subscription is needed.
 *
 * The audio loop is not owned here. Each beat emits `player:heartbeat`
 * ({ strength, fraction, rate, thorax, bleeding }) on the health bus and the
 * audio system plays it - a render pass has no business holding an AudioNode.
 *
 * The pass sets `enabled = false` whenever it would be a no-op so a healthy
 * player pays nothing - not even the ping-pong blit.
 */

import * as THREE from 'three'
import { E_BLEED_H } from '../health/index.js'
import { approach, clamp01 } from './springs.js'

/** Thorax ratio at which the vignette starts to lift. */
const THORAX_GATE = 0.5
/** Total-live-HP ratio at which the pulse starts to race. */
const LIVE_GATE = 0.4
/** Beats per second. */
const BEAT_CALM = 1.05
const BEAT_PANIC = 2.7
const BEAT_PER_HEAVY = 0.6
const BEAT_MAX = 3.6

// RawShaderMaterial: three prepends nothing, so every attribute and the
// precision qualifier are declared by hand.
const VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
/** x amount, y pulse, z hitFlash, w critical */
uniform vec4 uState;
uniform vec2 uAspect;
/** 1x1, .r = the exposure scalar the composite will apply after us. */
uniform sampler2D uExposure;
out vec4 fragColor;

void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float amount = uState.x;
  float pulse = uState.y;
  float flash = uState.z;

  // Radial distance in a square-corrected space so the vignette is round.
  vec2 d = (vUv - 0.5) * uAspect;
  float r = length(d) * 1.414;

  // Two lobes: a wide darkening and a narrower blood rim that breathes with the
  // heartbeat.
  float wide = smoothstep(0.18, 1.0, r);
  float rim = smoothstep(0.34, 1.1, r);
  float beat = amount * (0.32 + 0.68 * pulse);

  // ---- desaturation: Rec.709 luma, pulled toward a cold grey ------------
  // Note everything below is deliberately *relative* - multiplicative and
  // chromatic - because auto-exposure meters this pass's output and would
  // simply gain back any absolute brightness we removed.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float sat = amount * (0.74 + 0.16 * pulse);
  c = mix(c, vec3(luma) * vec3(0.93, 0.97, 1.06), clamp(sat, 0.0, 0.94));

  // ---- edge darkening ----------------------------------------------------
  c *= 1.0 - wide * (0.40 + 0.28 * beat) * amount;

  // ---- arterial rim ------------------------------------------------------
  // Subtractive first: the rim loses green and blue rather than gaining red, so
  // it survives the film curve instead of clipping into a magenta halo.
  float k = rim * beat;
  c *= mix(vec3(1.0), vec3(1.16, 0.26, 0.22), clamp(k * 0.98, 0.0, 1.0));

  // Then a small additive glow so the rim still reads where the corners are
  // already black. This is a viewer-side overlay, not light in the scene, so it
  // is authored display-referred and divided by the exposure the composite is
  // about to apply - otherwise it vanishes at noon and blinds you at night.
  float invExp = 1.0 / max(1e-3, texture(uExposure, vec2(0.5)).r);
  c += vec3(0.115, 0.008, 0.005) * k * invExp;

  // ---- hit flash ---------------------------------------------------------
  if (flash > 0.001) {
    float ring = 0.3 + 0.7 * smoothstep(0.05, 0.95, r);
    float f = clamp(flash * ring, 0.0, 1.0);
    c *= mix(vec3(1.0), vec3(1.3, 0.4, 0.34), f);
    c += vec3(0.16, 0.012, 0.008) * f * invExp;
  }

  fragColor = vec4(c, 1.0);
}
`

export class LowHealthPass {
	constructor() {
		this.name = 'player:lowhealth'
		/** After fx/volumetrics, before metering - the grade should meter darker. */
		this.order = 40
		this.enabled = false

		/* Written by HealthSystem.vitals() every frame. Preallocated: vitals()
		 * takes an out-object precisely so this pass never allocates per frame. */
		this._vitals = { thorax: 1, head: 1, live: 1, bleeding: 0, pain: 0, blacked: 0, dead: false }

		/** 0..1 overall treatment weight, driven by thorax only. */
		this.effect = 0
		this.pulse = 0
		this.hitFlash = 0
		this.beatPhase = 0
		this.beatRate = BEAT_CALM
		this._beat = { strength: 0, fraction: 1, rate: BEAT_CALM, thorax: 1, bleeding: false }

		// 1x1 fallback so the shader is valid before `render` publishes a real
		// exposure texture (and if auto-exposure is ever switched off).
		this.unitExposure = new THREE.DataTexture(
			new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType
		)
		this.unitExposure.needsUpdate = true

		this.uniforms = {
			uTex: { value: null },
			uState: { value: new THREE.Vector4(0, 0, 0, 0) },
			uAspect: { value: new THREE.Vector2(1, 1) },
			uExposure: { value: this.unitExposure },
		}
		this.material = new THREE.RawShaderMaterial({
			name: this.name,
			glslVersion: THREE.GLSL3,
			uniforms: this.uniforms,
			vertexShader: VERT,
			fragmentShader: FRAG,
			depthTest: false,
			depthWrite: false,
			blending: THREE.NoBlending,
		})

		// Own fullscreen triangle - this file may not import render/'s helpers.
		this.geometry = new THREE.BufferGeometry()
		this.geometry.setAttribute(
			'position',
			new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
		)
		this.geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
		this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e8)
		this.mesh = new THREE.Mesh(this.geometry, this.material)
		this.mesh.frustumCulled = false
		this.mesh.matrixAutoUpdate = false
		this.scene = new THREE.Scene()
		this.scene.matrixAutoUpdate = false
		this.scene.add(this.mesh)
		this.camera = new THREE.Camera()
	}

	/**
	 * Resolve the segmented health system.
	 *
	 * Accepts the system directly, or anything carrying a `ctx` - the historical
	 * call site hands over the player-local health object, and going through
	 * `ctx.peek('health')` means that call site did not have to change. `peek` is
	 * lazy on purpose: `player` does not declare `health` in its static deps.
	 */
	_resolve(source) {
		if (source && typeof source.vitals === 'function') return source
		const ctx = source?.ctx ?? null
		const sys = ctx?.peek ? ctx.peek('health') : null
		return sys && typeof sys.vitals === 'function' ? sys : null
	}

	/**
	 * Heavy bleeds across every limb.
	 *
	 * Read straight off the `fx` bitfield rather than `bleedCount()`, which
	 * allocates a result object - this runs every frame. `vitals().bleeding` is
	 * no use here either: it is a weighted light+2*heavy sum, so it cannot say
	 * whether a *heavy* bleed specifically is open.
	 */
	_heavyBleeds(sys) {
		const fx = sys.fx
		if (fx && typeof fx.length === 'number') {
			let n = 0
			for (let i = 0; i < fx.length; i++) if (fx[i] & E_BLEED_H) n++
			return n
		}
		const b = typeof sys.bleedCount === 'function' ? sys.bleedCount() : null
		return b ? b.heavy : 0
	}

	/** Nothing to show, and nothing to keep warm for the next frame. */
	idle() {
		this.enabled = false
		this.effect = 0
		this.pulse = 0
		this.hitFlash = 0
		this.beatPhase = 0
		this.beatRate = BEAT_CALM
	}

	/**
	 * @param {object} source - the HealthSystem, or any holder of engine ctx.
	 * @param {number} [dtArg] - seconds; falls back to ctx.time.dt.
	 */
	sync(source, dtArg) {
		const sys = this._resolve(source)
		if (!sys) {
			this.idle()
			return
		}

		const ctx = sys.ctx ?? source?.ctx ?? null
		const dt = Number.isFinite(dtArg) && dtArg > 0 ? dtArg : (ctx?.time?.dt ?? 0)
		const v = sys.vitals(this._vitals)
		const heavy = this._heavyBleeds(sys)

		/* ---- vignette: thorax, and only thorax ----------------------------
		 * Full at a blacked-out chest, nothing at or above THORAX_GATE. */
		const target = clamp01((THORAX_GATE - v.thorax) / THORAX_GATE)
		this.effect = dt > 0 ? approach(this.effect, target, 0.25, dt) : target

		/* ---- hit flash ----------------------------------------------------
		 * tremor is already impulse-set on damage and decayed in update(). */
		this.hitFlash = clamp01(sys.tremor || 0)

		/* ---- heartbeat rate ----------------------------------------------
		 * Two independent accelerants, as specified: total live HP under the
		 * gate, and any open heavy bleed. The second matters on its own - a
		 * player above 40% who is bleeding heavily is losing thorax HP now. */
		let rate = BEAT_CALM + (BEAT_PANIC - BEAT_CALM) * clamp01((LIVE_GATE - v.live) / LIVE_GATE)
		if (heavy > 0) rate += BEAT_PER_HEAVY * Math.min(3, heavy)
		this.beatRate = Math.min(BEAT_MAX, rate)

		if (v.dead) {
			// Hold the frame, stop the heart. Freezing mid-thump reads as a stutter.
			this.effect = 1
			this.pulse = 0
			this.beatPhase = 0
		} else {
			const audible = this.effect > 0.02 || heavy > 0 || v.live < LIVE_GATE
			if (audible && dt > 0) {
				const urgency = Math.max(this.effect, clamp01((LIVE_GATE - v.live) / LIVE_GATE), heavy > 0 ? 0.45 : 0)
				this.beatPhase += dt * this.beatRate
				if (this.beatPhase >= 1) {
					this.beatPhase -= Math.floor(this.beatPhase)
					const b = this._beat
					b.strength = urgency
					b.fraction = v.live
					b.rate = this.beatRate
					b.thorax = v.thorax
					b.bleeding = heavy > 0
					const bus = sys.bus ?? ctx?.events ?? null
					bus?.emit('player:heartbeat', b)
				}
				// lub-dub: two gaussian thumps 0.16 of a cycle apart
				const t = this.beatPhase
				const thump = (c, w, g) => g * Math.exp(-((t - c) * (t - c)) / (2 * w * w))
				this.pulse = (thump(0.06, 0.035, 1) + thump(0.22, 0.045, 0.62)) * urgency
			} else if (!audible) {
				this.beatPhase = 0
				this.pulse = 0
			}
		}

		const amount = clamp01(this.effect)
		this.enabled = amount > 0.004 || this.hitFlash > 0.004 || this.pulse > 0.004
		if (!this.enabled) return
		const critical = v.live < 0.2 || v.thorax < 0.25 || v.head < 0.25
		const s = this.uniforms.uState.value
		s.set(amount, clamp01(this.pulse), this.hitFlash, critical ? 1 : 0)
	}

	resize(w, h) {
		// Keep the vignette circular regardless of aspect.
		const a = this.uniforms.uAspect.value
		if (w >= h) a.set(1, h / Math.max(1, w))
		else a.set(w / Math.max(1, h), 1)
	}

	render(renderer, inputTexture, target, r) {
		this.uniforms.uTex.value = inputTexture
		this.uniforms.uExposure.value = r?.exposureTexture ?? this.unitExposure
		renderer.setRenderTarget(target)
		renderer.render(this.scene, this.camera)
	}

	dispose() {
		this.material.dispose()
		this.geometry.dispose()
		this.unitExposure.dispose()
	}
}
