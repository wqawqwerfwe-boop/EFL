import * as THREE from 'three';
import { EFL } from '../core/config.js';
import { KITS_BY_FACTION, VARIANTS, buildSoldier, resolveMaterials } from './soldier.js';
import { SoldierMaterials } from './textures.js';
import { buildActor as compileFactionMesh, disposeActor as freeFactionMesh } from './parts.js';

/**
 * Re-export the procedural faction mesh compiler so any caller (map spawner,
 * preview, inspection tooling) can route an actor's body/clothing build through
 * `buildActor()`. It reads the canonical faction archetype and never emits the
 * same kit twice: scav civil layers (+PACA only when a plate rolled), raider
 * combat uniform + helmet/visor/knee pads, pmc camo + ballistic helmet + pack,
 * and boss signatures (Killa Maska three-stripe visor, Shturman open camo coat).
 */
export { buildActor, disposeActor } from './parts.js';

/** The live compiler entry point, alias of the reference `buildActor`. */
export const buildFactionMesh = compileFactionMesh;
export const disposeFactionMesh = freeFactionMesh;

export const FACTION = { SCAV: 0, RAIDER: 1, PMC: 2, BOSS: 3 };

/** Faction index -> canonical archetype id, the field the mesh compiler reads. */
export const FACTION_ID = ['scav', 'raider', 'pmc', 'boss'];

const DEF = [
  { id: 'scav',   hp: 240, acc: 0.42, react: 0.62, view: 62,  fov: 105, wep: ['pm','m870','aks74u','mosin'],  xp: 120, karma: -0.03 },
  { id: 'raider', hp: 420, acc: 0.74, react: 0.28, view: 95,  fov: 125, wep: ['ak74n','m4a1','rpk16'],        xp: 480, karma: +0.02 },
  { id: 'pmc',    hp: 380, acc: 0.68, react: 0.34, view: 88,  fov: 120, wep: ['m4a1','ak74n','mp5'],          xp: 560, karma: 0 },
  { id: 'boss',   hp: 780, acc: 0.86, react: 0.20, view: 110, fov: 140, wep: ['rpk16','sv98'],                xp: 1500, karma: 0 },
];

const S_IDLE = 0, S_PATROL = 1, S_ALERT = 2, S_COMBAT = 3, S_COVER = 4, S_HEAL = 5, S_DEAD = 6;

/* Фолбэк ТТХ оружия: используется, только если items не отдал определение.
 * Без него любой промах по таблице предметов ронял тик обращением к .cap/.rpm. */
const DEFAULT_WEP = Object.freeze({ cap: 30, rpm: 600, spread: 0.02, cal: '545' });

/* Скорость бокового шага в метрах в секунду и границы окна смены направления. */
const STRAFE_SPEED = 2.35;
const STRAFE_MIN_T = 0.45;
const STRAFE_MAX_T = 1.30;

const LOCO_RADIUS = 0.36
const LOCO_HEIGHT = 1.72

/** Probe heights (metres above feet) for the structural wall sweep. */
const LOCO_PROBE_KNEE = 0.38
const LOCO_PROBE_CHEST = 1.25

/** Extra look-ahead beyond radius + displacement so corners are seen early. */
const LOCO_WALL_LOOKAHEAD = 0.22

/** Highest ledge an actor may step onto in a single tick. Above this = wall. */
const LOCO_STEP_MAX = 0.42

/** Headroom required above the feet at the candidate column. */
const LOCO_CEIL_CLEAR = LOCO_HEIGHT + 0.12

/** Ground snap search depth. Deeper than this = void, refuse the move. */
const LOCO_GROUND_SEARCH = 3.2

/** Max vertical settle per tick while grounded. Anything larger is a warp. */
const LOCO_SETTLE_MAX = 0.55

/** Longest horizontal displacement one tick may commit (teleport guard). */
const LOCO_MAX_TICK_MOVE = 0.60

/** Free-fall constants. */
const LOCO_GRAVITY = 9.81
const LOCO_TERMINAL = 18

/** Redirect: speed is held at zero for this long, then ramps back. */
const LOCO_REDIRECT_HOLD = 0.18
const LOCO_REDIRECT_RAMP = 0.42
const LOCO_REDIRECT_COOLDOWN = 0.30

/** Longest dt the variable-rate fallback will integrate in one go. */
const LOCO_MAX_DT = 1 / 30

/** Consecutive blocked ticks before the bot is forced to repath. */
const LOCO_REPATH_AFTER_BLOCKS = 6


/* Верхняя граница uint32. Держим константой: она нужна и в детерминированном
 * пути, и в аварийном фолбэке на Math.random. */
const UINT32_MAX = 4294967295;

/**
 * Camo patterns baked at boot.
 *
 * MUST include every pattern any variant can ask for. `SoldierMaterials` only
 * bakes `opts.camo ?? ['arid','woodland']` and `get()` THROWS on a set it never
 * baked, so leaving this at the default takes the raid down the first time a
 * kit whose pattern is `urban` is compiled — the pre-existing `breacher`
 * variant and the new `raider` are both urban.
 */
const CAMO_BAKES = Object.freeze(['arid', 'woodland', 'urban']);

/* Бюджеты по умолчанию, если EFL.budgets не заполнен целиком. */
const BUDGET_FALLBACK = { bots: 12, botsUpdatedPerFrame: 4, pathRequestsPerFrame: 2 };

function budget(name) {
  const b = EFL && EFL.budgets ? EFL.budgets[name] : undefined;
  return Number.isFinite(b) && b > 0 ? b : BUDGET_FALLBACK[name];
}

export class AiSystem {
  static id = 'ai';
  static deps = ['world', 'physics', 'items', 'health', 'fx', 'audio', 'materials'];

  async init(ctx) {
    this.ctx = ctx;
    this.world = ctx.get('world');
    this.physics = ctx.get('physics');
    this.items = ctx.get('items');
    this.playerHealth = ctx.get('health');
    this.audio = ctx.get('audio');
    this.rng = ctx.rng.fork('ai');

    this.bots = [];
    this.actors = this.bots;
    this.free = [];                      // пул выведенных из игры ботов
    this.cursor = 0;                     // курсор тайм-слайсинга
    this.pathQueue = [];                 // кольцевая очередь запросов пути
    this.scavKarmaHostile = false;       // стал ли игрок-Дикий врагом для Диких
    this.playerFaction = FACTION.PMC;
    this._botSeq = 1;

    // Кэш скомпилированных вариантов модели и общий набор материалов.
    // Геометрия одна на вариант: скелет — на экземпляр. See variant().
    this._variantCache = new Map();
    this._soldierMats = null;
    this._prewarmed = false;

    // преаллокация
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._eye = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._sv0 = new THREE.Vector3();     // зонд бокового шага: откуда
    this._sv1 = new THREE.Vector3();     // зонд бокового шага: куда
    this._los = { hit: false, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 0, actor: null, partIndex: -1 };

    /* Единственный возвращаемый объект деградировавшей баллистики.
     * Преаллоцирован, потому что путь может исполняться каждый выстрел. */
    this._fallbackImpact = { hit: true, damage: 25, penetrated: false };
    this._warned = Object.create(null);

    ctx.events.on('weapon:fire', this._onFire = (e) => this.hearNoise(e.origin, e.suppressed ? 22 : 85));
    ctx.events.on('explosion', this._onBoom = (e) => this.hearNoise(e.position, 140));
    ctx.events.on('raid:start', this._onRaid = (e) => this.spawnWave(e));
    ctx.events.on('raid:end', this._onEnd = () => this.clear());
    this._locoInit()
  }

