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
    if (!dest || !bot || !bot.root) return false;
    const p = bot.root.position;
    const dx = dest.x - p.x;
    const dz = dest.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.08) {
      p.x = dest.x;
      p.z = dest.z;
      const gy = this._groundAt(p.x, p.z, p.y + 4);
      if (Number.isFinite(gy)) p.y = gy;
      this._syncBot(bot);
      return true;
    }
    const step = Math.min(dist, Math.max(0.1, speed || 1) * dt * 5);
    p.x += (dx / dist) * step;
    p.z += (dz / dist) * step;
    const gy = this._groundAt(p.x, p.z, p.y + 4);
    if (Number.isFinite(gy)) p.y = gy;
    bot.yaw = Math.atan2(dx, dz);
    this._syncBot(bot);
    return dist <= step + 0.001;
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
    if (typeof bot === 'number') { dt = bot; bot = null; }
    if (!bot || !bot.root || !bot.alive) return false;

    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (step === 0) return false;

    // окно выдержки: смена стороны раз в STRAFE_MIN_T..STRAFE_MAX_T секунд
    bot.strafeT -= step;
    if (bot.strafeT <= 0) {
      bot.strafeT = STRAFE_MIN_T + this.rng.float() * (STRAFE_MAX_T - STRAFE_MIN_T);
      bot.strafeSign = this.rng.float() < 0.5 ? -1 : 1;
    }
    if (bot.strafeSign !== 1 && bot.strafeSign !== -1) bot.strafeSign = 1;

    // forward = (sin yaw, 0, cos yaw)  =>  right = (cos yaw, 0, -sin yaw)
    const sy = Math.sin(bot.yaw);
    const cy = Math.cos(bot.yaw);
    let rx = cy * bot.strafeSign;
    let rz = -sy * bot.strafeSign;

    const p = bot.root.position;
    const reach = STRAFE_SPEED * step;
    const probe = reach + 0.42;               // радиус капсулы + запас

    this._sv0.set(p.x, p.y + 0.95, p.z);
    this._sv1.set(p.x + rx * probe, p.y + 0.95, p.z + rz * probe);

    if (!this._sees(this._sv0, this._sv1)) {
      // сбоку глухо: разворачиваемся и подрезаем выдержку
      bot.strafeSign = -bot.strafeSign;
      bot.strafeT = STRAFE_MIN_T * 0.75;
      rx = -rx;
      rz = -rz;
      this._sv1.set(p.x + rx * probe, p.y + 0.95, p.z + rz * probe);
      if (!this._sees(this._sv0, this._sv1)) return false;   // зажат с двух сторон
    }

    const nx = p.x + rx * reach;
    const nz = p.z + rz * reach;
    const gy = this._groundAt(nx, nz, p.y + 4);
    if (!Number.isFinite(gy)) return false;                  // шаг в пустоту — стоим
    if (Math.abs(gy - p.y) > 0.75) {                         // обрыв или ступень выше пояса
      bot.strafeSign = -bot.strafeSign;
      bot.strafeT = STRAFE_MIN_T * 0.75;
      return false;
    }

    p.x = nx;
    p.z = nz;
    p.y = gy;
    this._syncBot(bot);
    return true;
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
  update(dt, ctx) {
    const n = this.bots.length;
    if (!n) return;
    const player = ctx.peek ? ctx.peek('player') : ctx.get('player');
    const ppos = player && player.position ? player.position : null;
    if (!ppos) {
      this._warnOnce('ppos', 'player system exposes no position — AI perception idle this frame');
      return;
    }
    const slice = Math.min(budget('botsUpdatedPerFrame'), n);

    for (let k = 0; k < slice; k++) {
      const bot = this.bots[(this.cursor + k) % n];
      if (!bot.alive) continue;
      // восприятие и поиск укрытий — редкие, дорогие операции
      this._perceive(bot, ppos, dt * n / slice);
    }
    this.cursor = (this.cursor + slice) % n;

    // лёгкая часть — для всех каждый кадр (движение, анимация, таймеры)
    for (let i = 0; i < n; i++) {
      const bot = this.bots[i];
      if (!bot.alive) continue;
      const far = bot.root.position.distanceToSquared(ppos) > 6400;   // >80 м
      bot.root.userData.owNoShadow = far;                             // далёкие не льют тени
      if (far && bot.state < S_COMBAT) continue;                      // далёкие патрули замирают
      this._think(bot, ppos, dt);
      this._animate(bot, dt);
    }

    // очередь путей: не больше 2 A* в кадр
    let left = budget('pathRequestsPerFrame');
    const canPath = this.world && typeof this.world.findPath === 'function';
    while (left-- > 0 && this.pathQueue.length) {
      const req = this.pathQueue.shift();
      if (!req.bot.alive) continue;
      req.bot.path = canPath && req.to ? (this.world.findPath(req.bot.root.position, req.to) || []) : [];
      req.bot.pathI = 0;
      req.bot.pathPending = false;
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
