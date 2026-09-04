/* ==========================================================================
 * Escape-From-Larpov · src/inventory/index.js
 *
 * Inventory model and subsystem lifecycle. Grids, items, sockets, weight, quick
 * access, and the open/close arbitration that hands the cursor between the
 * gameplay pointer lock and the DOM overlay.
 *
 * Presentation lives in ./view.js, shared tables in ./layout.js. This file
 * touches no DOM beyond constructing the view.
 * ========================================================================== */

import { EFL } from '../core/config.js';
import { STATE } from '../core/engine.js';
import {
  EMPTY,
  Grid,
  QUICK_SIZE,
  SLOT_ACCEPT,
  STASH_SIZE,
  VIEW,
} from './layout.js';
import { InventoryView } from './view.js';

export class InventorySystem {
  static id = 'inventory';
  static deps = ['items'];

  _scratch = { x: 0, y: 0, rot: 0 };
  _bodyPaths = ['pocket', '', '', ''];

  async init(ctx) {
    this.ctx = ctx;
    this.items = ctx.get('items');
    this.byUid = new Map();
    this.grids = new Map();
    this.slots = new Map();
    this.all = [];
    this.quick = new Array(QUICK_SIZE).fill(null);
    this.quickPinned = new Array(QUICK_SIZE).fill(null);
    this._uid = 1;
    this._weight = 0;
    this._weightDirty = true;
    this._rng = ctx.rng.fork('inventory');

    this.open = false;
    this.view = VIEW.RAID;
    this.selectedPart = 'thorax';
    this._useLabel = '';
    this._savedScale = 1;
    this._scaleOwned = false;
    this._controlOwned = false;
    this.ui = null;

    this.grids.set('stash', new Grid(STASH_SIZE.w, STASH_SIZE.h));
    this.grids.set('pocket', new Grid(4, 1));

    if (this.all.length === 0) this._seedStarterKit();

    if (typeof document !== 'undefined') {
      this.ui = new InventoryView(this);
      this.ui.mount();
      this.ui.renderAll();
    }

    ctx.events.on('health:select', (e) => {
      this.selectedPart = e?.part ?? 'thorax';
      this.ui?.renderVitals();
    });
    ctx.events.on('health:heal', () => this._render());

    /* Leaving a match closes the panel: otherwise it hangs over the raid results
     * and leaves time.scale pinned at zero forever. */
    ctx.events.on('raid:end', () => this.hide());
    ctx.events.on('state', (e) => {
      if (!e || !e.to || !this.open) return;
      const raidish = e.to === STATE.GAMEPLAY || e.to === STATE.PAUSED;
      /* Close only when the new state contradicts the open view. The raid view
       * needs a live match; the character view needs the out-of-raid shell,
       * because it carries the stash. */
      if (this.view === VIEW.RAID && e.to !== STATE.GAMEPLAY) this.hide();
      else if (this.view === VIEW.CHARACTER && raidish) this.hide();
    });

    this._syncWeapons();
    this._emit('ready');
  }

  grid(path) {
    return this.grids.get(path) ?? null;
  }

  get(uid) {
    return this.byUid.get(uid) ?? null;
  }

  slotItem(slot) {
    const uid = this.slots.get(slot);
    return uid ? this.byUid.get(uid) : null;
  }

  /* ----------------------------------------------- engine state and cursor */

  _engineState() {
    const engine = this.ctx?.engine ?? null;
    if (engine && typeof engine.state === 'string') return engine.state;
    /* Engine.setState() mirrors the state onto the document element — fallback
     * for dev harnesses where ctx.engine is not threaded through. */
    if (typeof document !== 'undefined' && document.documentElement) {
      return document.documentElement.getAttribute('data-game-state');
    }
    return null;
  }

  /**
   * True while a match is live or paused. THE guard for the stash leak: the
   * global stash may never be reachable from inside a raid.
   */
  _isRaidContext() {
    const s = this._engineState();
    return s === STATE.GAMEPLAY || s === STATE.PAUSED;
  }

  /* TAB belongs to the inventory only in a live match. On the loading screen, in
   * pause and on the results screen the key is not ours. */
  _canOpenRaid() {
    return this._engineState() === STATE.GAMEPLAY;
  }

