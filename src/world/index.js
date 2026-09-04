import * as THREE from 'three';
import { EFL } from '../core/config.js';
import {
  MAP_IDS,
  MAP_META,
  buildMap as buildMapFromRegistry,
  disposeMap,
  getMapMeta,
  hasMap,
  pickSpawn,
} from './maps/index.js';

/* ==========================================================================
 * Escape-From-Larpov · src/world/index.js
 *
 * WorldSystem — сборка, владение и снос тактического окружения рейда.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ЧТО ЗДЕСЬ БЫЛО СЛОМАНО
 * ──────────────────────────────────────────────────────────────────────────
 *
 * 1. RNG — та самая причина, по которой не собиралась НИ ОДНА карта.
 *    buildMap() делал
 *
 *      const rng = this.ctx.rng.fork('map:' + mapId + ':' + seed)
 *
 *    и отдавал результат в билдер как opts.rng. Но Rng.fork()
 *    (src/core/rng.js) возвращает ЭКЗЕМПЛЯР Rng, а не функцию, тогда как
 *    MapKit кладёт opts.rng в this.rng и зовёт this.rng() напрямую из
 *    rand() / randInt() / pick() / scatter() / loot(). Первый же вызов:
 *
 *      TypeError: this.rng is not a function
 *
 *    Карты нормализуют источник случайности через makeRng() ТОЛЬКО когда
 *    opts.rng пустой — `(a.opts && a.opts.rng) || makeRng(...)` — поэтому
 *    непустой, но нерабочий объект гарантированно доезжал до кита. Падали
 *    все четыре карты одинаково, на каждой высадке.
 *
 * 2. Отсюда и «тестовая сцена со сферами». Своего фоллбэка на тестовый
 *    уровень у движка НЕТ: ни 'sandbox', ни 'test' в коде не существует.
 *    Исключение уходило наружу через buildMap() → raid.start() →
 *    afterTerrain-хук runRaidPrewarm(); преварм не перебрасывает ошибку, а
 *    возвращает { ok:false }, и LobbyWizard._deploy() всё равно звал
 *    engine.enterGameplay(). Игрок оказывался в STATE.GAMEPLAY с ПУСТЫМ
 *    world.root, где сферы и серые кубы — это блокаут подсистемы render
 *    (userData.owProbe), который снимается только когда появляется
 *    настоящая геометрия, а пол — PhysicsSystem._addFallbackGround():
 *    бетонная плита 600×600 на y = 0, которую _ensureStatics() стелет,
 *    когда не находит в сцене ни одного меша.
 *
 * 3. Спавн. PlayerSystem._resolveSpawn() и PlayerSystem.respawn() зовут
 *    world.spawn(i) — метода с таким именем у WorldSystem НЕ БЫЛО, был
 *    только spawnZones(kind). Поэтому `world?.spawn?.(0)` всегда давал
 *    undefined, и игрок садился в жёстко прошитый THREE.Vector3(0, 0.2, 0):
 *    ровно то самое «одни и те же координаты на любой карте». Переставлять
 *    игрока после сборки уровня тоже было некому.
 *
 * 4. Реестр. Здесь лежала СОБСТВЕННАЯ таблица MAPS с продублированными
 *    size/duration/lights, а канонический src/world/maps/index.js не
 *    импортировался ни одним файлом проекта: buildMap / hasMap /
 *    getMapMeta / listMaps / disposeMap / pickSpawn были мёртвым кодом.
 *    Дубль разъехался с метаданными карт (factory: 25 мин против 20 в
 *    factoryMeta, свет 20 против lightBudget 24) и не знал ни meta.bots,
 *    ни minLevel, ни needCard. Валидации не было вообще: `MAPS[mapId]`
 *    для незнакомого id давал undefined, и падало это как
 *    «Cannot read properties of undefined (reading 'build')».
 *
 * 5. Хуки кита. MapKit._register() пробует world.addMesh / addStatic /
 *    trackStatic, а kit.collider() — world.addCollider. НИ ОДНОГО из этих
 *    методов не существовало, все вызовы молча гасились в try/catch, и
 *    физика никогда не получала явную статику карты.
 *
 * 6. Снос. teardown() диспозил только _owned, который ВСЕГДА был пуст:
 *    заполняться он должен был через колбэк opts.track, а MapKit его не
 *    вызывает никогда. Дескриптор карты, матрицы InstancedMesh, навсетка и
 *    BVH физики продолжали жить между рейдами.
 *
 * Маршрут id карты, к слову, был корректен и раньше:
 *   LobbyWizard.state.mapId → raid.start(mapId) → world.buildMap(mapId).
 * Ломалось всё уже внутри сборки.
 * ========================================================================== */

