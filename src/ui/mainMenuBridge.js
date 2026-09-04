/* ==========================================================================
 * Escape-From-Larpov · src/ui/mainMenuBridge.js
 *
 * «НАСТРОЙКИ» на стартовом экране не открывали ничего: MainMenuSystem не
 * владеет экземпляром SettingsMenu (его создаёт UiSystem у себя внутри) и
 * не имеет метода открытия панели, поэтому клик уходил в пустоту.
 *
 * Мост делает четыре вещи и ни одна из них не требует правок разметки меню:
 *   1. добавляет MainMenuSystem.prototype.openSettings() —
 *      он берёт готовый экземпляр у UiSystem, а если его нет,
 *      инстанцирует SettingsMenu сам и вызывает open();
 *   2. навешивает ОДИН делегированный слушатель клика в фазе capture,
 *      который распознаёт кнопку настроек по data-атрибуту или по подписи
 *      (НАСТРОЙКИ / SETTINGS / ОПЦИИ) и работает даже если меню
 *      перерисовывает свой DOM целиком;
 *   3. аккуратно отходит в сторону, когда клик пришёл из ESC-меню или из
 *      самой панели настроек — там свои обработчики;
 *   4. перекрывает легаси-подпись кнопки рейда: сразу после mount()
 *      'ESCAPE FROM TARKOV' в пунктах меню становится «ПОБЕГ ИЗ ЛАРПОВА»,
 *      без правок 84-килобайтного mainMenu.js.
 *
 * ВАЖНО: модуль не самоприменяется. applyMainMenuBridge() обязан быть вызван
 * из точки входа (src/main.js) ДО new MainMenuSystem() и до mount(), иначе
 * прототип останется непропатченным, слушатель не встанет, и «НАСТРОЙКИ»
 * снова будут молчать — именно так этот файл однажды и оказался мёртвым кодом,
 * на который никто не ссылался.
 *
 * Импорты НАМЕРЕННО неймспейсные: промах именованного импорта в ESM —
 * это ошибка СВЯЗЫВАНИЯ, которая роняет весь бандл. Слой мостов не имеет
 * права ронять загрузку игры.
 * ========================================================================== */

import * as MainMenuModule from './mainMenu.js'
import * as SettingsMenuModule from './settingsMenu.js'

const MainMenuSystem = MainMenuModule.MainMenuSystem || MainMenuModule.default || null
const SettingsMenu = SettingsMenuModule.SettingsMenu || SettingsMenuModule.default || null

const SETTINGS_TEXT = /^(настройки|настроики|settings|опции|options)$/i
const SETTINGS_TOKENS = [
  'settings',
  'setting',
  'open-settings',
  'opensettings',
  'options',
  'opts',
  'config',
]
const SKIP_ROOTS = '.efl-esc, .efl-set, #eftInv'
const MAX_WALK = 8

/* Ребрендинг: что ищем в подписях пунктов меню и на что меняем. */
const LEGACY_RAID_LABEL = 'ESCAPE FROM TARKOV'
const RAID_LABEL = 'ПОБЕГ ИЗ ЛАРПОВА'

/* Кандидаты на замену. Классы ОБОИХ поколений меню плюс голый button:
 * mainMenu.js рисует пункт как
 *   <button class="eft-item" data-action="raid"><span class="eft-item-txt">…
 * то есть '.efl-menu-item' и '[data-act="raid"]' сегодня не ловят ничего,
 * и держатся здесь только ради совместимости со старой разметкой. */
const RAID_ITEM_SELECTOR =
  '.efl-menu-item, .eft-item, [data-act="raid"], [data-action="raid"], button'

/* Внутренний span подписи: писать надо в него, а не в саму кнопку. */
const RAID_LABEL_SELECTOR = '.eft-item-txt, .efl-menu-item-txt'

let applied = false
let clickBound = false

function attrOf(node, name) {
  if (!node || typeof node.getAttribute !== 'function') return null
  const v = node.getAttribute(name)
  return v == null ? null : String(v).toLowerCase()
}

/** Значение совпадает с токеном настроек ЦЕЛИКОМ. */
function tokenHit(value) {
  if (value == null) return false
  const v = String(value).toLowerCase().trim()
  if (!v || v.length > 24) return false
  return SETTINGS_TOKENS.indexOf(v) >= 0
}

