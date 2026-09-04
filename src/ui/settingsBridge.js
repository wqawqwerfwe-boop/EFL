/* ==========================================================================
 * Escape-From-Larpov · src/ui/settingsBridge.js
 *
 * SettingsMenu писал значения в подсистемы, которых НЕ СУЩЕСТВУЕТ в реестре.
 * Registry.get() знает только id из static id подсистем:
 *
 *   'render', 'materials', 'sky', 'world', 'physics', 'player', 'weapons',
 *   'fx', 'ai', 'ui', 'audio', 'items', 'inventory', 'health', 'meta',
 *   'raid', 'net', 'hud'
 *
 * А панель настроек спрашивала 'camera', 'renderer', 'postfx', 'input',
 * 'character', 'csm', 'i18n', 'memory', 'workers', 'profile', 'mainMenu'.
 * Ни один из них подсистемой не является: камера и ввод живут на ctx,
 * постпроцессинг — на RenderSystem.postfx, контроллер персонажа — на
 * PlayerSystem.character, главное меню — на engine.mainMenu.
 *
 * Итог: ВСЕ вызовы уходили в null через безопасный call() и молча исчезали.
 * Ползунки двигались, картинка не менялась — ровно то самое «мёртвое» меню.
 *
 * Гораздо хуже было там, где вызов ВСЁ-ТАКИ доезжал: панель писала
 * сырые значения ПОВЕРХ живых проходов рендера — см. пункт 7.
 *
 * Этот мост:
 *   1. переопределяет SettingsMenu.prototype._svc правильным резолвером;
 *   2. добавляет пресет качества (graphics.quality -> render.setQuality);
 *   3. делает переключатель экрана настоящим requestFullscreen/exitFullscreen;
 *   4. прокидывает FOV в ctx.config (иначе CameraRig перезатирает камеру
 *      в следующем же кадре) и сразу в активную камеру;
 *   5. прокидывает инверсию вертикали и чувствительность в сырой обработчик
 *      мышиного дельта (core/input.js) и в config;
 *   6. гарантирует, что холодный десатурированный грейдинг Emilia доезжает
 *      до ShaderPass-ов композера;
 *   7. ЗАЩИЩАЕТ ЖИВЫЕ СЛОТЫ РЕНДЕРА. SettingsMenu.applyField делал
 *      `renderer.taa = value !== 'off'` и `renderer.ssr = intensity > 0`, то есть
 *      клал булево значение поверх экземпляров Taa и Ssr, созданных в
 *      RenderSystem.init(). Конструктор SettingsMenu вызывает applyAll(),
 *      то есть это происходило на UiSystem.init(), ДО первого кадра — и
 *      первый же render() падал в
 *        TypeError: this.taa?.reset is not a function
 *      в RenderSystem._ensureProbe. Optional chaining здесь не спасает:
 *      `?.` коротит только null/undefined, а `true` — не ни то ни другое,
 *      у него просто нет .reset. С SSR было то же самое чуть позже:
 *      `false?.setSize()` в resize(). Теперь оба слота — аксессоры:
 *      живой проход переживает запись, а значение настройки уезжает в
 *      render.aaMode / render.ssrMode.
 *
 * Патч ставится в applyTarkovBootstrap() ДО того, как UiSystem создаст
 * экземпляр SettingsMenu, поэтому конструкторный applyAll() уже рабочий.
 *
 * Импорт НАМЕРЕННО неймспейсный, а не именованный: промах именованного
 * импорта в ESM — это ошибка СВЯЗЫВАНИЯ, которая роняет весь бандл, а не
 * только этот модуль. Слой патчей не имеет права ронять загрузку.
 * ========================================================================== */

import * as SettingsMenuModule from './settingsMenu.js'

const SettingsMenu = SettingsMenuModule.SettingsMenu || SettingsMenuModule.default || null
const SETTINGS_TABS = Array.isArray(SettingsMenuModule.SETTINGS_TABS) ? SettingsMenuModule.SETTINGS_TABS : []
const DEFAULT_SETTINGS = SettingsMenuModule.DEFAULT_SETTINGS || {}
const GRADING_PRESETS = SettingsMenuModule.GRADING_PRESETS || {}

/** Пресеты качества из core/config.js (QUALITY_PRESETS). */
export const QUALITY_PRESETS_IDS = ['low', 'medium', 'high', 'ultra']

