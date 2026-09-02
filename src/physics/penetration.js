import * as THREE from 'three';

import {
  SURFACE as CANON,
  SURFACE_BALLISTICS,
  SURFACE_NAMES,
  SURFACE_THICKNESS,
} from '../core/surfaces.js';

/*
 * Escape from Larpov - ballistics and penetration solver.
 *
 * Пуля не моделируется как физическое тело: это цепочка рейкастов с бюджетом
 * энергии. На каждом попадании решается три исхода: рикошет, пробитие,
 * застревание. Всё состояние шага лежит в преаллоцированных векторах решателя.
 *
 * Ни clone(), ни new Vector3 внутри solve(). Ни одного шаблонного литерала.
 */

/*
 * Порядок поверхностей, баллистика и толщины приходят из src/core/surfaces.js.
 * Локальных таблиц здесь больше нет. Раньше локальный SURFACE_ORDER шёл в
 * другом порядке, чем physics/surfaces.js: индекс, записанный физикой в
 * треугольник, читался решателем как другой материал (11 - штукатурка там,
 * плоть здесь). Единое индексное пространство теперь одно на весь проект.
 */
export const SURFACE_ORDER = SURFACE_NAMES;

const SURF_N = SURFACE_ORDER.length;

/*
 * Баллистика поверхностей (значения живут в src/core/surfaces.js).
 *   cost - сколько единиц пробивной способности съедает один метр материала
 *   ric  - базовый шанс рикошета
 *   ang  - критический угол в градусах, ниже которого возможен рикошет
 *   pass - доля урона, сохраняемая пулей после пробития
 */

/* Struct-of-Arrays: в горячем цикле читаются только типизированные массивы. */
export const SURFACE = {
  count: SURF_N,
  name: SURFACE_ORDER.slice(),
  cost: new Float32Array(SURF_N),
  ric: new Float32Array(SURF_N),
  ang: new Float32Array(SURF_N),
  pass: new Float32Array(SURF_N),
};

for (let i = 0; i < SURF_N; i++) {
  const s = SURFACE_BALLISTICS[SURFACE_ORDER[i]];
  SURFACE.cost[i] = s.cost;
  SURFACE.ric[i] = s.ric;
  SURFACE.ang[i] = Math.cos((90 - s.ang) * Math.PI / 180);
  SURFACE.pass[i] = s.pass;
}

export function surfaceIndex(name) {
  const i = CANON[name];
  return i === undefined ? 0 : i;
}

export function surfaceName(index) {
  const n = SURFACE_ORDER[index];
  return n === undefined ? 'concrete' : n;
}

/*
 * Таблица патронов.
 * [id, имя, калибр, урон, пробитие, скорость м/с, шанс фрагментации, множитель рикошета, урон броне, трассер, вес кг]
 */
