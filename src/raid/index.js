import * as THREE from 'three'
import { EFL } from '../core/config.js'

/* ==========================================================================
 * Escape-From-Larpov · src/raid/index.js
 *
 * RaidSystem — жизненный цикл одного рейда: старт, лут, трупы, выходы, финал.
 *
 * ВЫДАЧА КИТА ДИКОГО. Раньше start() безусловно звал this.meta.equipScavKit(),
 * которого в MetaSystem нет ни в одном файле проекта: там есть money/spend,
 * loyalty, buyPrice/sellPrice, deal, insure, keepLoadout/loseLoadout,
 * questProgress, upgrade, tickProduction, addExperience — и ни одной выдачи
 * снаряжения. Любая высадка за Дикого падала на
 *
 *   TypeError: this.meta.equipScavKit is not a function
 *
 * причём падала ВНУТРИ afterTerrain-хука преварма (см. wizard._deploy()).
 * Промис runRaidPrewarm() отклонялся, экран «ВЫСАДКА НА МЕСТО ДИСЛОКАЦИИ»
 * навсегда замирал на текущей стадии, STATE.GAMEPLAY не наступал никогда, и
 * игрок оставался в мёртвом прогреве без единого способа выйти.
 *
 * Теперь выдача идёт через _equipScavLoadout(): сначала ищется реальный метод
 * профиля (любое имя из META_SCAV_METHODS), а если его нет — работает
 * внутренний мок-набор SCAV_*, собранный на существующих id из
 * src/items/index.js. Рейд за Дикого стартует при любом состоянии MetaSystem.
 *
 * Файл сознательно без точек с запятой.
 * ========================================================================== */

/*
 * Имена, под которыми выдача кита Дикого могла бы жить в профиле. Порядок —
 * это приоритет: сначала исторически ожидаемое equipScavKit, потом остальные
 * варианты, которые встречались в задачах и черновиках. Как только настоящий
 * метод появится в MetaSystem под любым из этих имён, RaidSystem подхватит
 * его сам, без правок здесь.
 */
const META_SCAV_METHODS = [
  'equipScavKit',
  'equipScavLoadout',
  'generateScavLoadout',
  'rollScavLoadout',
  'setScavKit',
  'giveScavKit',
  'equipStarterKit'
]

/*
 * Мок-кит Дикого. Ни одного нового предмета не изобретаем: все id взяты из
 * таблицы ITEMS (src/items/index.js), поэтому inv.add() их находит,
 * items.price() считает по ним страховую ценность, а сводка рейда не
 * превращается в NaN.
 */

/* Корпус. Контейнеры идут первыми: именно equip() создаёт гриды 'in:<uid>',
 * в которые падает всё остальное. */
const SCAV_GEAR = [
  { id: 'rig_bankrobber', slot: 'rig' },
  { id: 'backpack_smb', slot: 'backpack' },
  { id: 'secure_alpha', slot: 'secure' },
  { id: 'armor_paca', slot: 'armor' },
  { id: 'helmet_ssh', slot: 'helmet' }
]

/* Стволы Дикого — ровно те, что лежат в LOOT.gun. */
const SCAV_GUNS = [
  { id: 'aks74u', slot: 'primary', mag: 'mag_ak30', magCount: 2, ammo: '545ps', rounds: [40, 90] },
  { id: 'ak74n', slot: 'primary', mag: 'mag_ak30', magCount: 2, ammo: '545ps', rounds: [30, 60] },
  { id: 'mp5', slot: 'primary', mag: 'mag_mp5', magCount: 2, ammo: '9x19pst', rounds: [30, 60] },
  { id: 'm870', slot: 'primary', mag: null, magCount: 0, ammo: '12x70buck', rounds: [12, 28] },
  { id: 'mosin', slot: 'primary', mag: null, magCount: 0, ammo: '762x54lps', rounds: [10, 20] }
]

const SCAV_SIDEARM = { id: 'pm', slot: 'holster', mag: 'mag_pm', magCount: 1, ammo: '9x18pmm', rounds: [16, 32] }