/*
 * Презентационный слепок реестра карт.
 *
 * ВЫВОДИТСЯ из MAP_META, а не дублирует его: единственный источник истины —
 * src/world/maps/index.js. Оставлен потому, что LobbyWizard._syncCatalogue()
 * ищет таблицу как world.MAPS либо world.constructor.MAPS и гасит карточку
 * локации как «НЕДОСТУПНО», если билдера нет. Раньше не совпадало ни одно из
 * этих имён — MAPS был экспортом модуля, — поэтому каталог не сверялся, и в
 * меню светилась устаревшая длительность рейда.
 */
function mapsTable() {
  const out = {};
  for (let i = 0; i < MAP_IDS.length; i++) {
    const id = MAP_IDS[i];
    const m = MAP_META[id];
    if (!m || !hasMap(id)) continue;
    out[id] = {
      n: m.name || id,
      size: m.size,
      duration: m.duration,
      lights: m.lightBudget || 16,
      minLevel: m.minLevel === undefined ? 1 : m.minLevel,
      needCard: m.needCard || null,
      indoor: !!m.indoor,
      bots: m.bots || null,
    };
  }
  return out;
}

export const MAPS = mapsTable();

/**
 * Приводит любой источник случайности к функции () => [0,1).
 *
 * Ключевая функция этого файла: именно её отсутствие роняло сборку карт.
 * Rng из src/core/rng.js отдаёт float(), генераторы кита — вызываемую
 * функцию, а MapKit умеет работать только со вторым вариантом.
 */
function rngFunction(source, fallback) {
  const r = source;
  if (typeof r === 'function') return r;
  if (r && typeof r.float === 'function') return () => r.float();
  if (r && typeof r.next === 'function') return () => r.next();
  if (r && typeof r.random === 'function') return () => r.random();
  return fallback || null;
}

export class WorldSystem {
  static id = 'world';
  static deps = ['materials', 'render', 'sky'];

  /* Визард сверяет каталог локаций с этой таблицей. */
  static MAPS = MAPS;

  async init(ctx) {
    this.ctx = ctx;
    this.mats = ctx.get('materials');
    this.render = ctx.get('render');
    this.root = new THREE.Group();
    this.root.name = 'world';
    ctx.scene.add(this.root);

    /* Тот же слепок доступен и на экземпляре — визард смотрит оба места. */
    this.MAPS = MAPS;
    this.mapIds = MAP_IDS.slice();

    this.current = null;
    this.navGrid = null;
    this.buildings = [];
    this._owned = { geometries: new Set(), materials: new Set(), textures: new Set() };
    this._lights = [];              // ФИКСИРОВАННЫЙ пул point-light
    this._instanced = new Map();    // ключ кита → InstancedMesh
    this._actorPool = [];
    this._actors = new Set();
    this._colliders = [];
    this._staticMeshes = [];        // меши карты, ждущие регистрации в физике
    this._staticHandles = [];       // хендлы physics.addStatic — нужны для сноса BVH
    this._mapRng = null;
    this._spawnKind = 'pmc';
    this._matrix = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(1, 1, 1);
    this._spawnOut = new THREE.Vector3();
    this._spawnResult = { position: new THREE.Vector3(), yaw: 0, kind: 'pmc', index: -1 };

    /* Бюджет света берём из lightBudget метаданных карт, а не из локального
     * дубля: раньше пул считался по устаревшей колонке lights. */
    let budget = 0;
    for (let i = 0; i < MAP_IDS.length; i++) {
      const m = MAP_META[MAP_IDS[i]];
      if (m && m.lightBudget > budget) budget = m.lightBudget;
    }
    this._allocLightPool(budget || 16);
  }

