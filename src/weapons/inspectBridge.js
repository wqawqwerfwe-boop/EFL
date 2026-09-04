/* ==========================================================================
 * Escape-From-Larpov · src/weapons/inspectBridge.js
 *
 * Viewmodel "manual inspection" layer, applied when the inventory opens.
 *
 * WHY A BRIDGE AND NOT AN EDIT TO viewmodel.js
 * The animation stack in viewmodel.js is ~43 KB of interlocking springs, clips
 * and IK. This project already solves cross-cutting behaviour with prototype
 * bridges installed from core/tarkovBootstrap.js (mainMenuBridge, settingsBridge,
 * tarkovPlayerPatch, tarkovPhysicsPatch). Staying in that idiom keeps the
 * inspect pose out of the hot animation path and keeps the diff reviewable.
 *
 * WHY THE ANCHOR AND NOT THE RIG
 * The viewmodel graph is `anchor -> rig -> weapon + armL/armR`, plus
 * `anchor -> reticle`. The rig is where the animation stack writes, and the hand
 * IK is solved from the rig's world matrix at the end of update(). If we offset
 * the rig, the hands detach and the reticle stays behind. Offsetting the ANCHOR
 * after the original update() moves weapon, both IK hands and the reticle as one
 * rigid unit, in view space, with no IK re-solve and no allocation. The original
 * re-derives the anchor from the camera every frame, so the offset can never
 * accumulate drift.
 *
 * WHY ctx.time.raw AND NOT performance.now()
 * InventorySystem.show() sets `ctx.time.scale = 0`, so Engine.step() computes
 * `dt = rawDt * 0 = 0` and every dt-gated layer in the viewmodel (noiseT, the
 * springs, bob, lag, clips) freezes solid the instant the panel opens. The
 * inspect clock therefore has to be UNSCALED or the sway would be a still
 * frame. `ctx.time.raw` accumulates rawDt regardless of `scale`, and unlike
 * performance.now() it stays on the engine clock — which ARCHITECTURE.md rule 4
 * requires, and which the lockstep capture harness in dev/shots.js depends on
 * for frame-identical runs. Falls back to the wall clock only if no engine
 * clock is reachable.
 *
 * The rest of update() (compose, _solveHands, _updateParts, _updateReticle) is
 * NOT dt-gated, so it keeps running at dt = 0 and faithfully re-poses the hands
 * onto the raised weapon every frame.
 * ========================================================================== */

import * as ViewmodelModule from './viewmodel.js';
import * as WeaponsModule from './index.js';

/* Namespace imports on purpose: a missed named import in ESM is a LINK error
 * that takes the whole bundle down. A bridge layer may never break the load. */
const Viewmodel = ViewmodelModule.Viewmodel || ViewmodelModule.default || null;
const WeaponSystem = WeaponsModule.WeaponSystem || WeaponsModule.default || null;

/* ---------------------------------------------------------------- tunables */

/** Blend in/out duration. The spec fixes the return LERP at 240 ms. */
const INSPECT_MS = 240;
const INSPECT_RATE = 1000 / INSPECT_MS;

/** Spec pose: `rot.x -= 0.45; pos.y += 0.2`, in anchor-local (view) space. */
const INSPECT_RAISE_Y = 0.2;
const INSPECT_PITCH_X = -0.45;

/** Spec breathing loop. `performance.now() * 0.0025` == seconds * 2.5. */
const BREATH_HZ = 2.5;
const BREATH_POS_X = 0.004;
const BREATH_POS_Y = 0.005;
const BREATH_ROT_Z = 0.003;

/* Two extra低-amplitude axes so the pose never reads as a rigid 2-axis loop.
 * Frequencies are mutually irrational to the spec pair, so the composite never
 * visibly repeats. */
const BREATH_POS_Z = 0.0022;
const BREATH_ROT_Y = 0.0026;

/** How fast ADS is forced off when the panel opens, in units of blend/second. */
const ADS_BLEED_RATE = 6;

let applied = false;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Classic smootherstep — zero first AND second derivative at both ends, so the
 *  weapon neither snaps nor visibly "arrives" at the end of the 240 ms LERP. */