/*
 * КАРМАНЫ — ровно четыре позиции 1×1, столько же, сколько ячеек в гриде
 * 'pocket' (4×1). Ничего крупнее сюда не кладём: 'water' 1×2 в карман не
 * влезает и уходит в разгрузку вместе с остальным хабаром.
 */
const SCAV_POCKETS = [
  { id: 'bandage', count: [1, 1] },
  { id: 'analgin', count: [1, 1] },
  { id: 'crackers', count: [1, 1] },
  { id: 'rub', count: [4000, 26000] }
]

/* Хабар в разгрузку и рюкзак. */
const SCAV_BARTER = [
  { id: 'water', count: [1, 1] },
  { id: 'crackers', count: [1, 1] },
  { id: 'bolts', count: [1, 3] },
  { id: 'wires', count: [1, 2] }
]

export class RaidSystem {
  static id = 'raid'
  static deps = ['world', 'inventory', 'items', 'health', 'meta', 'ai', 'ui', 'audio', 'physics']

  /* Общий буфер статуса выхода. Раньше exitStatus() писал в this._exitStatus,
   * которого не существует ни в одном файле проекта. */
  _exitOut = { open: false, reason: '', progress: 0 }

  /* Откуда пришёл кит Дикого в последней высадке: 'meta:<method>', 'internal'
   * или 'none'. Нужно и логам, и экрану итогов. */
  _scavKitSource = ''

  async init(ctx) {
    this.ctx = ctx
    this.world = ctx.get('world')
    this.inv = ctx.get('inventory')
    this.items = ctx.get('items')
    this.health = ctx.get('health')
    this.meta = ctx.get('meta')

    this.active = false
    this.mapId = null
    this.faction = 'pmc'
    this.timeLeft = 0
    this.night = false
    this.kills = 0
    this.lootPoints = []      // пул, не пересоздаётся между рейдами
    this.corpses = []
    this.exits = []
    this._holdT = 0
    this._activeExit = null
    this._bag = []            // переиспользуемый буфер ролла лута
    this._v = new THREE.Vector3()
    this._startElapsed = 0
    this.summary = {
      kind: '',
      kills: 0,
      xp: 0,
      value: 0,
      time: 0,
      exit: '',
      mapId: '',
      faction: '',
      night: false
    }

    this._onKill = (e) => {
      if (!e || !e.killed) return
      this.kills++
      this.summary.xp += e.xp ?? 0
    }
    this._onDeath = (e) => {
      if (e && e.isPlayer) this.end('killed')
    }
    ctx.events.on('damage:dealt', this._onKill)
    ctx.events.on('actor:death', this._onDeath)
  }

  /* ---------- старт ---------- */
  async start(mapId, faction, night) {
    const seed = this.ctx.rng.u32()
    this.rng = this.ctx.rng.fork('raid:' + seed)
    this.mapId = mapId
    this.faction = faction
    this.night = !!night
    this.kills = 0
    this.summary = {
      kind: '',
      kills: 0,
      xp: 0,
      value: 0,
      time: 0,
      exit: '',
      mapId,
      faction,
      night: !!night
    }

    // строим мир по требованию — вот ради чего world.buildMap асинхронный
    const map = await this.world.buildMap(mapId, { night: this.night, seed })
    this.exits = map.exits
    this.timeLeft = map.duration
    this._startElapsed = this.ctx.time.elapsed

    this._scatterLoot(map)

    /*
     * Кит Дикого. Раньше здесь стоял прямой this.meta.equipScavKit(this.rng) —
     * вызов несуществующего метода, ронявший весь преварм. Теперь выдача
     * никогда не бросает: не нашлось метода профиля — работает внутренний
     * набор, не удался и он — рейд всё равно стартует, только с пустыми
     * карманами и предупреждением в консоли.
     */
    if (faction === 'scav') this._equipScavLoadout(this.rng)

    if (this.health && typeof this.health.reset === 'function') this.health.reset()

    this.active = true
    this.ctx.events.emit('raid:start', { mapId, faction, night: this.night, seed })
  }

