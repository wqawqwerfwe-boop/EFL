import * as THREE from 'three';

/*
 * Escape from Larpov — muzzle / bore solver.
 *
 * THE DEFECT THIS FILE EXISTS TO FIX
 * ----------------------------------
 * WeaponSystem.tryFire() used to read the camera's world matrix and spawn every
 * round at e[12..14] travelling along -e[8..10]. That is the eye, not the gun,
 * and it breaks three things at once:
 *
 *   - the tracer is born inside the near plane, so it reads as a bar flying at
 *     your face rather than a streak leaving the barrel;
 *   - the muzzle flash (which IS spawned at the barrel, see fx/muzzle.js) and
 *     the round no longer share an origin, so the two visually disagree;
 *   - firing past a corner works from the eye but not from the barrel, which is
 *     exactly backwards.
 *
 * WHAT A SHIPPED SHOOTER ACTUALLY DOES
 * ------------------------------------
 * Two rays, never one:
 *
 *   1. AIM RAY    from the eye, down the view axis. This is what the player is
 *                 pointing at and what the reticle promises.
 *   2. BULLET RAY from the MUZZLE DEVICE node, toward whatever the aim ray
 *                 resolved to.
 *
 * The two converge, so the round leaves the barrel tip (correct perspective,
 * correct flash/tracer origin) and still lands under the reticle (correct feel).
 * Convergence is what prevents the naive barrel-origin artefact — "my muzzle is
 * 120 mm right of and 60 mm below my eye, so at 3 m I miss by a hand".
 *
 * FAILURE MODES ARE HANDLED, NOT IGNORED
 * --------------------------------------
 *  - no viewmodel / unarmed        -> eye origin nudged forward past the near plane
 *  - muzzle buried inside geometry -> eye origin (you cannot shoot through a wall
 *                                     just because the barrel clipped into it)
 *  - muzzle behind the eye plane   -> eye origin (sprint / inspect poses)
 *  - degenerate convergence        -> fall back to the bore axis
 *
 * Allocation-free. One instance is owned by WeaponSystem; every vector below is
 * overwritten in place, never re-created.
 */

/** How far down the view axis we look for something to converge on. */
const CONVERGE_MAX = 600;
/** Below this the muzzle is treated as coincident with the eye. */
const MIN_SEPARATION = 1e-4;
/** A muzzle further off the view axis than this is a broken pose, not a pose. */
const MAX_OFFSET = 1.2;
/** Push the fallback origin past the near plane so nothing spawns in the lens. */
const EYE_PUSH = 0.18;

function maskAll(phys) {
  if (!phys) return 3;
  if (Number.isFinite(phys.MASK_ALL)) return phys.MASK_ALL;
  if (phys.MASK && Number.isFinite(phys.MASK.ALL)) return phys.MASK.ALL;
  return 3;
}

function maskWorld(phys) {
  if (!phys) return 1;
  if (Number.isFinite(phys.MASK_WORLD)) return phys.MASK_WORLD;
  if (phys.MASK && Number.isFinite(phys.MASK.WORLD)) return phys.MASK.WORLD;
  return 1;
}

export class MuzzleSolver {
  constructor() {
    /** Where the round is instantiated. World space. */
    this.origin = new THREE.Vector3();
    /** Unit direction the round travels. World space. */
    this.dir = new THREE.Vector3(0, 0, -1);

    /** The eye and its forward axis, for anything that needs the aim ray. */
    this.eye = new THREE.Vector3();
    this.eyeDir = new THREE.Vector3(0, 0, -1);
    /** The point the aim ray resolved to (a real hit, or the convergence cap). */
    this.aim = new THREE.Vector3();
    /** Raw bore axis of the viewmodel, before convergence. */
    this.bore = new THREE.Vector3(0, 0, -1);

    /** True when `origin` really is the barrel tip. Diagnostics + FX reuse. */
    this.fromMuzzle = false;
    /** Distance the aim ray travelled before it hit something (or the cap). */
    this.aimDistance = CONVERGE_MAX;
    /** Why we fell back, when we did. '' means the muzzle path was used. */
    this.reason = '';

    this._muzzle = new THREE.Vector3();
    this._delta = new THREE.Vector3();
  }