  /* Однократное предупреждение: тик не должен спамить консоль каждый кадр. */
  _warnOnce(key, msg) {
    if (this._warned[key]) return;
    this._warned[key] = true;
    console.warn('[ai] ' + msg);
  }

  /* ---------- безопасные обёртки над чужими подсистемами ---------- */

  /**
   * 32-битный сид для события weapon:fire.
   *
   * Прежний код звал this.rng.uint32() напрямую. У Rng (src/core/rng.js)
   * такого метода НЕТ: uint32 он отдаёт как u32(). Поэтому первый же выстрел
   * бота в S_COMBAT ронял весь главный цикл на
   *   TypeError: this.rng.uint32 is not a function
   * прямо внутри AiSystem._combat, то есть внутри Engine.step().
   *
   * Порядок предпочтений важен именно в таком виде:
   *   1. u32()    — родной контракт Rng. Детерминированный, поэтому
   *                 capture-режим продолжает давать байт-в-байт одинаковые
   *                 кадры. Ради этого он и стоит первым, а не Math.random.
   *   2. uint32() — если сид придёт из чужого генератора с таким контрактом.
   *   3. float()  — минимальный общий знаменатель любого PRNG.
   *   4. Math.random — аварийный нативный фолбэк.
   *
   * Каждая ветка обёрнута так, что ни отсутствие метода, ни исключение
   * внутри него не могут остановить Engine.step().
   */
  _seed32() {
    const rng = this.rng;

    if (rng) {
      if (typeof rng.u32 === 'function') {
        try {
          return rng.u32() >>> 0;
        } catch (err) {
          this._warnOnce('seed:u32', 'rng.u32() бросил исключение, ищем фолбэк: ' + err.message);
        }
      }

      if (typeof rng.uint32 === 'function') {
        try {
          return rng.uint32() >>> 0;
        } catch (err) {
          this._warnOnce('seed:uint32', 'rng.uint32() бросил исключение, ищем фолбэк: ' + err.message);
        }
      }

      if (typeof rng.float === 'function') {
        try {
          const f = rng.float();
          if (Number.isFinite(f)) return Math.floor(f * UINT32_MAX) >>> 0;
          this._warnOnce('seed:float:nan', 'rng.float() вернул не число — сид уходит в Math.random');
        } catch (err) {
          this._warnOnce('seed:float', 'rng.float() бросил исключение, ищем фолбэк: ' + err.message);
        }
      }

      this._warnOnce(
        'seed:missing',
        'у rng нет ни u32(), ни uint32(), ни float() — сид выстрела уходит в Math.random (детерминизм потерян)'
      );
    } else {
      this._warnOnce('seed:norng', 'rng не инициализирован — сид выстрела уходит в Math.random');
    }

    return Math.floor(Math.random() * UINT32_MAX) >>> 0;
  }

  _wep(id) {
    const it = this.items;
    const w = it && typeof it.get === 'function' ? it.get(id) : null;
    if (w) return w;
    this._warnOnce('wep:' + id, 'items.get("' + id + '") returned nothing — using fallback ballistics');
    return DEFAULT_WEP;
  }

  _groundAt(x, z, fromY) {
    const p = this.physics;
    if (!p || typeof p.groundHeight !== 'function') return NaN;
    const gy = p.groundHeight(x, z, fromY, p.MASK_WORLD ?? 1);
    return Number.isFinite(gy) ? gy : NaN;
  }

  /**
   * PUBLIC ground probe. `Agent`'s rewired vault path calls `ai.groundAt(x, z)`
   * by this name; only the private `_groundAt` existed, so every probe in the
   * fixed movement path would have thrown `ai.groundAt is not a function` and
   * taken the frame with it.
   *
   * `fromY` is optional here on purpose: the caller usually does not know a
   * sensible cast origin, and starting well above the query point is what makes
   * a downward ground query behave.
   */
  groundAt(x, z, fromY) {
    const from = Number.isFinite(fromY) ? fromY : 40;
    return this._groundAt(x, z, from);
  }

  /**
   * Snap a position onto the ground in place.
   *
   * Returns false and leaves the vector untouched when there is no ground under
   * it, which is the answer the vault gate needs: no ground means the step is
   * into a void and must not be taken. It deliberately does NOT clamp or
   * reinterpret the height — the whole point of the vault rewrite is that
   * vertical position is only ever set from a probe that succeeded.
   */
  probeGround(pos, fromY) {
    if (!pos) return false;
    const from = Number.isFinite(fromY) ? fromY : pos.y + 4;
    const gy = this._groundAt(pos.x, pos.z, from);
    if (!Number.isFinite(gy)) return false;
    pos.y = gy;
    return true;
  }

  _sees(from, to) {
    const p = this.physics;
    if (!p || typeof p.lineOfSight !== 'function') return true;
    return !!p.lineOfSight(from, to);
  }

  /**
   * Единственная точка входа ИИ в баллистику.
   * Приоритет: physics.penetrate -> physics.fireBullet -> безопасная заглушка.
   * Ни один из путей не может выбросить исключение в игровой поток.
   */
  _shoot(origin, dir, ammoIdx, shooter) {
    const p = this.physics;
    if (p && typeof p.penetrate === 'function') {
      try {
        // null здесь — легитимный промах, не подменяем его заглушкой
        return p.penetrate(origin, dir, ammoIdx, shooter);
      } catch (err) {
        this._warnOnce('pen:throw', 'physics.penetrate threw, falling back: ' + err.message);
      }
    } else {
      this._warnOnce('pen:missing', 'physics.penetrate unavailable — using fireBullet/stub');
    }

    if (p && typeof p.fireBullet === 'function') {
      try {
        const impacts = p.fireBullet({ origin, dir, ammoIndex: ammoIdx, shooter, damage: 25 });
        if (Array.isArray(impacts)) return impacts.length ? impacts[0] : null;
        if (impacts) return impacts;
        return null;
      } catch (err) {
        this._warnOnce('fb:throw', 'physics.fireBullet threw, using stub: ' + err.message);
      }
    }

    return this._fallbackImpact;
  }

  /* ---------- модель актора: материалы и варианты ---------- */

  /**
   * RNG adapter for the model compiler.
   *
   * `buildSoldier` needs `fork()`, `float()`, `int()` and `range()`. Core `Rng`
   * is not guaranteed to expose all four — `_seed32` above exists precisely
   * because it turned out not to have `uint32()` — and a missing method inside
   * a geometry build is an exception during a spawn, i.e. a dead raid. Same
   * defensive pattern as `_seed32` and `_wep`: prefer the native method, derive
   * the rest, warn once.
   */
  _soldierRng(src) {
    const base = src || this.rng
    const self = this
    const float = () => {
      if (base && typeof base.float === 'function') return base.float()
      if (base && typeof base.u32 === 'function') return (base.u32() >>> 0) / (UINT32_MAX + 1)
      self._warnOnce('mesh:rng', 'у rng нет float()/u32() — геометрия актора теряет детерминизм')
      return Math.random()
    }
    const api = {
      float,
      int: (a, b) => {
        if (base && typeof base.int === 'function') return base.int(a, b)
        return a + Math.floor(float() * (b - a + 1))
      },
      range: (a, b) => {
        if (base && typeof base.range === 'function') return base.range(a, b)
        return a + float() * (b - a)
      },
      u32: () => {
        if (base && typeof base.u32 === 'function') return base.u32() >>> 0
        return Math.floor(float() * UINT32_MAX) >>> 0
      },
      fork: (tag) => {
        if (base && typeof base.fork === 'function') return self._soldierRng(base.fork(tag))
        return api
      },
    }
    return api
  }

