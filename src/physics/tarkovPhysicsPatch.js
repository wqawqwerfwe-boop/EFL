import { PhysicsSystem } from './index.js';

/*
 * Escape from Larpov - боевой патч физики.
 *
 * Зачем этот файл существует
 * ---------------------
 * PhysicsSystem.penetrate() всегда был обычным методом класса. Но в init()
 * выполнялось:
 *
 *     this._pen = createPenetrationSolver(this, ctx);
 *     this.penetrate = this._pen.penetrate;
 *
 * createPenetrationSolver() возвращает PenetrationSolver, а у того есть solve(),
 * но НЕТ penetrate(). Значит вторая строка кладёт на экземпляр СОБСТВЕННОЕ
 * СВОЙСТВО со значением undefined, которое навсегда затеняет рабочий метод
 * прототипа. Оттуда и TypeError: this.physics.penetrate is not a function
 * на каждом тике Engine.step().
 *
 * Старая версия этого патча помочь не могла по двум причинам: она ставила
 * метод только при typeof proto.penetrate !== 'function' (а он всегда function),
 * и работала на уровне прототипа, а собственное свойство экземпляра всегда
 * выигрывает. К тому же init() исполняется ПОСЛЕ патча, так что любая
 * правка прототипа без перехвата init() гарантировано затиралась.
 *
 * Поэтому здесь перехватывается именно init(): сразу после его завершения
 * теневое свойство сносится, и вызов снова попадает на реальный метод.
 *
 * Ничего не аллокатится в кадре: запасная запись попадания, выходной массив
 * и объект опций баллистики преаллоцированы на экземпляр.
 */

let applied = false;

function warnOnce(phys, key, msg) {
  if (!phys._penWarned) phys._penWarned = Object.create(null);
  if (phys._penWarned[key]) return;
  phys._penWarned[key] = true;
  console.warn('[physics] ' + msg);
}

/* Привести экземпляр в рабочее состояние. Идемпотентно. */
function hardenInstance(phys) {
  if (!phys || typeof phys !== 'object') return;

  /* 1. Снять теневое собственное свойство.
   *    Удаляем безусловно: даже если там лежит функция, это отвязанная
   *    ссылка на метод солвера и она упадёт из-за потерянного this. */
  if (Object.prototype.hasOwnProperty.call(phys, 'penetrate')) {
    try {
      delete phys.penetrate;
    } catch (err) {
      phys.penetrate = PhysicsSystem.prototype.penetrate;
    }
  }

  /* 2. Солвер. init() создаёт _pen рано, а _solver — в самом конце.
   *    Любой выстрел в этом окне ушёл бы в null. Подшиваем. */
  if (!phys._solver && phys._pen && typeof phys._pen.solve === 'function') {
    phys._solver = phys._pen;
  }
  if (!phys._pen && phys._solver && typeof phys._solver.solve === 'function') {
    phys._pen = phys._solver;
  }

  /* 3. Баллистике нужен rng: без него Ballistics.fire() возьмёт opts.rng и может
   *    получить undefined, если вызывающая сторона его не передала. */
  if (phys.ballistics && !phys.ballistics.rng && phys.rng) {
    phys.ballistics.rng = phys.rng;
  }

  /* 4. Преаллокация горячего пути. */
  if (!phys._safeImpact) {
    phys._safeImpact = {
      hit: true,
      damage: 25,
      penetrated: false,
      ricochet: false,
      fragment: false,
      armorDamage: 0,
      surface: 'concrete',
      surfaceIndex: 0,
      target: null,
      partIndex: -1,
      ammo: 0,
      distance: 0,
      degraded: true,
    };
  }
  if (!phys._bulletOut) phys._bulletOut = [];
  if (!phys._fireOpts) {
    phys._fireOpts = {
      rng: null,
      origin: null,
      dir: null,
      ammoIndex: 0,
      shooter: null,
      damage: 0,
      penetration: 0,
      maxDist: 0,
      mask: 3,
    };
  }
  if (!phys._penWarned) phys._penWarned = Object.create(null);
}