  _scatterLoot(map) {
    const spots = map.lootSpots
    const budget = Math.min(EFL.budgets.lootPoints, spots.length)
    for (let i = 0; i < budget; i++) {
      const spot = spots[i]
      const lp = this.lootPoints[i] ?? (this.lootPoints[i] = { items: [], mesh: null, opened: false, kind: '', pos: new THREE.Vector3() })
      lp.items.length = 0
      lp.opened = false
      lp.kind = spot.kind
      lp.pos.copy(spot.position)
      lp.mesh = spot.mesh                         // инстанс из world, не создаём новый
      this.items.fillBag(this._bag, spot.kind, this.rng, spot.rich ?? 1)
      for (let k = 0; k < this._bag.length; k += 2) lp.items.push(this._bag[k], this._bag[k + 1])
    }
    this.lootPoints.length = budget
  }

  /* ====================================================================== */
  /*                          кит Дикого                                    */
  /* ====================================================================== */

  /** Первое реально существующее имя выдачи кита в профиле, иначе ''. */
  _resolveMetaScavMethod(meta) {
    if (!meta) return ''
    for (let i = 0; i < META_SCAV_METHODS.length; i++) {
      const name = META_SCAV_METHODS[i]
      if (typeof meta[name] === 'function') return name
    }
    return ''
  }

  /**
   * Единственная точка выдачи снаряжения Дикого.
   *
   * Порядок: реальный метод профиля → внутренний мок-набор → предупреждение.
   * Метод НЕ бросает ни при каком состоянии MetaSystem и инвентаря: он стоит
   * в середине преварма, и любое исключение отсюда снова заморозило бы экран
   * высадки.
   *
   * @returns {string} 'meta:<method>' | 'internal' | 'none'
   */
  _equipScavLoadout(rng) {
    const meta = this.meta
    const name = this._resolveMetaScavMethod(meta)

    if (name) {
      try {
        meta[name](rng)
        this._scavKitSource = 'meta:' + name
        this._emitScavKit()
        return this._scavKitSource
      } catch (err) {
        console.warn('[EFL/raid] meta.' + name + '() упал — выдаём внутренний кит Дикого', err)
      }
    } else {
      console.warn('[EFL/raid] в профиле нет выдачи кита Дикого (' + META_SCAV_METHODS.join(' / ') + ') — работает внутренний набор')
    }

    let ok = false
    try {
      ok = this._mockScavKit(rng)
    } catch (err) {
      console.error('[EFL/raid] внутренний кит Дикого не выдан', err)
      ok = false
    }

    this._scavKitSource = ok ? 'internal' : 'none'
    if (!ok) console.warn('[EFL/raid] Дикий уходит в рейд без снаряжения — инвентарь недоступен')
    this._emitScavKit()
    return this._scavKitSource
  }

  _emitScavKit() {
    const events = this.ctx && this.ctx.events ? this.ctx.events : null
    if (!events || typeof events.emit !== 'function') return
    try {
      events.emit('raid:scavkit', { source: this._scavKitSource, faction: this.faction })
    } catch (err) {
      /* шина событий не имеет права ронять высадку */
    }
  }