function smootherstep(x) {
  const t = clamp01(x);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Unscaled seconds. Engine clock first, wall clock only as a last resort. */
function unscaledNow(vm) {
  const t = vm && vm.ctx && vm.ctx.time;
  if (t && Number.isFinite(t.raw)) return t.raw;
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}

export function applyWeaponInspectBridge() {
  if (applied) return true;
  applied = true;

  const vmProto = Viewmodel && Viewmodel.prototype;
  if (!vmProto) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/inspect] Viewmodel не найден в ./viewmodel.js — качание при TAB отключено');
    }
    return false;
  }

  /* ------------------------------------------------------------ setInspect */

  vmProto.setInspect = function setInspect(on) {
    const want = on ? 1 : 0;
    if (this._inspectTarget === want) return want;
    this._inspectTarget = want;
    if (this._inspectT === undefined) this._inspectT = 0;
    /* Reset the breathing phase only on a cold start, so a fast TAB-TAB-TAB does
     * not visibly snap the loop back to zero mid-blend. */
    if (want === 1 && this._inspectT <= 0) {
      this._inspectClock = 0;
      this._inspectPrevRaw = -1;
    }
    return want;
  };

  Object.defineProperty(vmProto, 'inspecting', {
    configurable: true,
    get() {
      return (this._inspectT ?? 0) > 0 || (this._inspectTarget ?? 0) > 0;
    },
  });

  /* ---------------------------------------------------------------- update */

  const origUpdate = vmProto.update;
  if (typeof origUpdate !== 'function') {
    if (typeof console !== 'undefined') {
      console.error('[EFL/inspect] Viewmodel.prototype.update отсутствует — качание при TAB отключено');
    }
    return false;
  }

  vmProto.update = function patchedUpdate(dt, s) {
    if (this._inspectT === undefined) {
      this._inspectT = 0;
      this._inspectTarget = 0;
      this._inspectClock = 0;
      this._inspectPrevRaw = -1;
    }

    /* --- unscaled delta, immune to time.scale = 0 --- */
    const raw = unscaledNow(this);
    let rawDt = 0;
    if (this._inspectPrevRaw >= 0) rawDt = raw - this._inspectPrevRaw;
    this._inspectPrevRaw = raw;
    /* Clamp: an alt-tab or a breakpoint must not teleport the pose. */
    if (!(rawDt > 0)) rawDt = 0;
    else if (rawDt > 0.1) rawDt = 0.1;

    /* --- blend toward the target over exactly INSPECT_MS, both directions --- */
    const target = this._inspectTarget ?? 0;
    if (this._inspectT !== target && rawDt > 0) {
      const stepAmount = rawDt * INSPECT_RATE;
      if (target > this._inspectT) this._inspectT = Math.min(target, this._inspectT + stepAmount);
      else this._inspectT = Math.max(target, this._inspectT - stepAmount);
    }

    const k = smootherstep(this._inspectT);
    const active = this._inspectT > 0;

    /*
     * Force the sights down BEFORE the original runs. The original blends adsT
     * with `dt`, which is 0 while the panel is open, so writing adsT here is
     * both necessary (nothing else will move it) and safe (the original will
     * not overwrite it).
     */
    if (active && rawDt > 0) {
      this.adsTarget = 0;
      if (Number.isFinite(this.adsT)) {
        this.adsT = Math.max(0, this.adsT - rawDt * ADS_BLEED_RATE);
      }
      if (s) {
        s.ads = false;
        s.trigger = false;
      }
    }

    const res = origUpdate.apply(this, arguments);

    if (!active) return res;

    const anchor = this.anchor;
    if (!anchor) return res;

    this._inspectClock += rawDt;
    const t = this._inspectClock * BREATH_HZ;

    /*
     * Spec pose plus the breathing loop, all scaled by the blend so the sway
     * fades in and out with the raise instead of popping.
     *
     * translate* runs before rotate* on purpose: translate* projects along the
     * CURRENT quaternion, which at this point is still the camera basis, so the
     * offsets are true view-space metres. Rotating first would shear them.
     *
     * Scalar math only — Object3D.translateOnAxis / rotateOnAxis reuse three's
     * module-scope scratch, so this allocates nothing per frame
     * (ARCHITECTURE.md rule 5).
     */
    const dx = Math.sin(t * 0.8) * BREATH_POS_X * k;
    const dy = (INSPECT_RAISE_Y + Math.cos(t * 1.1) * BREATH_POS_Y) * k;
    const dz = Math.sin(t * 0.41) * BREATH_POS_Z * k;

    if (dx !== 0) anchor.translateX(dx);
    if (dy !== 0) anchor.translateY(dy);
    if (dz !== 0) anchor.translateZ(dz);

    const rx = INSPECT_PITCH_X * k;
    const ry = Math.sin(t * 0.37) * BREATH_ROT_Y * k;
    const rz = Math.sin(t * 0.5) * BREATH_ROT_Z * k;

    if (rx !== 0) anchor.rotateX(rx);
    if (ry !== 0) anchor.rotateY(ry);
    if (rz !== 0) anchor.rotateZ(rz);

    /* The original already solved the rig subtree against the untouched anchor.
     * Re-propagate so weapon, hands and reticle inherit the inspect transform. */
    anchor.updateMatrixWorld(true);

    return res;
  };

  /* --------------------------------------------------------- WeaponSystem */

  const wsProto = WeaponSystem && WeaponSystem.prototype;
  if (!wsProto) {
    if (typeof console !== 'undefined') {
      console.warn('[EFL/inspect] WeaponSystem не найден — инвентарь будет звать Viewmodel.setInspect напрямую');
    }
    return true;
  }

  /** Single entry point the inventory calls on show()/hide(). */
  wsProto.setInventoryInspect = function setInventoryInspect(on) {
    const want = !!on;
    this._inventoryInspect = want;

    /* Drop the trigger and latch it, so releasing the mouse over the panel
     * cannot queue a shot for the frame the panel closes. */
    if (want) {
      if (typeof this.setTrigger === 'function') {
        try {
          this.setTrigger(false);
        } catch (e) {
          /* weapon not built yet */
        }
      }
      this.triggerDown = false;
      this.triggerLatch = true;
    }

    const vm = this.viewmodel;
    if (vm && typeof vm.setInspect === 'function') vm.setInspect(want);
    return want;
  };

  Object.defineProperty(wsProto, 'inventoryInspecting', {
    configurable: true,
    get() {
      return !!this._inventoryInspect;
    },
  });

  /*
   * Second line of defence behind Input.fire. core/input.js already reports
   * fire === false while a UI surface owns the cursor, but a scripted or
   * gamepad path could still reach tryFire(), and `time.scale = 0` means
   * WeaponSystem.time never advances past nextShotAt — so any call that got
   * through would always pass the rate-of-fire gate.
   */
  const origTryFire = wsProto.tryFire;
  if (typeof origTryFire === 'function') {
    wsProto.tryFire = function patchedTryFire() {
      if (this._inventoryInspect) return false;
      return origTryFire.apply(this, arguments);
    };
  }

  return true;
}

export default applyWeaponInspectBridge;
