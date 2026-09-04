import { Movement } from './movement.js';
import { PlayerSystem } from './index.js';
import { clamp } from '../core/tarkovUtils.js';

let applied = false;

function syncHealthMotion(player) {
  const health = player?.ctx?.peek?.('health');
  if (!health) return;
  const m = player.movement;
  health.motion = {
    moving: (m?.horizontalSpeed ?? 0) > 0.15,
    sprinting: !!m?.sprinting,
    stance: m?.stance ?? 'stand',
    grounded: !!m?.grounded,
    airborne: !m?.grounded,
  };
}

export function applyTarkovPlayerPatch() {
  if (applied) return;
  applied = true;

  const origTargetSpeed = Movement.prototype.targetSpeed;
  Movement.prototype.targetSpeed = function patchedTargetSpeed(...args) {
    const base = origTargetSpeed.apply(this, args);
    const health = this.player?.ctx?.peek?.('health');
    const mult = health?.speedMultiplier?.({
      moving: (this.horizontalSpeed ?? 0) > 0.15,
      sprinting: !!this.sprinting,
      stance: this.stance,
      grounded: !!this.grounded,
      airborne: !this.grounded,
    }) ?? 1;
    return base * clamp(mult, 0, 1);
  };

  const origSprint = Movement.prototype._updateSprint;
  Movement.prototype._updateSprint = function patchedSprint(cmd, rawInput, forwardIntent) {
    const health = this.player?.ctx?.peek?.('health');
    if (health?.dead || (health?.blackedLegs?.() ?? 0) > 0) {
      this._sprintHoldTime = 0;
      this.sprinting = false;
      this.tacticalSprint = false;
      this._tacSprintTime = 0;
      this._tacSprintRequested = false;
      return;
    }
    return origSprint.call(this, cmd, rawInput, forwardIntent);
  };

  const origJump = Movement.prototype._doJump;
  Movement.prototype._doJump = function patchedJump(...args) {
    const health = this.player?.ctx?.peek?.('health');
    if (health) {
      health.stamina = Math.max(0, (health.stamina ?? 0) - 12);
    }
    return origJump.apply(this, args);
  };

  const origFixed = PlayerSystem.prototype.fixedUpdate;
  PlayerSystem.prototype.fixedUpdate = function patchedFixed(dt, ctx) {
    const out = origFixed.call(this, dt, ctx);
    syncHealthMotion(this);
    return out;
  };

  const origUpdate = PlayerSystem.prototype.update;
  PlayerSystem.prototype.update = function patchedUpdate(dt, ctx) {
    const out = origUpdate.call(this, dt, ctx);
    syncHealthMotion(this);
    return out;
  };
}
