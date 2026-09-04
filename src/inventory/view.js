/* ==========================================================================
 * Escape-From-Larpov · src/inventory/view.js
 *
 * Everything the inventory puts on screen, and every pointer event it consumes.
 * The model lives in ./index.js and is reached through `this.sys`.
 *
 * ---------------------------------------------------------------------------
 * MOUSE LOCK ISOLATION — three cooperating layers
 *
 * 1. Per-item grabs bind BOTH `pointerdown` and `mousedown`, each calling
 *    preventDefault + stopPropagation + stopImmediatePropagation. Two bindings
 *    because they are two independent event streams: sealing only `pointerdown`
 *    still let `mousedown` reach window, which is exactly how the original bug
 *    survived a partial fix.
 *
 * 2. A bubble-phase seal on the overlay root catches everything that had no
 *    handler of its own — empty grid space, card chrome, the scrim — and stops
 *    it before it can reach the window listeners in core/input.js.
 *
 *    Bubble phase, NOT capture. A capture-phase stopImmediatePropagation() on
 *    the root fires BEFORE the target and would kill the panel's own item
 *    handlers before they ever ran. By the time an event bubbles back up to the
 *    root, the item handlers have had their turn.
 *
 * 3. Drag move/up are bound on window in the CAPTURE phase, the mirror image of
 *    layer 2: capture on window runs before anything else in the dispatch, so
 *    the root seal cannot swallow a `pointerup` and strand a drag. It also means
 *    a release outside the overlay still completes the gesture.
 *
 * Layer 0, upstream of all of this, is Input.suppressPointerLock('inventory'),
 * filed by the model in _open(). These layers are deliberately redundant: a
 * stuck pointer lock is unrecoverable without an alt-tab.
 * ========================================================================== */

import {
  BUILD_VERSION,
  CELL,
  CONTAINER_SLOTS,
  CSS,
  EQUIP_SLOTS,
  QUICK_KEYS,
  QUICK_SIZE,
  RAIL,
  SLOT_ACCEPT,
  STYLE_ID,
  TABS,
  VIEW,
  WEIGHT_LIMIT,
  acceptedSlot,
  esc,
  grp,
  injectStyle,
  isEditable,
} from './layout.js';

export class InventoryView {
  constructor(sys) {
    this.sys = sys;
    this.root = null;
    this.ghost = null;
    this.drag = null;
    this.filter = '';
    this.rail = 'all';
    this._winBound = [];
    this._lastTarget = null;
  }

  get items() {
    return this.sys.items;
  }

  /* ------------------------------------------------------------------ mount */

  mount() {
    if (typeof document === 'undefined' || this.root) return;
    injectStyle(STYLE_ID, CSS);

    const root = document.createElement('div');
    root.id = 'eftInv';
    /* Marks the subtree as a cursor-owning overlay for core/input.js. */
    root.setAttribute('data-efl-overlay', 'inventory');
    root.innerHTML =
      '<div class="inv-scrim"></div>' +
      '<div class="inv-vig"></div>' +
      '<div class="inv-shell">' +
      '<div class="inv-top">' +
      '<div class="inv-tabs" id="inv-tabs"></div>' +
      '<div class="inv-wallet" id="inv-wallet"></div>' +
      '<button type="button" class="inv-back" id="inv-back">НАЗАД</button>' +
      '</div>' +
      '<div class="inv-body">' +
      '<div class="inv-pane inv-pane-left">' +
      '<div class="card"><div class="doll" id="inv-doll"></div></div>' +
      '<div class="card"><div class="vitals" id="inv-vitals"></div></div>' +
      '</div>' +
      '<div class="inv-pane inv-pane-mid">' +
      '<div class="scroll" id="inv-containers"></div>' +
      '<div class="card"><h6>БЫСТРЫЙ ДОСТУП</h6><div class="hotbar" id="inv-hotbar"></div></div>' +
      '</div>' +
      '<div class="inv-pane inv-pane-stash">' +
      '<div class="card stash-card">' +
      '<div class="stash-tools">' +
      '<h6>СХРОН</h6>' +
      '<input class="stash-search" id="inv-search" type="text" placeholder="ПОИСК" autocomplete="off" spellcheck="false" />' +
      '<button type="button" class="stash-btn" id="inv-sort">СОРТ. СТОЛ</button>' +
      '</div>' +
      '<div class="stash-body">' +
      '<div class="stash-rail" id="inv-rail"></div>' +
      '<div class="scroll" id="inv-stash"></div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="inv-foot"><span id="inv-hint"></span><span id="inv-build"></span></div>' +
      '</div>';
    document.body.appendChild(root);

    this.root = root;
    this.$tabs = root.querySelector('#inv-tabs');
    this.$wallet = root.querySelector('#inv-wallet');
    this.$doll = root.querySelector('#inv-doll');
    this.$vitals = root.querySelector('#inv-vitals');
    this.$containers = root.querySelector('#inv-containers');
    this.$hotbar = root.querySelector('#inv-hotbar');
    this.$stash = root.querySelector('#inv-stash');
    this.$rail = root.querySelector('#inv-rail');
    this.$search = root.querySelector('#inv-search');
    this.$hint = root.querySelector('#inv-hint');
    this.$build = root.querySelector('#inv-build');

    this._seal();
    this.applyViewClass();

    root.querySelector('#inv-back').addEventListener('click', () => this.sys.hide());
    root.querySelector('#inv-sort').addEventListener('click', () => this.sys.sortStash());
    this.$search.addEventListener('input', () => {
      this.filter = String(this.$search.value || '').trim().toLowerCase();
      this.renderStash();
    });

    this._bindWindow();
  }

