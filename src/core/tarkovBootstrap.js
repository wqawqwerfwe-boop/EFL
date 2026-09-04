import { applyTarkovPlayerPatch } from '../player/tarkovPlayerPatch.js';
import { applyTarkovPhysicsPatch } from '../physics/tarkovPhysicsPatch.js';
import { applyMainMenuBridge } from '../ui/mainMenuBridge.js';
import { applySettingsBridge } from '../ui/settingsBridge.js';
import { applyCharacterBridge } from '../ui/characterBridge.js';
import { applyWeaponInspectBridge } from '../weapons/inspectBridge.js';

/*
 * Единственный шов для патчей, которые обязаны встать ДО сборки движка.
 *
 * Вызывается первой строкой main.js, то есть раньше new Engine() и раньше
 * engine.init(). Это принципиально для settingsBridge: UiSystem создаёт
 * SettingsMenu внутри init(), а конструктор панели сразу зовёт applyAll().
 * Если патч опоздает, первый прогон настроек уйдёт в никуда.
 *
 * То же и для inspectBridge: WeaponSystem.init() строит Viewmodel, поэтому
 * Viewmodel.prototype.update должен быть уже обёрнут к этому моменту — иначе
 * первый рейд получит инвентарь без качания оружия.
 *
 * Каждый патч изолирован: падение одного моста не должно уронить загрузку
 * игры целиком.
 */
function step(name, fn) {
  try {
    fn();
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/bootstrap] патч "' + name + '" не установлен', err);
    }
  }
}

export function applyTarkovBootstrap() {
  step('player', applyTarkovPlayerPatch);
  step('physics', applyTarkovPhysicsPatch);

  /* Сначала настройки: mainMenuBridge умеет сам инстанцировать SettingsMenu,
   * и к этому моменту его прототип уже должен быть исправлен. */
  step('settings', applySettingsBridge);
  step('mainMenu', applyMainMenuBridge);

  /* Кнопка «ПЕРСОНАЖ» в нижней навигации стартового экрана. Ставим ПОСЛЕ
   * mainMenuBridge: оба патчат MainMenuSystem.prototype.mount, и порядок
   * обёрток определяет, чей bindDelegatedClick() встанет первым. */
  step('character', applyCharacterBridge);

  /* Качание оружия при TAB. Обязательно до WeaponSystem.init(). */
  step('weaponInspect', applyWeaponInspectBridge);
}

export default applyTarkovBootstrap;