  /**
   * The shared procedural material set, baked once.
   *
   * `CAMO_BAKES` is passed explicitly and that is the load-bearing part: the
   * constructor's default is `['arid','woodland']` and `get()` throws on a set
   * it never baked, so any urban kit would otherwise fail on first compile.
   */
  soldierMaterials() {
    if (this._soldierMats) return this._soldierMats
    const shared = this.ctx && typeof this.ctx.peek === 'function' ? this.ctx.peek('materials') : null
    if (shared && typeof shared.get === 'function' && shared.sets) {
      // the render layer already owns a compatible set — reuse it rather than
      // paying for a second CPU bake
      this._soldierMats = shared
      return this._soldierMats
    }
    try {
      this._soldierMats = new SoldierMaterials(this._soldierRng(this.rng).fork('mat'), { camo: CAMO_BAKES })
    } catch (err) {
      this._warnOnce('mesh:mats', 'не удалось испечь материалы актора: ' + err.message)
      this._soldierMats = null
    }
    return this._soldierMats
  }

  /**
   * Build (and cache) one visual variant.
   *
   * ONE GEOMETRY PER VARIANT, shared by every actor wearing it; only the
   * skeleton is per-instance. Cached on the variant key alone, which is why
   * `buildSoldier` must not branch geometry on anything per-actor: the first
   * actor to ask for a key decides what every later one looks like. Faction
   * differences are therefore separate keys, not per-instance rolls.
   *
   * @param name  variant key ('scav_civ', 'raider', 'boss_killa', ...)
   * @param rng   optional deterministic source; defaults to the AI stream
   * @param opts  { faction, subtype, armorZones } forwarded to the compiler
   */
  variant(name, rng, opts = {}) {
    const key = VARIANTS[name] ? name : this.factionVariant(opts.faction, rng)
    const hit = this._variantCache.get(key)
    if (hit) return hit
    const materials = this.soldierMaterials()
    if (!materials) return null
    let built = null
    try {
      built = buildSoldier(key, {
        rng: this._soldierRng(rng),
        materials,
        faction: opts.faction,
        subtype: opts.subtype,
        armorZones: opts.armorZones,
      })
    } catch (err) {
      this._warnOnce('mesh:build:' + key, `не удалось собрать модель "${key}": ` + err.message)
      return null
    }
    this._variantCache.set(key, built)
    return built
  }

  /**
   * Pick a mesh variant for a faction.
   *
   * Scavs roll between their four silhouettes so a wave is not four copies of
   * one civilian; every other faction has a single canonical kit. The armoured
   * scav key is only reachable through `variant()` being asked for it directly,
   * because the PACA is gated on the actor's own armour roll.
   */
  factionVariant(faction, rng) {
    const id = typeof faction === 'number' ? FACTION_ID[faction] : faction
    const pool = KITS_BY_FACTION[id]
    if (!pool || !pool.length) return 'pmc'
    if (pool.length === 1) return pool[0]
    const r = this._soldierRng(rng)
    return pool[r.int(0, pool.length - 1)]
  }

  /**
   * Compile every variant's shader programs while a loading screen is up.
   *
   * Materials only — NO geometry. Geometry construction draws from the shared
   * RNG stream, so building it early would move every downstream random draw
   * and change the picture; `resolveMaterials` was split out of `buildSoldier`
   * for exactly this call.
   */
  prewarmMaterials(renderer, scene, camera) {
    if (this._prewarmed) return 0
    const materials = this.soldierMaterials()
    if (!materials) return 0
    const seen = new Set()
    const list = []
    for (const name of Object.keys(VARIANTS)) {
      let mats = null
      try {
        mats = resolveMaterials(name, ['cloth', 'gear', 'boot', 'rubber', 'plate', 'polymer', 'skin', 'glass', 'steel'], materials)
      } catch (err) {
        this._warnOnce('mesh:prewarm:' + name, `материалы варианта "${name}" не разрешились: ` + err.message)
        continue
      }
      for (const m of mats) {
        if (m && !seen.has(m.uuid)) {
          seen.add(m.uuid)
          list.push(m)
        }
      }
    }
    this._prewarmed = true
    if (renderer && scene && camera && typeof renderer.compile === 'function') {
      try {
        renderer.compile(scene, camera)
      } catch (err) {
        this._warnOnce('mesh:compile', 'renderer.compile бросил исключение: ' + err.message)
      }
    }
    return list.length
  }

  /** Drop cached variant geometry and the baked material set. */
  disposeSoldierCache() {
    for (const built of this._variantCache.values()) {
      if (built && built.geometry && typeof built.geometry.dispose === 'function') built.geometry.dispose()
    }
    this._variantCache.clear()
    // only dispose a set we baked ourselves; a shared one belongs to render
    const shared = this.ctx && typeof this.ctx.peek === 'function' ? this.ctx.peek('materials') : null
    if (this._soldierMats && this._soldierMats !== shared && typeof this._soldierMats.dispose === 'function') {
      this._soldierMats.dispose()
    }
    this._soldierMats = null
    this._prewarmed = false
  }

  /* ---------- спавн ---------- */
  spawnWave({ faction, mapId, night } = {}) {
    this.playerFaction = faction === 'scav' ? FACTION.SCAV : FACTION.PMC;
    this.scavKarmaHostile = false;
    const zones = (this.world && typeof this.world.spawnZones === 'function')
      ? this.world.spawnZones('bot')
      : null;
    if (!Array.isArray(zones) || zones.length === 0) {
      this._warnOnce('zones', 'world.spawnZones("bot") gave no spawn points — wave skipped');
      return;
    }
    const cap = Math.min(budget('bots'), zones.length);
    for (let i = 0; i < cap; i++) {
      const r = this.rng.float();
      const kind = r < 0.68 ? FACTION.SCAV : r < 0.88 ? FACTION.RAIDER : r < 0.98 ? FACTION.PMC : FACTION.BOSS;
      this.spawn(kind, zones[i], night);
    }
  }

