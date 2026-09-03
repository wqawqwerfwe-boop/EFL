/**
 * PLAYER — movement state machine, camera feel, tactical health bridge.
 *
 * ────────────────────────────────────────────────────────────────────────────
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
 * ────────────────────────────────────────────────────────────────────────────
 * HEALTH LIVES IN src/health/index.js — NOT HERE
 * ────────────────────────────────────────────────────────────────────────────
 * There used to be a second, player-local health model: ./health.js, one 0..100
 * arcade pool with a passive CoD regeneration loop. It is gone, and with it the
 * situation where two independent models both believed they owned the player's
 * HP — one of them quietly handing it back four seconds after every firefight.
 *
 * `HealthSystem` is now the single authority: seven limbs, each with its own HP
 * and effect bitfield, no passive regen, HP returned only by meds. THIS FILE
 * OWNS NO HP AND NO REGEN.
 *
 * What it does still own is the *view* half of being shot, because all of it is
 * camera- and screen-space and none of it belongs