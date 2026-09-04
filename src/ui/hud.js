// src/ui/hud.js
// mmss() вызывался в update(), но нигде не был объявлен и не импортирован —
// гарантированный ReferenceError на первом же тике таймера рейда.

const HUD_STYLE_ID = 'efl-hud-css';

/* Разметки HUD не было нигде: в index.html лежат только #game и #ui, ни одна
 * система контейнер #hud не создавала. getElementById('hud') всегда возвращал
 * null, поэтому mount() выходил на первой строке, а update() молчал. Контейнер
 * создаём сами — один раз, при первом mount(). */
const HUD_CSS = `
#hud.efl-hud {
  position: fixed; inset: 0; z-index: 8000;
  pointer-events: none; user-select: none;
  font-family: 'Oswald', 'Bebas Neue', 'DIN Condensed', Impact, Arial, sans-serif;
  color: #c8c7c2;
}
#hud.efl-hud .efl-hud__clock {
  position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
  font-size: 30px; line-height: 1; letter-spacing: 0.14em;
  font-variant-numeric: tabular-nums; color: #eceae5;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.9);
}
#hud.efl-hud .efl-hud__vitals {
  position: absolute; left: 26px; bottom: 24px;
  display: flex; align-items: flex-end; gap: 26px;
}
#hud.efl-hud .efl-hud__cell { display: flex; flex-direction: column; gap: 3px; }
#hud.efl-hud .efl-hud__cap {
  font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
  color: rgba(200, 199, 194, 0.55);
}
#hud.efl-hud .efl-hud__val {
  font-size: 26px; line-height: 1; letter-spacing: 0.06em;
  font-variant-numeric: tabular-nums; color: #eceae5;
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.9);
}
#hud.efl-hud .efl-hud__val.warn { color: #e2a114; }
#hud.efl-hud .efl-hud__val.over { color: #e2544a; }
`;

/* Селекторы совпадают с тем, что ищет pick(): [data-hud="<имя>"]. */
const HUD_MARKUP =
  '<div class="efl-hud__clock" data-hud="time">--:--</div>' +
  '<div class="efl-hud__vitals">' +
    '<div class="efl-hud__cell">' +
      '<span class="efl-hud__cap">Здоровье</span>' +
      '<span class="efl-hud__val" data-hud="hp">—</span>' +
    '</div>' +
    '<div class="efl-hud__cell">' +
      '<span class="efl-hud__cap">Патроны</span>' +
      '<span class="efl-hud__val" data-hud="ammo">0</span>' +
    '</div>' +
    '<div class="efl-hud__cell">' +
      '<span class="efl-hud__cap">Вес</span>' +
      '<span class="efl-hud__val" data-hud="kg">0 кг</span>' +
    '</div>' +
  '</div>';

function pad2(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0');
}

export function mmss(totalSeconds) {
  const t = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
}

export class Hud {
  static id = 'hud';
  static deps = [];

  constructor(options = {}) {
    /* Engine.add(Hud, opts) создаёт систему сам и передаёт сюда opts, а не ctx:
     * ctx приходит только в init(). Ручное new Hud(ctx) из дев-харнессов тоже
     * должно работать — ctx отличаем по наличию peek/get. */
    const isCtx = !!options && (typeof options.peek === 'function' || typeof options.get === 'function');
    this.options = isCtx ? {} : (options || {});
    this.ctx = isCtx ? options : null;

    this._acc = 0;
    this._last = { hp: -1, ammo: -1, weight: -1, time: -1, mode: -1 };
    this.el = {};                       // ссылки на DOM берутся один раз, в mount()
    this.root = null;
    this.visible = false;
    this._ownsRoot = false;             // контейнер создали мы — нам его и убирать
    this.tabletOpen = false
    this._onTabletKey = null
    this._onTabletRequest = null
    this._offState = null
  }

  init(ctx) {
    this.ctx = ctx || this.ctx;
    this.mount();
    this._bindTablet()
    return this;
  }

  /* registry.get() бросает для незарегистрированного id — только peek. */
  _svc(id) {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (typeof ctx.peek === 'function') {
      try { return ctx.peek(id); } catch (e) { return null; }
    }
    if (typeof ctx.get === 'function') {
      try { return ctx.get(id); } catch (e) { return null; }
    }
    return null;
  }

  _injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(HUD_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HUD_STYLE_ID;
    style.textContent = HUD_CSS;
    document.head.appendChild(style);
  }

  /** Контейнер #hud, которого нет ни в index.html, ни в других системах. */
  _createRoot() {
    const host = document.getElementById('ui') || document.body;
    if (!host) return null;
    const node = document.createElement('div');
    node.id = 'hud';
    node.className = 'efl-hud';
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = HUD_MARKUP;
    host.appendChild(node);
    this._ownsRoot = true;
    return node;
  }

