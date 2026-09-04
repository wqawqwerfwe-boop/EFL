/* ==========================================================================
 * Escape-From-Larpov · src/ui/escapeMenu.js
 * ESC-меню внутри рейда: Пауза -> Предупреждение -> Дезертирство.
 *
 * НЕ импортирует ./settingsMenu.js: тот берёт ensureTarkovFonts отсюда,
 * и статический импорт в обратную сторону замыкал ESM-цикл. Панель
 * настроек приходит снаружи через options.settingsFactory.
 * ========================================================================== */

import {
  ESCAPE_MENU_CSS,
  ICON_GEAR,
  ICON_ALERT,
  ICON_USER,
  ICON_CLOCK,
  ICON_EXIT,
  PMC_SILHOUETTE,
  LEVEL_CLAW,
} from './escapeMenuTheme.js'

/* Единственный источник истины — src/core/engine.js. Строки обязаны совпадать
 * с ядром посимвольно. Engine.setState() НЕ валидирует аргумент — любая
 * опечатка кладёт state в мусор, и Engine._canRun() перестаёт пропускать все
 * игровые подсистемы без единого исключения в консоли. */
export const STATE = Object.freeze({
  BOOT: 'boot',
  MENU: 'menu',
  LOADING: 'loading',
  GAMEPLAY: 'gameplay',
  PAUSED: 'paused',
  RESULTS: 'results',
})

export const ESC_SCREEN = {
  PAUSE: 'pause',
  ABANDON: 'abandon',
  DESERTED: 'deserted',
}

export const MAP_CATALOG = {
  factory: {
    id: 'factory',
    title: 'Завод',
    thumbnail: 'assets/maps/factory.jpg',
    accent: 'linear-gradient(135deg, #3b3a34 0%, #22211d 55%, #14140f 100%)',
    description:
      'Территория и производственные помещения химического комбината №21 были незаконно сданы ' +
      'компании TerraGroup. В период Контрактных Войн здесь проходили бои между подразделениями USEC и ' +
      'BEAR, определяющие контроль за заводским районом города Таркова.',
  },
  woods: {
    id: 'woods',
    title: 'Лес',
    thumbnail: 'assets/maps/woods.jpg',
    accent: 'linear-gradient(135deg, #2f3a2c 0%, #1d241b 55%, #10140e 100%)',
    description:
      'Обширный лесной массив западнее Таркова, через который проходит старая лесовозная дорога и ' +
      'периметр лесопильного комплекса. Основной маршрут эвакуации гражданских в первые недели конфликта.',
  },
  customs: {
    id: 'customs',
    title: 'Таможня',
    thumbnail: 'assets/maps/customs.jpg',
    accent: 'linear-gradient(135deg, #3a352c 0%, #241f19 55%, #14110d 100%)',
    description:
      'Пограничный таможенный терминал и складская зона порта. Здесь TerraGroup вывозила документацию ' +
      'после начала беспорядков; сейчас район контролируют банды диких.',
  },
  cyberlarp: {
    id: 'cyberlarp',
    title: 'CyberLarp',
    thumbnail: 'assets/maps/cyberlarp.jpg',
    accent: 'linear-gradient(135deg, #2a1240 0%, #101033 55%, #05060f 100%)',
    description:
      'Экспериментальный сектор с неоновой застройкой и автономными дронами-наблюдателями TerraGroup. ' +
      'Зона повышенной радиоэлектронной активности.',
  },
}

/* function declaration, не const: settingsMenu.js импортирует именно её, и
 * хойстинг делает её доступной даже при частичной инициализации модуля. */
export function ensureTarkovFonts() {
  if (typeof document === 'undefined') return
  if (document.getElementById('efl-fonts')) return
  const pre1 = document.createElement('link')
  pre1.rel = 'preconnect'
  pre1.href = 'https://fonts.googleapis.com'
  const pre2 = document.createElement('link')
  pre2.rel = 'preconnect'
  pre2.href = 'https://fonts.gstatic.com'
  pre2.crossOrigin = 'anonymous'
  const css = document.createElement('link')
  css.id = 'efl-fonts'
  css.rel = 'stylesheet'
  css.href = 'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@200;300;400;500;600;700&display=swap'
  document.head.appendChild(pre1)
  document.head.appendChild(pre2)
  document.head.appendChild(css)
}

