export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const ri = (a, b) => Math.floor(rand(a, b + 1));
export const pick = (a) => a[Math.floor(Math.random() * a.length)];
export const uid = () => 'i' + Math.random().toString(36).slice(2, 10);
export const fmt = (n) => Math.round(n || 0).toLocaleString('ru-RU');
export const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function mmss(s) {
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

export function weighted(rows) {
  let t = 0;
  for (const r of rows) t += r.w;
  let r = Math.random() * t;
  for (const x of rows) {
    r -= x.w;
    if (r <= 0) return x.id;
  }
  return rows[rows.length - 1].id;
}

export function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const approach = (cur, target, rate, dt) => cur + (target - cur) * clamp(rate * dt, 0, 1);

export const escapeHtml = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export class EventBus {
  constructor() {
    this._map = new Map();
  }
  on(type, fn) {
    if (!this._map.has(type)) this._map.set(type, new Set());
    this._map.get(type).add(fn);
    return () => this.off(type, fn);
  }
  once(type, fn) {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }
  off(type, fn) {
    const s = this._map.get(type);
    if (s) s.delete(fn);
  }
  emit(type, payload) {
    const s = this._map.get(type);
    if (!s) return;
    for (const fn of Array.from(s)) {
      try {
        fn(payload);
      } catch (e) {
        console.error('[bus] ' + type, e);
      }
    }
  }
  clear() {
    this._map.clear();
  }
}

export function ensureBus(ctx) {
  if (!ctx) return new EventBus();
  if (ctx.events && typeof ctx.events.emit === 'function' && typeof ctx.events.on === 'function') return ctx.events;
  if (ctx.bus && typeof ctx.bus.emit === 'function' && typeof ctx.bus.on === 'function') return ctx.bus;
  if (typeof ctx.emit === 'function' && typeof ctx.on === 'function') return ctx;
  if (!ctx.__tarkovBus) ctx.__tarkovBus = new EventBus();
  return ctx.__tarkovBus;
}

export function peek(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.peek === 'function') {
      const s = ctx.peek(name);
      if (s) return s;
    }
    if (ctx.subsystems) {
      if (typeof ctx.subsystems.get === 'function') {
        const s = ctx.subsystems.get(name);
        if (s) return s;
      }
      if (ctx.subsystems[name]) return ctx.subsystems[name];
    }
    if (typeof ctx.get === 'function') {
      const s = ctx.get(name);
      if (s) return s;
    }
    if (ctx[name]) return ctx[name];
  } catch {
    // subsystem may still be initializing
  }
  return null;
}

export function getProfile(ctx) {
  if (!ctx) return { skills: {}, hideout: {}, stats: {} };
  const meta = peek(ctx, 'meta');
  if (meta?.P) return (ctx.profile = meta.P);
  if (!ctx.profile) {
    ctx.profile = {
      nick: 'MTDV_Fujiwara',
      lvl: 1,
      xp: 0,
      rub: 800000,
      usd: 1200,
      eur: 600,
      rows: 30,
      skills: { end: 0, str: 0, vit: 0, met: 0, rec: 0, mag: 0, srch: 0 },
      skillXp: {},
      hideout: { med: 0, rest: 0, range: 0, intel: 0, gen: 0 },
      stats: { raids: 0, surv: 0, died: 0, kills: 0, loot: 0, shots: 0, best: 0 },
    };
  }
  return ctx.profile;
}

export function addSkill(ctx, id, amount) {
  const P = getProfile(ctx);
  const rangeLvl = (P.hideout && P.hideout.range) || 0;
  const k = id === 'rec' || id === 'mag' ? 1 + rangeLvl * 0.22 : 1;
  P.skillXp[id] = (P.skillXp[id] || 0) + amount * k;
  const lvl = Math.min(50, Math.floor(Math.sqrt(P.skillXp[id] / 60)));
  if ((P.skills[id] || 0) < lvl) {
    P.skills[id] = lvl;
    ensureBus(ctx).emit('skill:levelup', { id, lvl });
  }
  return P.skills[id] || 0;
}

export function injectStyle(id, css) {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
  return el;
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