  /** Layer 2: bubble-phase seal on the overlay root. */
  _seal() {
    const seal = (e, blockDefault) => {
      if (blockDefault && e.cancelable && !isEditable(e.target)) e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    /* preventDefault on these; isEditable() inside seal() exempts the search box
     * so it can still take focus and a caret. */
    for (const type of ['pointerdown', 'mousedown', 'contextmenu', 'dragstart', 'selectstart']) {
      this.root.addEventListener(type, (e) => seal(e, true));
    }
    /* Never preventDefault: wheel must still scroll the stash, and click must
     * still reach the panel's own buttons. */
    for (const type of ['pointerup', 'mouseup', 'click', 'auxclick', 'dblclick', 'wheel']) {
      this.root.addEventListener(type, (e) => seal(e, false));
    }
  }

  _bindWindow() {
    const add = (type, fn, capture) => {
      addEventListener(type, fn, capture);
      this._winBound.push([type, fn, capture]);
    };
    add('keydown', (e) => this._onKey(e), true);
    /* Layer 3: capture phase, so the root seal cannot swallow a drop. */
    add('pointermove', (e) => this._onMove(e), true);
    add('pointerup', (e) => this._onUp(e), true);
    add('pointercancel', () => this.stopDrag(), true);
  }

  unmount() {
    for (const [type, fn, capture] of this._winBound) removeEventListener(type, fn, capture);
    this._winBound.length = 0;
    this.stopDrag();
    this.root?.remove();
    this.root = null;
  }

  applyViewClass() {
    if (!this.root) return;
    this.root.classList.toggle('view-raid', this.sys.view === VIEW.RAID);
    this.root.classList.toggle('view-character', this.sys.view === VIEW.CHARACTER);
  }

  setOpen(open) {
    if (!this.root) return;
    this.root.classList.toggle('open', !!open);
  }

  /* -------------------------------------------------------------- keyboard */

  _onKey(e) {
    const sys = this.sys;

    if (e.code === 'Tab') {
      /* Tab is also bound to swapWeapon in core ACTIONS, so it must be swallowed
       * whenever it is ours — otherwise opening the panel also swaps weapons. */
      if (!sys.open && !sys._canOpenRaid() && !sys._canOpenCharacter()) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      sys.toggle();
      return;
    }

    if (!sys.open) return;

    const swallow = () => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    if (e.code === 'Escape') {
      swallow();
      /* Escape unwinds one step at a time: an in-flight drag, then a live search
       * filter, then the panel. */
      if (this.drag) this.stopDrag();
      else if (isEditable(e.target) || this.filter) this._clearSearch();
      else sys.hide();
      return;
    }

    /* Everything below is a shortcut, so text entry keeps priority. */
    if (isEditable(e.target)) return;

    if (e.code === 'KeyR' && this.drag) {
      swallow();
      this.drag.rot = this.drag.rot ? 0 : 1;
      this._updateGhost();
      return;
    }

    /* Digit1..Digit9 -> 0..8, Digit0 -> 9, matching the 1-9,0 hotbar. */
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (Number.isFinite(n)) {
        swallow();
        sys.useQuickSlot(n === 0 ? QUICK_SIZE - 1 : n - 1);
      }
    }
  }