  /**
   * Внутренний мок-набор Дикого: корпус, ствол, магазины, патроны, четыре
   * кармана и немного хабара. Считается успешным, если хоть что-то легло:
   * забитый под потолок инвентарь — не повод отменять рейд.
   */
  _mockScavKit(rng) {
    const inv = this.inv
    if (!inv || typeof inv.add !== 'function') return false

    let placed = 0

    for (let i = 0; i < SCAV_GEAR.length; i++) {
      const entry = SCAV_GEAR[i]
      if (this._kitSlotBusy(entry.slot)) continue
      const it = this._kitStage(entry.id, 1)
      if (!it) continue
      if (this._kitEquip(it, entry.slot)) placed++
    }

    const gun = SCAV_GUNS[this._kitPick(rng, SCAV_GUNS.length)]
    if (this._kitWeapon(gun, rng)) placed++

    /* Пистолет — примерно каждому второму Дикому. */
    if (this._kitPick(rng, 2) === 0 && this._kitWeapon(SCAV_SIDEARM, rng)) placed++

    for (let i = 0; i < SCAV_POCKETS.length; i++) {
      const entry = SCAV_POCKETS[i]
      if (this._kitAdd(entry.id, this._kitAmount(rng, entry.count), 'pocket')) placed++
    }

    for (let i = 0; i < SCAV_BARTER.length; i++) {
      const entry = SCAV_BARTER[i]
      if (this._kitPlaceOnBody(entry.id, this._kitAmount(rng, entry.count))) placed++
    }

    return placed > 0
  }

  _kitWeapon(entry, rng) {
    if (!entry) return false
    if (this._kitSlotBusy(entry.slot)) return false
    const gun = this._kitStage(entry.id, 1)
    if (!gun) return false
    if (!this._kitEquip(gun, entry.slot)) return false
    const mags = Math.max(0, Math.round(Number(entry.magCount) || 0))
    if (entry.mag) {
      for (let i = 0; i < mags; i++) this._kitPlaceOnBody(entry.mag, 1)
    }
    if (entry.ammo) this._kitPlaceOnBody(entry.ammo, this._kitAmount(rng, entry.rounds))
    return true
  }

  /** Промежуточная посадка предмета в любой доступный грид перед equip(). */
  _kitStage(id, count) {
    const staging = ['stash', 'pocket']
    for (let i = 0; i < staging.length; i++) {
      const it = this._kitAdd(id, count, staging[i])
      if (it) return it
    }
    const body = this._kitBodyPaths()
    for (let i = 0; i < body.length; i++) {
      const it = this._kitAdd(id, count, body[i])
      if (it) return it
    }
    return null
  }

  /** Кладёт предмет на тело: сначала контейнеры, карманы — в последнюю очередь. */
  _kitPlaceOnBody(id, count) {
    if (!id) return false
    const paths = this._kitBodyPaths()
    for (let i = 0; i < paths.length; i++) {
      if (this._kitAdd(id, count, paths[i])) return true
    }
    return false
  }

  /*
   * bodyPaths() отдаёт ПЕРЕИСПОЛЬЗУЕМЫЙ массив инвентаря и правит его на каждом
   * вызове, поэтому копия обязательна. Порядок переворачиваем: разгрузка и
   * рюкзак впереди, 'pocket' в хвосте — иначе патроны съедали бы карманы
   * раньше, чем до них дойдёт SCAV_POCKETS.
   */
  _kitBodyPaths() {
    const inv = this.inv
    if (!inv || typeof inv.bodyPaths !== 'function') return ['pocket']
    let raw = null
    try {
      raw = inv.bodyPaths()
    } catch (err) {
      return ['pocket']
    }
    if (!raw || !raw.length) return ['pocket']
    const containers = []
    const rest = []
    for (let i = 0; i < raw.length; i++) {
      const path = String(raw[i])
      if (path.indexOf('in:') === 0) containers.push(path)
      else rest.push(path)
    }
    return containers.concat(rest)
  }

  _kitAdd(id, count, path) {
    const inv = this.inv
    if (!id || !path || !inv || typeof inv.add !== 'function') return null
    const n = Math.max(1, Math.round(Number(count) || 1))
    try {
      return inv.add(id, n, path, { fir: true }) || null
    } catch (err) {
      return null
    }
  }

  _kitEquip(it, slot) {
    const inv = this.inv
    if (!it || !inv || typeof inv.equip !== 'function') return false
    try {
      return !!inv.equip(it.uid, slot)
    } catch (err) {
      return false
    }
  }