const AMMO_RAW = [
  ['545_ps', '5.45 ПС', '545', 40, 20, 890, 0.08, 0.35, 38, 0, 0.0102],
  ['545_bt', '5.45 БТ', '545', 42, 31, 900, 0.1, 0.4, 42, 1, 0.0104],
  ['545_bp', '5.45 БП', '545', 45, 37, 915, 0.12, 0.45, 46, 0, 0.0105],
  ['545_bs', '5.45 БС', '545', 40, 46, 830, 0.05, 0.5, 52, 0, 0.0108],
  ['556_m855', '5.56 M855', '556', 40, 31, 920, 0.13, 0.4, 42, 0, 0.0121],
  ['556_m856', '5.56 M856', '556', 43, 22, 880, 0.16, 0.35, 36, 1, 0.0118],
  ['556_m995', '5.56 M995', '556', 42, 53, 1013, 0.05, 0.5, 58, 0, 0.0124],
  ['9x19_pst', '9x19 ПСТ', '9x19', 52, 12, 452, 0.05, 0.25, 22, 0, 0.0122],
  ['9x19_ap63', '9x19 AP 6.3', '9x19', 46, 30, 480, 0.03, 0.35, 38, 0, 0.0119],
  ['9x18_pst', '9x18 ПСТ', '9x18', 50, 8, 298, 0.04, 0.2, 18, 0, 0.0106],
  ['9x18_pbm', '9x18 ПБМ', '9x18', 45, 18, 519, 0.03, 0.3, 28, 0, 0.0101],
  ['762x54_lps', '7.62x54 ЛПС', '762x54', 64, 41, 800, 0.1, 0.45, 52, 0, 0.0212],
  ['762x54_snb', '7.62x54 СНБ', '762x54', 68, 48, 820, 0.08, 0.5, 58, 0, 0.0215],
  ['762x54_t46', '7.62x54 Т2-46', '762x54', 62, 32, 795, 0.12, 0.4, 46, 1, 0.0209],
  ['12x70_buck', '12x70 картечь', '12x70', 39, 3, 385, 0, 0.15, 12, 0, 0.0032],
  ['12x70_magnum', '12x70 магнум', '12x70', 50, 2, 430, 0, 0.12, 10, 0, 0.0034],
  ['12x70_slug', '12x70 пуля', '12x70', 165, 20, 470, 0.02, 0.3, 34, 0, 0.032],
  ['12x70_flechette', '12x70 флешетта', '12x70', 25, 31, 400, 0, 0.35, 30, 0, 0.0028],
];

const AMMO_N = AMMO_RAW.length;

export const AMMO = {
  count: AMMO_N,
  id: new Array(AMMO_N),
  name: new Array(AMMO_N),
  cal: new Array(AMMO_N),
  damage: new Float32Array(AMMO_N),
  pen: new Float32Array(AMMO_N),
  speed: new Float32Array(AMMO_N),
  fragChance: new Float32Array(AMMO_N),
  ricochet: new Float32Array(AMMO_N),
  armorDamage: new Float32Array(AMMO_N),
  tracer: new Uint8Array(AMMO_N),
  weight: new Float32Array(AMMO_N),
};

const AMMO_BY_ID = Object.create(null);
const AMMO_BY_CAL = Object.create(null);

for (let i = 0; i < AMMO_N; i++) {
  const r = AMMO_RAW[i];
  AMMO.id[i] = r[0];
  AMMO.name[i] = r[1];
  AMMO.cal[i] = r[2];
  AMMO.damage[i] = r[3];
  AMMO.pen[i] = r[4];
  AMMO.speed[i] = r[5];
  AMMO.fragChance[i] = r[6];
  AMMO.ricochet[i] = r[7];
  AMMO.armorDamage[i] = r[8];
  AMMO.tracer[i] = r[9];
  AMMO.weight[i] = r[10];
  AMMO_BY_ID[r[0]] = i;
  if (!AMMO_BY_CAL[r[2]]) AMMO_BY_CAL[r[2]] = [];
  AMMO_BY_CAL[r[2]].push(i);
}

export const AMMO_IDS = AMMO.id.slice();

/* Патрон по умолчанию для калибра. Совпадает с тем, что выдаёт Скупщик на 1 уровне. */
const CAL_DEFAULT = {
  '545': '545_bp',
  '556': '556_m855',
  '9x19': '9x19_pst',
  '9x18': '9x18_pst',
  '762x54': '762x54_lps',
  '12x70': '12x70_buck',
};

export function ammoIndex(id) {
  const i = AMMO_BY_ID[id];
  return i === undefined ? -1 : i;
}

export function ammoForCaliber(cal) {
  const id = CAL_DEFAULT[cal];
  if (id !== undefined) {
    const i = AMMO_BY_ID[id];
    if (i !== undefined) return i;
  }
  const list = AMMO_BY_CAL[cal];
  if (list && list.length > 0) return list[0];
  return 0;
}

export function ammoListForCaliber(cal) {
  const list = AMMO_BY_CAL[cal];
  return list ? list.slice() : [];
}