  /** Ловушка движка: число светов входит в permutation key шейдера.
   *  Создаём максимум раз и навсегда, лишние гасим intensity = 0.
   *  visible = false НЕЛЬЗЯ — это меняет ключ и вызывает рекомпиляцию всех материалов. */
  _allocLightPool(n) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffd9a0, 0, 14, 2);
      l.castShadow = false;
      this.root.add(l);
      this._lights.push(l);
      this.render.addLight(l);
    }
  }

  lamp(pos, color, intensity, distance) {
    const l = this._lights.find((x) => x.intensity === 0);
    if (!l) return null;                       // бюджет исчерпан — это норма, а не ошибка
    l.position.copy(pos); l.color.set(color); l.intensity = intensity; l.distance = distance;
    return l;
  }

  /* ====================================================================== */
  /* сборка карты                                                           */
  /* ====================================================================== */

  /**
   * Единственный вход в сборку уровня.
   *
   * mapId приходит из лобби без изменений:
   *   LobbyWizard.state.mapId → raid.start(mapId) → сюда.
   * Никаких дефолтов, 'sandbox' и 'test' здесь нет и быть не должно —
   * неизвестный id это ошибка маршрутизации, и она обязана быть громкой.
   */
  async buildMap(mapId, opts) {
    const o = opts || {};
    const night = !!o.night;
    const seed = o.seed === undefined ? 0 : o.seed;

    if (this.current) this.teardown();

    /*
     * Валидация ДО сборки. Раньше было `const def = MAPS[mapId]` и сразу
     * `def.build(...)`: любой незнакомый или разъехавшийся id падал внутри
     * преварма как «Cannot read properties of undefined (reading 'build')»,
     * то есть без единого намёка на то, что дело в идентификаторе карты.
     */
    if (!hasMap(mapId)) {
      throw new Error(
        '[world] неизвестная карта "' + mapId + '". Зарегистрированы: ' + MAP_IDS.join(', ')
      );
    }

    const meta = getMapMeta(mapId) || {};

    /*
     * КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ. ctx.rng.fork() возвращает экземпляр Rng, а
     * MapKit зовёт this.rng() напрямую. Раньше сюда уезжал сырой объект, и
     * первый же kit.loot()/kit.rand() ронял всю сборку с
     * «this.rng is not a function» — именно поэтому ни одна карта никогда
     * не строилась и движок оставался в пустой сцене.
     */
    this._mapRng = rngFunction(
      this.ctx.rng.fork('map:' + mapId + ':' + seed),
      () => this.ctx.rng.float()
    );

    this._staticMeshes.length = 0;
    this._colliders.length = 0;

    /*
     * Канонический реестр карт. Сам билдер синхронный (MapKit.finalize()
     * возвращает готовый дескриптор), но контракт buildMap() оставлен
     * async: raid.start() его ожидает, и после геометрии нам ещё нужен
     * прогрев материалов.
     */
    const built = buildMapFromRegistry(mapId, this, this.ctx, {
      ctx: this.ctx,
      world: this,
      rng: this._mapRng,
      night,
      seed,
      mats: this.mats,
      size: meta.size,
      track: (obj) => this._track(obj),
    });

    if (!built || !built.group) {
      throw new Error('[world] билдер карты "' + mapId + '" не вернул группу геометрии');
    }

    /* Владение ресурсами: колбэк track кит не вызывает, поэтому забираем
     * геометрию и свои материалы обходом готовой группы. */
    this._track(built.group);
    this.root.add(built.group);

    /*
     * Метаданные карты — источник истины. map.meta приходит из самого
     * модуля карты (factoryMeta / customsMeta / woodsMeta /
     * interchangeMeta / labMeta) и несёт duration, lightBudget, minLevel,
     * needCard и bots. Локальная таблица больше ничего не решает.
     */
    const mapMeta = built.meta || meta;
    this.current = {
      ...built,
      id: mapId,
      meta: mapMeta,
      night,
      duration: built.duration || mapMeta.duration || 25 * 60,
      bots: mapMeta.bots || null,
    };
    this.navGrid = built.navGrid || null;
    this.buildings = (built.rooms || []).map((spec) => ({ spec }));

    this._applyAtmosphere(this.current);

    /* Статика → BVH. Обязательно ДО спавна: игрок садится на пол по
     * physics.groundHeight(), а его ещё не существует. */
    this._registerStatics();

    const faction = this._raidFaction(o);
    this._spawnKind = faction === 'scav' ? 'scav' : 'pmc';
    this._placePlayer(this.current, this._spawnKind);

    await this.ctx.get('render').prewarmMaterials(this.ctx);

    console.info(
      '[world] карта "' + mapId + '" собрана: ' + (mapMeta.name || mapId) +
      ' · ' + (this.current.size || mapMeta.size) + ' м' +
      ' · ' + Math.round(this.current.duration / 60) + ' мин' +
      ' · выходов ' + (built.exits ? built.exits.length : 0) +
      ' · лута ' + (built.lootSpots ? built.lootSpots.length : 0) +
      ' · коллайдеров ' + this._colliders.length +
      (night ? ' · ночь' : ' · день')
    );

    return this.current;
  }

  /** Фракция текущей высадки: raid ставит её ДО вызова buildMap(). */
  _raidFaction(o) {
    if (o && o.faction) return o.faction;
    const raid = this.ctx.peek ? this.ctx.peek('raid') : null;
    if (raid && raid.faction) return raid.faction;
    const offline = this.ctx.engine ? this.ctx.engine.__eflOffline : null;
    if (offline && offline.faction) return offline.faction;
    return 'pmc';
  }

  /*
   * Туман и постановка света из дескриптора карты. kit.setFog() и
   * kit.setAmbient() складывают спеки в map.fog / map.ambient, но раньше их
   * не читал никто. Работаем строго через опциональные хуки sky: трогать
   * scene.fog напрямую нельзя — это меняет permutation key материалов.
   */
  _applyAtmosphere(map) {
    if (!map) return;
    const sky = this.ctx.peek ? this.ctx.peek('sky') : null;
    if (!sky) return;
    if (map.fog && typeof sky.setFog === 'function') {
      try {
        sky.setFog(map.fog.color, map.fog.density);
      } catch (err) {
        /* небо может не принимать спек — не повод ронять высадку */
      }
    }
    if (map.ambient && typeof sky.setAmbient === 'function') {
      try {
        sky.setAmbient(map.ambient);
      } catch (err) {
        /* необязательный хук */
      }
    }
  }

  /* ====================================================================== */
  /* хуки контракта MapKit                                                  */
  /* ====================================================================== */

  /**
   * MapKit._register() отдаёт сюда каждый Mesh и InstancedMesh карты.
   *
   * Кит пробует addMesh → addStatic → trackStatic и глотает исключения; ни
   * одного из этих методов у WorldSystem не было, так что регистрация
   * статики не происходила никогда. Копим и отдаём в физику одним пакетом
   * из _registerStatics(): один пересбор BVH на рейд вместо одного на меш.
   */
  addMesh(obj, info) {
    if (!obj) return null;
    if (info && obj.userData && !obj.userData.surface) {
      obj.userData.surface = info.surface || 'concrete';
      obj.userData.surfaceIndex = info.surfaceIndex || 0;
    }
    this._staticMeshes.push(obj);
    return obj;
  }

  addStatic(obj, info) {
    return this.addMesh(obj, info);
  }

  trackStatic(obj, info) {
    return this.addMesh(obj, info);
  }

  /**
   * Аналитический OBB из kit.collider(). Держим список для навсетки и
   * быстрых проверок занятости; в физику они не уезжают — там статика
   * живёт треугольниками в BVH, а не боксами.
   */
  addCollider(c) {
    if (!c) return null;
    this._colliders.push(c);
    return c;
  }

  get colliders() {
    return this._colliders;
  }

  /**
   * Явная регистрация геометрии карты в физике.
   *
   * Без неё PhysicsSystem._ensureStatics() либо сканирует всю сцену сам,
   * либо — если мешей нет вообще — стелет _addFallbackGround(): плиту
   * 600×600 на y = 0. Именно она и была «пустым пространством», в котором
   * игрок стоял на одном и том же месте на любой карте.
   */
  _registerStatics() {
    const phys = this.ctx.peek ? this.ctx.peek('physics') : null;
    if (!phys) return;

    this._dropStatics(phys);

    const group = this.current ? this.current.group : null;
    if (group && typeof phys.addStaticGroup === 'function') {
      const ids = phys.addStaticGroup(group);
      if (ids && ids.length) {
        for (let i = 0; i < ids.length; i++) this._staticHandles.push(ids[i]);
      }
    } else if (typeof phys.addStatic === 'function') {
      for (let i = 0; i < this._staticMeshes.length; i++) {
        const id = phys.addStatic(this._staticMeshes[i]);
        if (id >= 0) this._staticHandles.push(id);
      }
    }
    this._staticMeshes.length = 0;

    /* Один пересбор BVH на рейд, не покадрово. */
    if (typeof phys.rebuildStatic === 'function') phys.rebuildStatic();
  }

  /** Снимает статику прошлой карты с физики. */
  _dropStatics(physics) {
    const phys = physics || (this.ctx && this.ctx.peek ? this.ctx.peek('physics') : null);
    if (phys && typeof phys.removeStatic === 'function') {
      for (let i = 0; i < this._staticHandles.length; i++) {
        try {
          phys.removeStatic(this._staticHandles[i]);
        } catch (err) {
          /* хендл мог уехать вместе с dispose() физики */
        }
      }
    }
    this._staticHandles.length = 0;
  }

  /* ====================================================================== */
  /* владение ресурсами                                                     */
  /* ====================================================================== */

  _track(obj) {
    if (!obj || typeof obj.traverse !== 'function') return obj;
    obj.traverse((o) => {
      if (o.geometry) this._owned.geometries.add(o.geometry);
      const m = o.material;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) this._trackMaterial(m[i]);
      } else if (m) {
        this._trackMaterial(m);
      }
    });
    return obj;
  }

  /**
   * Диспозим ТОЛЬКО свои материалы.
   *
   * resolveMaterial() кита отдаёт либо общий материал из подсистемы
   * materials, либо собственный PBR-фоллбэк с меткой userData.owFallback.
   * Освободить общий материал здесь означало бы уронить вьюмодели, эффекты
   * и все последующие карты.
   */
  _trackMaterial(m) {
    if (!m || typeof m.dispose !== 'function') return;
    if (this._isShared(m)) return;
    const ud = m.userData;
    if (!ud || (!ud.owFallback && !ud.owCloned)) return;
    this._owned.materials.add(m);
  }

  _isShared(res) {
    if (!this.mats || typeof this.mats.isShared !== 'function') return false;
    try {
      return !!this.mats.isShared(res);
    } catch (err) {
      return false;
    }
  }

  /* ====================================================================== */
  /* спавны                                                                 */
  /* ====================================================================== */

  spawnZones(kind) {
    return this.current?.spawnZones?.[kind] || [];
  }

  spawnCount(kind) {
    return this.spawnZones(kind || this._spawnKind).length;
  }

  /**
   * Точка спавна карты. Контракт, которого не хватало движку.
   *
   * PlayerSystem._resolveSpawn() и PlayerSystem.respawn() зовут
   * world.spawn(index) — метода с таким именем НЕ БЫЛО, поэтому
   * `world?.spawn?.(0)` всегда возвращал undefined, и игрок садился в
   * жёстко прошитый THREE.Vector3(0, 0.2, 0). Теперь идём по настоящим
   * узлам kit.spawn('pmc'|'scav'|...) выбранной карты.
   *
   * kind по умолчанию берётся из фракции текущей высадки, потому что
   * PlayerSystem передаёт только индекс.
   */
  spawn(index, kind) {
    const want = kind || this._spawnKind || 'pmc';
    let list = this.spawnZones(want);
    if (!list.length && want !== 'pmc') list = this.spawnZones('pmc');
    if (!list.length) list = this.spawnZones('bot');
    if (!list.length) return null;

    let i = Number.isFinite(index) ? Math.floor(index) : 0;
    if (i < 0) i = 0;
    i %= list.length;

    const v = list[i];
    const out = this._spawnResult;
    out.position.copy(v);
    out.kind = want;
    out.index = i;
    /*
     * Разворот лицом к центру уровня. Спавны стоят по периметру карты, а
     * базис движения — forward = (-sin yaw, 0, -cos yaw), поэтому взгляд
     * в начало координат это yaw = atan2(x, z).
     */
    out.yaw = Math.atan2(v.x, v.z);
    return out;
  }

  /** Детерминированный спавн через реестр карт, без аллокаций. */
  pickSpawn(kind, rng, out) {
    const target = out || this._spawnOut;
    const fn = rngFunction(rng, this._mapRng || (() => this.ctx.rng.float()));
    return pickSpawn(this.current, kind || this._spawnKind, fn, target) ? target : null;
  }

  /**
   * Высадка игрока на подлинную точку спавна собранной карты.
   *
   * PlayerSystem._resolveSpawn() исполняется ОДИН раз, в init(), задолго до
   * того как появится хоть какая-то карта, и других мест, где движок
   * переставлял бы игрока на старте рейда, в проекте не было. Поэтому
   * капсула на любой локации оставалась в (0, 0.2, 0), а физика
   * подкладывала под неё fallback-плиту.
   *
   * player.respawn(index) внутри сам зовёт world.spawn(index),
   * physics.groundHeight() и movement.teleport(), так что здесь достаточно
   * выбрать индекс узла.
   */
  _placePlayer(map, kind) {
    const player = this.ctx.peek ? this.ctx.peek('player') : null;
    if (!player) return null;

    let list = this.spawnZones(kind);
    if (!list.length) list = this.spawnZones('pmc');
    if (!list.length) {
      console.warn(
        '[world] у карты "' + map.id + '" нет точек спавна ' + kind + ' — игрок остаётся на месте'
      );
      return null;
    }

    /* Детерминированно: тот же seed рейда даёт тот же узел высадки. */
    const rand = this._mapRng || (() => this.ctx.rng.float());
    let index = Math.floor(rand() * list.length);
    if (!Number.isFinite(index) || index < 0) index = 0;
    index %= list.length;

    if (typeof player.respawn === 'function') {
      player.respawn(index);
    } else if (player.movement && typeof player.movement.teleport === 'function') {
      const node = this.spawn(index, kind);
      const phys = this.ctx.peek ? this.ctx.peek('physics') : null;
      let y = node.position.y;
      if (phys && typeof phys.groundHeight === 'function') {
        const gy = phys.groundHeight(node.position.x, node.position.z, y + 8);
        if (Number.isFinite(gy)) y = gy + 0.03;
      }
      player.movement.yaw = node.yaw;
      player.movement.pitch = 0;
      player.movement.teleport(node.position.x, y, node.position.z);
    }

    const placed = this.spawn(index, kind);
    console.info(
      '[world] высадка: ' + map.id + ' · ' + kind + ' #' + index + '/' + list.length +
      ' → ' + placed.position.x.toFixed(1) + ', ' + placed.position.z.toFixed(1)
    );
    return placed;
  }

  /* ====================================================================== */
  /* снос                                                                   */
  /* ====================================================================== */

  /**
   * Полный цикл сноса между рейдами.
   *
   * Раньше здесь диспозились только геометрия и материалы из _owned — а
   * _owned ВСЕГДА был пуст, потому что наполнялся через колбэк opts.track,
   * которого MapKit не вызывает никогда. То есть по факту не освобождалось
   * ничего: physics.staticWorld держал треугольники прошлой карты,
   * матрицы InstancedMesh оставались в памяти, а следующий buildMap()
   * звал rebuildStatic() поверх устаревших объектов.
   */
  teardown() {
    const map = this.current;
    if (!map) return;

    const phys = this.ctx && this.ctx.peek ? this.ctx.peek('physics') : null;

    /* 1. Снимаем статику карты с физики: BVH не должен помнить прошлый уровень. */
    this._dropStatics(phys);

    /* 2. Убираем группу карты из графа сцены. */
    if (map.group) {
      this.root.remove(map.group);
      if (map.group.parent) map.group.parent.remove(map.group);
    }

    /* 3. Геометрия, свои материалы и их текстуры. */
    for (const g of this._owned.geometries) {
      if (g && typeof g.dispose === 'function') g.dispose();
    }
    for (const m of this._owned.materials) {
      for (const k in m) {
        const v = m[k];
        if (v && v.isTexture && !this._isShared(v)) v.dispose();
      }
      m.dispose();
    }
    for (const t of this._owned.textures) {
      if (t && typeof t.dispose === 'function' && !this._isShared(t)) t.dispose();
    }
    this._owned.geometries.clear();
    this._owned.materials.clear();
    this._owned.textures.clear();

    /*
     * 4. Ресурсы самого MapKit: буферы instanceMatrix, точечные светы
     *    карты, фоллбэк-материалы, пул геометрии, коллайдеры, лут, двери,
     *    выходы и навигационная сетка. disposeMap() из реестра карт делает
     *    ровно это — и до сих пор не вызывался ни одной строкой проекта.
     */
    try {
      disposeMap(map);
    } catch (err) {
      console.error('[world] disposeMap() упал', err);
    }

    /* 5. Пулы движка: свет гасим, но НЕ удаляем — иначе поменяется
     *    permutation key шейдеров и пересоберутся все материалы. */
    for (const l of this._lights) l.intensity = 0;
    this._instanced.clear();
    this._actors.clear();
    this._colliders.length = 0;
    this._staticMeshes.length = 0;
    this.buildings = [];
    this.navGrid = null;
    this._mapRng = null;
    this.current = null;

    /* 6. Пересобираем пустой BVH, чтобы в физике не осталось прошлой карты. */
    if (phys && typeof phys.rebuildStatic === 'function') phys.rebuildStatic();
  }

  /* ====================================================================== */
  /* запросы к уровню                                                       */
  /* ====================================================================== */

  /** meta.bots выбранной карты: сколько и кого поднимать подсистеме ИИ. */
  get botBudget() {
    return this.current?.meta?.bots || null;
  }

  /** Полные метаданные собранной карты. */
  get mapMeta() {
    return this.current?.meta || null;
  }

  get mapId() {
    return this.current?.id || null;
  }

  levelToWorld(x, y, z, out = new THREE.Vector3()) {
    return out.set(x, y, z);
  }

  isOpen(x, z, m = 0.3) {
    const nav = this.navGrid;
    if (!nav) return true;
    if (typeof nav.freeWorld !== 'function') return true;
    if (m <= 0) return nav.freeWorld(x, z);
    return (
      nav.freeWorld(x, z) &&
      nav.freeWorld(x + m, z) &&
      nav.freeWorld(x - m, z) &&
      nav.freeWorld(x, z + m) &&
      nav.freeWorld(x, z - m)
    );
  }

  groundAt(x, z, fromY = 20) {
    const phys = this.ctx?.peek('physics');
    const y = phys?.groundHeight?.(x, z, fromY, phys.MASK_WORLD ?? 1);
    return Number.isFinite(y) ? y : 0;
  }

  randomPatrolPoint(rng) {
    const rand = rngFunction(rng, () => this.ctx.rng.float());
    const nav = this.navGrid;
    const p = new THREE.Vector3();
    if (nav && typeof nav.randomFree === 'function' && nav.randomFree(rand, p)) {
      p.y = this.groundAt(p.x, p.z, p.y + 4);
      return p;
    }
    const zones = this.spawnZones('bot');
    if (zones.length) {
      const q = zones[(rand() * zones.length) | 0].clone();
      q.y = this.groundAt(q.x, q.z, q.y + 4);
      return q;
    }
    return p.set(0, this.groundAt(0, 0, 20), 0);
  }

  findPath(from, to) {
    const nav = this.navGrid;
    if (!nav || typeof nav.findPath !== 'function') return [];
    const out = [];
    const n = nav.findPath(from, to, out);
    if (!n) return [];
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      p.y = this.groundAt(p.x, p.z, p.y + 4);
    }
    return out;
  }

  findCover(pos, threat, rng) {
    const nav = this.navGrid;
    const phys = this.ctx?.peek('physics');
    if (!nav || !phys) return null;
    const rand = rngFunction(rng, () => this.ctx.rng.float());
    const mask = phys.MASK_WORLD ?? 1;
    const baseX = pos.x - threat.x;
    const baseZ = pos.z - threat.z;
    const baseLen = Math.hypot(baseX, baseZ) || 1;
    const awayX = baseX / baseLen;
    const awayZ = baseZ / baseLen;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 28; i++) {
      const wiggle = (rand() - 0.5) * 1.4;
      const ang = Math.atan2(awayZ, awayX) + wiggle;
      const dist = 6 + rand() * 16;
      const x = pos.x + Math.cos(ang) * dist;
      const z = pos.z + Math.sin(ang) * dist;
      if (typeof nav.freeWorld === 'function' && !nav.freeWorld(x, z)) continue;
      const y = phys.groundHeight(x, z, pos.y + 6, mask);
      if (!Number.isFinite(y)) continue;
      const p = new THREE.Vector3(x, y, z);
      if (phys.lineOfSight?.(threat, p, mask)) continue;
      const path = nav.findPath(pos, p, []);
      if (!path || path.length === 0) continue;
      const dBot = p.distanceTo(pos);
      const dThreat = p.distanceTo(threat);
      let score = dThreat * 2.1 - dBot * 0.6;
      score += ((x - pos.x) * awayX + (z - pos.z) * awayZ) / Math.max(1, dBot) * 2.4;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /* ====================================================================== */
  /* акторы                                                                 */
  /* ====================================================================== */

  addActor(actor) {
    if (!actor) return null;
    const node = actor.isObject3D ? actor : actor.root || null;
    if (node && node.parent !== this.root) this.root.add(node);
    if (actor.collider) actor.collider.enabled = true;
    if (Array.isArray(actor.colliders)) for (const c of actor.colliders) if (c) c.enabled = true;
    this._actors.add(actor);
    return actor;
  }

  removeActor(actor) {
    if (!actor) return null;
    const node = actor.isObject3D ? actor : actor.root || null;
    node?.parent?.remove(node);
    if (actor.collider) actor.collider.enabled = false;
    if (Array.isArray(actor.colliders)) for (const c of actor.colliders) if (c) c.enabled = false;
    this._actors.delete(actor);
    return actor;
  }

  disposeActor(actor) {
    if (!actor) return null;
    this.removeActor(actor);
    const phys = this.ctx?.peek('physics');
    if (actor.collider && phys?.removeCollider) phys.removeCollider(actor.collider);
    if (Array.isArray(actor.colliders) && phys?.removeCollider) {
      for (const c of actor.colliders) phys.removeCollider(c);
      actor.colliders.length = 0;
    }
    actor.dispose?.();
    return actor;
  }

  recycleCorpseMesh(actor) {
    return this.removeActor(actor);
  }

  recycleGhost(actor) {
    return this.removeActor(actor);
  }

  dispose() {
    this.teardown();
    this._dropStatics();
    for (const l of this._lights) l.parent?.remove(l);
    this._lights.length = 0;
  }
}

export default WorldSystem;
