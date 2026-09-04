/* ==========================================================================
 * Escape-From-Larpov · src/ui/lobbyDeployFlags.js
 *
 * LOBBY DEPLOY FLAGS — «Тренировочный рейд / Оффлайн» по умолчанию ВЫКЛЮЧЕН.
 *
 * WHY A BRIDGE. `mainMenu.js` is 84 KB and redraws its DOM wholesale; editing
 * the state selector inline is exactly how the checkbox drifted to `true` in
 * the first place. Like `mainMenuBridge.js`, this module patches the
 * MainMenuSystem PROTOTYPE once, before the first `mount()`, so the rule holds
 * regardless of how the menu builds its markup.
 *
 * WHAT IT GUARANTEES.
 *   1. `selectLobbyState(prev)` — the pure state selector. Every field that is
 *      not a deploy flag is carried over from `prev`; `training` and `offline`
 *      are forced to `false`. Exported so the menu (or a test) can call it
 *      directly.
 *   2. On EVERY `mount()` the instance state is run through the selector, the
 *      rendered checkbox is synchronised to UNCHECKED, and the menu's own
 *      change handler is respected afterwards — the player can still tick it.
 *   3. `startRaid()` / `deploy()` on the menu are wrapped so the raid
 *      controller ALWAYS receives an explicit options object:
 *        raid.start(mapId, faction, night, { isTraining, offline, insurance })
 *      A legacy 3-argument call site keeps working — the 4th argument is
 *      appended, never substituted.
 *
 * WIRING. From src/main.js, BEFORE `new MainMenuSystem()`:
 *   import { applyLobbyDeployFlags } from './ui/lobbyDeployFlags.js'
 *   applyLobbyDeployFlags()
 *
 * Imports are deliberately namespaced: a missed named import in ESM is a LINK
 * error and the bridge layer is not allowed to break the boot.
 *
 * File is intentionally semicolon-free. CRLF line endings.
 * ========================================================================== */

import * as MainMenuModule from './mainMenu.js'

const MainMenuSystem = MainMenuModule.MainMenuSystem || MainMenuModule.default || null

/** Deploy flags and their hardcore defaults. */
export const DEFAULT_DEPLOY_FLAGS = Object.freeze({
  training: false,
  offline: false,
  insurance: true,
})

/** State keys the selector owns. Everything else is passed through. */
const FLAG_KEYS = Object.freeze(Object.keys(DEFAULT_DEPLOY_FLAGS))

/**
 * Selectors that find the training / offline checkbox in either generation of
 * lobby markup. Matched in order; the first hit wins.
 */
export const TRAINING_TOGGLE_SELECTOR = [
  'input[type="checkbox"][data-flag="training"]',
  'input[type="checkbox"][data-flag="offline"]',
  'input[type="checkbox"][name="training"]',
  'input[type="checkbox"][name="offline"]',
  'input[type="checkbox"]#efl-training',
  'input[type="checkbox"]#efl-offline',
  'input[type="checkbox"]#eft-offline',
  '.efl-lobby-offline input[type="checkbox"]',
  '.eft-lobby-offline input[type="checkbox"]',
].join(', ')

/** Method names the menu may use to launch a raid. Each is wrapped if present. */
const DEPLOY_METHODS = Object.freeze(['startRaid', 'deploy', 'launchRaid', 'onDeploy'])

let applied = false

/**
 * Pure lobby state selector.
 *
 * Returns a NEW object: the previous state with the deploy flags reset to their
 * hardcore defaults. Passing nothing yields a fresh default state. Never
 * mutates `prev`.
 */
export function selectLobbyState(prev) {
  const next = {}
  if (prev && typeof prev === 'object') {
    const keys = Object.keys(prev)
    for (let i = 0; i < keys.length; i++) next[keys[i]] = prev[keys[i]]
  }
  for (let i = 0; i < FLAG_KEYS.length; i++) next[FLAG_KEYS[i]] = DEFAULT_DEPLOY_FLAGS[FLAG_KEYS[i]]
  return next
}

/** Extract the deploy options the raid controller expects from a menu state. */
export function deployOptionsFrom(state) {
  const s = state && typeof state === 'object' ? state : DEFAULT_DEPLOY_FLAGS
  const isTraining = s.training === true || s.offline === true
  return {
    isTraining,
    offline: isTraining,
    insurance: s.insurance !== false,
    night: s.night === true,
  }
}

/** Find the menu's state bag regardless of which field name it uses. */
function stateOf(menu) {
  if (!menu || typeof menu !== 'object') return null
  if (menu.state && typeof menu.state === 'object') return menu.state
  if (menu.lobby && typeof menu.lobby === 'object') return menu.lobby
  if (menu.lobbyState && typeof menu.lobbyState === 'object') return menu.lobbyState
  return null
}