const MAX_STEPS = 6;
const MAX_RANGE = 420;
const MIN_DAMAGE = 1.5;
const SKIN = 0.02;
const MASK_ALL = 3;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(ctx, label) {
  const r = ctx && ctx.rng;
  if (r) {
    if (typeof r.fork === 'function') {
      const f = r.fork(label);
      if (typeof f === 'function') return f;
      if (f && typeof f.next === 'function') return function next() { return f.next(); };
      if (f && typeof f.float === 'function') return function next() { return f.float(); };
    }
    if (typeof r === 'function') return r;
    if (typeof r.next === 'function') return function next() { return r.next(); };
    if (typeof r.float === 'function') return function next() { return r.float(); };
  }
  let a = 0x9e3779b9;
  for (let i = 0; i < label.length; i++) a = (Math.imul(a ^ label.charCodeAt(i), 16777619) >>> 0);
  return mulberry32(a);
}

/* Результат рейкаста. Создаётся один раз на решатель. */
function makeHitStruct() {
  return {
    hit: false,
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    surface: 0,
    actor: null,
    partIndex: -1,
    object: null,
  };
}

function resetHit(h) {
  h.hit = false;
  h.distance = 0;
  h.surface = 0;
  h.actor = null;
  h.partIndex = -1;
  h.object = null;
}

/*
 * Адаптер рейкаста. Собирается ОДИН РАЗ при привязке к физике,
 * а не на каждом выстреле. Возвращает функцию (origin, dir, maxDist, out, mask) -> boolean,
 * которая заполняет out и ничего не аллоцирует.
 */
function buildCast(phys) {
  if (!phys) {
    return function castNone() {
      return false;
    };
  }

  if (typeof phys.raycastInto === 'function') {
    return function castInto(origin, dir, maxDist, out, mask) {
      resetHit(out);
      phys.raycastInto(origin, dir, maxDist, out, mask);
      return !!out.hit;
    };
  }

  const pick = typeof phys.raycast === 'function' ? phys.raycast : typeof phys.raycastFirst === 'function' ? phys.raycastFirst : typeof phys.intersectRay === 'function' ? phys.intersectRay : null;

  if (!pick) {
    return function castMissing() {
      return false;
    };
  }

  return function castCopy(origin, dir, maxDist, out, mask) {
    resetHit(out);
    const r = pick.call(phys, origin, dir, maxDist, mask);
    if (!r) return false;
    const p = r.point || r.position;
    const n = r.normal || r.faceNormal;
    if (p) out.point.set(p.x, p.y, p.z);
    if (n) out.normal.set(n.x, n.y, n.z);
    out.distance = r.distance === undefined ? origin.distanceTo(out.point) : r.distance;
    out.actor = r.actor === undefined ? null : r.actor;
    out.partIndex = r.partIndex === undefined ? -1 : r.partIndex;
    out.object = r.object === undefined ? null : r.object;
    if (typeof r.surface === 'number') out.surface = r.surface;
    else if (typeof r.surface === 'string') out.surface = surfaceIndex(r.surface);
    else if (r.object && r.object.userData && r.object.userData.surfaceIndex !== undefined) out.surface = r.object.userData.surfaceIndex;
    else out.surface = 0;
    out.hit = true;
    return true;
  };
}

/*
 * Номинальная толщина преграды в метрах для расчёта цены пробития.
 * Значения канонические: src/core/surfaces.js, порядок - SURFACE_ORDER.
 */
const PEN_SCALE = 3;

const THICK = new Float32Array(SURF_N);
const PEN_COST = new Float32Array(SURF_N);
for (let i = 0; i < SURF_N; i++) {
  THICK[i] = SURFACE_THICKNESS[i];
  PEN_COST[i] = SURFACE.cost[i] * THICK[i] * PEN_SCALE;
}

/*
 * Индекс плоти. Раньше в solve() стояла константа 11, верная только для
 * старого локального порядка. В каноническом пространстве плоть - 19,
 * а 11 - песок, то есть сквозное пробитие тела считалось по песку.
 */
