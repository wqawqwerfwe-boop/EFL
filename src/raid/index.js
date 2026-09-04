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

export const RAID_END = Object.freeze({
  extracted: 'extracted',
  killed: 'killed',
  mia: 'mia',
  timeout: 'timeout',
  aborted: 'aborted',
})

/** Lobby flags the raid controller understands. Unknown keys are preserved. */
export const DEFAULT_RAID_OPTIONS = Object.freeze({
  isTraining: false,
  offline: false,
  night: false,
  insurance: true,
})

/**
 * Normalise whatever the lobby handed over into a complete options object.
 * Accepts a boolean (legacy `night` positional), a partial object or nothing.
 * `isTraining` is coerced strictly — only a real `true` turns protection on.
 */
export function normalizeRaidOptions(input, night) {
  const out = Object.assign({}, DEFAULT_RAID_OPTIONS)
  if (input && typeof input === 'object') {
    const keys = Object.keys(input)
    for (let i = 0; i < keys.length; i++) out[keys[i]] = input[keys[i]]
  }
  out.night = night === undefined ? !!out.night : !!night
  out.isTraining = input && typeof input === 'object' ? input.isTraining === true : false
  out.offline = out.isTraining || out.offline === true
  return out
}

function endKind(kind) {
  return RAID_END[kind] ? RAID_END[kind] : RAID_END.mia
}

export class RaidSystem {
  static id = 'raid'
  static deps = ['world', 'inventory', 'items', 'health', 'meta', 'ai', 'ui', 'audio', 'physics']

  /* Общий буфер статуса выхода. Раньше exitStatus() писал в this._exitStatus,
   * которого не существовало ни в одном файле проекта. */
  _exitOut = { open: false, reason: '', progress: 0 }

  /* Источник кита Дикого в последней высадке. Теперы всегда либо профиль,
   * либо пустота — внутренних наборов больше нет. */
  _scavKitSource = ''

  raidOptions = Object.assign({}, DEFAULT_RAID_OPTIONS)

  isTraining() {
    return !!(this.raidOptions && this.raidOptions.isTraining === true)
  }

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
      night: false,
      training: false,
      kitRetained: false
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
  async start(mapId, faction, night, options) {
    const seed = this.ctx.rng.u32()
    this.rng = this.ctx.rng.fork('raid:' + seed)
    this.raidOptions = normalizeRaidOptions(options, night)
    this.mapId = mapId
    this.faction = faction
    this.night = this.raidOptions.night
    this.kills = 0
    this._scavKitSource = ''
    this._activeExit = null
    this._holdT = 0
    this.summary = {
      kind: '',
      kills: 0,
      xp: 0,
      value: 0,
      time: 0,
      exit: '',
      mapId,
      faction,
      night: this.night,
      training: this.isTraining(),
      kitRetained: false,
    }

    const meta = this.ctx.get('meta')

    /* Таймер Дикого проверяется ДО buildMap(): отказ обязан быть дешёвым.
     * В тренировочном рейде кулдаун не применяется — это оффлайн-сессия. */
    if (faction === 'scav' && !this.isTraining()) {
      const left = meta.scavCooldownLeft()
      if (left > 0) {
        throw new Error('[EFL/raid] выход за Дикого будет доступен через ' + Math.ceil(left / 1000) + ' с')
      }
    }

    const map = await this.world.buildMap(mapId, { night: this.night, seed })
    this.exits = map.exits
    this.timeLeft = map.duration
    this._startElapsed = this.ctx.time.elapsed

    this._scatterLoot(map)

    if (faction === 'scav') {
      const descriptor = meta.generateScavLoadout(this.rng)
      const applied = this.inv.applyLoadout(descriptor)
      this._scavKitSource = 'meta:generateScavLoadout'
      this._emitScavKit(descriptor, applied)
    }

    if (this.health && typeof this.health.reset === 'function') this.health.reset()

    this.active = true
    this.ctx.events.emit('raid:start', {
      mapId,
      faction,
      night: this.night,
      seed,
      training: this.isTraining(),
      options: this.raidOptions,
    })
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
    if (!this.active) return
    if (exit?.cost) this._metaCall('spend', 'rub', exit.cost)
    this.summary.exit = exit && typeof exit.id === 'string' ? exit.id : exit?.label || exit?.name || ''
    this.ctx.events.emit('raid:extract', { exit, transfer: !!exit?.transfer })
    this.end(RAID_END.extracted)
  }

  /* ---------- конец ---------- */
  end(kind) {
    if (!this.active) return
    this.active = false

    const k = endKind(kind)
    const training = this.isTraining()

    this.summary.kind = k
    this.summary.kills = this.kills
    this.summary.time = Math.max(0, this.ctx.time.elapsed - this._startElapsed)
    this.summary.training = training
    this.summary.value = this._kitValue()

    let kitRetained = false

    if (k === RAID_END.extracted) {
      kitRetained = this._settleExtract()
    } else if (training) {
      /* OFFLINE DEATH PROTECTION.
       * Hard bypass. No death payload is built, nothing is serialised, no wipe
       * runs, the profile is not told a character died. The body — container,
       * rig, weapons, pockets, secure — stays exactly as it was at the moment
       * of death and the player returns to the stash with it. */
      kitRetained = this._settleTraining(k)
    } else {
      kitRetained = this._settleDeath(k)
    }

    this.summary.kitRetained = kitRetained

    this._clearField()
    if (this.health && typeof this.health.reset === 'function') this.health.reset()

    this.ctx.events.emit('raid:end', {
      kind: k,
      summary: this.summary,
      training,
      kitRetained,
      mapId: this.mapId,
      faction: this.faction,
    })

    this._returnToStash(k, training)
  }

