import { P } from './atlas.js';
import { resetSpawn } from './particles.js';

/**
 * Tracers.
 *
 * A tracer is a burning pellet in the base of the round, so what you see is a
 * short, very bright, velocity-aligned streak that *travels* — the fact that it
 * takes time to cross the street is most of the read. Real muzzle velocity
 * (~900 m/s) crosses a 30 m street in 33 ms, i.e. two frames, so like every
 * shipped shooter we clamp the visual speed into a range that reads on screen
 * while keeping the departure and arrival times honest.
 *
 * Three sprites: a hot head, the streak core (HDR, blooms), and a longer, dimmer
 * afterglow behind it.
 *
 * ALIGNMENT (REFACTOR 3)
 * ----------------------
 * `from` is the MUZZLE DEVICE, handed over by weapons/muzzle.js through
 * ProjectileSim — never the camera. `dir` is `velocity.normalize()`. Both matter:
 *
 *   - a streak born at the eye has almost no screen-space velocity when you fire
 *     down the view axis, which is what produced the "bar flying at my face";
 *   - `stretch` in particles.js is a per-metre-per-second coefficient, so it MUST
 *     be solved against the visual speed actually used here. The old constants
 *     (0.26 / 0.6) multiplied a clamped 340 m/s into a ~5 m and ~12 m smear.
 *     Below, the smear is specified in METRES and the coefficient derived from
 *     it, so the streak is the length it claims to be at any speed.
 */

const MIN_SPEED = 55;
const MAX_SPEED = 340;

/** Visible streak length, in metres. Core / afterglow. */
const CORE_LEN = 0.85;
const GLOW_LEN = 2.1;

/** Push the birth point out of the flash cone at the crown of the muzzle. */
const BORE_CLEAR = 0.25;

/**
 * particles.js computes `len = size * (1 + stretch * screenSpeed)`, so to get a
 * target length in metres out of a given sprite size and visual speed:
 *
 *     stretch = (targetLen / size - 1) / speed
 *
 * Clamped to something positive, because a value of 0 switches the sprite out of
 * velocity-aligned mode entirely and back to a spinning billboard.
 */
function stretchFor(targetLen, size, speed) {
  const s = Math.max(1e-4, size);
  const v = Math.max(1, speed);
  return Math.max(0.002, (targetLen / s - 1) / v);
}

/**
 * @param {object} fx    FxSystem
 * @param {{x:number,y:number,z:number}} from  MUZZLE position, world space
 * @param {{x:number,y:number,z:number}} to    where the round is heading
 * @param {number} speed muzzle velocity, m/s
 * @param {object} [opts] { warm, dir } — `dir` is velocity.normalize() when the
 *                        caller already has it, which avoids re-deriving it from
 *                        a segment that may be shorter than the streak.
 */
export function spawnTracer(fx, from, to, speed, opts) {
  const rng = fx.rng;

  /* Direction: prefer the caller's velocity.normalize(). Falling back to the
   * segment is only correct while the round has not begun to drop. */
  let dx;
  let dy;
  let dz;
  const hint = opts && opts.dir;
  if (hint) {
    dx = hint.x;
    dy = hint.y;
    dz = hint.z;
    const hl = Math.hypot(dx, dy, dz);
    if (hl < 1e-6) return;
    dx /= hl;
    dy /= hl;
    dz /= hl;
  } else {
    dx = to.x - from.x;
    dy = to.y - from.y;
    dz = to.z - from.z;
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) return;
    dx /= l;
    dy /= l;
    dz /= l;
  }

  /* Flight distance along that direction. Using the projection rather than the
   * raw segment length keeps the life honest when `dir` was supplied. */
  const sx = to.x - from.x;
  const sy = to.y - from.y;
  const sz = to.z - from.z;
  const dist = Math.max(0, sx * dx + sy * dy + sz * dz);
  if (dist < 0.35) return;

  const v = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed || 260));
  const life = dist / v;
  const warm = (opts && opts.warm) != null ? opts.warm : 1;

  // Start a little out of the bore so the tracer is not born inside the flash.
  const ox = from.x + dx * BORE_CLEAR;
  const oy = from.y + dy * BORE_CLEAR;
  const oz = from.z + dz * BORE_CLEAR;

  // core streak
  let s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.STREAK;
  s.size0 = 0.055;
  s.size1 = 0.04;
  s.stretch = stretchFor(CORE_LEN, s.size0, v);
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.52 * warm; s.b0 = 0.18 * warm; s.i0 = 26;
  s.r1 = 1; s.g1 = 0.4 * warm; s.b1 = 0.12 * warm; s.i1 = 16;
  s.alphaCurve = 0.25;
  s.soft = 0.1;
  s.seed = rng.float();
  fx.emitAdd(s);

  // afterglow: longer, dimmer, sits behind the core
  s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.STREAK;
  s.size0 = 0.09;
  s.size1 = 0.07;
  s.stretch = stretchFor(GLOW_LEN, s.size0, v);
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.33 * warm; s.b0 = 0.1 * warm; s.i0 = 5.5;
  s.r1 = 1; s.g1 = 0.24 * warm; s.b1 = 0.06 * warm; s.i1 = 2.5;
  s.alphaCurve = 0.3;
  s.soft = 0.14;
  s.seed = rng.float();
  fx.emitAdd(s);

  // incandescent head: round, NOT stretched — stretch stays 0 so it stays a dot
  s = resetSpawn();
  s.x = ox; s.y = oy; s.z = oz;
  s.vx = dx * v; s.vy = dy * v; s.vz = dz * v;
  s.tile = P.SPARK;
  s.size0 = 0.05;
  s.size1 = 0.042;
  s.life = life;
  s.drag = 0.02;
  s.gravity = -1.2;
  s.r0 = 1; s.g0 = 0.85; s.b0 = 0.6; s.i0 = 30;
  s.r1 = 1; s.g1 = 0.6; s.b1 = 0.3; s.i1 = 18;
  s.alphaCurve = 0.2;
  s.soft = 0.08;
  s.seed = rng.float();
  fx.emitAdd(s);
}