  _kitSlotBusy(slot) {
    const inv = this.inv
    if (!inv || typeof inv.slotItem !== 'function') return false
    try {
      return !!inv.slotItem(slot)
    } catch (err) {
      return false
    }
  }

  /** Детерминированный индекс из rng рейда, с полным набором фолбэков. */
  _kitPick(rng, max) {
    const n = Math.max(1, Math.round(Number(max) || 1))
    if (n === 1) return 0
    if (rng && typeof rng.int === 'function') {
      const v = Math.round(Number(rng.int(0, n - 1)))
      if (Number.isFinite(v)) return Math.max(0, Math.min(n - 1, v))
    }
    if (rng && typeof rng.float === 'function') {
      const f = Number(rng.float())
      if (Number.isFinite(f)) return Math.max(0, Math.min(n - 1, Math.floor(f * n)))
    }
    return 0
  }

  _kitAmount(rng, range) {
    const pair = Array.isArray(range) ? range : [range, range]
    const lo = Math.round(Number(pair[0]) || 1)
    const hi = Math.round(Number(pair[1]) || lo)
    const min = Math.max(1, Math.min(lo, hi))
    const max = Math.max(min, Math.max(lo, hi))
    if (max === min) return min
    if (rng && typeof rng.int === 'function') {
      const v = Math.round(Number(rng.int(min, max)))
      if (Number.isFinite(v)) return Math.max(min, Math.min(max, v))
    }
    if (rng && typeof rng.float === 'function') {
      const f = Number(rng.float())
      if (Number.isFinite(f)) return Math.max(min, Math.min(max, min + Math.floor(f * (max - min + 1))))
    }
    return min
  }

  /**
   * Мягкий вызов метода профиля.
   *
   * Ровно тот же класс аварии, что и equipScavKit: отсутствующий или
   * бросающий метод MetaSystem не имеет права оставлять рейд в active-состоянии
   * и не давать эмитнуть raid:end.
   */
  _metaCall(name, ...args) {
    const meta = this.meta
    if (!meta || typeof meta[name] !== 'function') {
      console.warn('[EFL/raid] meta.' + name + '() отсутствует — шаг пропущен')
      return null
    }
    try {
      return meta[name](...args)
    } catch (err) {
      console.error('[EFL/raid] meta.' + name + '() упал', err)
      return null
    }
  }

  /* ---------- лут ---------- */
  openLoot(index) {
    const lp = this.lootPoints[index]
    if (!lp || lp.opened) return null
    lp.opened = true
    this.ctx.events.emit('loot:opened', { point: lp })
    return lp
  }

  takeLoot(lp, slotIndex) {
    const id = lp.items[slotIndex * 2]
    const n = lp.items[slotIndex * 2 + 1]
    if (!id) return false
    for (const path of this.inv.bodyPaths()) {
      if (this.inv.add(id, n, path, { fir: true })) {
        lp.items.splice(slotIndex * 2, 2)
        this.ctx.events.emit('loot:taken', { itemId: id, count: n, fir: true })
        return true
      }
    }
    return false                                   // нет места
  }

  /** Труп бота — та же лут-точка. Старые трупы теряют меш, но не содержимое. */
  spawnCorpse(bot) {
    const lp = { items: [], opened: false, kind: 'corpse', pos: bot.root.position.clone(), bot }
    lp.items.push(bot.wepId, 1, this.items.ammoId[bot.ammoIdx], this.rng.int(10, 60))
    this.items.fillBag(this._bag, 'jacket', this.rng, 0.7)
    for (let k = 0; k < this._bag.length; k += 2) lp.items.push(this._bag[k], this._bag[k + 1])
    this.corpses.push(lp)
    this.lootPoints.push(lp)
    if (this.corpses.length > EFL.budgets.corpses) {
      const old = this.corpses.shift()
      this.world.recycleCorpseMesh(old.bot)        // меш в пул, лут остаётся доступен
    }
  }

  /* ---------- выходы ---------- */

