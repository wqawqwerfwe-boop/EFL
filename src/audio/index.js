import * as THREE from "three";

/*
 * Escape from Larpov - audio subsystem.
 *
 * Ни одного аудиофайла: весь банк синтезируется процедурно в OfflineAudioContext
 * при init() и живёт как набор AudioBuffer. В кадре не аллоцируется ни одного
 * JS-объекта: векторы поля слушателя, кэш окклюзии и результат рейкаста
 * преаллоцированы в конструкторе.
 *
 * play(kind, position, opts):
 *   position - THREE.Vector3 или null для 2D
 *   opts.cal        - калибр, выбирает подбанк выстрела
 *   opts.gain       - множитель громкости
 *   opts.pitch      - playbackRate
 *   opts.delay      - задержка в секундах
 *   opts.reverb     - 0..1, посыл в конволюцию
 *   opts.occlusion  - принудительное значение 0..1, минуя рейкаст
 *   opts.autoFar    - false отключает подмену выстрела на дальний
 */

const VOICE_COUNT = 24;
const FLAT_VOICES = 6;
const RAYS_PER_FRAME = 6;
const OCC_CACHE_SIZE = 24;
const OCC_TTL = 0.22;
const OCC_RADIUS2 = 6.25;
const LP_BLOCKED = 900;
const LP_OPEN = 18000;
const SOUND_SPEED = 343;
const MAX_AUDIBLE = 240;
const REF_DISTANCE = 6;
const FAR_SWITCH = 55;

const PRIORITY = {
  boom: 10,
  shot: 9,
  far: 8,
  shot_sup: 7,
  far_sup: 7,
  death: 7,
  hit: 6,
  armor: 6,
  hitmark: 6,
  ui: 6,
  whiz: 5,
  reload: 5,
  glass: 4,
  mag: 4,
  door: 4,
  heal: 4,
  click: 3,
  loot: 3,
  pickup: 3,
  shell: 2,
  step: 2,
};