  spawn(kind, at, night) {
    if (!at) return null;
    const d = DEF[kind] ?? DEF[FACTION.SCAV];
    const bot = this.free.pop() ?? this._createBot();
    bot.kind = kind;
    // canonical archetype id, so anything downstream reads a faction rather
    // than guessing from the numeric kind
    bot.faction = FACTION_ID[kind] ?? 'scav';
    this._attachFactionVisual(bot)
    bot.hp = d.hp;
    bot.state = S_PATROL;
    bot.alive = true;
    bot.target = null;
    bot.suspicion = 0;
    bot.path = [];
    bot.pathI = 0;
    bot.pathPending = false;
    bot.coverPoint = null;
    bot.burst = 0;
    bot.seesPlayer = false;
    bot.aimT = 0; bot.fireT = 0; bot.thinkT = 0; bot.lastSeen = -99;
    bot.reloadT = 0;
    bot.strafeSign = this.rng.float() < 0.5 ? -1 : 1;
    bot.strafeT = STRAFE_MIN_T + this.rng.float() * (STRAFE_MAX_T - STRAFE_MIN_T);
    bot.wepId = d.wep[this.rng.int(0, d.wep.length - 1)];
    bot.ammoIdx = this._resolveAmmo(bot.wepId);
    bot.mag = this._wep(bot.wepId).cap ?? DEFAULT_WEP.cap;
    bot.view = d.view * (night ? 0.45 : 1);
    bot.root.position.copy(at);
    const gy = this._groundAt(bot.root.position.x, bot.root.position.z, bot.root.position.y + 6);
    if (Number.isFinite(gy)) bot.root.position.y = gy;
    bot.noiseAt.copy(bot.root.position);
    bot.lastPos.copy(bot.root.position);
    bot.yaw = 0;
    this._ensureLocomotion(bot)
    bot.root.visible = true;
    if (this.world && typeof this.world.addActor === 'function') this.world.addActor(bot);   // в BVH как MASK_ACTOR
    this._syncBot(bot);
    this.bots.push(bot);
    return bot;
  }

  _createBot() {
    const root = new THREE.Group();
    root.name = `bot:${this._botSeq}`;
    root.visible = false;

    const collider = this.physics.addCollider({
      shape: 'capsule',
      layer: this.physics.LAYER.ACTOR,
      surface: 'flesh',
      owner: null,
      part: 'torso',
      radius: 0.33,
      damageScale: 1,
      enabled: false,
    });

    const bot = {
      id: this._botSeq++,
      root,
      body: null,
      head: null,
      actorData: null,
      visualKey: '',
      collider,
      kind: FACTION.SCAV,
      faction: 'scav',
      hp: 0,
      state: S_IDLE,
      alive: false,
      target: null,
      yaw: 0,
      aimT: 0,
      fireT: 0,
      thinkT: 0,
      reloadT: 0,
      lastSeen: -99,
      suspicion: 0,
      seesPlayer: false,
      ammoIdx: 0,
      mag: 0,
      view: 0,
      burst: 0,
      strafeSign: 1,
      strafeT: 0,
      path: [],
      pathI: 0,
      pathPending: false,
      coverPoint: null,
      noiseAt: new THREE.Vector3(),
      lastPos: new THREE.Vector3(),
    };
    collider.owner = bot;
    root.userData.bot = bot;
    return bot;
  }

  _attachFactionVisual(bot) {
    if (!bot?.root) return null

    let profile = 'civ'
    let armorZones = []
    if (bot.faction === 'scav') {
      profile = ['civ', 'track', 'jeans'][bot.id % 3]
      if (profile === 'jeans' && bot.id % 2 === 0) armorZones = ['thorax']
    } else if (bot.faction === 'raider') {
      profile = 'black'
      armorZones = ['thorax', 'stomach', 'head']
    } else if (bot.faction === 'pmc') {
      profile = bot.id % 2 ? 'usec' : 'bear'
      armorZones = ['thorax', 'stomach']
    } else if (bot.faction === 'boss') {
      profile = bot.id % 2 ? 'killa' : 'shturman'
      armorZones = profile === 'killa' ? ['thorax', 'stomach', 'head'] : ['thorax']
    }

    const visualKey = `${bot.faction}:${profile}:${armorZones.join(',')}`
    if (bot.actorData?.group && bot.visualKey === visualKey) {
      if (bot.actorData.group.parent !== bot.root) bot.root.add(bot.actorData.group)
      return bot.actorData
    }

    if (bot.actorData?.group) {
      bot.actorData.group.parent?.remove(bot.actorData.group)
      freeFactionMesh(bot.actorData.group)
    }

    try {
      const actorData = compileFactionMesh({
        faction: bot.faction,
        profile,
        armorZones,
        seed: 0x4f1bbcdc ^ bot.id,
      })
      if (!actorData?.group) throw new Error('compiler returned no group')
      actorData.group.traverse((object) => {
        if (!object.isMesh) return
        object.castShadow = true
        object.receiveShadow = true
      })
      bot.actorData = actorData
      bot.visualKey = visualKey
      bot.root.add(actorData.group)
      return actorData
    } catch (err) {
      bot.actorData = null
      bot.visualKey = ''
      this._warnOnce(`mesh:actor:${bot.id}`, `не удалось собрать faction mesh: ${err.message}`)
      return null
    }
  }

  _syncBot(bot) {
    if (!bot || !bot.root) return;
    bot.root.rotation.y = bot.yaw || 0;
    if (bot.collider) {
      const p = bot.root.position;
      bot.collider.enabled = bot.alive;
      bot.collider.setSegment(p.x, p.y + 0.11, p.z, p.x, p.y + 1.62, p.z);
    }
  }

  _faceTo(bot, targetPos, dt, rate) {
    const p = bot.root.position;
    const desired = Math.atan2(targetPos.x - p.x, targetPos.z - p.z);
    let dy = desired - bot.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const turn = Math.max(0.001, rate || 1) * dt;
    bot.yaw += Math.max(-turn, Math.min(turn, dy));
    this._syncBot(bot);
  }