export const QUALITY_FIELD = {
  type: 'dropdown',
  label: 'Пресет качества',
  path: 'graphics.quality',
  options: [
    { value: 'low', label: 'низкое' },
    { value: 'medium', label: 'среднее' },
    { value: 'high', label: 'высокое' },
    { value: 'ultra', label: 'ультра' },
  ],
  hint: 'Единый пресет рендера: renderScale, тени, TAA, GTAO, SSR, объёмы, бюджеты частиц',
}

let applied = false

function safeCall(target, method, ...args) {
  if (!target || typeof target[method] !== 'function') return undefined
  try {
    return target[method](...args)
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[EFL/settings] ' + method + '() бросил исключение, проигнорировано', err)
    }
    return undefined
  }
}

/* Registry.get() бросает для незарегистрированного id, peek() — нет. */
function fromRegistry(ctx, id) {
  if (!ctx) return null
  if (typeof ctx.peek === 'function') {
    try {
      const v = ctx.peek(id)
      if (v) return v
    } catch (e) {
      /* нет такой подсистемы */
    }
  }
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(id) || null
    } catch (e) {
      return null
    }
  }
  return null
}

function engineOf(ctx) {
  if (!ctx) return null
  if (ctx.engine) return ctx.engine
  if (typeof window !== 'undefined' && window.__ENGINE__) return window.__ENGINE__
  return null
}

/* -------------------------------------------------------------------------- */
/* Защита живых слотов рендера                                                */
/* -------------------------------------------------------------------------- */

/**
 * Сброс истории TAA по любому доступному контракту, в порядке предпочтения:
 *   1. родной reset()        — src/render/taa.js: this._needsReset = true;
 *   2. поля накопления      — TAARenderPass/SSAARenderPass из three не имеют
 *                              reset(), у них accumulate/sampleStep;
 *   3. _needsReset напрямую — если метод потеряли, а поле осталось.
 * @returns {boolean} сброс действительно выполнен.
 */
export function resetTaaLike(taa) {
  if (!taa || typeof taa !== 'object') return false

  if (typeof taa.reset === 'function') {
    try {
      taa.reset()
      return true
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[EFL/settings] taa.reset() бросил исключение', err)
      }
    }
  }

  let handled = false
  if ('accumulate' in taa) {
    taa.accumulate = false
    handled = true
  }
  if ('sampleStep' in taa) {
    taa.sampleStep = 0
    handled = true
  }
  if ('_needsReset' in taa) {
    taa._needsReset = true
    handled = true
  }
  if (typeof taa.clear === 'function') {
    safeCall(taa, 'clear')
    handled = true
  }
  return handled
}

/* Контракт, который RenderSystem требует от содержимого this.taa:
 * render() / setSize() / nextJitter() / reset() / previousTexture / dispose(). */
function isTaaPass(v) {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.render === 'function' &&
    typeof v.setSize === 'function' &&
    typeof v.nextJitter === 'function'
  )
}

/* this.ssr: render() / setSize() / dispose() / .texture. */
function isSsrPass(v) {
  return !!v && typeof v === 'object' && typeof v.render === 'function' && typeof v.setSize === 'function'
}

const SLOT_FLAG = '__eflRenderSlotsGuarded'

function describeValue(v) {
  if (typeof v === 'object') return '[' + (Array.isArray(v) ? 'array' : 'object') + ']'
  if (typeof v === 'string') return "'" + v + "'"
  return String(v)
}

/**
 * Превращает поле-слот в аксессор, который держит ТОЛЬКО живой проход
 * или null. Любая другая запись (boolean из панели настроек, чужой объект
 * из другого пайплайна) трактуется как НАМЕРЕНИЕ и уезжает в modeKey,
 * не трогая проход. Именно это делает `this.taa?.reset()` в index.js
 * безопасным ПО ПОСТРОЕНИЮ в обоих его точках вызова.
 */