  _clearSearch() {
    this.filter = '';
    if (this.$search) {
      this.$search.value = '';
      this.$search.blur();
    }
    this.renderStash();
  }

  /* ----------------------------------------------------------- render entry */

  renderAll() {
    if (!this.root) return;
    this.applyViewClass();
    this.renderTabs();
    this.renderWallet();
    this.renderDoll();
    this.renderVitals();
    this.renderContainers();
    this.renderHotbar();
    this.renderStash();
    this.renderFooter();
  }

  renderTabs() {
    const sys = this.sys;
    const raid = sys._isRaidContext();
    let html = '';
    for (const tab of TABS) {
      /* ПЕРСОНАЖ carries the stash, so it does not exist inside a raid — which is
       * exactly the difference between the two reference screenshots. */
      if (tab.id === 'character' && raid) continue;
      const active = tab.view === sys.view;
      const usable = !!tab.view && (tab.view !== VIEW.CHARACTER || !raid);
      const cls = 'inv-tab' + (active ? ' on' : usable ? '' : ' off');
      const attrs = usable
        ? ' data-view="' + tab.view + '"'
        : ' aria-disabled="true" title="Экран вне модуля инвентаря"';
      html += '<button type="button" class="' + cls + '"' + attrs + '>' + esc(tab.label) + '</button>';
    }
    this.$tabs.innerHTML = html;
    for (const el of this.$tabs.querySelectorAll('[data-view]')) {
      el.addEventListener('click', () => {
        const v = el.getAttribute('data-view');
        if (v === VIEW.CHARACTER) this.sys.openCharacter();
        else this.sys.openRaid();
      });
    }
  }

  /** Currency counters, computed from real stash contents. */
  renderWallet() {
    if (this.sys.view !== VIEW.CHARACTER || this.sys._isRaidContext()) {
      this.$wallet.innerHTML = '';
      return;
    }
    const rub = this.sys.countStash('rub');
    const eur = this.sys.countStash('eur');
    const usd = this.sys.countStash('usd');
    this.$wallet.innerHTML =
      '<span>₽ <b>' + grp(rub) + '</b></span>' +
      '<span>€ <b>' + grp(eur) + '</b></span>' +
      '<span>$ <b>' + grp(usd) + '</b></span>';
  }

  renderDoll() {
    let html = '';
    for (const slot of EQUIP_SLOTS) html += this._slotHtml(slot);
    this.$doll.innerHTML = html;
    this._bindSlots(this.$doll);
  }

  _slotHtml(slot) {
    const it = this.sys.slotItem(slot.id);
    const d = it ? this.items.get(it.id) : null;
    const cls = 'slot ' + slot.size + (it ? ' fill' : ' empty') +
      (this.drag && this.drag.uid === it?.uid ? ' drag-source' : '');
    let badge = '';
    if (it && d) {
      if (d.t === 'weapon') badge = '<i>' + (it.nm || 0) + '/' + (d.cap ?? 0) + '</i>';
      else if (it.dur != null && d.dur) badge = '<i>' + Math.round(it.dur) + '/' + d.dur + '</i>';
    }
    return (
      '<div class="' + cls + '" style="grid-area:' + slot.area + '" data-slot="' + slot.id + '"' +
      (it ? ' data-uid="' + it.uid + '"' : '') + '>' +
      '<em>' + esc(slot.label) + '</em>' + badge +
      '<b>' + (d ? esc(d.n) : '—') + '</b>' +
      '</div>'
    );
  }

  /** Equipment sockets are drag SOURCES too, not just double-click targets. */
  _bindSlots(host) {
    for (const el of host.querySelectorAll('[data-slot]')) {
      const uid = el.getAttribute('data-uid');
      if (uid) {
        const grab = (e) => this._grab(e, +uid);
        el.addEventListener('pointerdown', grab);
        el.addEventListener('mousedown', grab);
        el.addEventListener('dblclick', () => this.sys.unequip(+uid));
      }
    }
  }

  renderVitals() {
    const sys = this.sys;
    const kg = sys.weight();
    const v = this._readVitals();
    const wCls = kg > WEIGHT_LIMIT ? ' class="over"' : kg > WEIGHT_LIMIT * 0.75 ? ' class="warn"' : '';
    const cell = (label, value, attr) =>
      '<div class="vital"><span>' + label + '</span><b' + (attr || '') + '>' + value + '</b></div>';
    this.$vitals.innerHTML =
      cell('ВЕС', kg.toFixed(1) + '/' + WEIGHT_LIMIT, wCls) +
      cell('ЗДОРОВЬЕ', Math.round(v.hp) + '/' + Math.round(v.hpMax)) +
      cell('ГИДРАЦИЯ', Math.round(v.hydra) + '/' + Math.round(v.hydraMax)) +
      cell('ЭНЕРГИЯ', Math.round(v.energy) + '/' + Math.round(v.energyMax));
  }