function looksLikeSettings(node) {
  if (!node || node.nodeType !== 1) return false

  /* Раньше здесь был фиксированный список data-атрибутов (data-act, data-nav,
   * data-tab, ...). Шестерёнка в правой колонке меню сквозь него проваливалась:
   * в TABS_RIGHT это { id: 'settings', icon: 'gear' } — подписи нет вообще
   * (label: ''), а под каким именно атрибутом меню разложит свой id, мост знать
   * не должен. Поэтому сверяем ВСЕ атрибуты узла, но только по полному
   * совпадению значения: 'settings' ловим, 'settings-hint' — нет. */
  const attrs = node.attributes
  if (attrs) {
    for (let i = 0; i < attrs.length; i++) {
      if (tokenHit(attrs[i].value)) return true
    }
  }
  if (tokenHit(node.id)) return true

  const label = attrOf(node, 'aria-label')
  if (label && SETTINGS_TEXT.test(label.trim())) return true

  /* Подпись. Короткий текст, чтобы не поймать контейнер целиком. */
  const text = node.textContent
  if (text) {
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed.length > 0 && trimmed.length <= 24 && SETTINGS_TEXT.test(trimmed)) return true
  }
  return false
}

function engineFrom(instance) {
  if (!instance) return null
  if (instance.engine) return instance.engine
  if (instance.options && instance.options.engine) return instance.options.engine
  if (instance.ctx && instance.ctx.engine) return instance.ctx.engine
  if (typeof window !== 'undefined' && window.__ENGINE__) return window.__ENGINE__
  return null
}

function ctxFrom(instance) {
  if (!instance) {
    if (typeof window !== 'undefined' && window.__ENGINE__) return window.__ENGINE__.ctx || null
    return null
  }
  if (instance.ctx) return instance.ctx
  if (instance.options && instance.options.ctx) return instance.options.ctx
  const engine = engineFrom(instance)
  return (engine && engine.ctx) || null
}

function uiSystemOf(ctx) {
  if (!ctx) return null
  if (typeof ctx.peek === 'function') {
    try {
      const ui = ctx.peek('ui')
      if (ui) return ui
    } catch (e) {
      /* UiSystem ещё не зарегистрирован */
    }
  }
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get('ui') || null
    } catch (e) {
      return null
    }
  }
  return null
}

/** Экземпляр панели настроек: сначала общий из UiSystem, потом свой. */
export function ensureSettingsMenu(instance) {
  const ctx = ctxFrom(instance)
  if (!ctx) {
    if (typeof console !== 'undefined') console.warn('[EFL/mainMenu] нет ctx — настройки не открыть')
    return null
  }

  const ui = uiSystemOf(ctx)
  if (ui && ui.settingsMenu) {
    if (instance) instance.settingsMenu = ui.settingsMenu
    return ui.settingsMenu
  }

  if (instance && instance.settingsMenu) return instance.settingsMenu

  if (!SettingsMenu) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/mainMenu] SettingsMenu не найден в ./settingsMenu.js')
    }
    return null
  }

  try {
    const menu = new SettingsMenu(ctx, { zIndex: 9800 })
    if (instance) instance.settingsMenu = menu
    if (ui && !ui.settingsMenu) ui.settingsMenu = menu
    return menu
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[EFL/mainMenu] SettingsMenu не создан', err)
    return null
  }
}

export function openMainMenuSettings(instance) {
  const menu = ensureSettingsMenu(instance)
  if (!menu) return null
  if (menu.isOpen) return menu
  try {
    menu.open()
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[EFL/mainMenu] SettingsMenu.open() упал', err)
    return null
  }
  return menu
}

function mainMenuInstance() {
  if (typeof window === 'undefined') return null
  const engine = window.__ENGINE__
  return (engine && engine.mainMenu) || null
}

function mainMenuIsUp(instance) {
  const engine = engineFrom(instance)
  if (engine && typeof engine.state === 'string') {
    /* Стартовая сцена — это STATE.MENU. В рейде за настройки отвечает ESC-меню. */
    if (engine.state !== 'menu' && engine.state !== 'boot' && engine.state !== 'loading') return false
  }
  if (instance && typeof instance.isOpen === 'function') {
    try {
      if (instance.isOpen()) return true
    } catch (e) {
      /* игнорируем */
    }
  }
  if (instance && instance.open === true) return true
  /* Если инстанс молчит, доверяем состоянию движка. */
  return !!engine
}