  /** Сколько рублей у игрока. Без этого геттера this.money был undefined,
   *  а undefined < exit.cost всегда false — платные выходы ничего не проверяли. */
  get money() {
    if (!this.meta || typeof this.meta.money !== 'function') return 0
    const v = Number(this.meta.money('rub'))
    return Number.isFinite(v) ? v : 0
  }

  /** Сколько уже стоим в зоне выхода. */
  get extractHeld() {
    return this._holdT
  }

  /** Откуда пришёл кит Дикого в последней высадке. */
  get scavKitSource() {
    return this._scavKitSource
  }

  /** Вызывался из exitStatus(), но не существовал: было только _hasItem(). */
  hasItem(id) {
    return this._hasItem(id)
  }

  /** Ни рюкзака, ни основного ствола. Тоже не существовал. */
  handsFree() {
    if (!this.inv || typeof this.inv.slotItem !== 'function') return true
    let backpack = null
    let primary = null
    try {
      backpack = this.inv.slotItem('backpack')
    } catch (e) {
      backpack = null
    }
    try {
      primary = this.inv.slotItem('primary')
    } catch (e) {
      primary = null
    }
    return !backpack && !primary
  }

  /** Условия выхода из EFL: фракция, время, ключ, цена, свободные руки.
   *  Второй аргумент — буфер для результата (fixedUpdate передаёт _exitOut). */
  exitStatus(exit, out) {
    const s = (out && typeof out === 'object') ? out : this._exitOut
    s.open = false
    s.reason = ''
    s.progress = 0

    if (!exit) {
      s.reason = 'Выход недоступен'
      return s
    }

    const left = this.timeLeft

    /* Фракция: выходы Диких не работают за ЧВК и наоборот. */
    if (exit.faction && exit.faction !== this.faction) {
      s.reason = 'Только за Дикого'
      return s
    }

    /* afterSec: открывается, когда до конца рейда осталось меньше afterSec. */
    if (exit.afterSec > 0 && left > exit.afterSec) {
      s.reason = 'Откроется через ' + Math.ceil((left - exit.afterSec) / 60) + ' мин'
      return s
    }

    /* beforeSec: закрывается под конец рейда. */
    if (exit.beforeSec > 0 && left < exit.beforeSec) {
      s.reason = 'Уже закрыт'
      return s
    }

    /* Ключ или карта доступа. */
    if (exit.needKey && !this.hasItem(exit.needKey)) {
      s.reason = 'Нужен ключ'
      return s
    }

    /* Свободные руки: ни рюкзака, ни основного ствола. */
    if (exit.freeHands && !this.handsFree()) {
      s.reason = 'Нужны свободные руки'
      return s
    }

    /* Платный выход. */
    if (exit.cost > 0 && this.money < exit.cost) {
      s.reason = 'Нужно ' + exit.cost + ' ₽'
      return s
    }

    /*
     * noBotsNear: выход блокируется, пока в радиусе есть живой бот.
     * Сравнение идёт по квадратам дистанций, без sqrt и без аллокаций.
     */
    if (exit.noBotsNear > 0 && exit.position) {
      const ai = this.ctx && typeof this.ctx.peek === 'function' ? this.ctx.peek('ai') : null
      const list = ai ? ai.actors || ai.bots : null
      if (list && list.length > 0) {
        const r2 = exit.noBotsNear * exit.noBotsNear
        const ex = exit.position.x
        const ez = exit.position.z
        for (let i = 0; i < list.length; i++) {
          const bot = list[i]
          if (!bot || bot.dead || !bot.position) continue
          const dx = bot.position.x - ex
          const dz = bot.position.z - ez
          if (dx * dx + dz * dz < r2) {
            s.reason = 'Рядом противник'
            return s
          }
        }
      }
    }

    /* Прогресс удержания: 7 секунд обычно, 9 для перехода между картами.
     * Было this.cfg.raid.* — this.cfg не существует, берём EFL как fixedUpdate. */
    s.open = true
    const hold = exit.transfer ? EFL.raid.transferHold : EFL.raid.extractHold
    s.progress = hold > 0 ? Math.min(1, this._holdT / hold) : 1
    return s
  }

