import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'

import { Engine, STATE } from './core/engine.js';
import { createConfig } from './core/config.js';
import { MainMenuSystem } from './ui/mainMenu.js';
import { applyMainMenuBridge } from './ui/mainMenuBridge.js';
import { applyLobbyDeployFlags } from './ui/lobbyDeployFlags.js'

import { RenderSystem } from './render/index.js';
import { MaterialSystem } from './materials/index.js';
import { SkySystem } from './sky/index.js';
import { WorldSystem } from './world/index.js';
import { PhysicsSystem } from './physics/index.js';
import { PlayerSystem } from './player/index.js';
import { WeaponSystem } from './weapons/index.js';
import { FxSystem } from './fx/index.js';
import { AiSystem } from './ai/index.js';
import { UiSystem } from './ui/index.js';
import { Hud } from './ui/hud.js';
import { AudioSystem } from './audio/index.js';

// --- EFL ---
import { ItemsSystem } from './items/index.js';
import { InventorySystem } from './inventory/index.js';
import { HealthSystem } from './health/index.js';
import { MetaSystem } from './meta/index.js';
import { RaidSystem } from './raid/index.js';
import { NetSystem } from './net/index.js';
import { applyTarkovBootstrap } from './core/tarkovBootstrap.js';

import { installShotApi } from './dev/shots.js';
import { prewarm } from './core/prewarm.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
const lockstep = capture && params.get('lockstep') === '1';

applyTarkovBootstrap();

const config = createConfig({
  quality: params.get('q') ?? 'high',
  deterministic: capture,
});

const engine = new Engine({ canvas: document.getElementById('game'), config });

const diagnosticsHost = document.getElementById('diagnostics-root')
const diagnosticsRoot = diagnosticsHost ? createRoot(diagnosticsHost) : null
diagnosticsRoot?.render(createElement(App, { ctx: engine.ctx }))

/* Движок публикуется СРАЗУ, а не в конце модуля.
 *
 * ui/mainMenuBridge.js ищет живое меню через window.__ENGINE__.mainMenu, а
 * стартовый экран монтируется и становится кликабельным до `await
 * prewarm(engine)` — то есть за секунды до конца этого файла. Пока __ENGINE__
 * не выставлен, делегированный клик не находит ни инстанса меню, ни состояния
 * движка и молча уходит в никуда: ровно тот баг, из-за которого «НАСТРОЙКИ» не
 * открывали панель. */
window.__ENGINE__ = engine;

const ALL_STATES = [STATE.MENU, STATE.LOADING, STATE.GAMEPLAY, STATE.PAUSED, STATE.RESULTS];
const GAMEPLAY = [STATE.GAMEPLAY];

/* engine.add() принимает КЛАСС и сам делает new SystemClass(opts), поэтому
 * сюда нельзя передавать готовый экземпляр — new instance() бросает TypeError
 * и убивает загрузку.
 *
 * Порядок вызовов add() на порядок init() не влияет: registry.resolve() строит
 * его топологической сортировкой по static deps (именно поэтому UiSystem с
 * deps ['audio','meta'] спокойно регистрируется раньше AudioSystem и
 * MetaSystem). Hud объявляет deps = [] и берёт health/weapons/inventory/raid
 * лениво через ctx.peek() на каждом тике, так что зависимостей у него нет —
 * регистрируем последним, поверх остальных систем. */
engine
  .add(RenderSystem, { states: ALL_STATES })
  .add(MaterialSystem, { states: ALL_STATES })
  .add(SkySystem, { states: ALL_STATES })
  .add(WorldSystem, { states: GAMEPLAY })
  .add(PhysicsSystem, { states: GAMEPLAY })
  .add(PlayerSystem, { states: GAMEPLAY })
  .add(WeaponSystem, { states: GAMEPLAY })
  .add(FxSystem, { states: GAMEPLAY })
  .add(AiSystem, { states: GAMEPLAY })
  .add(UiSystem, { states: ALL_STATES })
  .add(AudioSystem, { states: ALL_STATES })
  .add(ItemsSystem, { states: ALL_STATES })
  .add(InventorySystem, { states: GAMEPLAY })
  .add(HealthSystem, { states: GAMEPLAY })
  .add(MetaSystem, { states: ALL_STATES })
  .add(RaidSystem, { states: GAMEPLAY })
  .add(NetSystem, { states: GAMEPLAY })
  .add(Hud, { states: GAMEPLAY });

try {
  await engine.init();
} catch (err) {
  console.error('[boot] init failed', err);
  throw err;
}

/* Мост «НАСТРОЙКИ» -> UiSystem.settingsMenu. Ставится ДО new MainMenuSystem()
 * и до mount(): applyMainMenuBridge() патчит прототип (openSettings,
 * showSettings, settingsMenuInstance) и оборачивает mount(), чтобы навесить
 * делегированный слушатель в фазе capture. Экземпляр, созданный раньше патча,
 * получил бы непропатченный mount, и слушатель бы так и не встал. Вызов
 * идемпотентен — повторные заходы (HMR) ничего не ломают. */
applyMainMenuBridge();
applyLobbyDeployFlags()

const mainMenu = new MainMenuSystem({
  engine,
  ctx: engine.ctx,
  mount: document.body,
  theme: 'default',
  buildVersion: '1.1.0.1.46777 | PvE',
  level: 100,
  nickname: 'Larpov',
  zone: 'PVE ZONE',
  expansionsLabel: 'EXPANSIONS',
  showSeasonBanner: true,
  showThemeChip: true,
});
engine.mainMenu = mainMenu;
mainMenu.mount();

const shotApi = installShotApi(engine, { capture, lockstep });

const warmup = params.get('prewarm') === '0'
  ? { ok: false, reason: 'disabled' }
  : await prewarm(engine);
console.info('[boot] prewarm', warmup);

engine.enterMenu();
engine.start();

const BOOT_FRAMES = 3;
if (lockstep) {
  await shotApi.pump(BOOT_FRAMES);
  window.__READY__ = true;
} else {
  let warm = 0;
  const probe = () => { if (++warm >= BOOT_FRAMES) window.__READY__ = true; else requestAnimationFrame(probe); };
  requestAnimationFrame(probe);
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  diagnosticsRoot?.unmount()
  engine.dispose()
});
