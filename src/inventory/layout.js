/* ==========================================================================
 * Escape-From-Larpov · src/inventory/layout.js
 *
 * Shared vocabulary for the inventory: slot tables, grid model, stylesheet and
 * small pure helpers. No behaviour, no DOM ownership — index.js owns the model,
 * view.js owns the screen, and both read from here.
 * ========================================================================== */

import { EFL } from '../core/config.js';

/** Sentinel for "no item occupies this cell". Uint16Array, so 0xffff. */
export const EMPTY = 0xffff;

/** Grid cell edge in CSS pixels. */
export const CELL = 34;

/** Build stamp in the footer, matching the reference client. */
export const BUILD_VERSION = '1.1.0.1.46911';

/** Display carry ceiling from the reference build ("26.8KG/89"). */
export const WEIGHT_LIMIT = 89;

/** Quick-access row: 1..9 then 0, exactly as the reference hotbar. */
export const QUICK_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
export const QUICK_SIZE = QUICK_KEYS.length;

/**
 * The two contexts the panel renders in.
 *
 * RAID is the in-match TAB view: equipment, pockets, rig, backpack, secure
 * container, hotbar. No stash, ever — the hideout is unreachable from a match.
 *
 * CHARACTER is the out-of-raid «ПЕРСОНАЖ» screen: the same left pane plus the
 * global stash filling the right half of the viewport.
 */
export const VIEW = { RAID: 'raid', CHARACTER: 'character' };

/**
 * PMC doll. `area` is the named CSS grid area used by the left pane, which
 * reproduces the reference three-column geometry: small sockets down the outer
 * columns, head and body armour stacked in the middle with БРОНЯ spanning two
 * rows, then two full-width weapon rails each paired with a small socket.
 *
 * Slot ids mirror SLOTS in items/index.js. Captions live here because they are
 * presentation, not data.
 */
export const EQUIP_SLOTS = [
  { id: 'headset', label: 'УШИ', accept: ['headset'], area: 'ears', size: 'sm' },
  { id: 'helmet', label: 'ГОЛОВА', accept: ['helmet'], area: 'head', size: 'md' },
  { id: 'face', label: 'ЛИЦО', accept: ['face'], area: 'face', size: 'sm' },
  { id: 'armband', label: 'ПОВЯЗКА', accept: ['armband'], area: 'band', size: 'sm' },
  { id: 'armor', label: 'БРОНЯ', accept: ['armor'], area: 'armor', size: 'tall' },
  { id: 'glasses', label: 'ГЛАЗА', accept: ['glasses'], area: 'eyes', size: 'sm' },
  { id: 'dogtag', label: 'ЖЕТОН', accept: ['dogtag'], area: 'tag', size: 'sm' },
  { id: 'primary', label: 'НА РЕМНЕ', accept: ['weapon'], area: 'sling', size: 'wide' },
  { id: 'holster', label: 'КОБУРА', accept: ['weapon'], area: 'holster', size: 'sm' },
  { id: 'secondary', label: 'НА СПИНЕ', accept: ['weapon'], area: 'back', size: 'wide' },
  { id: 'melee', label: 'НОЖНЫ', accept: ['melee'], area: 'sheath', size: 'sm' },
];

/** Sockets that carry their own grid. Rendered as cards in the middle pane. */
export const CONTAINER_SLOTS = [
  { id: 'rig', label: 'РАЗГРУЗКА', accept: ['rig'] },
  { id: 'backpack', label: 'РЮКЗАК', accept: ['backpack'] },
  { id: 'secure', label: 'ПОДСУМОК', accept: ['secure'] },
];

export const ALL_SLOTS = EQUIP_SLOTS.concat(CONTAINER_SLOTS);

/** Order used when resolving "which socket does this item belong in". */
export const EQUIP_ORDER = ALL_SLOTS.map((s) => s.id);

export const SLOT_LABEL = Object.create(null);
export const SLOT_ACCEPT = Object.create(null);
for (const s of ALL_SLOTS) {
  SLOT_LABEL[s.id] = s.label;
  SLOT_ACCEPT[s.id] = s.accept;
}

/**
 * Tab strip. `view` marks the tab that owns a view and switches to it; tabs
 * without one belong to screens outside this module and render disabled rather
 * than as dead clickable stubs.
 */