  _hasItem(id) {
    if (!this.inv || !this.inv.all) return false
    for (const it of this.inv.all) {
      if (it && it.id === id && this.inv.onBody(it)) return true
    }
    return false
  }

  fixedUpdate(h, ctx) {
    if (!this.active) return
    this.timeLeft -= h
    if (this.timeLeft <= 0) {
      this.end('mia')
      return
    }

    const pos = ctx.get('player').position
    let inside = null
    for (let i = 0; i < this.exits.length; i++) {
      const e = this.exits[i]
      if (pos.distanceToSquared(e.position) > e.radius * e.radius) continue
      if (!this.exitStatus(e, this._exitOut).open) continue
      inside = e
      break
    }

    if (!inside) {
      this._holdT = 0
      this._activeExit = null
      return
    }
    if (this._activeExit !== inside) {
      this._activeExit = inside
      this._holdT = 0
    }
    this._holdT += h
    const need = inside.transfer ? EFL.raid.transferHold : EFL.raid.extractHold
    ctx.events.emit('extract:progress', { exit: inside, t: this._holdT, need })
    if (this._holdT >= need) this.extract(inside)
  }

  extract(exit) {
    if (exit.cost) this._metaCall('spend', 'rub', exit.cost)
    this.ctx.events.emit('raid:extract', { exit, transfer: !!exit.transfer })
    this.end('survived', exit)
  }

  /* ---------- конец ---------- */
  end(kind, exit) {
    if (!this.active) return
    this.active = false

    const s = this.summary
    s.kind = kind
    s.kills = this.kills
    s.exit = exit?.name ?? ''
    s.mapId = this.mapId
    s.faction = this.faction
    s.night = this.night
    s.time = Math.max(0, this.ctx.time.elapsed - this._startElapsed)
    s.value = 0
    /* Коэрсим цену и количество: один undefined превращал всю сводку в NaN. */
    for (const it of this.inv.all) {
      if (!this.inv.onBody(it)) continue
      s.value += (Number(this.items.price(it.id)) || 0) * (Number(it.n) || 0)
    }

    if (kind === 'survived') this._metaCall('keepLoadout')
    else this._metaCall('loseLoadout', kind)       // страховка разбирается внутри meta

    /* ГЛАВНОЕ: освобождаем всю геометрию и RT. Под try — падение teardown()
     * раньше съедало и raid:end, а без этого события UI навсегда оставался
     * в рейде: ни итогов, ни возврата в убежище. */
    try {
      if (this.world && typeof this.world.teardown === 'function') this.world.teardown()
    } catch (err) {
      console.error('[EFL/raid] world.teardown() упал', err)
    }
    this.corpses.length = 0
    this.ctx.events.emit('raid:end', { kind, summary: { ...s } })
  }

  /**
   * Снимок сводки для UI. Экран итогов не всегда приходит из raid:end —
   * в STATE.RESULTS можно попасть и прямым setState(), и повторным показом
   * визарда, а payload события к тому моменту уже потерян.
   *
   * Возвращает копию (визард не должен писать в живую сводку) или null, пока
   * ни один рейд не завершался: kind == '' означает "показывать нечего".
   */
  getSummaryPayload() {
    const s = this.summary
    if (!s || !s.kind) return null
    return {
      kind: s.kind,
      kills: Number(s.kills) || 0,
      xp: Number(s.xp) || 0,
      value: Number(s.value) || 0,
      time: Number(s.time) || 0,
      exit: s.exit || '',
      mapId: s.mapId || '',
      faction: s.faction || '',
      night: !!s.night
    }
  }

  dispose() {
    this.ctx.events.off('damage:dealt', this._onKill)
    this.ctx.events.off('actor:death', this._onDeath)
    this.lootPoints.length = 0
    this.corpses.length = 0
    this.exits.length = 0
  }
}

export default RaidSystem