function priorityOf(kind) {
  const p = PRIORITY[kind];
  return p === undefined ? 3 : p;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function whiteNoiseBuffer(actx, seconds, rand) {
  const len = Math.max(1, Math.floor(actx.sampleRate * seconds));
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
  return buf;
}

/* ---------- элементарные кирпичи синтеза (только в offline-рендере) ---------- */

function noiseHit(V, t, dur, gain, cutoff, type, q, rate) {
  const src = V.oc.createBufferSource();
  src.buffer = V.noise;
  src.loop = true;
  src.playbackRate.value = rate === undefined ? 1 : rate;
  const f = V.oc.createBiquadFilter();
  f.type = type === undefined ? "lowpass" : type;
  f.frequency.value = Math.max(40, cutoff);
  f.Q.value = q === undefined ? 0.8 : q;
  const g = V.oc.createGain();
  const amp = Math.max(0.0004, gain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + 0.0016);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(V.dest);
  src.start(t);
  src.stop(t + dur + 0.02);
  return f;
}

function tone(V, t, dur, freq, gain, type, endFreq) {
  const o = V.oc.createOscillator();
  o.type = type === undefined ? "sine" : type;
  o.frequency.setValueAtTime(Math.max(20, freq), t);
  if (endFreq)
    o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
  const g = V.oc.createGain();
  const amp = Math.max(0.0004, gain);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(amp, t + Math.min(0.006, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(V.dest);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/* ---------- рецепты ---------- */

const SHOT_PROFILES = {
  545: { crack: 5200, body: 165, punch: 0.95, tail: 0.3, tailCut: 900 },
  556: { crack: 5600, body: 175, punch: 0.92, tail: 0.28, tailCut: 950 },
  "9x19": { crack: 4200, body: 210, punch: 0.78, tail: 0.22, tailCut: 800 },
  "9x18": { crack: 3900, body: 230, punch: 0.7, tail: 0.2, tailCut: 780 },
  "762x54": { crack: 4600, body: 120, punch: 1.1, tail: 0.42, tailCut: 700 },
  "12x70": { crack: 2600, body: 90, punch: 1.15, tail: 0.38, tailCut: 620 },
  default: { crack: 4800, body: 170, punch: 0.9, tail: 0.28, tailCut: 880 },
};

function renderShot(p, suppressed) {
  return function render(V, rng) {
    const j = 1 + (rng() - 0.5) * 0.12;
    if (suppressed) {
      noiseHit(V, 0, 0.09, 0.34, 900 * j, "lowpass", 0.9, 1);
      noiseHit(V, 0.004, 0.05, 0.18, 2400 * j, "bandpass", 1.4, 1);
      tone(V, 0, 0.05, 190 * j, 0.14, "square", 95);
      noiseHit(V, 0.02, 0.16, 0.1, 620 * j, "lowpass", 0.7, 0.8);
      return;
    }
    noiseHit(V, 0, 0.045, 0.95 * p.punch, p.crack * j, "highpass", 0.7, 1);
    noiseHit(V, 0, 0.16, 0.72 * p.punch, 2600 * j, "lowpass", 0.9, 1);
    tone(V, 0, 0.1, p.body * j, 0.55 * p.punch, "square", p.body * 0.42);
    noiseHit(V, 0.012, p.tail, 0.22, p.tailCut * j, "lowpass", 0.6, 0.7);
  };
}

function renderFar(p, suppressed) {
  return function render(V, rng) {
    const j = 1 + (rng() - 0.5) * 0.2;
    const g = suppressed ? 0.2 : 0.58;
    noiseHit(V, 0, 0.05, g * 0.7, 1900 * j, "bandpass", 1.1, 1);
    noiseHit(V, 0.03, 0.55, g, 420 * j, "lowpass", 0.5, 0.6);
    tone(V, 0.02, 0.4, 68 * j, g * 0.35, "sine", 40);
  };
}

function renderImpact(cut, gain, ringFreq, dur) {
  return function render(V, rng) {
    const j = 1 + (rng() - 0.5) * 0.25;
    noiseHit(V, 0, dur, gain, cut * j, "lowpass", 0.9, 1);
    if (ringFreq)
      tone(
        V,
        0.002,
        dur * 1.6,
        ringFreq * j,
        gain * 0.35,
        "triangle",
        ringFreq * 0.55,
      );
  };
}

function renderFlesh(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.2;
  noiseHit(V, 0, 0.09, 0.6, 1100 * j, "lowpass", 0.7, 1);
  tone(V, 0, 0.05, 240 * j, 0.22, "triangle", 120);
}

function renderArmor(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.25;
  noiseHit(V, 0, 0.06, 0.5, 5200 * j, "highpass", 1.2, 1);
  tone(V, 0, 0.14, 1650 * j, 0.28, "triangle", 640);
}

function renderWhiz(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.35;
  noiseHit(V, 0, 0.11, 0.3, 2300 * j, "bandpass", 6, 1.4);
  tone(V, 0, 0.1, 2400 * j, 0.12, "sine", 700);
}

function renderClick(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.2;
  tone(V, 0, 0.03, 1200 * j, 0.22, "square", 900);
  noiseHit(V, 0, 0.02, 0.16, 6000 * j, "highpass", 1, 1);
}

function renderReload(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.18;
  tone(V, 0, 0.05, 320 * j, 0.3, "square", 190);
  noiseHit(V, 0.005, 0.06, 0.24, 3400 * j, "bandpass", 1.6, 1);
  tone(V, 0.17, 0.06, 480 * j, 0.26, "square", 700);
  noiseHit(V, 0.175, 0.05, 0.22, 4200 * j, "highpass", 1.1, 1);
}

function renderMag(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.2;
  noiseHit(V, 0, 0.04, 0.24, 3800 * j, "bandpass", 2.2, 1);
  tone(V, 0.03, 0.05, 620 * j, 0.18, "square", 420);
}

function renderShell(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.3;
  tone(V, 0, 0.05, 2100 * j, 0.14, "triangle", 1300);
  tone(V, 0.06, 0.04, 1750 * j, 0.08, "triangle", 1050);
  noiseHit(V, 0, 0.03, 0.08, 7000 * j, "highpass", 1, 1);
}

function renderStep(cut, gain) {
  return function render(V, rng) {
    const j = 1 + (rng() - 0.5) * 0.3;
    noiseHit(V, 0, 0.075, gain, cut * j, "lowpass", 0.8, 1);
  };
}

function renderBoom(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.15;
  noiseHit(V, 0, 0.06, 1.0, 4200 * j, "highpass", 0.8, 1);
  noiseHit(V, 0, 0.85, 0.9, 380 * j, "lowpass", 0.6, 0.55);
  tone(V, 0, 0.7, 62 * j, 0.6, "sine", 26);
  noiseHit(V, 0.12, 0.9, 0.22, 900 * j, "lowpass", 0.5, 0.45);
}

function renderDeath(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.2;
  tone(V, 0, 0.75, 128 * j, 0.3, "sawtooth", 52);
  noiseHit(V, 0.05, 0.45, 0.16, 700 * j, "lowpass", 0.7, 0.8);
}

function renderDoor(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.2;
  noiseHit(V, 0, 0.3, 0.24, 900 * j, "bandpass", 2.4, 0.7);
  tone(V, 0.02, 0.28, 210 * j, 0.14, "sawtooth", 130);
  noiseHit(V, 0.3, 0.07, 0.3, 2600 * j, "lowpass", 0.9, 1);
}

function renderLoot(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.3;
  noiseHit(V, 0, 0.22, 0.2, 2600 * j, "bandpass", 1.2, 1.2);
  noiseHit(V, 0.14, 0.18, 0.14, 1800 * j, "bandpass", 1.4, 0.9);
}

function renderHeal(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.15;
  noiseHit(V, 0, 0.35, 0.16, 1400 * j, "bandpass", 1.1, 0.8);
  tone(V, 0.1, 0.2, 520 * j, 0.1, "sine", 780);
}

function renderPickup(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.15;
  tone(V, 0, 0.07, 760 * j, 0.16, "triangle", 1140);
  tone(V, 0.06, 0.08, 1140 * j, 0.12, "triangle", 1520);
}

function renderUi(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.1;
  tone(V, 0, 0.04, 880 * j, 0.16, "square", 1240);
}

function renderHitmark(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.1;
  tone(V, 0, 0.045, 1480 * j, 0.2, "square", 980);
  noiseHit(V, 0, 0.03, 0.12, 6500 * j, "highpass", 1, 1);
}

function renderGlass(V, rng) {
  const j = 1 + (rng() - 0.5) * 0.3;
  noiseHit(V, 0, 0.35, 0.4, 7000 * j, "highpass", 1.4, 1.3);
  tone(V, 0.01, 0.22, 3200 * j, 0.14, "triangle", 1900);
  tone(V, 0.06, 0.18, 4600 * j, 0.1, "triangle", 2600);
}

/*
 * Описание банка. dur - длина рендера в секундах, n - число вариаций.
 * Каждая вариация рендерится со своим сидом, поэтому очередь выстрелов
 * не звучит машинно одинаково, но в кадре не тратится ни одного вызова rng.
 */
function bankTable() {
  const t = [];
  for (const cal in SHOT_PROFILES) {
    if (cal === "default") continue;
    const p = SHOT_PROFILES[cal];
    t.push({
      kind: "shot",
      cal: cal,
      n: 3,
      dur: 0.7,
      fn: renderShot(p, false),
    });
    t.push({
      kind: "shot_sup",
      cal: cal,
      n: 2,
      dur: 0.32,
      fn: renderShot(p, true),
    });
    t.push({ kind: "far", cal: cal, n: 2, dur: 0.75, fn: renderFar(p, false) });
  }
  t.push({
    kind: "shot",
    cal: null,
    n: 3,
    dur: 0.7,
    fn: renderShot(SHOT_PROFILES.default, false),
  });
  t.push({
    kind: "shot_sup",
    cal: null,
    n: 2,
    dur: 0.32,
    fn: renderShot(SHOT_PROFILES.default, true),
  });
  t.push({
    kind: "far",
    cal: null,
    n: 2,
    dur: 0.75,
    fn: renderFar(SHOT_PROFILES.default, false),
  });
  t.push({
    kind: "far_sup",
    cal: null,
    n: 2,
    dur: 0.5,
    fn: renderFar(SHOT_PROFILES.default, true),
  });
  t.push({
    kind: "impact_concrete",
    cal: null,
    n: 3,
    dur: 0.22,
    fn: renderImpact(2600, 0.5, 0, 0.12),
  });
  t.push({
    kind: "impact_metal",
    cal: null,
    n: 3,
    dur: 0.3,
    fn: renderImpact(5200, 0.45, 2400, 0.1),
  });
  t.push({
    kind: "impact_wood",
    cal: null,
    n: 3,
    dur: 0.2,
    fn: renderImpact(1500, 0.45, 420, 0.11),
  });
  t.push({
    kind: "impact_dirt",
    cal: null,
    n: 3,
    dur: 0.2,
    fn: renderImpact(760, 0.4, 0, 0.13),
  });
  t.push({ kind: "impact_glass", cal: null, n: 2, dur: 0.6, fn: renderGlass });
  t.push({ kind: "glass", cal: null, n: 2, dur: 0.6, fn: renderGlass });
  t.push({ kind: "hit", cal: null, n: 3, dur: 0.2, fn: renderFlesh });
  t.push({ kind: "armor", cal: null, n: 3, dur: 0.3, fn: renderArmor });
  t.push({ kind: "whiz", cal: null, n: 3, dur: 0.2, fn: renderWhiz });
  t.push({ kind: "click", cal: null, n: 2, dur: 0.08, fn: renderClick });
  t.push({ kind: "reload", cal: null, n: 2, dur: 0.32, fn: renderReload });
  t.push({ kind: "mag", cal: null, n: 2, dur: 0.14, fn: renderMag });
  t.push({ kind: "shell", cal: null, n: 3, dur: 0.16, fn: renderShell });
  t.push({
    kind: "step",
    cal: null,
    n: 4,
    dur: 0.12,
    fn: renderStep(760, 0.16),
  });
  t.push({
    kind: "step_metal",
    cal: null,
    n: 3,
    dur: 0.14,
    fn: renderStep(3400, 0.18),
  });
  t.push({
    kind: "step_concrete",
    cal: null,
    n: 3,
    dur: 0.12,
    fn: renderStep(1500, 0.17),
  });
  t.push({
    kind: "step_dirt",
    cal: null,
    n: 3,
    dur: 0.13,
    fn: renderStep(560, 0.15),
  });
  t.push({ kind: "boom", cal: null, n: 2, dur: 1.5, fn: renderBoom });
  t.push({ kind: "death", cal: null, n: 2, dur: 1.0, fn: renderDeath });
  t.push({ kind: "door", cal: null, n: 2, dur: 0.55, fn: renderDoor });
  t.push({ kind: "loot", cal: null, n: 2, dur: 0.5, fn: renderLoot });
  t.push({ kind: "heal", cal: null, n: 1, dur: 0.6, fn: renderHeal });
  t.push({ kind: "pickup", cal: null, n: 1, dur: 0.2, fn: renderPickup });
  t.push({ kind: "ui", cal: null, n: 1, dur: 0.08, fn: renderUi });
  t.push({ kind: "hitmark", cal: null, n: 2, dur: 0.1, fn: renderHitmark });
  return t;
}

/* surface -> kind. Простой лукап по объекту, никаких конкатенаций строк в кадре. */
const IMPACT_KIND = {
  concrete: "impact_concrete",
  plaster: "impact_concrete",
  metal: "impact_metal",
  wood: "impact_wood",
  glass: "impact_glass",
  dirt: "impact_dirt",
  sand: "impact_dirt",
  foliage: "impact_dirt",
  fabric: "impact_wood",
  rubber: "impact_wood",
  water: "impact_dirt",
  flesh: "hit",
};

export class AudioSystem {
  static id = "audio";
  static deps = [];

  constructor() {
    this.ready = false;
    this.muted = false;
    this.masterVolume = 0.75;
    this.actx = null;
    this.ctx = null;
    this.sampleRate = 48000;

    /* Поле слушателя. Все векторы созданы один раз и только перезаписываются. */
    this.field = {
      listenerPos: new THREE.Vector3(),
      listenerFwd: new THREE.Vector3(0, 0, -1),
      listenerUp: new THREE.Vector3(0, 1, 0),
      indoor: 0,
      muffle: 0,
    };

    this.voices = [];
    this.flat = [];
    this._bank = Object.create(null);
    this._seq = 0;
    this._rays = RAYS_PER_FRAME;
    this._phys = null;
    this._physTried = false;
    this._muffleF = LP_OPEN;

    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._ray = {
      hit: false,
      distance: 0,
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      surface: 0,
      actor: null,
      partIndex: -1,
    };

    this._occX = new Float32Array(OCC_CACHE_SIZE);
    this._occY = new Float32Array(OCC_CACHE_SIZE);
    this._occZ = new Float32Array(OCC_CACHE_SIZE);
    this._occV = new Float32Array(OCC_CACHE_SIZE);
    this._occT = new Float32Array(OCC_CACHE_SIZE);
    this._occHead = 0;
    this._lastOcc = 0;

    this._handlers = null;
    this._unlockFn = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    const AC =
      typeof window === "undefined"
        ? null
        : window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      console.warn("[audio] Web Audio API недоступен, звук отключён");
      return;
    }
    try {
      this._AC = AC;
    } catch (e) {
      console.warn("[audio] не удалось создать AudioContext", e);
      return;
    }
    try {
      await this._renderBank();
    } catch (e) {
      console.warn("[audio] рендер банка не удался", e);
      return;
    }
    this._bindEvents();
    this._bindUnlock();
    this.ready = true;
  }

  _ensureActx() {
    if (this.actx) return this.actx;
    const AC = this._AC;
    if (!AC) return null;
    try {
      this.actx = new AC({ latencyHint: "interactive" });
    } catch (e) {
      console.warn("[audio] не удалось создать AudioContext", e);
      return null;
    }
    this.sampleRate = this.actx.sampleRate;
    this._buildGraph();
    return this.actx;
  }

  resume() {
    const a = this._ensureActx();
    if (!a) return null;
    if (a.state === "suspended") return a.resume();
    return Promise.resolve(a);
  }

  _buildGraph() {
    const a = this.actx;

    this.limiter = a.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.limiter.connect(a.destination);

    this.master = a.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(this.limiter);

    /* Общий lowpass контузии: при field.muffle = 1 всё уходит в 700 Гц. */
    this.muffleFilter = a.createBiquadFilter();
    this.muffleFilter.type = "lowpass";
    this.muffleFilter.frequency.value = LP_OPEN;
    this.muffleFilter.Q.value = 0.7;
    this.muffleFilter.connect(this.master);

    this.dry = a.createGain();
    this.dry.gain.value = 1;
    this.dry.connect(this.muffleFilter);

    this.convolver = a.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = this._makeIR(1.6, 2.4, 0x5eed);
    this.reverbIn = a.createGain();
    this.reverbIn.gain.value = 1;
    this.wet = a.createGain();
    this.wet.gain.value = 0.55;
    this.reverbIn.connect(this.convolver);
    this.convolver.connect(this.wet);
    this.wet.connect(this.muffleFilter);

    const listener = a.listener;
    if (listener && listener.positionX) {
      listener.positionX.value = 0;
      listener.positionY.value = 1.6;
      listener.positionZ.value = 0;
    }

    for (let i = 0; i < VOICE_COUNT; i++)
      this.voices.push(this._makeVoice(true));
    for (let i = 0; i < FLAT_VOICES; i++)
      this.flat.push(this._makeVoice(false));
  }

  _makeVoice(spatial) {
    const a = this.actx;
    const lp = a.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = LP_OPEN;
    lp.Q.value = 0.7;

    const hp = a.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 24;
    hp.Q.value = 0.6;

    const gain = a.createGain();
    gain.gain.value = 0;

    lp.connect(hp);
    hp.connect(gain);

    let panner = null;
    let send = null;
    if (spatial) {
      panner = a.createPanner();
      try {
        panner.panningModel = "HRTF";
      } catch (e) {
        panner.panningModel = "equalpower";
      }
      panner.distanceModel = "inverse";
      panner.refDistance = REF_DISTANCE;
      panner.rolloffFactor = 1.15;
      panner.maxDistance = MAX_AUDIBLE;
      panner.coneInnerAngle = 360;
      panner.coneOuterAngle = 360;
      panner.coneOuterGain = 1;
      gain.connect(panner);
      panner.connect(this.dry);
      send = a.createGain();
      send.gain.value = 0;
      panner.connect(send);
      send.connect(this.reverbIn);
    } else {
      gain.connect(this.dry);
    }

    return {
      lp: lp,
      hp: hp,
      gain: gain,
      panner: panner,
      send: send,
      src: null,
      busy: false,
      priority: -1,
      startedAt: 0,
      endsAt: 0,
    };
  }

  _makeIR(seconds, decay, seed) {
    const rate = this.sampleRate;
    const len = Math.max(1, Math.floor(seconds * rate));
    const buf = this.actx.createBuffer(2, len, rate);
    const rnd = mulberry32(seed);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const attack = i < 64 ? i / 64 : 1;
        d[i] = (rnd() * 2 - 1) * Math.pow(1 - t, decay) * attack;
      }
    }
    return buf;
  }

  async _renderOne(dur, fn, seed) {
    const rate = this.sampleRate;
    const frames = Math.max(128, Math.ceil(dur * rate));
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const oc = new OC(1, frames, rate);
    const noise = whiteNoiseBuffer(oc, 1.2, mulberry32(seed ^ 0x9e3779b9));
    fn({ oc: oc, noise: noise, dest: oc.destination }, mulberry32(seed));
    return await oc.startRendering();
  }

  async _renderBank() {
    const table = bankTable();
    for (let i = 0; i < table.length; i++) {
      const d = table[i];
      let entry = this._bank[d.kind];
      if (!entry) {
        entry = { buffers: [], byCal: null };
        this._bank[d.kind] = entry;
      }
      const list = [];
      for (let v = 0; v < d.n; v++) {
        const seed = hashString(
          d.kind + "|" + (d.cal === null ? "-" : d.cal) + "|" + v,
        );
        list.push(await this._renderOne(d.dur, d.fn, seed));
      }
      if (d.cal) {
        if (!entry.byCal) entry.byCal = new Map();
        entry.byCal.set(d.cal, list);
        if (entry.buffers.length === 0) entry.buffers = list;
      } else {
        entry.buffers = list;
      }
    }
  }

  _bindUnlock() {
    const self = this;
    this._unlockFn = function unlock() {
      self.resume();
    };
    window.addEventListener("pointerdown", this._unlockFn);
    window.addEventListener("keydown", this._unlockFn);
  }

  _bindEvents() {
    const ev = this.ctx && this.ctx.events;
    if (!ev || typeof ev.on !== "function") return;
    const self = this;

    this._handlers = [
      [
        "weapon:fire",
        function onFire(e) {
          if (!e) return;
          self.play(e.suppressed ? "shot_sup" : "shot", e.origin, e);
        },
      ],
      [
        "weapon:reload",
        function onReload(e) {
          if (e && e.phase === "end") return;
          self.play("reload", e && e.position ? e.position : null, e);
        },
      ],
      [
        "weapon:magcheck",
        function onMag(e) {
          self.play("mag", e && e.position ? e.position : null, e);
        },
      ],
      [
        "weapon:malfunction",
        function onJam(e) {
          self.play("click", e && e.position ? e.position : null, e);
        },
      ],
      [
        "weapon:shell",
        function onShell(e) {
          self.play("shell", e && e.position ? e.position : null, e);
        },
      ],
      [
        "bullet:impact",
        function onImpact(e) {
          if (!e) return;
          let kind;
          if (e.target) kind = e.armorDamage > 0 ? "armor" : "hit";
          else {
            const s = typeof e.surface === "string" ? e.surface : e.surfaceName;
            kind = IMPACT_KIND[s] || "impact_concrete";
          }
          self.play(kind, e.point, null);
        },
      ],
      [
        "explosion",
        function onBoom(e) {
          self.play("boom", e && e.position ? e.position : null, null);
        },
      ],
      [
        "actor:death",
        function onDeath(e) {
          self.play("death", e && e.point ? e.point : null, null);
        },
      ],
      [
        "loot:opened",
        function onLoot(e) {
          self.play("loot", e && e.position ? e.position : null, null);
        },
      ],
      [
        "loot:taken",
        function onTaken(e) {
          self.play("pickup", null, null);
        },
      ],
      [
        "door:toggle",
        function onDoor(e) {
          self.play("door", e && e.position ? e.position : null, null);
        },
      ],
      [
        "health:effect",
        function onEffect(e) {
          if (e && e.kind === "heal") self.play("heal", null, null);
        },
      ],
      [
        "raid:start",
        function onRaidStart() {
          self._phys = null;
          self._physTried = false;
          self.field.muffle = 0;
        },
      ],
    ];

    for (let i = 0; i < this._handlers.length; i++) {
      ev.on(this._handlers[i][0], this._handlers[i][1]);
    }
  }

  _physics() {
    if (this._phys) return this._phys;
    const c = this.ctx;
    if (!c) return null;
    let p = null;
    try {
      if (typeof c.peek === "function") p = c.peek("physics");
    } catch (e) {
      p = null;
    }
    if (!p && !this._physTried) {
      this._physTried = true;
      try {
        if (typeof c.get === "function") p = c.get("physics");
      } catch (e) {
        p = null;
      }
    }
    if (p) this._phys = p;
    return p;
  }

  /*
   * Возвращает 0 (прямая видимость) или 1 (стена).
   * Не более RAYS_PER_FRAME трассировок в кадр, остальное берётся из кольцевого кэша.
   */
  _occlusion(pos, dist) {
    if (dist < 2) return 0;
    if (!this.actx) return 0;
    const now = this.actx.currentTime;
    for (let i = 0; i < OCC_CACHE_SIZE; i++) {
      if (now - this._occT[i] > OCC_TTL) continue;
      const dx = this._occX[i] - pos.x;
      const dy = this._occY[i] - pos.y;
      const dz = this._occZ[i] - pos.z;
      if (dx * dx + dy * dy + dz * dz < OCC_RADIUS2) return this._occV[i];
    }
    if (this._rays <= 0) return this._lastOcc;
    const phys = this._physics();
    if (!phys) return 0;
    this._rays--;

    const lp = this.field.listenerPos;
    let blocked = 0;
    if (typeof phys.lineOfSight === "function") {
      this._tmpA.set(pos.x, pos.y, pos.z);
      this._tmpB.set(lp.x, lp.y + 0.1, lp.z);
      blocked = phys.lineOfSight(this._tmpA, this._tmpB, 1) ? 0 : 1;
    } else if (typeof phys.raycastInto === "function") {
      this._tmpA.set(lp.x, lp.y + 0.1, lp.z);
      this._tmpB.set(
        pos.x - this._tmpA.x,
        pos.y - this._tmpA.y,
        pos.z - this._tmpA.z,
      );
      const len = this._tmpB.length();
      if (len > 0.001) {
        this._tmpB.multiplyScalar(1 / len);
        this._ray.hit = false;
        phys.raycastInto(this._tmpA, this._tmpB, len - 0.35, this._ray, 1);
        blocked = this._ray.hit ? 1 : 0;
      }
    } else {
      return 0;
    }

    const i = this._occHead;
    this._occHead = (i + 1) % OCC_CACHE_SIZE;
    this._occX[i] = pos.x;
    this._occY[i] = pos.y;
    this._occZ[i] = pos.z;
    this._occV[i] = blocked;
    this._occT[i] = now;
    this._lastOcc = blocked;
    return blocked;
  }

  _takeVoice(pool, prio) {
    let worst = null;
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (!v.busy) return v;
      if (worst === null) {
        worst = v;
        continue;
      }
      if (
        v.priority < worst.priority ||
        (v.priority === worst.priority && v.startedAt < worst.startedAt)
      )
        worst = v;
    }
    if (worst !== null && worst.priority <= prio) {
      this._release(worst);
      return worst;
    }
    return null;
  }

  _release(v) {
    if (v.src) {
      try {
        v.src.stop();
      } catch (e) {
        /* источник уже отыграл */
      }
      try {
        v.src.disconnect();
      } catch (e) {
        /* уже отключён */
      }
      v.src = null;
    }
    v.busy = false;
    v.priority = -1;
  }

  /* Главный вход. Не аллоцирует ни одного JS-объекта. */
  play(kind, position, opts) {
    if (!this.ready || this.muted) return null;
    const a = this.actx || this._ensureActx();
    if (!a) return null;
    if (a.state !== "running") return null;

    let dist = 0;
    if (position) {
      const lp = this.field.listenerPos;
      const dx = position.x - lp.x;
      const dy = position.y - lp.y;
      const dz = position.z - lp.z;
      dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > MAX_AUDIBLE) return null;
    }

    let delay = opts && opts.delay ? opts.delay : 0;
    if (position && dist > FAR_SWITCH && (!opts || opts.autoFar !== false)) {
      if (kind === "shot") {
        kind = "far";
        delay += dist / SOUND_SPEED;
      } else if (kind === "shot_sup") {
        kind = "far_sup";
        delay += dist / SOUND_SPEED;
      }
    }

    const entry = this._bank[kind];
    if (!entry) return null;
    let list = entry.buffers;
    if (opts && opts.cal && entry.byCal) {
      const sub = entry.byCal.get(opts.cal);
      if (sub) list = sub;
    }
    if (!list || list.length === 0) return null;
    const buf = list[this._seq++ % list.length];
    if (this._seq > 1000000) this._seq = 0;

    const prio = priorityOf(kind);
    const voice = position
      ? this._takeVoice(this.voices, prio)
      : this._takeVoice(this.flat, prio);
    if (!voice) return null;

    let occ = 0;
    if (position) {
      occ =
        opts && opts.occlusion !== undefined
          ? opts.occlusion
          : this._occlusion(position, dist);
    }

    const now = a.currentTime;
    const when = now + delay;
    let g = opts && opts.gain !== undefined ? opts.gain : 1;
    g *= 1 - 0.55 * occ;
    const pitch = opts && opts.pitch ? opts.pitch : 1;

    /* 900 Гц за стеной, 18000 Гц по прямой, минус воздушное поглощение по дальности. */
    const air = 1 - Math.min(0.72, dist / MAX_AUDIBLE);
    const cutoff = LP_BLOCKED + (LP_OPEN - LP_BLOCKED) * (1 - occ) * air;

    voice.busy = true;
    voice.priority = prio;
    voice.startedAt = now;
    voice.endsAt = when + buf.duration / pitch + 0.06;

    voice.lp.frequency.cancelScheduledValues(now);
    voice.lp.frequency.setValueAtTime(
      Math.max(220, Math.min(LP_OPEN, cutoff)),
      when,
    );
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(Math.max(0.0001, g), when);

    if (voice.panner && position) {
      const p = voice.panner;
      if (p.positionX) {
        p.positionX.setValueAtTime(position.x, when);
        p.positionY.setValueAtTime(position.y, when);
        p.positionZ.setValueAtTime(position.z, when);
      } else {
        p.setPosition(position.x, position.y, position.z);
      }
    }

    if (voice.send) {
      let wet =
        opts && opts.reverb !== undefined
          ? opts.reverb
          : 0.1 + 0.34 * occ + 0.3 * this.field.indoor;
      if (wet > 1) wet = 1;
      voice.send.gain.cancelScheduledValues(now);
      voice.send.gain.setValueAtTime(wet, when);
    }

    const src = a.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch;
    src.connect(voice.lp);
    src.start(when);
    voice.src = src;
    return voice;
  }

  /* Удобные обёртки для UI и HUD. */
  playUi(kind) {
    return this.play(kind, null, null);
  }

  stun(amount) {
    this.field.muffle = Math.min(1, this.field.muffle + amount);
  }

  setIndoor(v) {
    this.field.indoor = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  setVolume(v) {
    this.masterVolume = v < 0 ? 0 : v > 1 ? 1 : v;
    if (this.master) this.master.gain.value = this.masterVolume;
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master)
      this.master.gain.value = this.muted ? 0 : this.masterVolume;
  }

  setPaused(p) {
    if (!this.actx) return;
    if (p) this.actx.suspend();
    else this.actx.resume();
  }

  _applyListener() {
    if (!this.actx) return;
    const l = this.actx.listener;
    const f = this.field;
    if (l.positionX) {
      const t = this.actx.currentTime;
      l.positionX.setTargetAtTime(f.listenerPos.x, t, 0.02);
      l.positionY.setTargetAtTime(f.listenerPos.y, t, 0.02);
      l.positionZ.setTargetAtTime(f.listenerPos.z, t, 0.02);
      l.forwardX.setTargetAtTime(f.listenerFwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(f.listenerFwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(f.listenerFwd.z, t, 0.02);
      l.upX.setTargetAtTime(f.listenerUp.x, t, 0.02);
      l.upY.setTargetAtTime(f.listenerUp.y, t, 0.02);
      l.upZ.setTargetAtTime(f.listenerUp.z, t, 0.02);
    } else {
      l.setPosition(f.listenerPos.x, f.listenerPos.y, f.listenerPos.z);
      l.setOrientation(
        f.listenerFwd.x,
        f.listenerFwd.y,
        f.listenerFwd.z,
        f.listenerUp.x,
        f.listenerUp.y,
        f.listenerUp.z,
      );
    }
  }

  update(dt, ctx) {
    if (!this.ready) return;
    if (!this.actx) return;
    this._rays = RAYS_PER_FRAME;

    const c = ctx || this.ctx;
    const cam = c && c.camera ? c.camera : null;
    if (cam) {
      const e = cam.matrixWorld.elements;
      this.field.listenerPos.set(e[12], e[13], e[14]);
      this.field.listenerFwd.set(-e[8], -e[9], -e[10]);
      this.field.listenerUp.set(e[4], e[5], e[6]);
    }
    this._applyListener();

    const now = this.actx.currentTime;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.busy && now >= v.endsAt) this._release(v);
    }
    for (let i = 0; i < this.flat.length; i++) {
      const v = this.flat[i];
      if (v.busy && now >= v.endsAt) this._release(v);
    }

    if (this.field.muffle > 0)
      this.field.muffle = Math.max(0, this.field.muffle - dt * 0.35);
    const target = LP_OPEN - (LP_OPEN - 700) * this.field.muffle;
    if (Math.abs(target - this._muffleF) > 20) {
      this._muffleF = target;
      this.muffleFilter.frequency.setTargetAtTime(target, now, 0.05);
    }
  }

  dispose() {
    const ev = this.ctx && this.ctx.events;
    if (ev && this._handlers && typeof ev.off === "function") {
      for (let i = 0; i < this._handlers.length; i++)
        ev.off(this._handlers[i][0], this._handlers[i][1]);
    }
    this._handlers = null;
    if (this._unlockFn) {
      window.removeEventListener("pointerdown", this._unlockFn);
      window.removeEventListener("keydown", this._unlockFn);
      this._unlockFn = null;
    }
    for (let i = 0; i < this.voices.length; i++) this._release(this.voices[i]);
    for (let i = 0; i < this.flat.length; i++) this._release(this.flat[i]);
    this.voices.length = 0;
    this.flat.length = 0;
    this._bank = Object.create(null);
    this.ready = false;
    if (this.actx) {
      try {
        this.actx.close();
      } catch (e) {
        /* контекст уже закрыт */
      }
      this.actx = null;
    }
  }
}

export default AudioSystem;