  /** The character screen carries the stash, so it is out-of-raid only. */
  _canOpenCharacter() {
    const s = this._engineState();
    if (s === STATE.GAMEPLAY || s === STATE.PAUSED) return false;
    return s === STATE.MENU || s === STATE.BOOT || s === STATE.LOADING || s == null;
  }

  _canOpen() {
    return this._canOpenRaid() || this._canOpenCharacter();
  }

  /* EscapeMenuSystem hangs off UiSystem, not the registry. Fetched lazily and
   * without a dep: the inventory must work with no UI system at all. */
  _escapeMenu() {
    const ui = this.ctx?.peek ? this.ctx.peek('ui') : null;
    return ui?.escapeMenu ?? null;
  }

  _holdCursor() {
    const esc = this._escapeMenu();
    if (!esc || typeof esc.holdCursor !== 'function') return;
    try {
      esc.holdCursor('inventory');
    } catch (e) {
      /* arbiter is advisory — never block opening on it */
    }
  }

  /* Released two frames later: the pointer-lock-loss heuristic in escapeMenu
   * re-checks itself after one rAF, and dropping the claim early reopens the
   * pause menu behind us. */
  _releaseCursorSoon() {
    const esc = this._escapeMenu();
    if (!esc || typeof esc.releaseCursor !== 'function') return;
    const drop = () => {
      try {
        esc.releaseCursor('inventory');
      } catch (e) {}
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(drop));
    } else {
      setTimeout(drop, 32);
    }
  }

  /** Weapon inspection pose, installed by weapons/inspectBridge.js. */
  _setWeaponInspect(on) {
    const weapons = this.ctx?.peek ? this.ctx.peek('weapons') : null;
    if (!weapons) return;
    try {
      if (typeof weapons.setInventoryInspect === 'function') weapons.setInventoryInspect(!!on);
      else if (typeof weapons.viewmodel?.setInspect === 'function') weapons.viewmodel.setInspect(!!on);
    } catch (e) {
      /* the bridge is optional — a cosmetic pose may never break the panel */
    }
  }

  /* ------------------------------------------------------------ grid model */

  _ensureContainer(host) {
    const d = this.items.get(host.id);
    if (!d?.grid) return null;
    const path = 'in:' + host.uid;
    let g = this.grids.get(path);
    if (!g) {
      g = new Grid(d.grid.w, d.grid.h);
      this.grids.set(path, g);
    }
    return g;
  }

  fits(g, it, x, y, rot) {
    const d = this.items.get(it.id);
    if (!d) return false;
    const w = rot ? d.h : d.w;
    const h = rot ? d.w : d.h;
    if (x < 0 || y < 0 || x + w > g.w || y + h > g.h) return false;
    const idx = g.items.indexOf(it);
    for (let j = 0; j < h; j++) {
      const row = (y + j) * g.w;
      for (let i = 0; i < w; i++) {
        const c = g.cells[row + x + i];
        if (c !== EMPTY && c !== idx) return false;
      }
    }
    return true;
  }

  _stamp(g, it, value) {
    const d = this.items.get(it.id);
    if (!d) return;
    const w = it.rot ? d.h : d.w;
    const h = it.rot ? d.w : d.h;
    for (let j = 0; j < h; j++) {
      const row = (it.y + j) * g.w;
      for (let i = 0; i < w; i++) g.cells[row + it.x + i] = value;
    }
  }

  findFree(g, it, out) {
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (this.fits(g, it, x, y, false)) {
          out.x = x;
          out.y = y;
          out.rot = 0;
          return true;
        }
        if (this.fits(g, it, x, y, true)) {
          out.x = x;
          out.y = y;
          out.rot = 1;
          return true;
        }
      }
    }
    return false;
  }

  /** Remove `it` from whichever grid currently holds it, keeping indices tight. */
  _detach(it) {
    const g = this.grids.get(it.path);
    if (g) {
      const i = g.items.indexOf(it);
      if (i >= 0) {
        this._stamp(g, it, EMPTY);
        g.items.splice(i, 1);
        /* Cells store the index into items, so everything after the hole must be
         * restamped or the grid points at the wrong objects. */
        for (let k = i; k < g.items.length; k++) this._stamp(g, g.items[k], k);
      }
    }
    if (it.path.startsWith('slot:')) this.slots.delete(it.path.slice(5));
  }

  add(itemId, count, path, extra) {
    const d = this.items.get(itemId);
    if (!d) return null;
    const g = this.grids.get(path);
    if (!g) return null;

    if (d.stack > 1) {
      for (let i = 0; i < g.items.length && count > 0; i++) {
        const o = g.items[i];
        if (o.id !== itemId || o.n >= d.stack) continue;
        const can = Math.min(d.stack - o.n, count);
        o.n += can;
        count -= can;
      }
      if (count <= 0) {
        this._weightDirty = true;
        this._emit('stack');
        return null;
      }
    }

    const it = {
      uid: this._uid++,
      id: itemId,
      n: Math.min(count, d.stack ?? 1),
      path,
      x: 0,
      y: 0,
      rot: 0,
      dur: d.dur ?? null,
      uses: d.uses ?? null,
      mods: d.t === 'weapon' ? Object.create(null) : null,
      am: null,
      nm: 0,
      mag: d.magId ?? null,
      heat: 0,
      mode: 0,
      fir: extra?.fir ?? false,
    };
    if (!this.findFree(g, it, this._scratch)) return null;
    it.x = this._scratch.x;
    it.y = this._scratch.y;
    it.rot = this._scratch.rot;

    g.items.push(it);
    this._stamp(g, it, g.items.length - 1);
    this.byUid.set(it.uid, it);
    this.all.push(it);
    if (d.grid) this._ensureContainer(it);
    this._weightDirty = true;
    this._emit('add');
    return it;
  }

  remove(uid, count) {
    const it = this.byUid.get(uid);
    if (!it) return;
    if (count && it.n > count) {
      it.n -= count;
      this._weightDirty = true;
      this._emit('split');
      return;
    }
    /* Destroying a container destroys its contents with it. */
    const inner = this.grids.get('in:' + uid);
    if (inner) {
      for (let i = inner.items.length - 1; i >= 0; i--) this.remove(inner.items[i].uid);
      this.grids.delete('in:' + uid);
    }
    this._detach(it);
    for (const [s, u] of this.slots) if (u === uid) this.slots.delete(s);
    for (let i = 0; i < QUICK_SIZE; i++) if (this.quickPinned[i] === uid) this.quickPinned[i] = null;
    this.byUid.delete(uid);
    const a = this.all.indexOf(it);
    if (a >= 0) this.all.splice(a, 1);
    this._weightDirty = true;
    this._emit('remove');
  }

  move(uid, path, x, y, rot) {
    const it = this.byUid.get(uid);
    const dst = this.grids.get(path);
    if (!it || !dst) return false;

    /* Nothing may be moved into the stash from inside a raid, and nothing may be
     * pulled out of it either — the hideout does not exist during a match. This
     * is the model-level half of the stash guard, so even a synthetic drop or a
     * script cannot reach the grid. */
    if (path === 'stash' && this._isRaidContext()) return false;

    /* A container may not end up inside itself, at any depth. */
    if (path.startsWith('in:')) {
      let hostUid = +path.slice(3);
      let guard = 0;
      while (hostUid && guard++ < 12) {
        if (hostUid === uid) return false;
        const host = this.byUid.get(hostUid);
        hostUid = host?.path.startsWith('in:') ? +host.path.slice(3) : 0;
      }
    }

    const oldRot = it.rot;
    it.rot = rot ?? it.rot;
    if (x == null || !this.fits(dst, it, x, y, it.rot)) {
      if (!this.findFree(dst, it, this._scratch)) {
        it.rot = oldRot;
        return false;
      }
      x = this._scratch.x;
      y = this._scratch.y;
      it.rot = this._scratch.rot;
    }

    this._detach(it);
    it.path = path;
    it.x = x;
    it.y = y;
    dst.items.push(it);
    this._stamp(dst, it, dst.items.length - 1);
    this._weightDirty = true;
    this._emit('move');
    return true;
  }

  equip(uid, slot) {
    const it = this.byUid.get(uid);
    if (!it) return false;
    const d = this.items.get(it.id);
    if (!d) return false;
    const accept = SLOT_ACCEPT[slot];
    if (accept && !accept.includes(d.t)) return false;

    const cur = this.slotItem(slot);
    if (cur && cur.uid !== uid && !this.unequip(cur.uid)) return false;

    this._detach(it);
    it.path = 'slot:' + slot;
    it.x = 0;
    it.y = 0;
    it.rot = 0;
    this.slots.set(slot, uid);
    if (d.grid) this._ensureContainer(it);
    this._weightDirty = true;
    this._emit('equip');
    return true;
  }

  unequip(uid) {
    const it = this.byUid.get(uid);
    if (!it) return false;
    for (const p of this.bodyPaths()) {
      /* Never into a container carried by the item being removed. */
      if (p.startsWith('in:' + uid)) continue;
      if (this.move(uid, p)) return true;
    }
    /* The stash is only an overflow destination out of raid. In a match this
     * fails rather than silently teleporting gear to the hideout. */
    if (!this._isRaidContext() && this.move(uid, 'stash')) return true;
    return false;
  }

  bodyPaths() {
    const p = this._bodyPaths;
    p.length = 1;
    for (const s of ['rig', 'backpack', 'secure']) {
      const h = this.slotItem(s);
      if (h) p.push('in:' + h.uid);
    }
    return p;
  }

  onBody(it) {
    let cur = it;
    let guard = 0;
    while (cur && guard++ < 12) {
      if (cur.path === 'pocket' || cur.path.startsWith('slot:')) return true;
      if (!cur.path.startsWith('in:')) return false;
      cur = this.byUid.get(+cur.path.slice(3));
    }
    return false;
  }

  inStash(it) {
    let cur = it;
    let guard = 0;
    while (cur && guard++ < 12) {
      if (cur.path === 'stash') return true;
      if (!cur.path.startsWith('in:')) return false;
      cur = this.byUid.get(+cur.path.slice(3));
    }
    return false;
  }

  countStash(id) {
    let n = 0;
    for (const it of this.all) if (it.id === id && this.inStash(it)) n += it.n;
    return n;
  }

  takeStash(id, count) {
    let left = count;
    for (let i = this.all.length - 1; i >= 0 && left > 0; i--) {
      const it = this.all[i];
      if (it.id !== id || !this.inStash(it)) continue;
      const take = Math.min(it.n, left);
      left -= take;
      if (it.n > take) it.n -= take;
      else this.remove(it.uid);
    }
    return left <= 0;
  }

  weight() {
    if (!this._weightDirty) return this._weight;
    let kg = 0;
    for (const it of this.all) {
      if (!this.onBody(it)) continue;
      const d = this.items.get(it.id);
      kg += (d?.kg ?? 0) * (d?.stack > 1 ? it.n : 1);
      if (it.mods) for (const s in it.mods) kg += this.items.get(it.mods[s])?.kg ?? 0;
      if (it.nm) kg += it.nm * 0.012;
    }
    this._weight = kg;
    this._weightDirty = false;
    return kg;
  }

  /** Carry penalty, for the player controller. Free allowance then linear falloff. */
  weightPenalty() {
    const over = this.weight() - EFL.weight.free;
    if (over <= 0) return 0;
    return Math.min(EFL.weight.maxPenalty, over * EFL.weight.perKg);
  }

  /**
   * «СОРТ. СТОЛ» — repack the stash largest-first, then by type, then by name, so
   * a raid's worth of fragmented loot collapses into a solid block.
   */
  sortStash() {
    const g = this.grid('stash');
    if (!g || this._isRaidContext()) return false;
    const list = g.items.slice();
    list.sort((a, b) => {
      const da = this.items.get(a.id);
      const db = this.items.get(b.id);
      const areaA = (da?.w ?? 1) * (da?.h ?? 1);
      const areaB = (db?.w ?? 1) * (db?.h ?? 1);
      if (areaB !== areaA) return areaB - areaA;
      const ta = da?.t ?? '';
      const tb = db?.t ?? '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      const na = da?.n ?? a.id;
      const nb = db?.n ?? b.id;
      return na < nb ? -1 : na > nb ? 1 : 0;
    });

    g.clear();
    for (const it of list) {
      it.rot = 0;
      if (this.findFree(g, it, this._scratch)) {
        it.x = this._scratch.x;
        it.y = this._scratch.y;
        it.rot = this._scratch.rot;
      } else {
        /* Unreachable for a set that already fitted, but never drop an item. */
        it.x = 0;
        it.y = 0;
      }
      g.items.push(it);
      this._stamp(g, it, g.items.length - 1);
    }
    this._weightDirty = true;
    this._emit('sort');
    return true;
  }

  /* ------------------------------------------------------- use / quick access */

  useItem(uid) {
    const health = this.ctx.peek('health');
    const it = this.get(uid);
    if (!health || !it) return 0;
    const d = this.items.get(it.id);
    if (!d || (d.t !== 'med' && d.t !== 'food')) return 0;
    const t = health.use(uid, this.selectedPart);
    if (t > 0) {
      this._useLabel = d.n;
      this._emit('use');
    }
    return t;
  }

  quickHeal() {
    const rec = this._firstConsumable();
    return rec ? this.useItem(rec.uid) : 0;
  }

  useQuickSlot(index) {
    if (index < 0 || index >= QUICK_SIZE) return 0;
    const uid = this.quick[index];
    if (uid && this.get(uid)) return this.useItem(uid);
    return this.quickHeal();
  }

  /** Drag-to-pin: an explicit assignment outranks auto-fill. */
  assignQuick(index, uid) {
    if (index < 0 || index >= QUICK_SIZE) return false;
    const it = this.get(uid);
    if (!it || !this.onBody(it)) return false;
    for (let i = 0; i < QUICK_SIZE; i++) if (this.quickPinned[i] === uid) this.quickPinned[i] = null;
    this.quickPinned[index] = uid;
    this._emit('quick');
    return true;
  }

  clearQuick(index) {
    if (index < 0 || index >= QUICK_SIZE) return false;
    if (this.quickPinned[index] == null) return false;
    this.quickPinned[index] = null;
    this._emit('quick');
    return true;
  }

  _firstConsumable() {
    for (const it of this.all) {
      if (!this.onBody(it)) continue;
      const d = this.items.get(it.id);
      if (d?.t === 'med' || d?.t === 'food') return it;
    }
    return null;
  }

  /**
   * Pinned assignments survive; the remaining sockets auto-fill from carried
   * consumables. The old build wiped the whole row on every change, so a manual
   * assignment could never outlive picking anything up.
   */
  _rebuildQuick() {
    this.quick.fill(null);
    const taken = new Set();

    for (let i = 0; i < QUICK_SIZE; i++) {
      const uid = this.quickPinned[i];
      if (uid == null) continue;
      const it = this.get(uid);
      if (!it || !this.onBody(it)) {
        this.quickPinned[i] = null;
        continue;
      }
      this.quick[i] = uid;
      taken.add(uid);
    }

    const preferred = ['ifak', 'afak', 'salewa', 'bandage', 'calokb', 'splint', 'analgin', 'water', 'crackers'];
    let qi = 0;
    for (const id of preferred) {
      while (qi < QUICK_SIZE && this.quick[qi] != null) qi++;
      if (qi >= QUICK_SIZE) break;
      const found = this.all.find((it) => it.id === id && this.onBody(it) && !taken.has(it.uid));
      if (found) {
        this.quick[qi] = found.uid;
        taken.add(found.uid);
      }
    }
  }

  /* ------------------------------------------------------------- weapons sync */

  _weaponIdForItem(id) {
    return { ak74n: 'ak74m', glock: 'glock17' }[id] ?? id;
  }

  _syncWeapons() {
    const weapons = this.ctx.peek('weapons');
    if (!weapons || typeof weapons.setWeapon !== 'function') return;
    for (const slot of ['primary', 'secondary', 'holster']) {
      const it = this.slotItem(slot);
      weapons.setWeapon(slot, it ? this._weaponIdForItem(it.id) : null, null);
    }
    if (!this.slotItem(weapons.slot)) {
      for (const slot of ['primary', 'secondary', 'holster']) {
        if (this.slotItem(slot)) {
          weapons.equip(slot);
          break;
        }
      }
    }
  }

  _seedStarterKit() {
    const add = (id, count, path = 'stash') => this.add(id, count, path);

    const gear = {
      rig: add('rig_fcpc', 1),
      backpack: add('backpack_beta2', 1),
      secure: add('secure_epsilon', 1),
      armor: add('armor_paca', 1),
      helmet: add('helmet_ronin', 1),
      headset: add('headset_proflex', 1),
      armband: add('armband_obereg', 1),
      dogtag: add('dogtag_usec', 1),
      glasses: add('glasses_crossbow', 1),
      melee: add('melee_m2', 1),
      primary: add('mp7a2', 1),
      holster: add('glock', 1),
    };
    /* Containers first: equipping them is what creates the grids everything else
     * lands in. */
    for (const slot of ['rig', 'backpack', 'secure', 'armor', 'helmet', 'headset', 'armband', 'dogtag', 'glasses', 'melee', 'primary', 'holster']) {
      const it = gear[slot];
      if (it) this.equip(it.uid, slot);
    }

    /* КАРМАНЫ — four sockets, as in the reference. */
    add('ifak', 1, 'pocket');
    add('salewa', 1, 'pocket');
    add('bandage', 1, 'pocket');
    add('calokb', 1, 'pocket');

    const rig = this.slotItem('rig');
    if (rig) {
      add('mag_mp7', 3, 'in:' + rig.uid);
      add('9x19pst', 60, 'in:' + rig.uid);
    }
    const bag = this.slotItem('backpack');
    if (bag) {
      add('afak', 1, 'in:' + bag.uid);
      add('splint', 1, 'in:' + bag.uid);
      add('water', 1, 'in:' + bag.uid);
      add('crackers', 1, 'in:' + bag.uid);
    }
    const sec = this.slotItem('secure');
    if (sec) {
      add('tgdocs', 1, 'in:' + sec.uid);
      add('analgin', 2, 'in:' + sec.uid);
    }

    /* Stash seed. `rub` caps at 500000 per stack and add() only tops up stacks
     * that already exist, so the balance is built from whole stacks and the
     * wallet reports the real computed total rather than a hard-coded figure. */
    for (let i = 0; i < 4; i++) add('rub', 500000);
    add('usd', 7252);
    add('eur', 3608);
    add('m4a1', 1);
    add('ak74n', 1);
    add('mag_stanag', 2);
    add('mag_ak30', 2);
    add('556m855', 60);
    add('545ps', 60);
    add('helmet_ssh', 1);
    add('rig_bankrobber', 1);
    add('backpack_smb', 1);
    add('headset_comtac', 1);
    add('face_shroud', 1);
    add('ledx', 1);
    add('gpu', 1);
    add('bolts', 4);
    add('wires', 4);

    this._rebuildQuick();
  }

  _render() {
    this.ui?.renderAll();
  }

  _emit(reason) {
    this._rebuildQuick();
    this._syncWeapons();
    const payload = { reason, weight: this._weightDirty ? this.weight() : this._weight };
    this.ctx.events.emit('inv:changed', payload);
    this.ctx.events.emit('inventory:changed', payload);
    this.ctx.events.emit('inventory:weight', { kg: payload.weight });
    this._render();
  }

  /* ---------------------------------------------------------- open / close */

  /** TAB: the raid panel in a match, the character screen out of one. */
  toggle(force) {
    const wantOpen = force == null ? !this.open : !!force;
    if (!wantOpen) {
      this.hide();
      return false;
    }
    return this._isRaidContext() ? this.openRaid() : this.openCharacter();
  }

  openRaid() {
    return this._canOpenRaid() ? this._open(VIEW.RAID) : false;
  }

  openCharacter() {
    return this._canOpenCharacter() ? this._open(VIEW.CHARACTER) : false;
  }

  /** Back-compat: show() with no argument picks the view from engine state. */
  show(view) {
    if (view === VIEW.CHARACTER) return this.openCharacter();
    if (view === VIEW.RAID) return this.openRaid();
    return this._isRaidContext() ? this.openRaid() : this.openCharacter();
  }

  /**
   * The cursor is taken EXPLICITLY and WITH NOTICE.
   *
   * Two separate claims, because they solve two separate problems:
   *   - escapeMenu.holdCursor() stops the ESC menu reading the pointer-lock loss
   *     as an alt-tab and raising a pause screen over the panel;
   *   - input.suppressPointerLock() stops core/input.js re-acquiring the lock on
   *     the next mousedown, which is what broke item dragging. It also makes
   *     Input.fire report false, so clicking an item cannot discharge the
   *     weapon.
   */
  _open(view) {
    if (!this.ui) return false;

    if (this.open) {
      if (this.view === view) return true;
      /* Live view switch (ПЕРСОНАЖ <-> ВЕЩИ). */
      this.view = view;
      this.ui.applyViewClass();
      this._render();
      return true;
    }

    this.open = true;
    this.view = view;
    const raid = view === VIEW.RAID;

    this._holdCursor();

    /* Freeze the world only in a match. Zeroing time.scale in the main menu
     * would stall the menu's own animated backdrop. */
    if (raid) {
      const time = this.ctx.time;
      const scale = time && Number.isFinite(time.scale) ? time.scale : 1;
      this._savedScale = scale > 0 ? scale : 1;
      if (time) {
        time.scale = 0;
        this._scaleOwned = true;
      }
      const player = this.ctx.peek('player');
      if (typeof player?.setControlEnabled === 'function') {
        player.setControlEnabled(false);
        this._controlOwned = true;
      }
      this._setWeaponInspect(true);
    }

    const input = this.ctx.input;
    if (input) {
      input.frozen = true;
      if (typeof input.suppressPointerLock === 'function') input.suppressPointerLock('inventory');
    }

    if (typeof document !== 'undefined' && typeof document.exitPointerLock === 'function') {
      try {
        document.exitPointerLock();
      } catch (e) {}
    }

    this.ui.setOpen(true);
    this.ui.applyViewClass();
    this._render();
    this.ctx.events.emit('inventory:toggle', { open: true, view });
    return true;
  }

  hide() {
    if (!this.open || !this.ui) return false;
    this.open = false;
    const wasRaid = this.view === VIEW.RAID;

    if (this._scaleOwned) {
      const time = this.ctx.time;
      if (time) time.scale = this._savedScale > 0 ? this._savedScale : 1;
      this._scaleOwned = false;
    }
    if (this._controlOwned) {
      this.ctx.peek('player')?.setControlEnabled?.(true);
      this._controlOwned = false;
    }
    if (wasRaid) this._setWeaponInspect(false);

    const input = this.ctx.input;
    if (input) {
      input.frozen = false;
      /* Release BEFORE re-requesting, or requestPointerLock() no-ops against our
       * own suppressor and the player is left with a dead camera. */
      if (typeof input.allowPointerLock === 'function') input.allowPointerLock('inventory');
    }

    this.ui.setOpen(false);
    this.ui.stopDrag();

    /* Recapture the cursor only if the match is still running. */
    if (this._canOpenRaid()) input?.requestPointerLock?.();
    this._releaseCursorSoon();

    this.ctx.events.emit('inventory:toggle', { open: false, view: this.view });
    return true;
  }

  dispose() {
    /* Never leave the cursor suppressed or the clock stopped behind us: a hot
     * reload with the panel open would otherwise be unrecoverable. */
    if (this._scaleOwned) {
      const time = this.ctx?.time;
      if (time) time.scale = this._savedScale > 0 ? this._savedScale : 1;
      this._scaleOwned = false;
    }
    if (this._controlOwned) {
      this.ctx?.peek('player')?.setControlEnabled?.(true);
      this._controlOwned = false;
    }
    this._setWeaponInspect(false);

    const input = this.ctx?.input;
    if (input && typeof input.allowPointerLock === 'function') input.allowPointerLock('inventory');

    this.ui?.unmount();
    this.ui = null;
    this.open = false;

    this.grids.clear();
    this.byUid.clear();
    this.slots.clear();
    this.all.length = 0;
  }
}

export default InventorySystem;