  /**
   * The health subsystem is optional and its surface is not contracted here, so
   * every read is defensive and every value has a fallback. A missing health
   * system shows the reference figures rather than NaN.
   */
  _readVitals() {
    const h = this.sys.ctx?.peek ? this.sys.ctx.peek('health') : null;
    const num = (x) => (Number.isFinite(x) ? x : null);
    const call = (fn) => {
      if (typeof fn !== 'function') return null;
      try {
        return num(fn.call(h));
      } catch (e) {
        return null;
      }
    };
    const hp = (h && (call(h.total) ?? num(h.hp))) ?? 440;
    const hpMax = (h && (call(h.maxTotal) ?? num(h.hpMax) ?? num(h.max))) ?? 440;
    const hydra = (h && num(h.hydration)) ?? 100;
    const hydraMax = (h && (num(h.hydrationMax) ?? num(h.maxHydration))) ?? 100;
    const energy = (h && num(h.energy)) ?? 110;
    const energyMax = (h && (num(h.energyMax) ?? num(h.maxEnergy))) ?? 110;
    return { hp, hpMax, hydra, hydraMax, energy, energyMax };
  }

  /** КАРМАНЫ plus the three container sockets. Never the stash. */
  renderContainers() {
    let html = this._gridCardHtml('pocket', 'КАРМАНЫ', '');
    for (const slot of CONTAINER_SLOTS) {
      const host = this.sys.slotItem(slot.id);
      if (!host) {
        html +=
          '<div class="card"><div class="grid-head"><h6>' + esc(slot.label) + '</h6>' +
          '<span>НЕ НАДЕТО</span></div>' +
          '<div class="slot empty" data-slot="' + slot.id + '"><b>—</b></div></div>';
        continue;
      }
      const d = this.items.get(host.id);
      let meta = esc(d?.n ?? host.id);
      if (host.dur != null && d?.dur) meta += '  ' + Math.round(host.dur) + '/' + d.dur;
      html += this._gridCardHtml('in:' + host.uid, slot.label, meta);
    }
    this.$containers.innerHTML = html;
    this._bindGrids(this.$containers);
    this._bindSlots(this.$containers);
  }

  _gridCardHtml(path, label, meta) {
    const g = this.sys.grid(path);
    if (!g) return '';
    return (
      '<div class="card"><div class="grid-head"><h6>' + esc(label) + '</h6>' +
      '<span>' + esc(meta || g.w + '×' + g.h) + '</span></div>' +
      '<div class="grid" data-path="' + path + '" style="width:' + (g.w * CELL + 1) + 'px;height:' +
      (g.h * CELL + 1) + 'px;background-size:' + CELL + 'px ' + CELL + 'px">' +
      this._itemsHtml(g, false) + '</div></div>'
    );
  }

  _itemsHtml(g, dimmable) {
    let html = '';
    for (const it of g.items) {
      const d = this.items.get(it.id);
      if (!d) continue;
      const w = it.rot ? d.h : d.w;
      const h = it.rot ? d.w : d.h;
      let badge = '';
      if (d.t === 'weapon') badge = '<i>' + (it.nm || 0) + '/' + (d.cap ?? 0) + '</i>';
      else if (d.stack > 1 && it.n > 1) badge = '<i>' + grp(it.n) + '</i>';
      else if (it.uses != null && d.uses > 1) badge = '<i>' + it.uses + '/' + d.uses + '</i>';
      const dur =
        it.dur != null && d.dur
          ? '<div class="dur" style="width:' +
            Math.max(0, Math.min(100, (it.dur / d.dur) * 100)).toFixed(1) + '%"></div>'
          : '';
      const cls =
        'item ' + d.t +
        (this.drag && this.drag.uid === it.uid ? ' drag-source' : '') +
        (dimmable && !this._matches(d) ? ' dim' : '');
      html +=
        '<div class="' + cls + '" data-uid="' + it.uid + '" style="left:' + (it.x * CELL + 1) +
        'px;top:' + (it.y * CELL + 1) + 'px;width:' + (w * CELL - 1) + 'px;height:' +
        (h * CELL - 1) + 'px"><b>' + esc(d.n) + '</b>' + badge + dur + '</div>';
    }
    return html;
  }

