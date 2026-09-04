import { peek } from '../core/tarkovUtils.js';

export function buildViewmodelState(ctx) {
  const weapons = peek(ctx, 'weapons');
  const player = peek(ctx, 'player');
  const hud = typeof weapons?.getHudState === 'function' ? weapons.getHudState() : weapons?.hudState?.() ?? null;
  return {
    ads: !!(hud?.ads ?? player?.adsRequested ?? player?.adsAmount > 0.5),
    sprint: !!(player?.sprinting ?? player?.movement?.sprinting ?? hud?.sprint),
    lowReady: false,
    speed: player?.horizontalSpeed ?? player?.speed ?? 0,
    crouch: player?.stance === 'crouch',
    airborne: !!player?.airborne,
    trigger: !!(weapons?.triggerDown ?? weapons?.triggerLatch),
    empty: !!(hud && hud.ammo <= 0),
    reloading: !!hud?.reloading,
  };
}

export function mountViewmodelBridge(ctx, vm) {
  if (!ctx || !vm) return null;
  return {
    vm,
    update(dt) {
      vm.update?.(dt, buildViewmodelState(ctx));
    },
    dispose() {
      vm.dispose?.();
    },
  };
}