  /** Старая версия никогда не заполняла this.el, так что любая запись в
   *  this.el.hp.textContent падала с TypeError. */
  mount(root) {
    if (typeof document === 'undefined') return this;
    this._injectStyles();

    const host = root || document.getElementById('hud') || this._createRoot();
    this.root = host || null;
    if (!this.root) return this;

    const pick = (name) =>
      this.root.querySelector('[data-hud="' + name + '"]') ||
      this.root.querySelector('#hud-' + name) ||
      this.root.querySelector('.hud-' + name) ||
      null;

    this.el = {
      hp: pick('hp'),
      ammo: pick('ammo'),
      kg: pick('kg') || pick('weight'),
      time: pick('time'),
    };

    /* Ссылки новые — кэш прошлых значений больше ничего не значит. */
    this._last = { hp: -1, ammo: -1, weight: -1, time: -1, mode: -1 };
    this.setVisible(this.visible);
    return this;
  }

  /** UiSystem.setHudVisible() зовут ещё до init() (в самом UiSystem.init),
   *  а hot-reload или пересборка оверлеев может выкинуть узел из документа. */
  _ensureRoot() {
    if (this.root && this.root.isConnected !== false) return this.root;
    this.root = null;
    this.el = {};
    this.mount();
    return this.root;
  }

  /** Контракт, который щупает UiSystem.setHudVisible(). */
  setVisible(v) {
    this.visible = !!v;
    const node = this.root ||
      (typeof document !== 'undefined' ? document.getElementById('hud') : null);
    if (node && node.style) node.style.display = this.visible ? '' : 'none';
    return this;
  }

  _bindTablet() {
    if (typeof window === 'undefined' || this._onTabletKey) return

    this._onTabletKey = (event) => {
      const key = (event.key || '').toLowerCase()
      if (key !== 'm' && key !== 'ь' && !(key === 'escape' && this.tabletOpen)) return
      const tag = document.activeElement?.tagName || ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!this.tabletOpen && this.ctx?.engine?.state !== 'gameplay') return
      event.preventDefault()
      event.stopImmediatePropagation()
      this._setTabletOpen(key === 'escape' ? false : !this.tabletOpen)
    }

    this._onTabletRequest = (event) => {
      this._setTabletOpen(event.detail?.open !== false)
    }

    window.addEventListener('keydown', this._onTabletKey, true)
    window.addEventListener('efl:diagnostics-request', this._onTabletRequest)
    this._offState = this.ctx?.events?.on?.('state', ({ to }) => {
      if (to !== 'gameplay' && this.tabletOpen) this._setTabletOpen(false)
    })
  }

  _setTabletOpen(open) {
    const want = !!open
    if (want && this.ctx?.engine?.state !== 'gameplay') return false
    if (want === this.tabletOpen) return want
    this.tabletOpen = want

    const input = this.ctx?.input
    if (input) {
      input.enabled = !want
      input.frozen = want
      if (want) input.pointerLocked = false
    }
    if (want) {
      try { document.exitPointerLock?.() } catch {}
    }

    window.dispatchEvent(new CustomEvent('efl:diagnostics', {
      detail: { open: want, tab: 'gps', ctx: this.ctx },
    }))
    return want
  }

  /** HUD обновляется 10 раз в секунду, а не каждый кадр,
   *  и пишет в DOM только изменившиеся поля. */
  update(dt) {
    this._acc += Number(dt) || 0;
    if (this._acc < 0.1) return;
    this._acc = 0;

    if (!this._ensureRoot()) return;

    const health = this._svc('health');
    if (health && typeof health.total === 'function' && this.el.hp) {
      const hp = Math.round(Number(health.total()) || 0);
      if (hp !== this._last.hp) { this.el.hp.textContent = String(hp); this._last.hp = hp; }
    }

    const weapons = this._svc('weapons');
    if (weapons && this.el.ammo) {
      const ammo = weapons.active?.nm ?? 0;
      if (ammo !== this._last.ammo) { this.el.ammo.textContent = String(ammo); this._last.ammo = ammo; }
    }

    const inv = this._svc('inventory');
    if (inv && typeof inv.weight === 'function' && this.el.kg) {
      const kg = Math.round((Number(inv.weight()) || 0) * 10) / 10;
      if (kg !== this._last.weight) {
        this.el.kg.textContent = kg + ' кг';
        /* Здесь была запись в className — она стирала базовый класс элемента
         * вместе с его вёрсткой. Трогаем только модификаторы. */
        if (this.el.kg.classList) {
          this.el.kg.classList.toggle('over', kg > 42);
          this.el.kg.classList.toggle('warn', kg > 28 && kg <= 42);
        }
        this._last.weight = kg;
      }
    }

    const raid = this._svc('raid');
    if (raid && this.el.time) {
      const t = Math.ceil(Number(raid.timeLeft) || 0);
      if (t !== this._last.time) { this.el.time.textContent = mmss(t); this._last.time = t; }
    }
  }

  dispose() {
    if (this.tabletOpen) this._setTabletOpen(false)
    if (this._onTabletKey && typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onTabletKey, true)
      window.removeEventListener('efl:diagnostics-request', this._onTabletRequest)
    }
    if (typeof this._offState === 'function') this._offState()
    this._onTabletKey = null
    this._onTabletRequest = null
    this._offState = null
    if (this._ownsRoot && this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    this._ownsRoot = false;
    this.el = {};
    this.root = null;
    this.ctx = null;
  }
}

export default Hud;