  /** Search box AND category rail, both real filters. */
  _matches(d) {
    if (this.filter) {
      const name = String(d.n ?? '').toLowerCase();
      const id = String(d.id ?? '').toLowerCase();
      if (name.indexOf(this.filter) < 0 && id.indexOf(this.filter) < 0) return false;
    }
    if (this.rail && this.rail !== 'all') {
      const row = RAIL.find((r) => r.id === this.rail);
      if (row && row.types && !row.types.includes(d.t)) return false;
    }
    return true;
  }

  renderHotbar() {
    const sys = this.sys;
    let html = '';
    for (let i = 0; i < QUICK_SIZE; i++) {
      const uid = sys.quick[i];
      const it = uid ? sys.get(uid) : null;
      const d = it ? this.items.get(it.id) : null;
      const pinned = sys.quickPinned[i] != null;
      html +=
        '<div class="hot' + (it ? '' : ' empty') + (pinned ? ' pin' : '') + '" data-hotbar="' + i + '">' +
        '<em>' + QUICK_KEYS[i] + '</em><b>' + (d ? esc(d.n) : '—') + '</b></div>';
    }
    this.$hotbar.innerHTML = html;
    for (const el of this.$hotbar.querySelectorAll('[data-hotbar]')) {
      const i = +el.getAttribute('data-hotbar');
      el.addEventListener('click', () => this.sys.useQuickSlot(i));
      el.addEventListener('dblclick', () => this.sys.clearQuick(i));
    }
  }

  /**
   * THE in-raid stash guard. Two independent conditions, because the view flag
   * and the engine state can disagree for a frame during a transition and the
   * stash must never flash into a raid.
   */
  renderStash() {
    const sys = this.sys;
    const allowed = sys.view === VIEW.CHARACTER && !sys._isRaidContext();
    if (!allowed) {
      this.$stash.innerHTML = '';
      this.$rail.innerHTML = '';
      return;
    }

    let rails = '';
    for (const row of RAIL) {
      rails +=
        '<button type="button" class="rail-btn' + (this.rail === row.id ? ' on' : '') +
        '" data-rail="' + row.id + '">' + esc(row.label) + '</button>';
    }
    this.$rail.innerHTML = rails;
    for (const el of this.$rail.querySelectorAll('[data-rail]')) {
      el.addEventListener('click', () => {
        this.rail = el.getAttribute('data-rail');
        this.renderStash();
      });
    }

    const g = sys.grid('stash');
    if (!g) {
      this.$stash.innerHTML = '';
      return;
    }
    this.$stash.innerHTML =
      '<div class="grid" data-path="stash" style="width:' + (g.w * CELL + 1) + 'px;height:' +
      (g.h * CELL + 1) + 'px;background-size:' + CELL + 'px ' + CELL + 'px">' +
      this._itemsHtml(g, true) + '</div>';
    this._bindGrids(this.$stash);
  }

  renderFooter() {
    const raid = this.sys._isRaidContext();
    this.$hint.textContent = 'TAB / ESC — ЗАКРЫТЬ · R — ПОВОРОТ · 2×КЛИК — НАДЕТЬ / ПРИМЕНИТЬ';
    this.$build.textContent = BUILD_VERSION + (raid ? ' | TRAINING | PvE' : ' | PvE');
  }

  /* --------------------------------------------------------------- dragging */