const FLESH = CANON.flesh;

export class PenetrationSolver {
  constructor(physics, ctx) {
    this.physics = physics || null;
    this.ctx = ctx || null;
    this.rng = makeRng(ctx, 'ballistics');
    this._cast = buildCast(physics);

    /* --- Весь пул векторов решателя. Больше ничего не создаётся. --- */
    this._hit = makeHitStruct();
    this._pos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._from = new THREE.Vector3();
    this._end = new THREE.Vector3();
    this._inc = new THREE.Vector3();

    /* Пейлоады событий. surface — СТРОКА, именно её ждёт аудио и fx. */
    this._impact = {
      point: this._hit.point,
      normal: this._hit.normal,
      incident: this._inc,
      surface: 'concrete',
      surfaceIndex: 0,
      damage: 0,
      penetrated: false,
      ricochet: false,
      fragment: false,
      armorDamage: 0,
      target: null,
      partIndex: -1,
      ammo: 0,
      distance: 0,
    };
    this._tracer = { from: this._from, to: this._end, speed: 0, ammo: 0, tracer: 0 };
    this._dmg = { actor: null, amount: 0, partIndex: -1, source: null, ammo: 0, armorDamage: 0 };

    this.stats = { shots: 0, hits: 0, penetrations: 0, ricochets: 0, kills: 0 };
  }

  /* Перепривязка к физике: адаптер пересобирается один раз, не в кадре. */
  attach(physics, ctx) {
    this.physics = physics || null;
    if (ctx) {
      this.ctx = ctx;
      this.rng = makeRng(ctx, 'ballistics');
    }
    this._cast = buildCast(this.physics);
    return this;
  }

  _emit(name, payload) {
    const ev = this.ctx && this.ctx.events;
    if (ev && typeof ev.emit === 'function') ev.emit(name, payload);
  }

  /* Класс брони в точке попадания. 0 — брони нет. */
  _armorOf(actor, partIndex) {
    if (!actor) return 0;
    if (typeof actor.armorAt === 'function') {
      const a = actor.armorAt(partIndex);
      return typeof a === 'number' ? a : 0;
    }
    if (actor.armorParts && partIndex >= 0) {
      const a = actor.armorParts[partIndex];
      if (typeof a === 'number') return a;
    }
    /* Грудь и живот — индексы 1 и 2 в HITBOX. Бронежилет прикрывает только их. */
    if (partIndex === 1 || partIndex === 2) {
      if (typeof actor.armorClass === 'number') return actor.armorClass;
      if (typeof actor.armor === 'number') return actor.armor;
    }
    if (partIndex === 0 && typeof actor.helmetClass === 'number') return actor.helmetClass;
    return 0;
  }

  /* Нанесение урона. Перебирает возможные имена методов актора. */
  _deal(actor, amount, partIndex, shooter, ammoIdx, armorDamage) {
    if (!actor) return;
    let done = false;
    if (typeof actor.applyBulletDamage === 'function') {
      actor.applyBulletDamage(amount, partIndex, shooter, ammoIdx, armorDamage);
      done = true;
    } else if (typeof actor.takeDamage === 'function') {
      actor.takeDamage(amount, partIndex, shooter);
      done = true;
    } else if (typeof actor.damage === 'function') {
      actor.damage(amount, partIndex, shooter);
      done = true;
    } else if (typeof actor.hit === 'function') {
      actor.hit(amount, partIndex, shooter);
      done = true;
    }
    this._dmg.actor = actor;
    this._dmg.amount = amount;
    this._dmg.partIndex = partIndex;
    this._dmg.source = shooter || null;
    this._dmg.ammo = ammoIdx;
    this._dmg.armorDamage = armorDamage;
    this._dmg.handled = done;
    this._emit('damage:dealt', this._dmg);
  }