export function applyTarkovPhysicsPatch() {
  if (applied) return;
  applied = true;

  const proto = PhysicsSystem.prototype;

  /* ---- Перехват init(): снимаем теневое свойство после его установки ---- */
  const originalInit = proto.init;
  proto.init = function patchedInit(ctx) {
    const out = typeof originalInit === 'function' ? originalInit.call(this, ctx) : undefined;
    if (out && typeof out.then === 'function') {
      const self = this;
      return out.then(function afterInit(value) {
        hardenInstance(self);
        return value;
      });
    }
    hardenInstance(this);
    return out;
  };

  /* ---- Пробитие ---- */
  proto.penetrate = function penetrate(origin, dir, ammoIdx, shooter) {
    if (!this._safeImpact) hardenInstance(this);

    if (!origin || !dir) {
      warnOnce(this, 'args', 'penetrate() called without origin/dir — returning safe impact');
      return this._safeImpact;
    }

    const solver =
      this._solver && typeof this._solver.solve === 'function'
        ? this._solver
        : this._pen && typeof this._pen.solve === 'function'
          ? this._pen
          : null;

    if (!solver) {
      warnOnce(this, 'solver', 'penetration solver unavailable — returning safe impact');
      return this._safeImpact;
    }

    const idx = Number.isFinite(ammoIdx) && ammoIdx >= 0 ? ammoIdx : 0;

    try {
      /* null здесь легитимен — это чистый промах, не ошибка. */
      return solver.solve(origin, dir, idx, shooter === undefined ? null : shooter);
    } catch (err) {
      warnOnce(this, 'throw', 'penetration solver threw (' + err.message + ') — returning safe impact');
      return this._safeImpact;
    }
  };

  /* ---- Выстрел ----
   * Исходный fireBullet() всегда возвращал пустой массив: Ballistics.fire()
   * отдаёт ОБЪЕКТ попадания (либо null, либо 0), а вызывающий код считал
   * его КОЛИЧЕСТВОМ и крутил for (i = 0; i < n; i++) по объекту, то есть ни разу.
   */
  proto.fireBullet = function fireBullet(opts) {
    if (!this._bulletOut) hardenInstance(this);
    const out = this._bulletOut;
    out.length = 0;

    if (!opts || !opts.origin || !opts.dir) {
      warnOnce(this, 'fb:args', 'fireBullet() called without origin/dir — no impacts');
      return out;
    }

    const idx = Number.isFinite(opts.ammoIndex)
      ? opts.ammoIndex
      : Number.isFinite(opts.ammoIdx)
        ? opts.ammoIdx
        : 0;

    let res = null;
    const b = this.ballistics;
    if (b && typeof b.fire === 'function') {
      const o = this._fireOpts;
      o.rng = this.rng || b.rng || null;
      o.origin = opts.origin;
      o.dir = opts.dir;
      o.ammoIndex = idx;
      o.shooter = opts.shooter === undefined ? null : opts.shooter;
      o.damage = Number.isFinite(opts.damage) ? opts.damage : 0;
      o.penetration = Number.isFinite(opts.penetration) ? opts.penetration : 0;
      o.maxDist = Number.isFinite(opts.maxDist) ? opts.maxDist : 0;
      o.mask = Number.isFinite(opts.mask) ? opts.mask : 3;
      try {
        res = b.fire(o);
      } catch (err) {
        warnOnce(this, 'fb:throw', 'ballistics.fire threw (' + err.message + ') — using solver directly');
        res = null;
      }
    }

    /* Счётчик попаданий из пула. */
    if (typeof res === 'number') {
      if (res > 0 && b && b.impacts) {
        const n = Math.min(res, b.impacts.length);
        for (let i = 0; i < n; i++) out.push(b.impacts[i]);
        return out;
      }
      res = null;
    }

    if (Array.isArray(res)) {
      for (let i = 0; i < res.length; i++) out.push(res[i]);
      return out;
    }

    if (res && typeof res === 'object') {
      out.push(res);
      return out;
    }

    /* Баллистика не сработала — идём напрямую в солвер пробития. */
    const direct = this.penetrate(opts.origin, opts.dir, idx, opts.shooter);
    if (direct) out.push(direct);
    return out;
  };
}

export default applyTarkovPhysicsPatch;