  _moveTo(bot, dest, dt, speed) {
    if (!dest || !bot?.root) return false
    const p = bot.root.position
    const dx = dest.x - p.x
    const dz = dest.z - p.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.08) {
      bot.moveDir?.set(0, 0, 0)
      bot.wantSpeed = 0
      return true
    }
    const moveDir = bot.moveDir || (bot.moveDir = new THREE.Vector3())
    moveDir.set(dx / dist, 0, dz / dist)
    bot.wantSpeed = Math.max(0.1, speed || 1) * 5
    return false
  }

  /**
   * Боковой шаг в бою. Раньше этот метод отсутствовал, и ветка ближнего боя
   * (dist < 8) роняла весь Engine.step() на TypeError.
   *
   * Бот шаркает перпендикулярно своему взгляду, периодически меняя сторону.
   * Перед шагом пускается зонд: если сбоку преграда — направление немедленно
   * инвертируется, поэтому бот не втирается в стену и не застревает в ней.
   *
   * Терпимо относится к устаревшей форме вызова _strafe(dt).
   */
  _strafe(bot, dt) {
    if (typeof bot === 'number') { dt = bot; bot = null }
    if (!bot?.root || !bot.alive) return false
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0
    if (step === 0) return false

    bot.strafeT -= step
    if (bot.strafeT <= 0) {
      bot.strafeT = STRAFE_MIN_T + this.rng.float() * (STRAFE_MAX_T - STRAFE_MIN_T)
      bot.strafeSign = this.rng.float() < 0.5 ? -1 : 1
    }
    if (bot.strafeSign !== 1 && bot.strafeSign !== -1) bot.strafeSign = 1

    const sy = Math.sin(bot.yaw)
    const cy = Math.cos(bot.yaw)
    let rx = cy * bot.strafeSign
    let rz = -sy * bot.strafeSign
    const p = bot.root.position
    const probe = LOCO_RADIUS + STRAFE_SPEED * step + LOCO_WALL_LOOKAHEAD
    this._sv0.set(p.x, p.y + LOCO_PROBE_CHEST, p.z)
    this._sv1.set(p.x + rx * probe, p.y + LOCO_PROBE_CHEST, p.z + rz * probe)

    if (!this._sees(this._sv0, this._sv1)) {
      bot.strafeSign = -bot.strafeSign
      bot.strafeT = STRAFE_MIN_T * 0.75
      rx = -rx
      rz = -rz
      this._sv1.set(p.x + rx * probe, p.y + LOCO_PROBE_CHEST, p.z + rz * probe)
      if (!this._sees(this._sv0, this._sv1)) {
        bot.wantSpeed = 0
        return false
      }
    }

    const moveDir = bot.moveDir || (bot.moveDir = new THREE.Vector3())
    moveDir.set(rx, 0, rz)
    bot.wantSpeed = STRAFE_SPEED
    return true
  }

  _followPath(bot, dt, speed) {
    if (!bot.path || bot.pathI >= bot.path.length) {
      bot.path = [];
      bot.pathI = 0;
      bot.pathPending = false;
      return false;
    }
    const wp = bot.path[bot.pathI];
    if (!wp) {
      bot.path = [];
      bot.pathI = 0;
      bot.pathPending = false;
      return false;
    }
    if (this._moveTo(bot, wp, dt, speed)) {
      bot.pathI++;
      if (bot.pathI >= bot.path.length) {
        bot.path = [];
        bot.pathI = 0;
        bot.pathPending = false;
      }
    }
    return true;
  }

  _animate(bot, dt) {
    this._syncBot(bot);
  }

  _resolveAmmo(wepId) {
    const it = this.items;
    const cal = this._wep(wepId).cal ?? DEFAULT_WEP.cal;
    const list = it && typeof it.ammoForCaliber === 'function' ? it.ammoForCaliber(cal) : null;
    if (!Array.isArray(list) || list.length === 0) return 0;
    const pick = list[this.rng.int(0, list.length - 1)];
    if (it && typeof it.ammoSlot === 'function') {
      const slot = it.ammoSlot(pick);
      if (Number.isFinite(slot)) return slot;
    }
    return Number.isFinite(pick) ? pick : 0;
  }

  /* ---------- враждебность: точно как в EFL ---------- */
  hostileToPlayer(bot) {
    if (this.playerFaction === FACTION.SCAV) {
      if (bot.kind === FACTION.SCAV) return this.scavKarmaHostile;   // своих не трогают
      return true;                                                   // рейдеры/ЧВК/боссы — всегда
    }
    return true;
  }
  hostileBots(a, b) {
    if (a.kind === b.kind) return false;
    if (a.kind === FACTION.SCAV && b.kind === FACTION.BOSS) return false;   // босс и его свита
    return true;
  }

  /** Игрок-Дикий убил Дикого — вся карта становится враждебной. */
  angerScavs(reason) {
    if (this.scavKarmaHostile) return;
    this.scavKarmaHostile = true;
    for (const b of this.bots) if (b.kind === FACTION.SCAV && b.state < S_ALERT) b.state = S_ALERT;
    this.ctx.events.emit('karma:scav', { delta: -0.15, reason });
  }

  /* ---------- восприятие ---------- */
  hearNoise(pos, loudness) {
    if (!pos) return;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      if (!b.alive) continue;
      const dist = b.root.position.distanceTo(pos);
      if (dist > loudness) continue;
      // стены глушат: один дешёвый луч на бота, а не полный рейкаст
      const clear = this._sees(b.root.position, pos);
      if (!clear && dist > loudness * 0.45) continue;
      b.suspicion = Math.min(1, b.suspicion + (1 - dist / loudness) * 0.8);
      b.noiseAt.copy(pos);
      if (b.state < S_ALERT) b.state = S_ALERT;
    }
  }

  _perceive(bot, playerPos, dt) {
    const d = DEF[bot.kind] ?? DEF[FACTION.SCAV];
    this._eye.copy(bot.root.position).y += 1.6;
    this._v.subVectors(playerPos, this._eye);
    const dist = this._v.length();
    if (dist > bot.view || dist < 1e-6) { bot.seesPlayer = false; return; }

    this._v.divideScalar(dist);
    bot.root.getWorldDirection(this._v2);
    const cos = this._v.dot(this._v2);
    if (cos < Math.cos((d.fov * 0.5) * 0.01745)) { bot.seesPlayer = false; return; }

    bot.seesPlayer = this._sees(this._eye, playerPos);
    if (bot.seesPlayer) {
      bot.lastSeen = this.ctx.time.elapsed;
      bot.lastPos.copy(playerPos);
      if (bot.state < S_COMBAT && this.hostileToPlayer(bot)) {
        bot.state = S_COMBAT;
        bot.aimT = d.react * (0.7 + this.rng.float() * 0.6);
      }
    }
  }

  /* ---------- бой ---------- */
  _combat(bot, playerPos, dt) {
    const d = DEF[bot.kind] ?? DEF[FACTION.SCAV];
    bot.aimT -= dt;
    if (!bot.seesPlayer) {
      if (this.ctx.time.elapsed - bot.lastSeen > 4.5) { bot.state = S_ALERT; return; }
      this._moveTo(bot, bot.lastPos, dt, 1);
      return;
    }

    this._faceTo(bot, playerPos, dt, 7.5);
    const dist = bot.root.position.distanceTo(playerPos);

    // тактика: держать дистанцию, уходить в укрытие на перезарядке
    if (bot.mag <= 0) { bot.state = S_COVER; bot.reloadT = 3.2; return; }
    if (dist > 34 && bot.kind !== FACTION.SCAV) this._moveTo(bot, playerPos, dt, 0.8);
    else if (dist < 8) this._strafe(bot, dt);

    if (bot.aimT > 0) return;
    bot.fireT -= dt;
    if (bot.fireT > 0) return;

    // стрельба очередями через ту же баллистику, что и у игрока
    const wep = this._wep(bot.wepId);
    const spreadBase = Number.isFinite(wep.spread) ? wep.spread : DEFAULT_WEP.spread;
    const rpm = Number.isFinite(wep.rpm) && wep.rpm > 0 ? wep.rpm : DEFAULT_WEP.rpm;
    const skill = d.acc * (1 - Math.min(0.5, dist / 160));
    const spread = spreadBase * (2.2 - skill * 1.6);
    this._target.copy(playerPos);
    this._target.x += (this.rng.float() * 2 - 1) * spread * dist;
    this._target.y += (this.rng.float() * 2 - 1) * spread * dist + 0.9;
    this._target.z += (this.rng.float() * 2 - 1) * spread * dist;
    this._v.subVectors(this._target, this._eye);
    if (this._v.lengthSq() < 1e-12) return;
    this._v.normalize();

    this._shoot(this._eye, this._v, bot.ammoIdx, bot);
    /* Сид берём через _seed32(), а НЕ через this.rng.uint32(): у Rng нет
     * метода uint32(), и прямой вызов ронял Engine.step() на первом выстреле. */
    this.ctx.events.emit('weapon:fire', { weapon: bot.wepId, origin: this._eye, dir: this._v, seed: this._seed32(), bot: true });
    bot.mag--;
    bot.burst = bot.burst > 0 ? bot.burst - 1 : this.rng.int(2, 5);
    bot.fireT = bot.burst > 0 ? 60 / rpm : 0.35 + this.rng.float() * 0.9;
  }

  /* ---------- шаг модели поведения ---------- */
  _think(bot, playerPos, dt) {
    switch (bot.state) {
      case S_PATROL:
        if (!bot.path || bot.pathI >= bot.path.length) this._requestPath(bot, this._patrolPoint());
        this._followPath(bot, dt, 0.55);
        break;
      case S_ALERT:
        this._moveTo(bot, bot.noiseAt, dt, 0.85);
        if (bot.root.position.distanceToSquared(bot.noiseAt) < 4) { bot.suspicion *= 0.5; if (bot.suspicion < 0.2) bot.state = S_PATROL; }
        break;
      case S_COMBAT: this._combat(bot, playerPos, dt); break;
      case S_COVER:
        bot.reloadT -= dt;
        if (!bot.coverPoint) bot.coverPoint = this._findCover(bot.root.position, playerPos);
        if (bot.coverPoint) this._moveTo(bot, bot.coverPoint, dt, 1.2);
        if (bot.reloadT <= 0) {
          bot.mag = this._wep(bot.wepId).cap ?? DEFAULT_WEP.cap;
          bot.coverPoint = null;
          bot.state = S_COMBAT;
        }
        break;
    }
  }

  _patrolPoint() {
    const w = this.world;
    if (w && typeof w.randomPatrolPoint === 'function') return w.randomPatrolPoint(this.rng);
    return null;
  }

  _findCover(from, threat) {
    const w = this.world;
    if (w && typeof w.findCover === 'function') return w.findCover(from, threat, this.rng);
    return null;
  }

  /* ---------- тайм-слайсинг: тяжёлое только для N ботов в кадр ---------- */
  _locoInit() {
    this._up = new THREE.Vector3(0, 1, 0)
    this._down = new THREE.Vector3(0, -1, 0)
    this._disp = new THREE.Vector3()
    this._cand = new THREE.Vector3()
    this._probeO = new THREE.Vector3()
    this._probeD = new THREE.Vector3()
    this._slide = new THREE.Vector3()
    this._tangent = new THREE.Vector3()
    this._hit = { hit: false, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 0, actor: null, partIndex: -1 }
    this._fixedSeen = false
    this._locoFrame = -1
    this._redirectEvt = { actor: null, id: 0, position: new THREE.Vector3(), normal: new THREE.Vector3(), dir: new THREE.Vector3(), reason: '' }
    this.nav = this.nav || (typeof this.ctx.peek === 'function' ? this.ctx.peek('nav') : null)
  }

  /**
   * Per-bot locomotion state. Allocated ONCE when the bot leaves the pool.
   * `prev` is the last position that passed all gates — the rollback target.
   */
  _ensureLocomotion(bot) {
    if (bot.loco) {
      bot.loco.prev.copy(bot.root.position)
      bot.moveDir?.set(0, 0, 0)
      bot.wantSpeed = 0
      bot.loco.vy = 0
      bot.loco.speed = 0
      bot.loco.blocked = 0
      bot.loco.redirectT = 0
      bot.loco.cooldown = 0
      bot.loco.grounded = false
      bot.loco.frozen = false
      return bot.loco
    }
    bot.moveDir = bot.moveDir || new THREE.Vector3()
    bot.wantSpeed = 0
    bot.loco = {
      prev: bot.root.position.clone(),
      vy: 0,
      speed: 0,
      blocked: 0,
      redirectT: 0,
      cooldown: 0,
      grounded: false,
      frozen: false,
    }
    return bot.loco
  }

  /* ---------- engine entry points ---------- */

  /**
   * Fixed-rate locomotion. Deterministic, PHYSICS_HZ. Marks `_fixedSeen` so the
   * variable-rate fallback in `update()` steps aside.
   */
  fixedUpdate(h, ctx) {
    this._fixedSeen = true
    if (!this.bots || !this.bots.length) return
    this._locoTick(h, ctx)
  }

  /**
   * Variable-rate tick: perception / decision time-slicing, path queue drain,
   * and — ONLY when the engine never calls fixedUpdate — the locomotion matrix.
   */
  update(dt, ctx) {
    const bots = this.bots
    const n = bots?.length || 0
    if (!n) return

    this._drainPathQueue(budget('pathRequestsPerFrame'))

    const player = ctx.peek ? ctx.peek('player') : ctx.get('player')
    const ppos = player?.position || null
    if (!ppos) {
      this._warnOnce('ppos', 'player system exposes no position — AI idle this frame')
      return
    }

    const slice = Math.min(budget('botsUpdatedPerFrame'), n)
    for (let k = 0; k < slice; k++) {
      const bot = bots[(this.cursor + k) % n]
      if (!bot?.alive) continue
      this._perceive(bot, ppos, dt * n / slice)
    }
    this.cursor = (this.cursor + slice) % n

    for (let i = 0; i < n; i++) {
      const bot = bots[i]
      if (!bot?.alive) continue
      const moveDir = bot.moveDir || (bot.moveDir = new THREE.Vector3())
      moveDir.set(0, 0, 0)
      bot.wantSpeed = 0
      const far = bot.root.position.distanceToSquared(ppos) > 6400
      bot.root.userData.owNoShadow = far
      if (!far || bot.state >= S_COMBAT) this._think(bot, ppos, dt)
      this._animate(bot, dt)
    }

    if (!this._fixedSeen) {
      let left = Math.min(dt, 0.25)
      while (left > 0) {
        const step = left > LOCO_MAX_DT ? LOCO_MAX_DT : left
        this._locoTick(step, ctx)
        left -= step
      }
    }

    this._syncVisuals(ctx)
    for (let i = 0; i < n; i++) this._syncBot(bots[i])
  }

  /**
   * One locomotion step for EVERY live agent. Same frame guard so a core that
   * calls fixedUpdate several times per frame never double-integrates a bot
   * that `update()` already moved in the fallback branch.
   */
  _locoTick(h, ctx) {
    const bots = this.bots
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i]
      if (!bot || !bot.root || bot.state === S_DEAD) continue
      const loco = bot.loco || this._ensureLocomotion(bot)
      this._advanceBot(bot, loco, h, ctx)
      this._settleBot(bot, loco, h, ctx)
    }
  }

  /* ---------- physics wrapper ---------- */

  /**
   * Raycast against static world geometry only. Accepts both physics return
   * styles seen in this codebase: a boolean with the out-struct filled, or a
   * hit object / null. Never throws into the tick.
   */
  _ray(origin, dir, max, out) {
    out.hit = false
    const ph = this.physics
    if (!ph || typeof ph.raycast !== 'function') return false
    let res = null
    try {
      const mask = ph.MASK?.WORLD ?? ph.MASK_WORLD
      res = ph.raycast(origin, dir, max, mask)
    } catch (err) {
      this._warnOnce('ray', 'physics.raycast threw inside the locomotion tick: ' + err.message)
      return false
    }
    if (res === true) return out.hit !== false && out.distance <= max
    if (res && typeof res === 'object') {
      out.hit = res.hit !== false
      out.distance = Number(res.distance) || 0
      if (res.point) out.point.copy(res.point)
      if (res.normal) out.normal.copy(res.normal)
      out.surface = res.surface ?? res.surfaceIndex ?? 0
      return out.hit && out.distance <= max
    }
    return false
  }

  /* ---------- GATE MATRIX: horizontal ---------- */

  /**
   * Resolve the speed the actor is allowed to use this tick. A redirect holds
   * speed at zero, then ramps it back so the slide around a corner reads as a
   * deliberate sidestep rather than a snap.
   */
  _resolveSpeed(bot, loco, h) {
    if (loco.cooldown > 0) loco.cooldown -= h
    if (loco.frozen) {
      loco.redirectT += h
      if (loco.redirectT < LOCO_REDIRECT_HOLD) {
        loco.speed = 0
        return 0
      }
      const t = (loco.redirectT - LOCO_REDIRECT_HOLD) / LOCO_REDIRECT_RAMP
      if (t >= 1) {
        loco.frozen = false
        loco.redirectT = 0
        loco.speed = bot.wantSpeed
        return loco.speed
      }
      loco.speed = bot.wantSpeed * t * t
      return loco.speed
    }
    loco.speed = bot.wantSpeed
    return loco.speed
  }

  /**
   * Horizontal advance. Reads intent (`bot.moveDir`, `bot.wantSpeed`), runs the
   * three gates on the candidate position and commits ONLY if all pass.
   */
  _advanceBot(bot, loco, h, ctx) {
    const pos = bot.root.position
    const speed = this._resolveSpeed(bot, loco, h)
    if (speed <= 0) return
    const dir = bot.moveDir
    const lenSq = dir.x * dir.x + dir.z * dir.z
    if (lenSq < 1e-8) return

    const disp = this._disp
    const inv = 1 / Math.sqrt(lenSq)
    disp.set(dir.x * inv, 0, dir.z * inv)
    let dist = speed * h
    if (dist > LOCO_MAX_TICK_MOVE) dist = LOCO_MAX_TICK_MOVE

    /* GATE 1 — structural wall. Probe at knee and chest along the travel dir. */
    const wallN = this._wallProbe(pos, disp, dist)
    if (wallN) {
      /* Try the tangential slide once: remove the into-wall component. */
      const slide = this._slide
      const dot = disp.x * wallN.x + disp.z * wallN.z
      slide.set(disp.x - wallN.x * dot, 0, disp.z - wallN.z * dot)
      const sl = Math.sqrt(slide.x * slide.x + slide.z * slide.z)
      if (sl < 0.15 || this._wallProbe(pos, slide.multiplyScalar(1 / sl), dist * sl)) {
        return this._blockRollback(bot, loco, wallN, 'wall', ctx)
      }
      disp.copy(slide)
      dist *= sl
    }

    const cand = this._cand
    cand.set(pos.x + disp.x * dist, pos.y, pos.z + disp.z * dist)

    /* GATE 2 — step height and ceiling clearance at the candidate column. */
    const floorY = this._floorAt(cand)
    if (floorY === null) {
      return this._blockRollback(bot, loco, this._faceNormal(disp), 'void', ctx)
    }
    if (floorY - pos.y > LOCO_STEP_MAX) {
      return this._blockRollback(bot, loco, this._faceNormal(disp), 'ledge', ctx)
    }
    if (!this._headroomAt(cand, floorY)) {
      return this._blockRollback(bot, loco, this._faceNormal(disp), 'ceiling', ctx)
    }

    /* GATE 3 — navmesh membership. Only enforced when a navmesh is present. */
    if (!this._onNavmesh(cand)) {
      return this._blockRollback(bot, loco, this._faceNormal(disp), 'offmesh', ctx)
    }

    /* All gates passed: commit horizontally. Vertical is settled next. */
    loco.prev.copy(pos)
    pos.x = cand.x
    pos.z = cand.z
    loco.blocked = 0
    if (floorY <= pos.y && pos.y - floorY <= LOCO_STEP_MAX) loco.grounded = true
  }

  /**
   * Sweep two rays (knee, chest) along `dir`. Returns the blocking normal
   * (preallocated, valid until the next probe) or null when the way is clear.
   */
  _wallProbe(pos, dir, dist) {
    const reach = LOCO_RADIUS + dist + LOCO_WALL_LOOKAHEAD
    const o = this._probeO
    const hit = this._hit
    o.set(pos.x, pos.y + LOCO_PROBE_CHEST, pos.z)
    if (this._ray(o, dir, reach, hit) && hit.distance < LOCO_RADIUS + dist) {
      if (Math.abs(hit.normal.y) < 0.6) return hit.normal
    }
    o.set(pos.x, pos.y + LOCO_PROBE_KNEE, pos.z)
    if (this._ray(o, dir, reach, hit) && hit.distance < LOCO_RADIUS + dist) {
      if (Math.abs(hit.normal.y) < 0.6) return hit.normal
    }
    return null
  }

  /** Floor height under `p`, searched from just above step height. Null = void. */
  _floorAt(p) {
    const o = this._probeO
    const hit = this._hit
    o.set(p.x, p.y + LOCO_STEP_MAX + 0.05, p.z)
    const max = LOCO_STEP_MAX + 0.05 + LOCO_GROUND_SEARCH
    if (!this._ray(o, this._down, max, hit)) return null
    if (hit.normal.y < 0.45) return null
    return hit.point.y
  }

  /** True when there is a full standing height of clearance above `floorY`. */
  _headroomAt(p, floorY) {
    const o = this._probeO
    const hit = this._hit
    o.set(p.x, floorY + 0.05, p.z)
    if (!this._ray(o, this._up, LOCO_CEIL_CLEAR, hit)) return true
    return hit.distance >= LOCO_CEIL_CLEAR
  }

  /** Navmesh membership. A missing navmesh means the gate is not applicable. */
  _onNavmesh(p) {
    const nav = this.nav
    if (!nav) return true
    if (typeof nav.contains === 'function') return !!nav.contains(p)
    if (typeof nav.isOnMesh === 'function') return !!nav.isOnMesh(p)
    if (typeof nav.nearest === 'function') {
      const n = nav.nearest(p)
      if (!n) return false
      const dx = (n.x ?? p.x) - p.x
      const dz = (n.z ?? p.z) - p.z
      return dx * dx + dz * dz <= LOCO_RADIUS * LOCO_RADIUS
    }
    return true
  }

  /** A normal facing back against the travel direction, for non-ray blocks. */
  _faceNormal(dir) {
    return this._tangent.set(-dir.x, 0, -dir.z)
  }

  /* ---------- rollback + lateral redirect ---------- */

  /**
   * HARD ROLLBACK. Restore the last legal position, zero the speed, and pick a
   * lateral direction along the blocking surface. Emits exactly one
   * `ai:redirect` per cooldown window so listeners (squad, audio, debug
   * overlay) are not flooded while an actor is pinned.
   */
  _blockRollback(bot, loco, normal, reason, ctx) {
    const pos = bot.root.position
    pos.copy(loco.prev)
    loco.speed = 0
    loco.vy = 0
    loco.blocked++
    loco.frozen = true
    loco.redirectT = 0

    /* Tangent along the wall: cross(up, n). Keep the sign that best matches
     * where the bot already wanted to go so it slides, not reverses. */
    const t = this._slide
    t.set(normal.z, 0, -normal.x)
    const tl = Math.sqrt(t.x * t.x + t.z * t.z)
    if (tl < 1e-4) {
      t.set(1, 0, 0)
    } else {
      t.multiplyScalar(1 / tl)
      if (t.x * bot.moveDir.x + t.z * bot.moveDir.z < 0) t.multiplyScalar(-1)
    }
    if (loco.blocked > LOCO_REPATH_AFTER_BLOCKS && (loco.blocked & 1)) t.multiplyScalar(-1)
    bot.moveDir.copy(t)

    if (loco.blocked >= LOCO_REPATH_AFTER_BLOCKS) {
      loco.blocked = 0
      this._requestRepath(bot)
    }

    if (loco.cooldown > 0) return
    loco.cooldown = LOCO_REDIRECT_COOLDOWN

    const e = this._redirectEvt
    e.actor = bot
    e.id = bot.id ?? 0
    e.position.copy(pos)
    e.normal.copy(normal)
    e.dir.copy(t)
    e.reason = reason
    const events = (ctx && ctx.events) || (this.ctx && this.ctx.events)
    if (events && typeof events.emit === 'function') events.emit('ai:redirect', e)
  }

  /** Push the bot onto the path queue once; the drain is budgeted per frame. */
  _requestRepath(bot) {
    if (!bot || bot.pathPending) return
    const to = bot.coverPoint || (bot.state === S_ALERT ? bot.noiseAt : null) || bot.lastPos
    if (to) this._requestPath(bot, to)
  }

  /** Serve at most `n` queued path requests this frame. */
  _drainPathQueue(n) {
    const q = this.pathQueue
    if (!q?.length) return
    const canPath = this.world && typeof this.world.findPath === 'function'
    for (let i = 0; i < n && q.length; i++) {
      const req = q.shift()
      const bot = req?.bot || req
      const to = req?.to || bot?.lastPos
      if (!bot?.alive) continue
      bot.path = canPath && to ? (this.world.findPath(bot.root.position, to) || []) : []
      bot.pathI = 0
      bot.pathPending = false
    }
  }

  /* ---------- GATE MATRIX: vertical ---------- */

  /**
   * Vertical settle. Gravity when airborne, ground snap when a floor is within
   * reach, and — the part that stops roof warps — a per-tick vertical delta
   * clamp with a post-snap headroom re-check. Any violation rolls back to the
   * last legal position exactly like the horizontal gates.
   */
  _settleBot(bot, loco, h, ctx) {
    const pos = bot.root.position
    const startY = pos.y

    const floorY = this._floorAt(pos)
    if (floorY === null) {
      /* Nothing under the actor within search depth: free fall, but never
       * below the last legal height minus the search depth. */
      loco.grounded = false
      loco.vy = Math.max(loco.vy - LOCO_GRAVITY * h, -LOCO_TERMINAL)
      pos.y += loco.vy * h
      if (loco.prev.y - pos.y > LOCO_GROUND_SEARCH) {
        return this._blockRollback(bot, loco, this._up, 'void', ctx)
      }
    } else {
      const dy = floorY - pos.y
      if (dy > LOCO_SETTLE_MAX) {
        /* Floor found ABOVE the actor by more than a settle step — this is the
         * roof-warp signature. Refuse it. */
        return this._blockRollback(bot, loco, this._down, 'roofwarp', ctx)
      }
      if (dy >= -LOCO_STEP_MAX) {
        pos.y = floorY
        loco.vy = 0
        loco.grounded = true
      } else {
        loco.grounded = false
        loco.vy = Math.max(loco.vy - LOCO_GRAVITY * h, -LOCO_TERMINAL)
        pos.y += loco.vy * h
        if (pos.y < floorY) {
          pos.y = floorY
          loco.vy = 0
          loco.grounded = true
        }
      }
    }

    /* Vertical delta clamp while grounded: a snap larger than the settle
     * budget in one tick is never a legitimate step. */
    if (loco.grounded && Math.abs(pos.y - startY) > LOCO_SETTLE_MAX) {
      return this._blockRollback(bot, loco, this._down, 'settle', ctx)
    }

    /* Post-snap headroom: standing up into a ceiling is a rollback too. */
    if (loco.grounded && !this._headroomAt(pos, pos.y)) {
      return this._blockRollback(bot, loco, this._down, 'ceiling', ctx)
    }

    /* NaN fence. A single bad ray must never poison the transform. */
    if (pos.x !== pos.x || pos.y !== pos.y || pos.z !== pos.z) {
      pos.copy(loco.prev)
      loco.vy = 0
      loco.speed = 0
      this._warnOnce('nan', 'non-finite actor position rolled back')
      return
    }

    if (loco.grounded) loco.prev.copy(pos)
  }

  /* ---------- visuals follow the committed transform ---------- */

  /**
   * Face the actor along its committed travel direction. The rig, the
   * animator and the weapon sync hooks read `bot.root` after this, so the
   * transform they see is always one that passed every gate.
   */
  _syncVisuals(ctx) {
    const bots = this.bots
    for (let i = 0; i < bots.length; i++) {
      const bot = bots[i]
      if (!bot || !bot.root || bot.state === S_DEAD) continue
      const loco = bot.loco
      if (!loco || loco.speed <= 0.05) continue
      const d = bot.moveDir
      if (d.x * d.x + d.z * d.z < 1e-6) continue
      const yaw = Math.atan2(d.x, d.z)
      let delta = yaw - bot.root.rotation.y
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      bot.root.rotation.y += delta * Math.min(1, (ctx && ctx.time ? ctx.time.dt : 0.016) * 10)
      bot.yaw = bot.root.rotation.y
    }
  }

  _requestPath(bot, to) {
    if (bot.pathPending || !to) return;
    bot.pathPending = true;
    this.pathQueue.push({ bot, to });
  }

  /* ---------- смерть ---------- */
  kill(bot, byPlayer) {
    if (!bot || !bot.alive) return;
    bot.alive = false;
    bot.state = S_DEAD;
    this._syncBot(bot);
    this.ctx.events.emit('actor:death', { actor: bot, point: bot.root.position, faction: bot.faction });
    if (byPlayer) {
      if (this.playerFaction === FACTION.SCAV && bot.kind === FACTION.SCAV) this.angerScavs('scav_kill');
      if (this.playerFaction === FACTION.SCAV && bot.kind === FACTION.RAIDER)
        this.ctx.events.emit('karma:scav', { delta: +0.05, reason: 'raider_kill' });
      this.ctx.events.emit('damage:dealt', { target: bot, killed: true, xp: (DEF[bot.kind] ?? DEF[FACTION.SCAV]).xp });
    }
    const raid = this.ctx.peek ? this.ctx.peek('raid') : null;
    if (raid && typeof raid.spawnCorpse === 'function') raid.spawnCorpse(bot);   // труп с лутом владеет raid
  }

  clear() {
    for (const b of this.bots) {
      b.root.visible = false;
      b.alive = false;
      if (b.collider) b.collider.enabled = false;
      if (this.world && typeof this.world.removeActor === 'function') this.world.removeActor(b);
      this.free.push(b);
    }
    this.bots.length = 0;
    this.pathQueue.length = 0;
    this.cursor = 0;
  }

  dispose() {
    this.clear();
    this.disposeSoldierCache();
    for (const b of this.free) {
      if (this.world && typeof this.world.disposeActor === 'function') this.world.disposeActor(b);
      if (b.actorData?.group) {
        freeFactionMesh(b.actorData.group)
        b.actorData = null
      }
      if (b.collider && this.physics && typeof this.physics.removeCollider === 'function') {
        this.physics.removeCollider(b.collider);
      }
    }
    this.free.length = 0;
    const e = this.ctx.events;
    e.off('weapon:fire', this._onFire); e.off('explosion', this._onBoom);
    e.off('raid:start', this._onRaid);  e.off('raid:end', this._onEnd);
  }
}