function onDocumentClick(event) {
  if (!event || event.defaultPrevented) return
  const target = event.target
  if (!target || target.nodeType !== 1) return

  /* ESC-меню и сама панель настроек обрабатывают свои кнопки сами. */
  if (typeof target.closest === 'function' && target.closest(SKIP_ROOTS)) return

  let node = target
  let hit = null
  for (let i = 0; i < MAX_WALK && node && node.nodeType === 1; i++) {
    if (looksLikeSettings(node)) {
      hit = node
      break
    }
    node = node.parentElement
  }
  if (!hit) return

  const instance = mainMenuInstance()
  if (!mainMenuIsUp(instance)) return

  event.preventDefault()
  if (typeof event.stopPropagation === 'function') event.stopPropagation()

  if (instance && typeof instance.openSettings === 'function') instance.openSettings()
  else openMainMenuSettings(instance)
}

function bindDelegatedClick() {
  if (clickBound || typeof document === 'undefined') return
  clickBound = true
  document.addEventListener('click', onDocumentClick, true)
}

/**
 * Перекрывает легаси-подпись пункта рейда.
 *
 * mainMenu.js держит подпись в захардкоженном MENU_ITEMS
 * ({ id: 'raid', label: 'ESCAPE FROM TARKOV', primary: true }), поэтому
 * менять текст в самом модуле меню не требуется: mount() уже положил
 * разметку в документ, и здесь мы просто переписываем подпись.
 *
 * @param {ParentNode} [scope] корень меню; по умолчанию весь документ
 * @returns {number} сколько подписей заменено
 */
export function rebrandRaidLabel(scope) {
  /* Ищем строго внутри меню, если корень известен: голый селектор button
   * иначе прошёлся бы по всем кнопкам страницы. */
  let root = null
  if (scope && typeof scope.querySelectorAll === 'function') root = scope
  else if (typeof document !== 'undefined') root = document
  if (!root) return 0

  const items = root.querySelectorAll(RAID_ITEM_SELECTOR)
  let hits = 0
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || item.nodeType !== 1) continue

    const text = item.textContent
    if (!text) continue
    if (text.replace(/\s+/g, ' ').trim() !== LEGACY_RAID_LABEL) continue

    /* textContent на самой кнопке снёс бы <span class="eft-item-txt">, а с ним
     * и white-space:nowrap из таблицы стилей меню. Поэтому сначала ищем span
     * подписи и пишем в него, и только если его нет — в сам узел. */
    const label =
      typeof item.querySelector === 'function' ? item.querySelector(RAID_LABEL_SELECTOR) : null
    if (label) label.textContent = RAID_LABEL
    else item.textContent = RAID_LABEL

    /* Подсказка и aria-подпись, если меню их проставило. */
    if (typeof item.getAttribute === 'function' && typeof item.setAttribute === 'function') {
      if (item.getAttribute('title') === LEGACY_RAID_LABEL) item.setAttribute('title', RAID_LABEL)
      if (item.getAttribute('aria-label') === LEGACY_RAID_LABEL) {
        item.setAttribute('aria-label', RAID_LABEL)
      }
    }
    hits++
  }
  return hits
}

export function applyMainMenuBridge() {
  if (applied) return MainMenuSystem
  applied = true

  const proto = MainMenuSystem && MainMenuSystem.prototype
  if (!proto) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/mainMenu] MainMenuSystem не найден в ./mainMenu.js — мост без прототипа')
    }
    /* Делегированный клик всё равно ставим: он умеет работать без инстанса. */
    bindDelegatedClick()
    return MainMenuSystem
  }

  const original = proto.openSettings

  proto.openSettings = function openSettings() {
    /* Если у меню уже был свой рабочий метод — уважаем его, но страхуем. */
    if (typeof original === 'function' && original !== proto.openSettings) {
      try {
        const res = original.call(this)
        if (this.settingsMenu && this.settingsMenu.isOpen) return res
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[EFL/mainMenu] родной openSettings() упал, открываем панель сами', err)
        }
      }
    }
    return openMainMenuSettings(this)
  }

  if (typeof proto.showSettings !== 'function') {
    proto.showSettings = function showSettings() {
      return this.openSettings()
    }
  }
  if (typeof proto.settingsMenuInstance !== 'function') {
    proto.settingsMenuInstance = function settingsMenuInstance() {
      return ensureSettingsMenu(this)
    }
  }

  /* Кнопка может рисоваться при mount() — вешаем делегирование после него. */
  const originalMount = proto.mount
  if (typeof originalMount === 'function') {
    proto.mount = function patchedMount() {
      const res = originalMount.apply(this, arguments)
      /* mount() добавляет корень в документ синхронно, так что подпись уже
       * можно перекрыть — до первого кадра, без мигания старого текста. */
      rebrandRaidLabel(this && this.root)
      bindDelegatedClick()
      return res
    }
  }

  bindDelegatedClick()
  return MainMenuSystem
}

export default applyMainMenuBridge