function defineSlotGuard(host, name, isPass, modeKey, label) {
  const desc = Object.getOwnPropertyDescriptor(host, name)
  if (desc && (typeof desc.get === 'function' || typeof desc.set === 'function')) return

  let slot = null
  if (desc) {
    if (isPass(desc.value)) {
      slot = desc.value
    } else if (desc.value !== null && desc.value !== undefined && typeof console !== 'undefined') {
      console.error(
        '[EFL/settings] render.' + name + ' уже был перезатёрт (' + describeValue(desc.value) +
          ') до установки защиты — проход потерян, слот обнулён'
      )
    }
  }

  Object.defineProperty(host, name, {
    configurable: true,
    enumerable: true,
    get() {
      return slot
    },
    set(v) {
      if (v === null || v === undefined) {
        slot = null
        return
      }
      if (isPass(v)) {
        slot = v
        return
      }
      host[modeKey] = v
      if (name === 'taa') resetTaaLike(slot)
      if (typeof console !== 'undefined') {
        console.warn(
          '[EFL/settings] запись ' + describeValue(v) + ' в render.' + name + ' отклонена: слот держит ' +
            label + '. Значение ушло в render.' + modeKey
        )
      }
    },
  })
}

/**
 * Ставит защиту на taa/ssr один раз на экземпляр. Вызывается из renderOf(),
 * через который проходит АБСОЛЮТНО любое обращение панели настроек к
 * рендеру (_svc('renderer') -> resolveSettingsService -> renderOf), так что
 * ставится она ГАРАНТИРОВАННО РАНЬШЕ первого же присваивания.
 */
export function guardRenderSlots(render) {
  if (!render || typeof render !== 'object') return render
  if (render[SLOT_FLAG]) return render
  try {
    Object.defineProperty(render, SLOT_FLAG, { value: true, enumerable: false, configurable: true })
    defineSlotGuard(render, 'taa', isTaaPass, 'aaMode', 'живой TAA-проход (src/render/taa.js)')
    defineSlotGuard(render, 'ssr', isSsrPass, 'ssrMode', 'живой SSR-проход (src/render/ssr.js)')
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[EFL/settings] защита слотов рендера не установлена', err)
    }
  }
  return render
}

function renderOf(ctx) {
  return guardRenderSlots(fromRegistry(ctx, 'render'))
}

function postfxOf(ctx) {
  const render = renderOf(ctx)
  if (render) {
    if (render.postfx) return render.postfx
    if (render.postFx) return render.postFx
    if (render.pipeline) return render.pipeline
    if (render.composer) return render.composer
  }
  return fromRegistry(ctx, 'postfx')
}

function playerOf(ctx) {
  return fromRegistry(ctx, 'player')
}

/**
 * Единый резолвер «сервисов» панели настроек.
 * Всё, что не является подсистемой реестра, берётся из ctx/engine напрямую.
 */
export function resolveSettingsService(ctx, name) {
  if (!ctx || !name) return null

  switch (name) {
    case 'camera':
      return ctx.camera || null
    case 'viewCamera':
      return ctx.viewCamera || null
    case 'config':
      return ctx.config || null
    case 'input':
      return ctx.input || null
    case 'engine':
      return engineOf(ctx)
    case 'events':
      return ctx.events || null
    case 'mainMenu': {
      const engine = engineOf(ctx)
      return (engine && engine.mainMenu) || null
    }
    case 'renderer':
    case 'render':
      return renderOf(ctx)
    case 'postfx':
      return postfxOf(ctx)
    case 'csm': {
      const render = renderOf(ctx)
      return (render && (render.csm || render.shadows)) || null
    }
    case 'character': {
      const player = playerOf(ctx)
      if (!player) return null
      return player.character || player.movement || player.rig || null
    }
    case 'profile':
      return fromRegistry(ctx, 'meta')
    default:
      return fromRegistry(ctx, name)
  }
}

/* -------------------------------------------------------------------------- */
/* Пресет качества                                                            */
/* -------------------------------------------------------------------------- */

export function applyQualityPreset(ctx, value) {
  const preset = QUALITY_PRESETS_IDS.indexOf(value) >= 0 ? value : 'high'
  const render = renderOf(ctx)

  /* Приоритет ровно тот, что описан в задаче: ctx.get('render')?.setQuality(). */
  if (render && typeof render.setQuality === 'function') {
    safeCall(render, 'setQuality', preset)
  } else {
    /* Фолбэк: config владеет таблицей QUALITY_PRESETS и мутирует cfg.q на месте,
     * а рендер читает cfg.q каждый кадр. */
    const cfg = ctx && ctx.config
    if (cfg && typeof cfg.setQuality === 'function') safeCall(cfg, 'setQuality', preset)
    if (render) {
      render.quality = preset
      safeCall(render, 'applyQuality', preset)
      safeCall(render, 'onQualityChanged', preset)
      safeCall(render, 'rebuild')
    }
  }

  if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
    try {
      ctx.events.emit('quality', { preset: preset })
    } catch (e) {
      /* EventBus сам логирует */
    }
  }

  /* Пересборка проекций/размеров после смены renderScale. */
  const engine = engineOf(ctx)
  if (engine && typeof engine.resize === 'function') safeCall(engine, 'resize')
  return preset
}