  /* ---------- урегулирование снаряжения ---------- */

  /** Extraction: the profile banks the loadout and the FIR loot. */
  _settleExtract() {
    const snapshot = this._serializeBody()
    this._metaCall('keepLoadout', snapshot, this.summary)
    this._metaCall('bankRaid', this.summary)
    if (this.faction === 'scav') this._metaCall('transferScavKit', snapshot, this.summary)
    return true
  }

  /**
   * Training death. Deliberately does NOT call `_serializeBody()`, does NOT
   * call `applyDeath`, does NOT clear any body path. Only a bookkeeping note
   * for the result screen; even that is optional for the profile.
   */
  _settleTraining(kind) {
    this._metaCall('noteTrainingRaid', { kind, summary: this.summary })
    return true
  }

  /**
   * Live death / MIA / timeout — the hardcore path. Serialise what was on the
   * body, hand the death payload to the profile, then wipe the body paths so
   * the stash shows exactly what the profile decided survived (insurance,
   * secure container).
   */
  _settleDeath(kind) {
    const snapshot = this._serializeBody()
    const payload = { kind, summary: this.summary, body: snapshot, insured: !!this.raidOptions.insurance }
    this._metaCall('applyDeath', payload)
    this._wipeBody()
    if (this.faction === 'scav') this._metaCall('startScavCooldown', this.summary)
    return false
  }

  /** Snapshot of every body path. Soft: a missing serializer yields null. */
  _serializeBody() {
    const inv = this.inv
    if (!inv) return null
    if (typeof inv.serializeBody === 'function') return inv.serializeBody()
    if (typeof inv.serialize === 'function') return inv.serialize({ scope: 'body' })
    if (!Array.isArray(inv.all) || typeof inv.onBody !== 'function') return null
    return inv.all.filter((item) => item && inv.onBody(item)).map((item) => ({ ...item }))
  }

  /** Clear every body path except the secure container. */
  _wipeBody() {
    const inv = this.inv
    if (!inv) return
    if (typeof inv.wipeBody === 'function') {
      inv.wipeBody({ keepSecure: true })
      return
    }
    if (typeof inv.bodyPaths === 'function' && typeof inv.clearPath === 'function') {
      const paths = inv.bodyPaths()
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i]
        if (typeof p === 'string' && p.indexOf('secure') === 0) continue
        inv.clearPath(p)
      }
      return
    }
    if (!Array.isArray(inv.all) || typeof inv.remove !== 'function' || typeof inv.onBody !== 'function') return
    const secure = typeof inv.slotItem === 'function' ? inv.slotItem('secure') : null
    const keep = new Set()
    if (secure) {
      keep.add(secure.uid)
      const grid = typeof inv.grid === 'function' ? inv.grid('in:' + secure.uid) : null
      for (const item of grid?.items || []) keep.add(item.uid)
    }
    for (let i = inv.all.length - 1; i >= 0; i--) {
      const item = inv.all[i]
      if (item && inv.onBody(item) && !keep.has(item.uid)) inv.remove(item.uid)
    }
  }

  /** Rouble value of the current body for the result screen. Soft. */
  _kitValue() {
    const inv = this.inv
    if (!inv) return 0
    try {
      if (typeof inv.bodyValue === 'function') {
        const v = inv.bodyValue()
        return Number.isFinite(v) ? v : 0
      }
      if (!Array.isArray(inv.all) || typeof inv.onBody !== 'function') return 0
      let value = 0
      for (const item of inv.all) {
        if (!item || !inv.onBody(item)) continue
        value += (Number(this.items.price(item.id)) || 0) * (Number(item.n) || 0)
      }
      return value
    } catch (_err) {
      return 0
    }
  }

  /* ---------- уборка поля ---------- */

  /** Corpses and loot points are pooled; only their contents are dropped. */
  _clearField() {
    for (let i = 0; i < this.lootPoints.length; i++) {
      const lp = this.lootPoints[i]
      lp.items.length = 0
      lp.opened = false
      lp.mesh = null
    }
    this.lootPoints.length = 0
    this.corpses.length = 0
    this.exits = []
    this._activeExit = null
    this._holdT = 0
    this._exitOut.open = false
    this._exitOut.reason = ''
    this._exitOut.progress = 0
    try {
      if (this.world && typeof this.world.teardown === 'function') this.world.teardown()
    } catch (err) {
      console.error('[EFL/raid] world.teardown() упал', err)
    }
  }

  _returnToStash(kind, training) {
    const ctx = this.ctx
    const menu = (typeof ctx.peek === 'function' ? ctx.peek('mainMenu') : null) || ctx.engine?.mainMenu || null
    const tab = kind === RAID_END.extracted || training ? 'stash' : 'result'
    if (tab === 'stash' && typeof ctx.engine?.returnToMenu === 'function') ctx.engine.returnToMenu()
    if (menu && typeof menu.show === 'function') {
      try {
        menu.show(tab, { summary: this.summary, training })
        return
      } catch (err) {
        console.warn('[EFL/raid] mainMenu.show(' + tab + ') упал, уходим через событие', err)
      }
    }
    ctx.events.emit('menu:open', { tab, summary: this.summary, training })
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
      night: !!s.night,
      training: s.training === true,
      kitRetained: s.kitRetained === true
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