/* Отсутствующий метод — не ошибка. try/catch здесь намеренно: исключение
 * ВНУТРИ существующего метода раньше пробивало UI насквозь и рвало переход. */
export function call(target, method, ...args) {
  if (!target) return undefined
  const fn = target[method]
  if (typeof fn !== 'function') return undefined
  try {
    return fn.apply(target, args)
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[EFL/ui] ' + method + '() бросил исключение, проигнорировано', err)
    return undefined
  }
}

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/* AudioSystem.playUi(kind) уходит в play(kind) -> this._bank[kind], а в банке
 * только процедурные виды (ui, click, hitmark, pickup, door, loot...).
 * 'банку неизвестные' back/hover/alert тихо возвращали null — половина
 * интерфейса была беззвучной. Сопоставляем псевдонимы с реальными видами. */
export const UI_SOUND_ALIASES = {
  ui: 'ui',
  click: 'click',
  ok: 'click',
  confirm: 'click',
  accept: 'click',
  apply: 'click',
  toggle: 'click',
  back: 'ui',
  cancel: 'ui',
  close: 'ui',
  open: 'ui',
  hover: 'ui',
  focus: 'ui',
  tab: 'ui',
  step: 'ui',
  alert: 'hitmark',
  warn: 'hitmark',
  error: 'hitmark',
  danger: 'hitmark',
  levelup: 'pickup',
  reward: 'pickup',
  success: 'pickup',
}

export function playUiSound(audio, name) {
  if (!audio) return
  const key = typeof name === 'string' ? name : 'ui'
  const kind = UI_SOUND_ALIASES[key] || 'ui'
  if (typeof audio.playUi === 'function') {
    call(audio, 'playUi', kind)
    return
  }
  call(audio, 'play', kind, null, null)
}

/* --------------------------------------------------------------------------
 * Совместимость с миксером.
 *
 * src/audio/index.js умеет ровно: play, playUi, stun, setIndoor, setVolume,
 * setMuted, setPaused, resume. А UI звал setMasterVolume / setUiVolume /
 * setMusicVolume / setHideoutVolume (SettingsMenu) и duck / unduck /
 * stopRaidAmbience / stopHideoutLoop / playMenuMusic (этот файл). Ни одного из
 * них не существовало: всё шло через безопасный call() и просто исчезало,
 * то есть ползунки громкости были декорацией. Один адаптер на инстанс
 * делает все существующие места вызова рабочими и непадающими.
 * ------------------------------------------------------------------------ */
export function installAudioCompat(audio) {
  if (!audio) return null
  if (audio.__eflAudioCompat) return audio
  try {
    Object.defineProperty(audio, '__eflAudioCompat', { value: true, enumerable: false, configurable: true })
  } catch (e) {
    audio.__eflAudioCompat = true
  }

  const mix = {
    master: typeof audio.masterVolume === 'number' ? audio.masterVolume : 0.75,
    ui: 0.6,
    music: 0.45,
    hideout: 0.55,
    duck: 1,
  }
  audio.mix = mix

  const applyMaster = () => {
    const v = clamp01(mix.master * mix.duck)
    if (typeof audio.setVolume === 'function') {
      call(audio, 'setVolume', v)
      return
    }
    audio.masterVolume = v
    if (audio.master && audio.master.gain) audio.master.gain.value = v
  }

  const define = (name, fn) => {
    if (typeof audio[name] === 'function') return
    audio[name] = fn
  }

  define('setMasterVolume', (v) => { mix.master = clamp01(v); applyMaster() })
  define('getMasterVolume', () => mix.master)
  define('setUiVolume', (v) => { mix.ui = clamp01(v) })
  define('setMusicVolume', (v) => { mix.music = clamp01(v) })
  define('setHideoutVolume', (v) => { mix.hideout = clamp01(v) })

  /* duck(amount, fadeMs): fade игнорируем, у мастер-гейна нет рампы. */
  define('duck', (amount) => { mix.duck = clamp01(amount == null ? 0.35 : amount); applyMaster() })
  define('unduck', () => { mix.duck = 1; applyMaster() })

  /* Потоковых лупов в процедурном банке нет — безопасные заглушки. */
  define('stopRaidAmbience', () => {})
  define('stopHideoutLoop', () => {})
  define('stopMenuMusic', () => {})
  define('playMenuMusic', () => {})
  define('playMenuAmbience', () => {})

  return audio
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n
}

