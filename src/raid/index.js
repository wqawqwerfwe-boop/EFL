import * as THREE from 'three'
import { EFL } from '../core/config.js'

/* ==========================================================================
 * Escape-From-Larpov · src/raid/index.js
 *
 * RaidSystem — жизненный цикл одного рейда: старт, лут, трупы, выходы, финал.
 *
 * КИТ ДИКОГО ЗДЕСЬ БОЛЬШЕ НЕ ЖИВЁТ.
 *
 * История вопроса: сначала start() безусловно звал this.meta.equipScavKit(),
 * которого в MetaSystem не было, и любая высадка за Дикого падала внутри
 * afterTerrain-хука преварма. Затем здесь появился META_SCAV_METHODS — список из
 * семи спекулятивных имён плюс внутренний мок-кит на статических таблицах.
 * Оба решения были замазкой: баланс экономики лежал в контроллере рейда,
 * который не видит ни профиля, ни кармы, ни уровня, а каждая выдача
 * предмета шла в своём try/catch — то есть половина потерь кита просто
 * молчала.
 *
 * Теперь владелец снаряжения — профиль:
 *
 *   meta.scavCooldownLeft()          таймер Дикого, проверяется ДО постройки карты
 *   meta.generateScavLoadout(rng)    дескриптор [uid,id,n,path,x,y,rot,dur]
 *   inv.applyLoadout(descriptor)     раскладка одной операцией
 *
 * Защитных обёрток вокруг выдачи больше нет сознательно. Сломанный кит обязан
 * падать громко: engine.startRaid() уже ловит исключение из start() и
 * возвращает игрока в меню, так что молчаливый фолбэк больше ничего не
 * спасает — он только скрывает баги до прода.
 *
 * Файл сознательно без точек с запятой.
 * ========================================================================== */

export class RaidSystem {
  static id = 'raid'
  static deps = ['world', 'inventory', 'items', 'health', 'meta', 'ai', 'ui', 'audio', 'physics']

  /* Общий буфер статуса выхода. Раньше exitStatus() писал в this._exitStatus,
   * которого не существовало ни в одном файле проекта. */
  _exitOut = { open: false, reason: '', progress: 0 }

  /* Источник кита Дикого в последней высадке. Теперы всегда либо профиль,
   * либо пустота — внутренних наборов больше нет. */
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
    this._scavKitSource = ''
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

    const meta = this.ctx.get('meta')

    /*
     * Таймер Дикого проверяется ДО buildMap(): отказ обязан быть дешёвым.
     * Исключение ловит engine.startRaid() и возвращает игрока в меню.
     */
    if (faction === 'scav') {
      const left = meta.scavCooldownLeft()
      if (left > 0) {
        throw new Error('[EFL/raid] выход за Дикого будет доступен через ' + Math.ceil(left / 1000) + ' с')
      }
    }

    // строим мир по требованию — вот ради чего world.buildMap асинхронный
    const map = await this.world.buildMap(mapId, { night: this.night, seed })
    this.exits = map.exits
    this.timeLeft = map.duration
    this._startElapsed = this.ctx.time.elapsed

    this._scatterLoot(map)

    /*
     * Кит Дикого. Одна строка владельца (профиль) и одна строка раскладки
     * (инвентарь). Без перебора имён методов, без мок-набора, без try/catch
     * на каждый предмет: в dev-сборке сломанная выдача обязана быть видна.
     */
    if (faction === 'scav') {
      const descriptor = meta.generateScavLoadout(this.rng)
      const applied = this.inv.applyLoadout(descriptor)
      this._scavKitSource = 'meta:generateScavLoadout'
      this._emitScavKit(descriptor, applied)
    }

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

  /** Событие для логов и экрана итогов: что именно выдал профиль. */
  _emitScavKit(descriptor, applied) {
    this.ctx.events.emit('raid:scavkit', {
      source: this._scavKitSource,
      faction: this.faction,
      rows: Array.isArray(descriptor) ? descriptor.length : 0,
      placed: applied && applied.items ? applied.items : 0,
      dropped: applied && applied.dropped ? applied.dropped : 0
    })
  }

  /**
   * Мягкий вызов метода профиля в ФИНАЛЬНОЙ части рейда.
   *
   * Остаётся мягким только здесь и только по одной причине: extract() и end()
   * ОБЯЗАНЫ дойти до emit('raid:end'). Упавший spend/keepLoadout не имеет
   * права оставить игрока навечно в рейде без экрана итогов. На выдачу
   * снаряжения это послабление не распространяется.
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
    return !this.inv.slotItem('backpack') && !this.inv.slotItem('primary')
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