  /*
   * ГЛАВНЫЙ МЕТОД. Цепочка до MAX_STEPS попаданий.
   * origin и dir не мутируются — их владелец (WeaponSystem) переиспользует свои векторы.
   */
  solve(origin, dir, ammoIdx, shooter) {
    const idx = ammoIdx >= 0 && ammoIdx < AMMO.count ? ammoIdx : 0;
    let damage = AMMO.damage[idx];
    let pen = AMMO.pen[idx];
    const speed = AMMO.speed[idx];

    this._pos.set(origin.x, origin.y, origin.z);
    this._dir.set(dir.x, dir.y, dir.z);
    this._from.set(origin.x, origin.y, origin.z);

    let range = MAX_RANGE;
    let travelled = 0;
    let steps = 0;
    const hit = this._hit;
    const imp = this._impact;
    this.stats.shots++;

    while (steps < MAX_STEPS && range > 0.05 && damage > MIN_DAMAGE) {
      steps++;

      if (!this._cast(this._pos, this._dir, range, hit, MASK_ALL)) {
        /* Промах: трассер до конца дальности и выход. */
        this._end.set(this._pos.x + this._dir.x * range, this._pos.y + this._dir.y * range, this._pos.z + this._dir.z * range);
        this._tracer.speed = speed;
        this._tracer.ammo = idx;
        this._tracer.tracer = AMMO.tracer[idx];
        this._emit('bullet:tracer', this._tracer);
        return null;
      }

      const si = hit.surface >= 0 && hit.surface < SURF_N ? hit.surface : 0;
      travelled += hit.distance;
      range -= hit.distance;

      /* Трассер до точки попадания. */
      this._end.set(hit.point.x, hit.point.y, hit.point.z);
      this._tracer.speed = speed;
      this._tracer.ammo = idx;
      this._tracer.tracer = AMMO.tracer[idx];
      this._emit('bullet:tracer', this._tracer);

      /* Падение урона с дистанцией: не ниже 55 процентов на предельной дальности. */
      const falloff = travelled > 40 ? Math.max(0.55, 1 - (travelled - 40) / 700) : 1;

      /* Скалярное произведение направления и нормали: без создания векторов. */
      const dx = this._dir.x;
      const dy = this._dir.y;
      const dz = this._dir.z;
      let nx = hit.normal.x;
      let ny = hit.normal.y;
      let nz = hit.normal.z;
      let dot = dx * nx + dy * ny + dz * nz;
      if (dot > 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
        dot = -dot;
      }
      const cosI = -dot;

      this._inc.set(dx, dy, dz);
      imp.surfaceIndex = si;
      imp.surface = SURFACE_ORDER[si];
      imp.ammo = idx;
      imp.distance = travelled;
      imp.ricochet = false;
      imp.fragment = false;
      imp.penetrated = false;
      imp.armorDamage = 0;
      imp.target = null;
      imp.partIndex = hit.partIndex;

      /* ---------- Попадание в актора ---------- */
      if (hit.actor) {
        this.stats.hits++;
        const armor = this._armorOf(hit.actor, hit.partIndex);
        let dealt = damage * falloff;
        let armorDmg = 0;

        if (armor > 0) {
          const need = armor * 10;
          if (pen >= need) {
            dealt *= 0.9;
            armorDmg = AMMO.armorDamage[idx] * 0.4;
            pen -= need * 0.35;
          } else {
            const k = pen / need;
            dealt *= 0.15 + 0.6 * k;
            armorDmg = AMMO.armorDamage[idx];
            pen *= 0.4;
          }
        }

        if (AMMO.fragChance[idx] > 0 && this.rng() < AMMO.fragChance[idx]) {
          dealt *= 1.35;
          imp.fragment = true;
        }

        this._deal(hit.actor, dealt, hit.partIndex, shooter, idx, armorDmg);

        imp.damage = dealt;
        imp.armorDamage = armorDmg;
        imp.target = hit.actor;
        this._emit('bullet:impact', imp);

        /* Сквозное пробитие тела. */
        const fleshCost = PEN_COST[FLESH];
        if (pen <= fleshCost || imp.fragment) return imp;
        pen -= fleshCost;
        damage = dealt * SURFACE.pass[FLESH];
        this._pos.set(hit.point.x + dx * (THICK[FLESH] + SKIN), hit.point.y + dy * (THICK[FLESH] + SKIN), hit.point.z + dz * (THICK[FLESH] + SKIN));
        range -= THICK[FLESH] + SKIN;
        this._from.set(this._pos.x, this._pos.y, this._pos.z);
        continue;
      }

      /* ---------- Рикошет ---------- */
      const ricChance = SURFACE.ric[si] * AMMO.ricochet[idx] * 4;
      if (cosI < SURFACE.ang[si] && ricChance > 0 && this.rng() < ricChance) {
        this.stats.ricochets++;
        imp.ricochet = true;
        imp.damage = damage * falloff * 0.35;
        this._emit('bullet:impact', imp);

        /* Отражение d - 2(d·n)n с небольшим разбросом. */
        const k = 2 * dot;
        let rx = dx - k * nx + (this.rng() - 0.5) * 0.12;
        let ry = dy - k * ny + (this.rng() - 0.5) * 0.12;
        let rz = dz - k * nz + (this.rng() - 0.5) * 0.12;
        const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (rl < 1e-6) return imp;
        const rinv = 1 / rl;
        rx *= rinv;
        ry *= rinv;
        rz *= rinv;
        this._dir.set(rx, ry, rz);
        damage *= 0.55;
        pen *= 0.5;
        this._pos.set(hit.point.x + rx * SKIN, hit.point.y + ry * SKIN, hit.point.z + rz * SKIN);
        this._from.set(this._pos.x, this._pos.y, this._pos.z);
        continue;
      }

      /* ---------- Пробитие или застревание ---------- */
      /* Косой вход увеличивает эффективную толщину. */
      const obliquity = cosI > 0.15 ? 1 / cosI : 6.6667;
      const cost = PEN_COST[si] * obliquity;

      if (pen > cost) {
        this.stats.penetrations++;
        imp.penetrated = true;
        imp.damage = damage * falloff;
        this._emit('bullet:impact', imp);

        pen -= cost;
        damage *= SURFACE.pass[si];
        const step = THICK[si] * obliquity + SKIN;
        this._pos.set(hit.point.x + dx * step, hit.point.y + dy * step, hit.point.z + dz * step);
        range -= step;
        this._from.set(this._pos.x, this._pos.y, this._pos.z);
        continue;
      }

      imp.penetrated = false;
      imp.damage = damage * falloff;
      this._emit('bullet:impact', imp);
      return imp;
    }

    return null;
  }

  dispose() {
    this.physics = null;
    this.ctx = null;
    this._cast = buildCast(null);
  }
}

/* Фабрика для PhysicsSystem.init(). */
export function createPenetrationSolver(physics, ctx) {
  return new PenetrationSolver(physics, ctx);
}

export default PenetrationSolver;

export class Ballistics {
  constructor(physics) {
    this.physics = physics;
    this.rng = null;
    // Преаллоцированный пул попаданий для пули, чтобы не создавать объекты в кадре
    this.impacts = [];
    for (let i = 0; i < 16; i++) {
      this.impacts.push({
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        surfaceIndex: 0,
        damage: 0,
        armorDamage: 0,
        penetrated: false,
      });
    }
  }

  fire(opts) {
    if (!this.rng) this.rng = opts.rng;
    // Базовая заглушка вызова баллистического солвера для пуль/дроби
    const origin = opts.origin;
    const dir = opts.dir;
    const ammoIdx = opts.ammoIndex ?? 0;

    if (this.physics._solver) {
      return this.physics._solver.solve(origin, dir, ammoIdx, opts.shooter);
    }
    return 0;
  }
}
