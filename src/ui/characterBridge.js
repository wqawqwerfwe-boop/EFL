/* ==========================================================================
 * Escape-From-Larpov · src/ui/characterBridge.js
 *
 * The bottom navigation bar on the start screen has a «ПЕРСОНАЖ» entry that was
 * wired to nothing: MainMenuSystem does not own the InventorySystem instance and
 * has no method to raise the character screen, so the click went nowhere.
 *
 * Exactly the same shape of problem as «НАСТРОЙКИ», and solved exactly the same
 * way as ui/mainMenuBridge.js solves it — one delegated capture-phase listener
 * that recognises the button by data-attribute or by caption, so it keeps working
 * even when the menu re-renders its whole DOM. No markup edits, no reach into
 * mainMenu.js internals.
 *
 * Imports are namespace imports ON PURPOSE: a missed named import in ESM is a
 * LINK error that takes the whole bundle down, and a bridge layer may never
 * break the game load.
 * ========================================================================== */

import * as MainMenuModule from './mainMenu.js';

const MainMenuSystem = MainMenuModule.MainMenuSystem || MainMenuModule.default || null;

const CHARACTER_TEXT = /^(персонаж|перс|character|char|pmc)$/i;
const CHARACTER_TOKENS = [
  'character',
  'char',
  'persona',
  'personazh',
  'pmc',
  'open-character',
  'opencharacter',
  'inventory',
];

/* The inventory owns every click inside itself (its own tab strip lives there),
 * the ESC menu and the settings panel own theirs. Same list mainMenuBridge uses. */
const SKIP_ROOTS = '.efl-esc, .efl-set, #eftInv';
const MAX_WALK = 8;

let applied = false;
let clickBound = false;

function attrOf(node, name) {
  if (!node || typeof node.getAttribute !== 'function') return null;
  const v = node.getAttribute(name);
  return v == null ? null : String(v).toLowerCase();
}

function looksLikeCharacter(node) {
  if (!node || node.nodeType !== 1) return false;

  const attrs = [
    attrOf(node, 'data-act'),
    attrOf(node, 'data-action'),
    attrOf(node, 'data-nav'),
    attrOf(node, 'data-screen'),
    attrOf(node, 'data-menu'),
    attrOf(node, 'data-tab'),
    attrOf(node, 'data-role'),
    attrOf(node, 'data-view'),
    node.id ? String(node.id).toLowerCase() : null,
  ];
  for (let i = 0; i < attrs.length; i++) {
    if (attrs[i] && CHARACTER_TOKENS.indexOf(attrs[i]) >= 0) return true;
  }

  const label = attrOf(node, 'aria-label');
  if (label && CHARACTER_TEXT.test(label.trim())) return true;

  /* Caption. Short text only, so we don't match the whole nav container. */
  const text = node.textContent;
  if (text) {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (trimmed.length > 0 && trimmed.length <= 24 && CHARACTER_TEXT.test(trimmed)) return true;
  }
  return false;
}

function engineOf() {
  if (typeof window === 'undefined') return null;
  return window.__ENGINE__ || null;
}

function ctxOf(instance) {
  if (instance && instance.ctx) return instance.ctx;
  const engine = engineOf();
  return (engine && engine.ctx) || null;
}

/** registry.get() throws for an unregistered id — peek only. */
function inventoryOf(instance) {
  const ctx = ctxOf(instance);
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') {
    try {
      const inv = ctx.peek('inventory');
      if (inv) return inv;
    } catch (e) {
      /* not registered yet */
    }
  }
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get('inventory') || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * Raise the character screen. InventorySystem is registered `{ states: GAMEPLAY }`,
 * which gates update/fixedUpdate/lateUpdate only — init() always ran, so the DOM
 * and the grids exist in STATE.MENU and the panel is fully usable there.
 */
export function openCharacterScreen(instance) {
  const inv = inventoryOf(instance);
  if (!inv) {
    if (typeof console !== 'undefined') {
      console.warn('[EFL/character] InventorySystem недоступен — экран персонажа не открыть');
    }
    return null;
  }
  if (typeof inv.openCharacter !== 'function') {
    if (typeof console !== 'undefined') {
      console.warn('[EFL/character] InventorySystem.openCharacter() отсутствует — версия инвентаря устарела');
    }
    return null;
  }
  try {
    inv.openCharacter();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[EFL/character] openCharacter() упал', err);
    return null;
  }
  return inv;
}

function menuIsUp() {
  const engine = engineOf();
  if (!engine || typeof engine.state !== 'string') return true;
  /* The character screen carries the global stash, so it belongs to the
   * out-of-raid shell only. In a raid TAB gives the in-raid panel instead, and
   * InventorySystem refuses the character view outright. */
  return engine.state === 'menu' || engine.state === 'boot' || engine.state === 'loading';
}

function onDocumentClick(event) {
  if (!event || event.defaultPrevented) return;
  const target = event.target;
  if (!target || target.nodeType !== 1) return;

  if (typeof target.closest === 'function' && target.closest(SKIP_ROOTS)) return;

  let node = target;
  let hit = null;
  for (let i = 0; i < MAX_WALK && node && node.nodeType === 1; i++) {
    if (looksLikeCharacter(node)) {
      hit = node;
      break;
    }
    node = node.parentElement;
  }
  if (!hit) return;
  if (!menuIsUp()) return;

  event.preventDefault();
  if (typeof event.stopPropagation === 'function') event.stopPropagation();

  openCharacterScreen(null);
}

function bindDelegatedClick() {
  if (clickBound || typeof document === 'undefined') return;
  clickBound = true;
  document.addEventListener('click', onDocumentClick, true);
}

export function applyCharacterBridge() {
  if (applied) return MainMenuSystem;
  applied = true;

  const proto = MainMenuSystem && MainMenuSystem.prototype;
  if (!proto) {
    if (typeof console !== 'undefined') {
      console.error('[EFL/character] MainMenuSystem не найден в ./mainMenu.js — мост без прототипа');
    }
    /* The delegated listener works without an instance — install it anyway. */
    bindDelegatedClick();
    return MainMenuSystem;
  }

  const original = proto.openCharacter;

  proto.openCharacter = function openCharacter() {
    /* Respect a native implementation if one ever lands, but always insure it. */
    if (typeof original === 'function' && original !== proto.openCharacter) {
      try {
        const res = original.call(this);
        const inv = inventoryOf(this);
        if (inv && inv.open) return res;
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.warn('[EFL/character] родной openCharacter() упал, открываем панель сами', err);
        }
      }
    }
    return openCharacterScreen(this);
  };

  if (typeof proto.showCharacter !== 'function') {
    proto.showCharacter = function showCharacter() {
      return this.openCharacter();
    };
  }

  /* The nav bar may be drawn in mount() — delegate after it. */
  const originalMount = proto.mount;
  if (typeof originalMount === 'function') {
    proto.mount = function patchedMount() {
      const res = originalMount.apply(this, arguments);
      bindDelegatedClick();
      return res;
    };
  }

  bindDelegatedClick();
  return MainMenuSystem;
}

export default applyCharacterBridge;
