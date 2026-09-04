import { clamp, escapeHtml, injectStyle, peek, el } from '../core/tarkovUtils.js';

const STYLE_ID = 'ow-tarkov-health-style';
injectStyle(
  STYLE_ID,
  `
.ow-tarkov-health {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 250px;
  padding: 14px 14px 12px;
  border: 1px solid rgba(255,255,255,.08);
  background: linear-gradient(180deg, rgba(4,8,12,.88), rgba(6,12,18,.68));
  box-shadow: 0 20px 50px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.04);
  border-radius: 16px;
  color: #eaf5ff;
  font-family: var(--ff, system-ui);
  user-select: none;
  pointer-events: auto;
}
.ow-tarkov-health .title {
  display:flex; justify-content:space-between; align-items:baseline;
  margin-bottom:10px; letter-spacing:.12em; text-transform:uppercase;
}
.ow-tarkov-health .title b { font-size:13px; }
.ow-tarkov-health .title i { font-style:normal; color:rgba(220,235,255,.72); font-size:11px; }
.ow-tarkov-health .body { position:relative; height:180px; }
.ow-tarkov-health .part {
  position:absolute;
  border:1px solid rgba(255,255,255,.16);
  border-radius:12px;
  background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(0,0,0,.18));
  color: rgba(255,255,255,.88);
  font-size:11px;
  letter-spacing:.08em;
  text-transform:uppercase;
  cursor:pointer;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06);
}
.ow-tarkov-health .part.sel { outline: 2px solid rgba(255,255,255,.35); }
.ow-tarkov-health .part span { display:block; font-size:9px; opacity:.8; letter-spacing:.02em; }
.ow-tarkov-health .stats {
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px 10px;
  margin-top:8px;
  font-size:11px;
  color: rgba(230,240,255,.88);
}
.ow-tarkov-health .stats .line {
  padding:6px 8px;
  border-radius:10px;
  background: rgba(255,255,255,.04);
}
.ow-tarkov-health .effects {
  margin-top:8px;
  font-size:10px;
  color: rgba(255,220,210,.92);
  line-height:1.35;
  min-height: 28px;
}
`
);

const PARTS = [
  { id: 'head', label: 'Head', x: 101, y: 4, w: 52, h: 34 },
  { id: 'thorax', label: 'Thorax', x: 83, y: 40, w: 88, h: 38 },
  { id: 'stomach', label: 'Stomach', x: 88, y: 82, w: 78, h: 34 },
  { id: 'larm', label: 'L Arm', x: 24, y: 48, w: 52, h: 30 },
  { id: 'rarm', label: 'R Arm', x: 172, y: 48, w: 52, h: 30 },
  { id: 'lleg', label: 'L Leg', x: 74, y: 120, w: 52, h: 44 },
  { id: 'rleg', label: 'R Leg', x: 124, y: 120, w: 52, h: 44 },
];

function ratioColor(t) {
  t = clamp(t, 0, 1);
  const stops = [
    [0, [12, 12, 12]],
    [0.25, [210, 44, 44]],
    [0.55, [230, 202, 48]],
    [1, [48, 210, 96]],
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      a = stops[i - 1];
      b = stops[i];
      break;
    }
  }
  const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * clamp(u, 0, 1)));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export class HealthHud {
  constructor(parent, ctx) {
    this.ctx = ctx;
    this.root = el('div', 'ow-tarkov-health', parent);
    const title = el('div', 'title', this.root);
    this.titleLeft = el('b', null, title, 'HEALTH');
    this.titleRight = el('i', null, title, '440 / 440');
    this.body = el('div', 'body', this.root);
    this.parts = new Map();
    for (const p of PARTS) {
      const b = el('button', 'part', this.body);
      b.type = 'button';
      b.style.left = `${p.x}px`;
      b.style.top = `${p.y}px`;
      b.style.width = `${p.w}px`;
      b.style.height = `${p.h}px`;
      b.innerHTML = `${escapeHtml(p.label)}<span>0 / 0</span>`;
      b.addEventListener('click', () => this.ctx.peek('health')?.selectPart?.(p.id));
      this.parts.set(p.id, b);
    }
    this.stats = el('div', 'stats', this.root);
    this._h = el('div', 'line', this.stats, 'STAMINA 100');
    this._e = el('div', 'line', this.stats, 'ENERGY 100');
    this._w = el('div', 'line', this.stats, 'WATER 100');
    this._p = el('div', 'line', this.stats, 'PAIN 0');
    this.effects = el('div', 'effects', this.root, '');
    this._show = 1;
  }

  _readHealth() {
    const h = peek(this.ctx, 'health');
    if (!h) return null;
    return typeof h.snapshot === 'function' ? h.snapshot() : typeof h.getHudState === 'function' ? h.getHudState() : h;
  }

  update(dt) {
    const s = this._readHealth();
    if (!s) {
      this.root.style.display = 'none';
      return;
    }
    this.root.style.display = '';
    this._show = clamp(this._show + dt * 8, 0, 1);
    const total = Math.round(s.health ?? 0);
    const max = Math.round(s.maxHealth ?? 440);
    this.titleRight.textContent = `${total} / ${max}`;
    for (const p of PARTS) {
      const b = this.parts.get(p.id);
      const d = s.parts?.[p.id] ?? { hp: 0, max: 0 };
      const r = d.max > 0 ? clamp(d.hp / d.max, 0, 1) : 0;
      b.style.background = `linear-gradient(180deg, ${ratioColor(r)}, rgba(0,0,0,.45))`;
      b.classList.toggle('sel', s.selectedPart === p.id);
      b.lastElementChild.textContent = `${Math.round(d.hp ?? 0)} / ${Math.round(d.max ?? 0)}`;
      b.title = `${p.label}: ${Math.round(d.hp ?? 0)} / ${Math.round(d.max ?? 0)}`;
    }
    this._h.textContent = `STAMINA ${Math.round(s.stamina ?? 0)}`;
    this._e.textContent = `ENERGY ${Math.round(s.energy ?? 0)}`;
    this._w.textContent = `WATER ${Math.round(s.hydration ?? 0)}`;
    this._p.textContent = `PAIN ${Math.round(s.pain ?? 0)}`;
    const effects = Array.isArray(s.effects) ? s.effects : [];
    this.effects.innerHTML = effects.length ? effects.map(escapeHtml).join('<br>') : '&nbsp;';
  }

  dispose() {
    this.root.remove();
  }
}