  /**
   * Resolve the firing origin and direction for this shot.
   *
   * @param {object}  o
   * @param {THREE.Camera} o.camera     world camera (the eye)
   * @param {object}  [o.viewmodel]     Viewmodel instance (muzzleWorld/boreDir)
   * @param {object}  [o.physics]       PhysicsSystem, for the aim ray
   * @param {object}  [o.shooter]       bot actor, used when there is no camera
   * @param {number}  [o.converge]      convergence cap in metres
   * @returns {this}
   */
  solve(o) {
    const cam = o && o.camera ? o.camera : null;
    const vm = o && o.viewmodel ? o.viewmodel : null;
    const phys = o && o.physics ? o.physics : null;
    const shooter = o && o.shooter ? o.shooter : null;
    const converge = Number.isFinite(o && o.converge) ? o.converge : CONVERGE_MAX;

    this.fromMuzzle = false;
    this.reason = '';

    /* ---- 1. the eye and the aim axis ------------------------------------ */
    if (cam) {
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      this.eye.set(e[12], e[13], e[14]);
      this.eyeDir.set(-e[8], -e[9], -e[10]);
    } else if (shooter && shooter.position && shooter.forward) {
      /* Bots have no camera: their "eye" is the shoulder line. */
      this.eye.set(shooter.position.x, shooter.position.y + 1.5, shooter.position.z);
      this.eyeDir.set(shooter.forward.x, shooter.forward.y, shooter.forward.z);
    } else {
      this.reason = 'no-camera';
      return this;
    }
    if (this.eyeDir.lengthSq() < 1e-12) {
      this.eyeDir.set(0, 0, -1);
    } else {
      this.eyeDir.normalize();
    }
    this.bore.copy(this.eyeDir);

    /* ---- 2. what is the player pointing at? ----------------------------- */
    this.aimDistance = converge;
    if (phys && typeof phys.raycast === 'function') {
      try {
        const hit = phys.raycast(this.eye, this.eyeDir, converge, maskAll(phys));
        if (hit && hit.hit && Number.isFinite(hit.distance) && hit.distance > 0.05) {
          this.aimDistance = hit.distance;
        }
      } catch (err) {
        /* The aim ray is an optimisation, not a requirement. */
      }
    }
    this.aim.copy(this.eye).addScaledVector(this.eyeDir, this.aimDistance);

    /* ---- 3. the muzzle device ------------------------------------------- */
    let haveMuzzle = false;
    if (vm && vm.active && typeof vm.muzzleWorld === 'function') {
      try {
        vm.muzzleWorld(this._muzzle);
        haveMuzzle = Number.isFinite(this._muzzle.x)
          && Number.isFinite(this._muzzle.y)
          && Number.isFinite(this._muzzle.z);
      } catch (err) {
        haveMuzzle = false;
      }
      if (haveMuzzle && typeof vm.boreDir === 'function') {
        try {
          vm.boreDir(this.bore);
          if (this.bore.lengthSq() < 1e-12) this.bore.copy(this.eyeDir);
        } catch (err) {
          this.bore.copy(this.eyeDir);
        }
      }
    }

    if (!haveMuzzle) {
      this.reason = 'no-muzzle';
      return this._useEye();
    }

    /* Reject broken poses instead of firing sideways out of them. */
    this._delta.copy(this._muzzle).sub(this.eye);
    const sep = this._delta.length();
    if (sep < MIN_SEPARATION) {
      this.reason = 'coincident';
      return this._useEye();
    }
    if (sep > MAX_OFFSET) {
      this.reason = 'muzzle-too-far';
      return this._useEye();
    }
    /* Behind the eye plane: sprint / reload / inspect have the gun off-camera. */
    if (this._delta.dot(this.eyeDir) <= 0.01) {
      this.reason = 'muzzle-behind-eye';
      return this._useEye();
    }
    /* Barrel clipped into geometry. You do not get to shoot through the wall. */
    if (phys && typeof phys.raycast === 'function') {
      try {
        this._delta.divideScalar(sep);
        const blocked = phys.raycast(this.eye, this._delta, sep, maskWorld(phys));
        if (blocked && blocked.hit) {
          this.reason = 'muzzle-occluded';
          return this._useEye();
        }
      } catch (err) {
        /* fall through: occlusion test is advisory */
      }
    }

    /* ---- 4. converge the bullet ray on the aim point --------------------- */
    this.origin.copy(this._muzzle);
    this.dir.copy(this.aim).sub(this.origin);
    if (this.dir.lengthSq() < 1e-10) {
      this.dir.copy(this.bore);
    } else {
      this.dir.normalize();
    }
    /*
     * Sanity gate. At contact range the convergence vector can swing wildly
     * (the aim point is between the eye and the muzzle plane), which would send
     * the round back past the player. Below ~1.5 m we hand over to the bore axis,
     * which is both physically right and stable.
     */
    if (this.aimDistance < 1.5 || this.dir.dot(this.eyeDir) < 0.2) {
      this.dir.copy(this.bore);
    }

    this.fromMuzzle = true;
    return this;
  }

  /** Fallback: eye origin, nudged past the near plane, along the view axis. */
  _useEye() {
    this.origin.copy(this.eye).addScaledVector(this.eyeDir, EYE_PUSH);
    this.dir.copy(this.eyeDir);
    this.fromMuzzle = false;
    return this;
  }
}

export default MuzzleSolver;