export const TABS = [
  { id: 'character', label: 'ПЕРСОНАЖ', view: VIEW.CHARACTER },
  { id: 'common', label: 'ОБЩЕЕ' },
  { id: 'gear', label: 'ВЕЩИ', view: VIEW.RAID },
  { id: 'health', label: 'ЗДОРОВЬЕ' },
  { id: 'skills', label: 'УМЕНИЯ' },
  { id: 'map', label: 'КАРТА' },
  { id: 'quests', label: 'ЗАДАНИЯ' },
  { id: 'achievements', label: 'ДОСТИЖЕНИЯ' },
];

/** Stash category rail. `types` null means "everything". */
export const RAIL = [
  { id: 'all', label: 'ВСЕ', types: null },
  { id: 'wpn', label: 'ОРУ', types: ['weapon', 'melee'] },
  { id: 'ammo', label: 'БК', types: ['ammo', 'mag'] },
  {
    id: 'gear',
    label: 'СНР',
    types: ['armor', 'helmet', 'rig', 'backpack', 'secure', 'headset', 'glasses', 'face', 'armband', 'dogtag'],
  },
  { id: 'med', label: 'МЕД', types: ['med', 'food'] },
  { id: 'mod', label: 'МОД', types: ['mod'] },
  { id: 'brt', label: 'БАР', types: ['barter'] },
];

/** Rectangular occupancy grid. cells holds the index into items, or EMPTY. */
export class Grid {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.cells = new Uint16Array(w * h).fill(EMPTY);
    this.items = [];
  }

  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    this.cells = new Uint16Array(w * h).fill(EMPTY);
    const list = this.items;
    this.items = [];
    for (let i = 0; i < list.length; i++) list[i].dirty = true;
  }

  clear() {
    this.cells.fill(EMPTY);
    this.items.length = 0;
  }
}

export function injectStyle(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
}

/* split/join instead of regex: item names are user-visible data and this keeps
 * the escaping obvious. */
export function esc(s) {
  return String(s)
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;');
}