/* -------------------------------------------------------------------------- */
/* Сглаживание и отражения                                                    */
/* -------------------------------------------------------------------------- */

/**
 * graphics.antialiasing. Родной обработчик делал `renderer.taa = value !== 'off'`
 * и убивал проход. Здесь проход не трогаем вообще: пишем режим в aaMode
 * и сбрасываем историю, чтобы смена настроек не тянула старые кадры.
 *
 * Полное выключение/включение в рантайме — это пересборка цепочки (джиттер
 * камеры, FXAA-фолбэк, sharpen в композите), и ей владеет RenderSystem через
 * пресет качества (q.taa), а не панель настроек. Молча делать вид, что
 * переключатель работает, хуже, чем сказать это в лог.
 */
export function applyAntialiasing(ctx, value) {
  if (value === undefined || value === null) return null
  const render = renderOf(ctx)
  const mode = typeof value === 'string' ? value : value ? 'taa_high' : 'off'
  const on = mode !== 'off'

  if (render) {
    render.aaMode = mode
    resetTaaLike(render.taa)
    if (on && !render.taa && typeof console !== 'undefined') {
      console.info(
        '[EFL/settings] TAA-проход не собран текущим пресетом качества: ' + mode +
          ' записан в render.aaMode, фактическое включение — через graphics.quality'
      )
    }
  }

  safeCall(postfxOf(ctx), 'setTaa', on)
  return mode
}

/** Интенсивность SSR по имени пресета панели. */
export const SSR_INTENSITY = { off: 0, low: 0.35, medium: 0.6, high: 0.85, ultra: 1 }

/**
 * graphics.ssr. Ровно та же болезнь, что у TAA: родной обработчик кладёт
 * `renderer.ssr = intensity > 0` поверх экземпляра Ssr, а потом resize() идёт
 * в `false?.setSize()`. Значение держим в ssrMode/ssrIntensity.
 */
export function applyReflections(ctx, value) {
  if (value === undefined || value === null) return null
  const render = renderOf(ctx)
  const known = typeof value === 'string' && SSR_INTENSITY[value] !== undefined
  const intensity = typeof value === 'number' ? value : known ? SSR_INTENSITY[value] : value ? 1 : 0

  if (render) {
    render.ssrMode = typeof value === 'string' ? value : intensity > 0 ? 'high' : 'off'
    render.ssrIntensity = intensity
  }

  safeCall(postfxOf(ctx), 'setSsr', intensity)
  return intensity
}

/* -------------------------------------------------------------------------- */
/* Режим экрана: настоящий fullscreen                                         */
/* -------------------------------------------------------------------------- */

export function applyScreenMode(ctx, value, allowRequest) {
  const render = renderOf(ctx)
  if (render) render.screenMode = value

  if (typeof document === 'undefined') return value
  /* requestFullscreen обязан быть внутри пользовательского жеста, иначе
   * браузер отклоняет промис. allowRequest === true только из _commit(). */
  if (!allowRequest) return value

  try {
    const el = document.documentElement
    if (value === 'fullscreen') {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        const request = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen
        if (request) {
          const p = request.call(el)
          if (p && typeof p.catch === 'function') p.catch(() => {})
        }
      }
    } else if (document.fullscreenElement || document.webkitFullscreenElement) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen
      if (exit) {
        const p = exit.call(document)
        if (p && typeof p.catch === 'function') p.catch(() => {})
      }
    }
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[EFL/settings] fullscreen отклонён', err)
  }
  return value
}

/* -------------------------------------------------------------------------- */
/* FOV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Одной записи в camera.fov не хватает: CameraRig.applyTo() каждый кадр
 * пересчитывает fov из ctx.config.fov (baseFov = cfg.fov) и затирает её.
 * Поэтому пишем И в конфиг (источник истины), И сразу в активную камеру,
 * чтобы изменение было видно в том же кадре.
 */