export function formatRaidClock(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return pad2(h) + ':' + pad2(m) + ':' + pad2(s)
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ==========================================================================
 * EscapeMenuSystem
 *
 * ЕДИНСТВЕННЫЙ владелец клавиши Escape. Раньше их было два: здесь
 * (document, capture) и в UiSystem (window, capture). Оконный срабатывал раньше
 * и звал stopPropagation(), поэтому этот вообще не получал событие. Оконный
 * удалён из ui/index.js.
 *
 * Клавиша Tab здесь НЕ обрабатывается и никогда не будет: инвентарь —
 * единственный владелец Tab (src/inventory/index.js).
 * ========================================================================== */
export class EscapeMenuSystem {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options || {}

    this.root = null
    this.screen = null
    this.open = false
    this.destroyed = false

    this.buildVersion = this.options.buildVersion || '1.1.0.1.46911'
    this.raidMode = this.options.raidMode || 'TRAINING'
    this.gameMode = this.options.gameMode || 'PvE'

    this.settingsMenu = null
    this._clockTimer = null
    this._deserted = false
    this._raidElapsedMs = 0
    this._fallbackStart = Date.now()

    /* Заявки на курсор. Пока хотя бы один оверлей держит мышь, потеря
     * pointer lock НЕ считается альт-табом и пауза не открывается. */
    this._cursorHolds = new Set()
    this._lockProbe = 0

    this._onKeyDown = this._onKeyDown.bind(this)
    this._onClick = this._onClick.bind(this)
    this._onPointerLockChange = this._onPointerLockChange.bind(this)

    ensureTarkovFonts()
    this._injectStyles()
    installAudioCompat(this._svc('audio'))

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this._onKeyDown, true)
      document.addEventListener('pointerlockchange', this._onPointerLockChange, false)
    }
  }

  /* ---------------------------------------------------------------- сервисы */
  /* Registry хранит ТОЛЬКО подсистемы со static id, и ctx.get() бросает для
   * всего остального. 'state', 'input', 'bus', 'events', 'hud' и 'mainMenu'
   * подсистемами никогда не были — они живут на ctx/engine напрямую. */
  _svc(name) {
    const ctx = this.ctx
    if (!ctx) return null
    if (typeof ctx.peek === 'function') {
      try { return ctx.peek(name) } catch (e) { return null }
    }
    if (typeof ctx.get === 'function') {
      try { return ctx.get(name) } catch (e) { return null }
    }
    return null
  }

  _engine() {
    if (this.ctx && this.ctx.engine) return this.ctx.engine
    if (this.options.engine) return this.options.engine
    return null
  }

  _engineState() {
    const engine = this._engine()
    return engine && typeof engine.state === 'string' ? engine.state : null
  }

  _audio() {
    return installAudioCompat(this._svc('audio'))
  }

  _ui(sound) {
    playUiSound(this._audio(), sound)
  }

  _emit(type, payload) {
    const events = this.ctx && this.ctx.events
    if (events && typeof events.emit === 'function') {
      try { events.emit(type, payload) } catch (e) { /* EventBus сам логирует */ }
    }
    if (typeof this.options.onEvent === 'function') {
      try { this.options.onEvent(type, payload) } catch (e) {}
    }
  }

  _injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById('efl-escape-menu-css')) return
    const style = document.createElement('style')
    style.id = 'efl-escape-menu-css'
    style.textContent = ESCAPE_MENU_CSS
    document.head.appendChild(style)
  }

  /* ------------------------------------------------- заявка на курсор (публично) */

  /**
   * Оверлей, который намеренно отдаёт pointer lock, обязан сказать об этом.
   * Иначе pointerlockchange неотличим от альт-таба и мы уроним игру в паузу.
   */
  holdCursor(owner) {
    this._cursorHolds.add(owner == null ? 'anonymous' : owner)
  }

  releaseCursor(owner) {
    this._cursorHolds.delete(owner == null ? 'anonymous' : owner)
  }

  isCursorHeld() {
    if (this._cursorHolds.size > 0) return true
    if (this._inventoryOpen()) return true
    if (this.settingsMenu && this.settingsMenu.isOpen) return true
    const raidResult = this._svc('ui')
    if (raidResult && raidResult.raidResult && raidResult.raidResult.isOpen) return true
    return false
  }

  _inventory() {
    return this._svc('inventory')
  }

  _inventoryOpen() {
    const inv = this._inventory()
    return !!(inv && inv.open)
  }

  /* -------------------------------------------------------------- данные */
  get currentMap() {
    const raid = this._svc('raid')
    const id = (raid && raid.mapId) || this.options.mapId || 'factory'
    return MAP_CATALOG[id] || MAP_CATALOG.factory
  }

  playerLevel() {
    const meta = this._svc('meta')
    if (meta && meta.P && Number.isFinite(meta.P.lvl)) return meta.P.lvl
    return Number.isFinite(this.options.level) ? this.options.level : 1
  }

  nickname() {
    const meta = this._svc('meta')
    if (meta && meta.P && meta.P.nick) return String(meta.P.nick)
    return this.options.nickname || 'LARPOV'
  }

  get raidStartedAt() {
    return this._fallbackStart
  }

  ownsResultsScreen() {
    return !!(this.open && !this.destroyed && this.screen === ESC_SCREEN.DESERTED)
  }

  /* ------------------------------------------------------------- клавиатура */

  /**
   * Строго одна клавиша: Escape. Всё остальное — включая Tab — уходит
   * дальше без preventDefault и без stopPropagation. Пауза НИКОГДА не реагирует
   * на Tab: инвентарём владеет InventorySystem и только он.
   */
  _onKeyDown(event) {
    if (this.destroyed) return
    if (!event) return

    /* Tab — чужая клавиша. Явный выход вынесен отдельной строкой, чтобы никто
     * больше не добавил сюда ветку переключения инвентаря. */
    if (event.code === 'Tab') return
    if (event.code !== 'Escape') return

    /* SettingsMenu регистрирует свой capture-слушатель позже нашего, а на
     * одном и том же узле capture-слушатели идут в порядке регистрации.
     * Без этого выхода мы бы съели Escape и панель настроек не закрылась. */
    if (this.settingsMenu && this.settingsMenu.isOpen) return

    /* Точно так же уступаем инвентарю. Его слушатель висит на window в фазе
     * всплытия, то есть ПОСЛЕ нашего document-capture. Раньше мы глушили
     * событие через stopPropagation(), инвентарь Escape не видел и оставался
     * открытым навсегда при time.scale === 0. */
    if (this._inventoryOpen()) return

    const state = this._engineState()

    if (state === STATE.GAMEPLAY) {
      event.preventDefault()
      event.stopPropagation()
      this.openMenu()
      return
    }

    if (state === STATE.PAUSED) {
      event.preventDefault()
      event.stopPropagation()
      if (this.screen === ESC_SCREEN.ABANDON) {
        this._ui('back')
        this.showScreen(ESC_SCREEN.PAUSE)
        return
      }
      this.resumeGameplay()
      return
    }

    /* MENU / LOADING / RESULTS — Escape нас не касается. Не глушим событие. */
  }

  /**
   * Потеря pointer lock — эвристика альт-таба, а не факт. Любое окно,
   * которому нужен курсор (инвентарь на Tab, настройки, итоги рейда),
   * легитимно отдаёт lock сам. До этого фильтра Tab уронял игру в PAUSED.
   */
  _onPointerLockChange() {
    if (this.destroyed || this.open) return
    if (this.options.openOnPointerLockLost === false) return
    if (typeof document === 'undefined') return
    if (document.pointerLockElement) return

    /* Оверлей забрал мышь сознательно — это не альт-таб. */
    if (this.isCursorHeld()) return

    /* Только из GAMEPLAY: в MENU/RESULTS движок сам снимает захват курсора
     * в _setInputActive(false), и открывать меню паузы там нельзя. */
    if (this._engineState() !== STATE.GAMEPLAY) return

    /* Откладываем на кадр: пара release -> requestPointerLock внутри одного
     * жеста не должна считаться потерей. */
    const probe = ++this._lockProbe
    const check = () => {
      if (this.destroyed || this.open) return
      if (probe !== this._lockProbe) return
      if (typeof document === 'undefined') return
      if (document.pointerLockElement) return
      if (this.isCursorHeld()) return
      if (this._engineState() !== STATE.GAMEPLAY) return
      this.openMenu()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(check)
    else setTimeout(check, 16)
  }

  /* ---------------------------------------------------------------- ввод */
  /* Input — это ctx.input, а не подсистема реестра, и у него нет
   * setEnabled() — только поля enabled/frozen. Прежний вызов
   * call(_svc('input'), 'setEnabled', false) промахивался дважды, и игрок
   * продолжал стрелять и крутить камеру сквозь меню паузы. */
  _setInputActive(active) {
    const engine = this._engine()
    if (engine && typeof engine._setInputActive === 'function') {
      call(engine, '_setInputActive', active)
      return
    }
    const input = this.ctx && this.ctx.input
    if (input) {
      input.enabled = !!active
      input.frozen = !active
    }
    if (!active && typeof document !== 'undefined' && typeof document.exitPointerLock === 'function') {
      try { document.exitPointerLock() } catch (e) {}
    }
  }

  /* -------------------------------------------------------- открыть / закрыть */
  openMenu() {
    if (this.destroyed || this.open) return

    /* Над инвентарем пауза не встаёт никогда. */
    if (this._inventoryOpen()) return

    const engine = this._engine()
    const state = this._engineState()

    /* Однонаправленный поток: сначала просим ядро сменить состояние,
     * слушатель 'state' в UiSystem вернётся сюда уже в PAUSED — DOM
     * рендерится ровно один раз, рекурсия гаснет на первом шаге. */
    if (state !== STATE.PAUSED && engine && typeof engine.setState === 'function') {
      if (state !== STATE.GAMEPLAY) return
      engine.setState(STATE.PAUSED)
      return
    }

    this.open = true
    this._deserted = false

    this._setInputActive(false)
    const audio = this._audio()
    call(audio, 'duck', 0.35, 180)

    this._render()
    this.showScreen(ESC_SCREEN.PAUSE)
    this._ui('open')
    this._emit('esc:opened', { screen: ESC_SCREEN.PAUSE })
  }

  resumeGameplay() {
    if (this.destroyed) return

    /* Снимаем DOM и флаг ДО передачи перехода ядру, иначе обратный
     * вызов из UiSystem увидит open === true и зациклится. */
    this._stopStopwatch()
    this._teardownDom()
    this.open = false
    this.screen = null

    const audio = this._audio()
    call(audio, 'unduck', 220)
    playUiSound(audio, 'click')

    this._setInputActive(true)

    const engine = this._engine()
    if (engine && typeof engine.setState === 'function' && engine.state !== STATE.GAMEPLAY) {
      engine.setState(STATE.GAMEPLAY)
    }
    if (engine && typeof engine.requestPointerLock === 'function') call(engine, 'requestPointerLock')

    this._emit('esc:resumed', {})
  }

  /* ---------------------------------------------------------------- рендер */
  _render() {
    if (typeof document === 'undefined') return
    if (this.root) return

    const root = document.createElement('div')
    root.className = 'efl-esc'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    if (this.options.zIndex) root.style.zIndex = String(this.options.zIndex)

    root.innerHTML =
      '<div class="efl-esc__backdrop"></div>' +
      '<div class="efl-esc__grain"></div>' +
      '<div class="efl-esc__vignette"></div>' +
      this._renderPauseScreen() +
      this._renderAbandonScreen() +
      this._renderDesertedScreen() +
      this._renderShellBar()

    root.addEventListener('click', this._onClick)
    document.body.appendChild(root)
    this.root = root

    requestAnimationFrame(() => {
      if (this.root) this.root.classList.add('is-visible')
    })
  }

  _buildString() {
    return escapeHtml(this.buildVersion) + ' · ' + escapeHtml(this.raidMode) + ' · ' + escapeHtml(this.gameMode)
  }

  _renderShellBar() {
    return (
      '<div class="efl-esc__shell">' +
        '<div class="efl-esc__shell-group">' +
          '<span>' + escapeHtml(this.gameMode) + '</span>' +
          '<span>' + escapeHtml(this.currentMap.title) + '</span>' +
        '</div>' +
        '<div class="efl-esc__shell-group efl-esc__shell-group--right">' +
          '<span>' + escapeHtml(this.nickname()) + '</span>' +
          '<span>' + escapeHtml(this.buildVersion) + '</span>' +
        '</div>' +
      '</div>'
    )
  }

  _renderLevelBadge() {
    return (
      '<div class="efl-esc__level">' +
        LEVEL_CLAW +
        '<span class="efl-esc__level-value" data-role="level">' + escapeHtml(this.playerLevel()) + '</span>' +
      '</div>'
    )
  }

  _renderPauseScreen() {
    return (
      '<section class="efl-esc__screen" data-screen="' + ESC_SCREEN.PAUSE + '">' +
        '<div class="efl-esc__title">ПАУЗА</div>' +
        '<div class="efl-esc__subtitle">' + escapeHtml(this.currentMap.title) + '</div>' +
        '<div class="efl-esc__stack">' +
          '<button type="button" class="efl-esc__big" data-act="resume">ПРОДОЛЖИТЬ</button>' +
          '<button type="button" class="efl-esc__big" data-act="settings">НАСТРОЙКИ</button>' +
          '<button type="button" class="efl-esc__big efl-esc__big--danger" data-act="abandon">ОТКЛЮЧИТЬСЯ</button>' +
        '</div>' +
        '<div class="efl-esc__build">' + this._buildString() + '</div>' +
        '<button type="button" class="efl-esc__gear" data-act="settings" aria-label="Настройки">' + ICON_GEAR + '</button>' +
      '</section>'
    )
  }

  /**
   * Экран подтверждения выхода.
   *
   * Плашка предупреждения и кнопки выбора лежат в ОДНОМ flex-контейнере
   * .efl-desertion-footer, поэтому наложение невозможно в принципе: поток
   * раскладывает их строго друг под другом, а расстояние задаёт gap:24px.
   *
   * Раньше .efl-esc__alert тёк в общем потоке секции, а .efl-esc__footer был
   * выдернут из потока через `position:absolute; bottom:74px` — и красный блок
   * садился прямо на «ПОКИНУТЬ РЕЙД»/«НАЗАД». Между ними стоял ещё и
   * вестигиальный .efl-esc__grace от вырезанного таймера автокика; он удалён,
   * потому что третий элемент только мешал требуемой геометрии.
   */
  _renderAbandonScreen() {
    const map = this.currentMap
    const shot = map.thumbnail
      ? '<img class="efl-esc__map-shot" src="' + escapeHtml(map.thumbnail) + '" alt="' + escapeHtml(map.title) + '" />'
      : '<div class="efl-esc__map-shot efl-esc__map-shot--fallback" style="background:' + map.accent + '"></div>'

    return (
      '<section class="efl-esc__screen" data-screen="' + ESC_SCREEN.ABANDON + '">' +
        '<div class="efl-esc__title">ПОКИНУТЬ РЕЙД</div>' +
        '<div class="efl-esc__subtitle">подтверждение выхода</div>' +
        '<div class="efl-esc__body">' +
          '<div class="efl-esc__pmc">' + PMC_SILHOUETTE + this._renderLevelBadge() + '</div>' +
          '<div class="efl-esc__map">' +
            '<div class="efl-esc__map-tag">' + escapeHtml(map.title) + '</div>' +
            shot +
            '<div class="efl-esc__map-info">' +
              '<div class="efl-esc__map-name">' + escapeHtml(map.title) + '</div>' +
              '<div class="efl-esc__map-desc">' + escapeHtml(map.description) + '</div>' +
            '</div>' +
            '<div class="efl-esc__dots">' +
              '<span class="efl-esc__dot is-active"></span>' +
              '<span class="efl-esc__dot"></span>' +
              '<span class="efl-esc__dot"></span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="efl-desertion-footer">' +
          '<div class="efl-esc__alert">' +
            '<div class="efl-esc__alert-icon">' + ICON_ALERT + '</div>' +
            '<div>' +
              '<div class="efl-esc__alert-title">Внимание: досрочный выход из рейда</div>' +
              '<div class="efl-esc__alert-text">' +
                'Покинув рейд без эвакуации, вы теряете всё снаряжение с тела, кроме содержимого ' +
                'защитного контейнера, и получаете статус дезертира. Опыт за рейд не начисляется.' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="efl-esc__footer">' +
            '<button type="button" class="efl-esc__big efl-esc__big--danger" data-act="confirm-desert">ПОКИНУТЬ РЕЙД</button>' +
            '<button type="button" class="efl-esc__big" data-act="back">НАЗАД</button>' +
          '</div>' +
        '</div>' +
        '<div class="efl-esc__build">' + this._buildString() + '</div>' +
      '</section>'
    )
  }

  _renderDesertedScreen() {
    return (
      '<section class="efl-esc__screen" data-screen="' + ESC_SCREEN.DESERTED + '">' +
        '<div class="efl-esc__title">РЕЙД ОКОНЧЕН</div>' +
        '<div class="efl-esc__subtitle">' + escapeHtml(this.currentMap.title) + '</div>' +
        '<div class="efl-esc__result">' +
          '<div class="efl-esc__result-figure">' + PMC_SILHOUETTE + this._renderLevelBadge() + '</div>' +
          '<div class="efl-esc__nickname">' + ICON_USER + '<span>' + escapeHtml(this.nickname()) + '</span></div>' +
          '<div class="efl-esc__verdict">' +
            '<div class="efl-esc__badge">' + ICON_EXIT + '<span>ДЕЗЕРТИР</span></div>' +
            '<div class="efl-esc__clock">' +
              '<span class="efl-esc__clock-label">время в рейде</span>' +
              '<div class="efl-esc__clock-row">' + ICON_CLOCK +
                '<span class="efl-esc__clock-value" data-role="clock-value">00:00:00</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="efl-esc__exp">' +
            '<span class="efl-esc__exp-tag">EXP</span>' +
            '<span class="efl-esc__exp-value" data-role="exp-value">0</span>' +
          '</div>' +
        '</div>' +
        '<div class="efl-esc__footer">' +
          '<button type="button" class="efl-esc__big" data-act="next">ДАЛЕЕ</button>' +
          '<button type="button" class="efl-esc__big" data-act="main-menu">ГЛАВНОЕ МЕНЮ</button>' +
        '</div>' +
        '<div class="efl-esc__build">' + this._buildString() + '</div>' +
      '</section>'
    )
  }

  showScreen(name) {
    if (!this.root) return
    this.screen = name
    const screens = this.root.querySelectorAll('.efl-esc__screen')
    for (let i = 0; i < screens.length; i++) {
      screens[i].classList.toggle('is-active', screens[i].getAttribute('data-screen') === name)
    }
    /* Экран ABANDON больше не взводит никаких таймеров — игрок стоит там
     * сколько угодно и уходит только кнопкой. */
    if (name !== ESC_SCREEN.DESERTED) this._stopStopwatch()
  }

  /* ------------------------------------------------------------- таймеры */
  _startStopwatch() {
    this._stopStopwatch()
    if (!this.root) return
    const el = this.root.querySelector('[data-role="clock-value"]')
    if (el) el.textContent = formatRaidClock(this._raidElapsedMs)
  }

  _stopStopwatch() {
    if (this._clockTimer) {
      clearInterval(this._clockTimer)
      this._clockTimer = null
    }
  }

  /* ------------------------------------------------------------- настройки */
  openSettings() {
    this._ui('click')
    if (!this.settingsMenu && typeof this.options.settingsFactory === 'function') {
      try {
        this.settingsMenu = this.options.settingsFactory()
      } catch (err) {
        console.error('[EFL/esc] settingsFactory упал', err)
        this.settingsMenu = null
      }
    }
    if (!this.settingsMenu) {
      console.warn('[EFL/esc] панель настроек недоступна')
      return
    }
    call(this.settingsMenu, 'open')
  }

  onSettingsClosed() {
    /* UiSystem передаёт сюда onClose из SettingsMenu. Ничего не делаем кроме
     * сброса заявки на курсор: меню паузы остаётся открытым под панелью. */
    this.releaseCursor('settings')
  }

  /* ---------------------------------------------------------- дезертирство */

  /**
   * Вызывается ТОЛЬКО из кнопки ПОКИНУТЬ РЕЙД. Автоматического
   * вызова по таймеру больше не существует.
   */
  desertRaid() {
    if (this.destroyed || this._deserted) return
    this._deserted = true
    this._raidElapsedMs = Math.max(0, Date.now() - this.raidStartedAt)

    /* Экран дезертира поднимаем ДО raid.end(): тот шлёт 'raid:end',
     * движок уходит в showResults() и зовёт ui.showRaidResults(). UiSystem
     * спросит ownsResultsScreen(), увидит true и отложит визард итогов до
     * кнопки ДАЛЕЕ, а не нарисует его поверх этого экрана. */
    this.showScreen(ESC_SCREEN.DESERTED)

    const audio = this._audio()
    call(audio, 'stopRaidAmbience')
    playUiSound(audio, 'alert')

    const raid = this._svc('raid')
    if (raid && raid.summary) {
      raid.summary.kind = 'deserted'
      raid.summary.exit = ''
    }

    let ended = false
    if (raid && raid.active && typeof raid.end === 'function') {
      try {
        raid.end('deserted')
        ended = true
      } catch (err) {
        console.error('[EFL/esc] raid.end("deserted") упал', err)
      }
    }

    /* Резервный путь. Прежний код звал raid.teardown() — такого метода у
     * RaidSystem нет и не было (teardown живёт на WorldSystem), поэтому
     * геометрия и render-target’ы мира при дезертирстве не освобождались. */
    if (!ended) {
      if (raid) raid.active = false
      call(this._svc('world'), 'teardown')
      call(this._svc('meta'), 'loseLoadout', 'deserted')
      const engine = this._engine()
      if (engine && typeof engine.setState === 'function' && engine.state !== STATE.RESULTS) {
        engine.setState(STATE.RESULTS)
      }
    }

    this._paintDesertedSummary()
    this._startStopwatch()
    this._emit('raid:deserted', { elapsedMs: this._raidElapsedMs, mapId: this.currentMap.id })
  }

  _paintDesertedSummary() {
    if (!this.root) return
    const raid = this._svc('raid')
    const summary = raid && raid.summary ? raid.summary : null
    const xp = summary && Number.isFinite(summary.xp) ? Math.round(summary.xp) : 0
    const exp = this.root.querySelector('[data-role="exp-value"]')
    if (exp) exp.textContent = String(xp)
    const clock = this.root.querySelector('[data-role="clock-value"]')
    if (clock) clock.textContent = formatRaidClock(this._raidElapsedMs)
  }

  /* Передаём управление последовательным экранам итогов рейда. */
  continueToResults() {
    const ui = this._svc('ui')
    const fallback = {
      kind: 'deserted',
      kills: 0,
      xp: 0,
      value: 0,
      time: this._raidElapsedMs / 1000,
      exit: '',
      mapId: this.currentMap.id,
      faction: 'pmc',
      night: false,
      killList: [],
    }
    this.destroyOverlay()
    if (ui && typeof ui.showRaidResults === 'function') {
      ui.showRaidResults(fallback)
      return
    }
    this.exitToMainMenu()
  }

  exitToMainMenu() {
    const audio = this._audio()
    call(audio, 'stopRaidAmbience')
    playUiSound(audio, 'click')
    call(audio, 'unduck', 300)

    this.destroyOverlay()

    const engine = this._engine()
    if (engine && typeof engine.returnToMenu === 'function') {
      call(engine, 'returnToMenu')
      this._emit('esc:mainMenu', {})
      return
    }
    if (engine && typeof engine.setState === 'function') engine.setState(STATE.MENU)
    call(engine && engine.mainMenu, 'show')
    this._emit('esc:mainMenu', {})
  }

  /* ---------------------------------------------------------------- события */
  _onClick(event) {
    const node = event && event.target && event.target.closest ? event.target.closest('[data-act]') : null
    if (!node) return
    event.preventDefault()

    switch (node.getAttribute('data-act')) {
      case 'resume':
        this.resumeGameplay()
        break
      case 'settings':
        this.holdCursor('settings')
        this.openSettings()
        break
      case 'abandon':
        this._ui('alert')
        this.showScreen(ESC_SCREEN.ABANDON)
        break
      case 'back':
        this._ui('back')
        this.showScreen(ESC_SCREEN.PAUSE)
        break
      case 'confirm-desert':
        this.desertRaid()
        break
      case 'next':
        this._ui('click')
        if (this.screen === ESC_SCREEN.DESERTED) this.continueToResults()
        else this.exitToMainMenu()
        break
      case 'main-menu':
        this.exitToMainMenu()
        break
      default:
        break
    }
  }

  /* ---------------------------------------------------------------- уборка */
  _teardownDom() {
    if (!this.root) return
    this.root.removeEventListener('click', this._onClick)
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
    this.root = null
  }

  destroyOverlay() {
    this._stopStopwatch()
    this._teardownDom()
    this.open = false
    this.screen = null
    this._deserted = false
    this._cursorHolds.clear()
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._onKeyDown, true)
      document.removeEventListener('pointerlockchange', this._onPointerLockChange, false)
    }
    this.destroyOverlay()
    this.settingsMenu = null
  }
}

export default EscapeMenuSystem