/** 42778605 -> "42 778 605", the reference client's thousands grouping. */
export function grp(n) {
  const s = String(Math.max(0, Math.floor(Number(n) || 0)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ' ';
    out += s[i];
  }
  return out;
}

/** Text entry inside the panel must keep its native keyboard behaviour. */
export function isEditable(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable === true;
}

export function itemName(items, it) {
  return items.get(it.id)?.n ?? it.id;
}

export function itemType(items, it) {
  return items.get(it.id)?.t ?? 'barter';
}

export function sizeFor(items, it, rot) {
  const d = items.get(it.id);
  if (!d) return { w: 1, h: 1 };
  return rot ? { w: d.h, h: d.w } : { w: d.w, h: d.h };
}

/** First socket that accepts this item definition, in canonical order. */
export function acceptedSlot(def) {
  if (!def) return null;
  for (const slot of EQUIP_ORDER) {
    const accept = SLOT_ACCEPT[slot];
    if (accept && accept.includes(def.t)) return slot;
  }
  return null;
}

/** Default stash geometry, read once so index.js and dev tools agree. */
export const STASH_SIZE = { w: EFL.stash.width, h: EFL.stash.rows };

export const STYLE_ID = 'eft-inventory-css';

export const CSS = `
#eftInv{position:fixed;inset:0;z-index:9400;display:none;color:#d7dbd3;font:12px/1.35 "Oswald","Segoe UI",sans-serif;letter-spacing:.05em;user-select:none}
#eftInv.open{display:block}
#eftInv *{box-sizing:border-box}

/* The root is transparent on purpose: backdrop-filter samples what is BEHIND the
 * element, so an opaque root would leave the blur nothing to work with. */
#eftInv .inv-scrim{position:absolute;inset:0;backdrop-filter:blur(15px) saturate(.6);-webkit-backdrop-filter:blur(15px) saturate(.6);background:rgba(9,11,12,.62)}
#eftInv .inv-vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(118% 88% at 50% 42%,rgba(0,0,0,0) 34%,rgba(0,0,0,.55) 78%,rgba(0,0,0,.86) 100%)}
#eftInv .inv-shell{position:absolute;inset:0;display:flex;flex-direction:column;min-height:0}

#eftInv .inv-top{display:flex;align-items:center;gap:18px;padding:12px 22px 10px;border-bottom:1px solid rgba(199,161,90,.22);background:linear-gradient(180deg,rgba(18,21,22,.72),rgba(18,21,22,0))}
#eftInv .inv-tabs{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0;overflow:hidden}
#eftInv .inv-tab{padding:7px 15px;font-size:12px;letter-spacing:.16em;color:#7f877f;background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;font-family:inherit}
#eftInv .inv-tab.on{color:#e8dcc0;border-bottom-color:#c8a15a;background:rgba(200,161,90,.07)}
#eftInv .inv-tab.off{color:#4e544e;cursor:not-allowed}
#eftInv .inv-wallet{display:flex;gap:16px;font:12px/1 "Consolas",monospace;letter-spacing:.06em;color:#cdd2c8;white-space:nowrap}
#eftInv .inv-wallet b{color:#e8dcc0;font-weight:400}
#eftInv .inv-back{padding:7px 18px;font-size:12px;letter-spacing:.18em;color:#cdd2c8;background:rgba(30,35,36,.8);border:1px solid #3d4446;cursor:pointer;font-family:inherit}
#eftInv .inv-back:hover{border-color:#c8a15a;color:#e8dcc0}

#eftInv .inv-body{flex:1 1 auto;min-height:0;display:grid;gap:14px;padding:14px 18px}
#eftInv.view-raid .inv-body{grid-template-columns:344px minmax(0,1fr)}
#eftInv.view-character .inv-body{grid-template-columns:344px minmax(0,420px) minmax(0,1fr)}
#eftInv.view-raid .inv-pane-stash{display:none}
#eftInv .inv-pane{display:flex;flex-direction:column;gap:12px;min-height:0;min-width:0}
#eftInv .card{background:linear-gradient(160deg,rgba(20,24,26,.92),rgba(11,13,14,.86));border:1px solid #2a3033;box-shadow:0 14px 32px rgba(0,0,0,.45);padding:10px}
#eftInv h6{margin:0 0 8px;font-size:10px;letter-spacing:.24em;color:#c8a15a;font-weight:400}
#eftInv .scroll{overflow:auto;min-height:0;flex:1 1 auto;padding-right:4px}
#eftInv .scroll::-webkit-scrollbar{width:8px}
#eftInv .scroll::-webkit-scrollbar-thumb{background:#333a3c}

/* PMC doll: three columns, БРОНЯ spans two rows, weapons take full-width rails. */
#eftInv .doll{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;
  grid-template-areas:
    "ears  head  face"
    "band  armor eyes"
    "tag   armor ."
    "sling sling holster"
    "back  back  sheath"}
#eftInv .slot{position:relative;display:flex;align-items:flex-end;border:1px dashed #3a4143;background:rgba(20,24,26,.72);padding:16px 6px 6px;cursor:pointer;min-height:56px;overflow:hidden}
#eftInv .slot.md{min-height:70px}
#eftInv .slot.tall{min-height:118px}
#eftInv .slot.fill{border-style:solid;border-color:#58625e;background:rgba(26,31,33,.92);cursor:grab}
#eftInv .slot.target-ok{outline:2px solid #8fc06a;outline-offset:-2px}
#eftInv .slot.target-bad{outline:2px solid #d95c46;outline-offset:-2px}
#eftInv .slot.drag-source{opacity:.3}
#eftInv .slot em{position:absolute;left:6px;top:4px;font-style:normal;font-size:8px;letter-spacing:.14em;color:#6c746f}
#eftInv .slot b{font:11px/1.15 "Consolas",monospace;color:#dfe5db;font-weight:400;word-break:break-word}
#eftInv .slot i{position:absolute;right:6px;top:4px;font-style:normal;font:9px/1 "Consolas",monospace;color:#8fc06a}
#eftInv .slot.empty b{color:#4e544e}

#eftInv .vitals{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
#eftInv .vital{display:flex;flex-direction:column;gap:3px}
#eftInv .vital span{font-size:9px;letter-spacing:.16em;color:#78807a}
#eftInv .vital b{font:15px/1 "Consolas",monospace;font-weight:400;color:#e6ebe1;font-variant-numeric:tabular-nums}
#eftInv .vital b.warn{color:#e2a114}
#eftInv .vital b.over{color:#e2544a}

#eftInv .grid-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;gap:10px}
#eftInv .grid-head h6{margin:0}
#eftInv .grid-head span{font:9px/1 "Consolas",monospace;color:#6f776f;white-space:nowrap}
#eftInv .grid{position:relative;background:rgba(18,22,23,.85);border:1px solid #2d3436;background-image:linear-gradient(to right,rgba(49,58,60,.75) 1px,transparent 1px),linear-gradient(to bottom,rgba(49,58,60,.75) 1px,transparent 1px)}
#eftInv .grid.target-ok{outline:2px solid #8fc06a;outline-offset:-1px}
#eftInv .grid.target-bad{outline:2px solid #d95c46;outline-offset:-1px}
#eftInv .item{position:absolute;border:1px solid rgba(0,0,0,.75);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05),0 4px 12px rgba(0,0,0,.45);padding:2px 4px;display:flex;flex-direction:column;justify-content:space-between;cursor:grab;overflow:hidden}
#eftInv .item.drag-source{opacity:.3}
#eftInv .item.dim{opacity:.14}
#eftInv .item b{font:10px/1.08 "Consolas",monospace;color:#edf0ea;font-weight:400;pointer-events:none;word-break:break-word}
#eftInv .item i{font-style:normal;font:9px/1 "Consolas",monospace;color:#d8ddd3;align-self:flex-end;pointer-events:none}
#eftInv .item .dur{position:absolute;left:0;right:0;bottom:0;height:2px;background:#8fc06a}
#eftInv .item.med{background:linear-gradient(145deg,#4d6d4e,#273629)}
#eftInv .item.food{background:linear-gradient(145deg,#705d38,#3e3321)}
#eftInv .item.weapon{background:linear-gradient(145deg,#6b6858,#2e2f2b)}
#eftInv .item.melee{background:linear-gradient(145deg,#5e6167,#2b2d31)}
#eftInv .item.mag{background:linear-gradient(145deg,#4d5457,#262a2b)}
#eftInv .item.ammo{background:linear-gradient(145deg,#5a5348,#2c2924)}
#eftInv .item.mod{background:linear-gradient(145deg,#67524a,#302722)}
#eftInv .item.barter{background:linear-gradient(145deg,#6a5533,#34291b)}
#eftInv .item.armor,#eftInv .item.helmet,#eftInv .item.rig,#eftInv .item.backpack,#eftInv .item.secure,#eftInv .item.headset,#eftInv .item.glasses,#eftInv .item.face,#eftInv .item.armband,#eftInv .item.dogtag{background:linear-gradient(145deg,#48545a,#242b2f)}

#eftInv .hotbar{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:5px}
#eftInv .hot{position:relative;min-height:46px;border:1px solid #333a3c;background:rgba(18,22,23,.9);padding:13px 3px 3px;cursor:pointer;overflow:hidden}
#eftInv .hot em{position:absolute;left:4px;top:3px;font-style:normal;font:9px/1 "Consolas",monospace;color:#c8a15a}
#eftInv .hot b{font:9px/1.05 "Consolas",monospace;font-weight:400;color:#cdd2c8;word-break:break-word}
#eftInv .hot.empty b{color:#454b45}
#eftInv .hot.pin{border-color:#5d6a5a}
#eftInv .hot.target-ok{outline:2px solid #8fc06a;outline-offset:-2px}

#eftInv .stash-card{display:flex;flex-direction:column;min-height:0;flex:1 1 auto}
#eftInv .stash-tools{display:flex;align-items:center;gap:8px;margin-bottom:10px}
#eftInv .stash-search{flex:1 1 auto;min-width:0;background:rgba(12,15,16,.92);border:1px solid #343b3d;color:#dfe5db;padding:6px 9px;font:11px/1.2 "Consolas",monospace;letter-spacing:.06em}
#eftInv .stash-search:focus{outline:none;border-color:#c8a15a}
#eftInv .stash-btn{padding:6px 13px;font-size:10px;letter-spacing:.16em;color:#cdd2c8;background:rgba(30,35,36,.9);border:1px solid #3d4446;cursor:pointer;white-space:nowrap;font-family:inherit}
#eftInv .stash-btn:hover{border-color:#c8a15a;color:#e8dcc0}
#eftInv .stash-body{display:flex;gap:10px;min-height:0;flex:1 1 auto}
#eftInv .stash-rail{display:flex;flex-direction:column;gap:3px;flex:0 0 auto}
#eftInv .rail-btn{width:32px;height:30px;border:1px solid #333a3c;background:rgba(18,22,23,.9);color:#7f877f;font:9px/1 "Consolas",monospace;cursor:pointer;font-family:inherit}
#eftInv .rail-btn.on{border-color:#c8a15a;color:#e8dcc0;background:rgba(200,161,90,.1)}

#eftInv .inv-foot{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:7px 22px 9px;border-top:1px solid rgba(255,255,255,.06);font:9px/1 "Consolas",monospace;letter-spacing:.12em;color:#5f665f}
#eftInv .ghost{position:fixed;pointer-events:none;z-index:9500;opacity:.95}
`;