export function applyFov(ctx, value) {
  const fov = Number(value)
  if (!Number.isFinite(fov) || fov <= 1) return null

  if (ctx && ctx.config) ctx.config.fov = fov

  if (ctx && ctx.camera) {
    ctx.camera.fov = fov
    if (typeof ctx.camera.updateProjectionMatrix === 'function') ctx.camera.updateProjectionMatrix()
  }

  const player = playerOf(ctx)
  const rig = player && (player.rig || player.cameraRig)
  if (rig) {
    rig.baseFov = fov
    rig.fov = fov * (rig.fovMove || 1) * (rig.fovAds || 1)
  }
  return fov
}

/* -------------------------------------------------------------------------- */
/* Мышь                                                                       */
/* -------------------------------------------------------------------------- */

const SENS_MIN = 0.0006
const SENS_SPAN = 0.0042
const ADS_MIN = 0.3
const ADS_SPAN = 1.1

export function applyInvertY(ctx, value) {
  const on = !!value
  if (ctx && ctx.config) ctx.config.invertY = on
  const input = ctx && ctx.input
  if (input) {
    input.invertY = on
    safeCall(input, 'setInvertY', on)
  }
  return on
}

export function applySensitivity(ctx, percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0)) / 100
  const raw = SENS_MIN + SENS_SPAN * p
  if (ctx && ctx.config) ctx.config.sensitivity = raw
  const input = ctx && ctx.input
  if (input) {
    input.sensitivity = raw
    safeCall(input, 'setSensitivity', raw)
  }
  return raw
}

export function applyAimSensitivity(ctx, percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0)) / 100
  const scale = ADS_MIN + ADS_SPAN * p
  if (ctx && ctx.config) ctx.config.adsSensScale = scale
  const input = ctx && ctx.input
  if (input) {
    input.aimSensitivity = scale
    safeCall(input, 'setAimSensitivity', scale)
  }
  return scale
}

/* -------------------------------------------------------------------------- */
/* PostFX                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Полная переливка матрицы постобработки в композер: включение, яркость,
 * чёткость, две резкости и холодный десатурированный грейдинг.
 */
export function applyPostFxMatrix(ctx, settings) {
  const postfx = postfxOf(ctx)
  if (!postfx || !settings || !settings.postfx) return null
  const p = settings.postfx
  const grading = GRADING_PRESETS[p.grading] || GRADING_PRESETS.emilia || { id: p.grading }

  safeCall(postfx, 'setEnabled', !!p.enabled)
  safeCall(postfx, 'setBrightness', (Number(p.brightness) || 0) / 100)
  safeCall(postfx, 'setClarity', (Number(p.clarity) || 0) / 100)
  safeCall(postfx, 'setLumaSharpen', (Number(p.lumaSharpen) || 0) / 100)
  safeCall(postfx, 'setAdaptiveSharpen', (Number(p.adaptiveSharpen) || 0) / 100)
  safeCall(postfx, 'setColorGrading', grading.id || p.grading, grading)

  const graphics = settings.graphics || {}
  safeCall(postfx, 'setGrain', graphics.grain ? 0.35 : 0)
  safeCall(postfx, 'setChromaticAberration', graphics.chromatic ? 0.0022 : 0)
  return grading
}

/* -------------------------------------------------------------------------- */
/* Установка патча                                                            */
/* -------------------------------------------------------------------------- */

function ensureQualityField() {
  if (!DEFAULT_SETTINGS.graphics) DEFAULT_SETTINGS.graphics = {}
  if (DEFAULT_SETTINGS.graphics.quality === undefined) {
    DEFAULT_SETTINGS.graphics.quality = 'high'
  }

  for (let i = 0; i < SETTINGS_TABS.length; i++) {
    const tab = SETTINGS_TABS[i]
    if (!tab || tab.id !== 'graphics' || !Array.isArray(tab.sections)) continue
    for (let s = 0; s < tab.sections.length; s++) {
      const section = tab.sections[s]
      if (!section || !Array.isArray(section.fields)) continue
      let exists = false
      for (let f = 0; f < section.fields.length; f++) {
        if (section.fields[f] && section.fields[f].path === 'graphics.quality') exists = true
      }
      if (exists) return
    }
    /* Кладём пресет первым в блок «Качество картинки», иначе в «Дисплей». */
    let target = tab.sections[1] || tab.sections[0]
    for (let s = 0; s < tab.sections.length; s++) {
      if (tab.sections[s] && tab.sections[s].title === 'Качество картинки') target = tab.sections[s]
    }
    if (target && Array.isArray(target.fields)) target.fields.unshift(QUALITY_FIELD)
    return
  }
}