/** Write the reset flags back in place so live references stay valid. */
function resetStateInPlace(menu) {
  const state = stateOf(menu)
  if (!state) {
    menu.state = selectLobbyState(null)
    return menu.state
  }
  const next = selectLobbyState(state)
  for (let i = 0; i < FLAG_KEYS.length; i++) state[FLAG_KEYS[i]] = next[FLAG_KEYS[i]]
  return state
}

/** Sync the rendered checkbox to the state. Safe when the markup has none. */
function syncToggle(root, checked) {
  if (!root || typeof root.querySelector !== 'function') return null
  const box = root.querySelector(TRAINING_TOGGLE_SELECTOR)
  if (!box) return null
  if (box.checked !== checked) {
    box.checked = checked
    if (typeof box.setAttribute === 'function') {
      if (checked) box.setAttribute('checked', '')
      else box.removeAttribute('checked')
    }
  }
  return box
}

/**
 * Keep the state bag and the checkbox in lock-step after mount. The menu's own
 * handler runs too — we only mirror the value into the flag the raid reads.
 */
function bindToggle(menu, box) {
  if (!box || box._eflFlagBound) return
  box._eflFlagBound = true
  box.addEventListener('change', () => {
    const state = stateOf(menu) || resetStateInPlace(menu)
    state.training = box.checked === true
    state.offline = box.checked === true
  })
}

/** Ensure a raid launch always carries an explicit options object. */
function wrapDeploy(proto, name) {
  const original = proto[name]
  if (typeof original !== 'function' || original._eflFlagWrapped) return
  const wrapped = function eflDeployWithFlags() {
    const state = stateOf(this) || resetStateInPlace(this)
    const opts = deployOptionsFrom(state)
    const args = Array.prototype.slice.call(arguments)
    const last = args.length ? args[args.length - 1] : null
    if (last && typeof last === 'object' && !Array.isArray(last)) {
      args[args.length - 1] = Object.assign({}, last, opts, {
        isTraining: last.isTraining === true || opts.isTraining,
      })
    } else {
      args.push(opts)
    }
    return original.apply(this, args)
  }
  wrapped._eflFlagWrapped = true
  proto[name] = wrapped
}

/**
 * Apply the bridge once. Returns the (possibly patched) MainMenuSystem so the
 * entry point can keep a single import line.
 */
export function applyLobbyDeployFlags() {
  if (applied) return MainMenuSystem
  applied = true

  const proto = MainMenuSystem && MainMenuSystem.prototype
  if (!proto) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/lobby] MainMenuSystem не найден в ./mainMenu.js — флаги высадки не применены')
    }
    return MainMenuSystem
  }

  /* 1. The selector is exposed on the prototype so the menu can call
   *    `this.selectLobbyState()` from its own redraw path. */
  if (typeof proto.selectLobbyState !== 'function') {
    proto.selectLobbyState = function selectLobbyStateOnMenu() {
      return resetStateInPlace(this)
    }
  }

  /* 2. Reset on every mount, then mirror the checkbox. */
  const originalMount = proto.mount
  if (typeof originalMount === 'function' && !originalMount._eflFlagWrapped) {
    const mount = function eflMountWithFlags() {
      resetStateInPlace(this)
      const res = originalMount.apply(this, arguments)
      const root = this && (this.root || this.el || this.dom) ? this.root || this.el || this.dom : null
      const box = syncToggle(root, false)
      bindToggle(this, box)
      return res
    }
    mount._eflFlagWrapped = true
    proto.mount = mount
  }

  /* 3. Some menus redraw the lobby tab without remounting. If they expose a
   *    lobby (re)render, resync the checkbox there as well. */
  const renderNames = ['renderLobby', 'drawLobby', 'showLobby', 'openLobby']
  for (let i = 0; i < renderNames.length; i++) {
    const name = renderNames[i]
    const original = proto[name]
    if (typeof original !== 'function' || original._eflFlagWrapped) continue
    const wrapped = function eflLobbyRenderWithFlags() {
      const res = original.apply(this, arguments)
      const state = stateOf(this) || resetStateInPlace(this)
      const root = this && (this.root || this.el || this.dom) ? this.root || this.el || this.dom : null
      const box = syncToggle(root, state.training === true)
      bindToggle(this, box)
      return res
    }
    wrapped._eflFlagWrapped = true
    proto[name] = wrapped
  }

  /* 4. Every launch path carries explicit deploy options. */
  for (let i = 0; i < DEPLOY_METHODS.length; i++) wrapDeploy(proto, DEPLOY_METHODS[i])

  return MainMenuSystem
}

export default applyLobbyDeployFlags