  /** Layer 1: both event streams sealed, then the grab starts. */
  _bindGrids(host) {
    for (const el of host.querySelectorAll('.item[data-uid]')) {
      const uid = +el.getAttribute('data-uid');
      const grab = (e) => this._grab(e, uid);
      el.addEventListener('pointerdown', grab);
      el.addEventListener('mousedown', grab);
      el.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        this._activate(uid);
      });
    }
  }

  _grab(e, uid) {
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    /* pointerdown and mousedown both fire for one physical press — first wins. */
    if (this.drag || (e.button != null && e.button !== 0)) return;
    this.startDrag(uid, e);
  }

  /** Double-click: equip if it fits a socket, otherwise use it. */
  _activate(uid) {
    const it = this.sys.get(uid);
    if (!it) return;
    const d = this.items.get(it.id);
    if (!d) return;
    if (d.t === 'med' || d.t === 'food') {
      this.sys.useItem(uid);
      return;
    }
    const slot = acceptedSlot(d);
    if (slot) {
      if (it.path === 'slot:' + slot) this.sys.unequip(uid);
      else this.sys.equip(uid, slot);
    }
  }

  startDrag(uid, e) {
    const it = this.sys.get(uid);
    if (!it) return;
    const d = this.items.get(it.id);
    if (!d) return;
    this.drag = { uid, rot: it.rot, x: e.clientX, y: e.clientY };
    if (!this.ghost) {
      this.ghost = document.createElement('div');
      this.ghost.className = 'ghost';
      document.body.appendChild(this.ghost);
    }
    this.ghost.innerHTML =
      '<div class="item ' + d.t + '" style="position:static"><b>' + esc(d.n) + '</b></div>';
    this.ghost.style.display = 'block';
    this._updateGhost();
    this.renderAll();
  }

  _updateGhost() {
    if (!this.drag || !this.ghost) return;
    const it = this.sys.get(this.drag.uid);
    const d = it ? this.items.get(it.id) : null;
    if (!d) return;
    const w = this.drag.rot ? d.h : d.w;
    const h = this.drag.rot ? d.w : d.h;
    this.ghost.style.width = w * CELL - 1 + 'px';
    this.ghost.style.height = h * CELL - 1 + 'px';
    this.ghost.style.left = this.drag.x - (w * CELL) / 2 + 'px';
    this.ghost.style.top = this.drag.y - (h * CELL) / 2 + 'px';
  }

  _onMove(e) {
    if (!this.drag) return;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this._updateGhost();
    this._highlight(this._pickTarget(e));
  }

  _highlight(target) {
    if (this._lastTarget) {
      this._lastTarget.el.classList.remove('target-ok', 'target-bad');
      this._lastTarget = null;
    }
    if (!target || !target.el) return;
    target.el.classList.add(target.ok ? 'target-ok' : 'target-bad');
    this._lastTarget = target;
  }

  _onUp(e) {
    if (!this.drag) return;
    const uid = this.drag.uid;
    const rot = this.drag.rot;
    const target = this._pickTarget(e);
    this.stopDrag();
    if (!target || !target.ok) {
      this.renderAll();
      return;
    }
    if (target.kind === 'slot') this.sys.equip(uid, target.slot);
    else if (target.kind === 'hotbar') this.sys.assignQuick(target.index, uid);
    else if (target.kind === 'grid') this.sys.move(uid, target.path, target.gx, target.gy, rot);
    else this.renderAll();
  }

  /**
   * Resolve the drop under the cursor. elementFromPoint is used rather than
   * event.target because the ghost follows the pointer and the real target is
   * underneath it — the ghost is pointer-events:none for this reason.
   */
  _pickTarget(e) {
    if (typeof document === 'undefined') return null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || typeof el.closest !== 'function') return null;
    const it = this.sys.get(this.drag ? this.drag.uid : 0);
    const d = it ? this.items.get(it.id) : null;
    if (!d) return null;

    const hot = el.closest('[data-hotbar]');
    if (hot) {
      const ok = d.t === 'med' || d.t === 'food';
      return { kind: 'hotbar', el: hot, index: +hot.getAttribute('data-hotbar'), ok };
    }

    const slotEl = el.closest('[data-slot]');
    if (slotEl) {
      const slot = slotEl.getAttribute('data-slot');
      const accept = SLOT_ACCEPT[slot];
      return { kind: 'slot', el: slotEl, slot, ok: !!accept && accept.includes(d.t) };
    }

    const gridEl = el.closest('.grid[data-path]');
    if (gridEl) {
      const path = gridEl.getAttribute('data-path');
      const g = this.sys.grid(path);
      if (!g) return null;
      const rect = gridEl.getBoundingClientRect();
      const w = this.drag.rot ? d.h : d.w;
      const h = this.drag.rot ? d.w : d.h;
      /* Anchor by the item's top-left, with the cursor at its centre. */
      const gx = Math.round((e.clientX - rect.left - (w * CELL) / 2) / CELL);
      const gy = Math.round((e.clientY - rect.top - (h * CELL) / 2) / CELL);
      /* The stash is unreachable in a raid, so a drop into it is never valid. */
      const reachable = path !== 'stash' || !this.sys._isRaidContext();
      const ok = reachable && this.sys.fits(g, it, gx, gy, this.drag.rot);
      return { kind: 'grid', el: gridEl, path, gx, gy, ok };
    }
    return null;
  }

  stopDrag() {
    this._highlight(null);
    this.drag = null;
    if (this.ghost) this.ghost.style.display = 'none';
  }
}