export function applySettingsBridge() {
  if (applied) return SettingsMenu
  applied = true

  /* Без класса патчить нечего. Не бросаем — загрузка игры важнее. */
  if (!SettingsMenu || !SettingsMenu.prototype) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/settings] SettingsMenu не найден в ./settingsMenu.js — мост не установлен')
    }
    return null
  }

  ensureQualityField()

  const proto = SettingsMenu.prototype
  const originalApplyField = proto.applyField
  const originalApplyAll = proto.applyAll
  const originalCommit = proto._commit

  /* --- 1. правильный резолвер сервисов -------------------------------- */
  proto._svc = function patchedSvc(name) {
    try {
      return resolveSettingsService(this.ctx, name)
    } catch (err) {
      return null
    }
  }

  /* --- 2. живые привязки, которых не было вообще ---------------------- */
  proto.applyField = function patchedApplyField(path, value) {
    const ctx = this.ctx

    switch (path) {
      case 'game.fov':
        applyFov(ctx, value)
        return this

      case 'graphics.quality':
        applyQualityPreset(ctx, value)
        return this

      case 'graphics.screenMode':
        applyScreenMode(ctx, value, this._interactive === true)
        return this

      /* Родные ветки этих двух путей затирали живые проходы рендера
       * булевыми значениями, так что до originalApplyField не доходим. */
      case 'graphics.antialiasing':
        applyAntialiasing(ctx, value)
        return this

      case 'graphics.ssr':
        applyReflections(ctx, value)
        return this

      case 'controls.invertY':
        applyInvertY(ctx, value)
        return this

      case 'controls.sensitivity':
        applySensitivity(ctx, value)
        return this

      case 'controls.aimSensitivity':
        applyAimSensitivity(ctx, value)
        return this

      case 'postfx.enabled':
      case 'postfx.grading':
        /* Профиль и выключатель тянут за собой всю матрицу uniform-ов. */
        if (typeof originalApplyField === 'function') {
          try {
            originalApplyField.call(this, path, value)
          } catch (err) {
            if (typeof console !== 'undefined') console.warn('[EFL/settings] applyField(' + path + ')', err)
          }
        }
        applyPostFxMatrix(ctx, this.settings)
        return this

      default:
        break
    }

    if (typeof originalApplyField === 'function') {
      try {
        return originalApplyField.call(this, path, value)
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[EFL/settings] applyField(' + path + ')', err)
      }
    }
    return this
  }

  /* --- 3. applyAll: прогон всех значений, включая новые пути ---------- */
  proto.applyAll = function patchedApplyAll() {
    if (typeof originalApplyAll === 'function') {
      try {
        originalApplyAll.call(this)
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('[EFL/settings] applyAll', err)
      }
    }

    const ctx = this.ctx
    const s = this.settings || {}
    const graphics = s.graphics || {}
    const controls = s.controls || {}
    const game = s.game || {}

    applyQualityPreset(ctx, graphics.quality)
    applyAntialiasing(ctx, graphics.antialiasing)
    applyReflections(ctx, graphics.ssr)
    applyFov(ctx, game.fov)
    applyInvertY(ctx, controls.invertY)
    applySensitivity(ctx, controls.sensitivity)
    applyAimSensitivity(ctx, controls.aimSensitivity)
    applyPostFxMatrix(ctx, s)
    /* Режим экрана без жеста применяем только как состояние рендера. */
    applyScreenMode(ctx, graphics.screenMode, false)

    return this
  }

  /* --- 4. любой коммит из UI — это пользовательский жест -------------- */
  proto._commit = function patchedCommit(path, value) {
    const prev = this._interactive
    this._interactive = true
    try {
      if (typeof originalCommit === 'function') return originalCommit.call(this, path, value)
      return undefined
    } finally {
      this._interactive = prev === true
    }
  }

  /* --- 5. публичный хук для главного меню и ESC-меню ------------------ */
  if (typeof proto.reapply !== 'function') {
    proto.reapply = function reapply() {
      return this.applyAll()
    }
  }

  return SettingsMenu
}

export default applySettingsBridge
