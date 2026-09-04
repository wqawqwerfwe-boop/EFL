import {
  ARMOR_SLOTS,
  ITEMS,
  armorMaterial,
  ensureArmorInstance,
  isArmorDef,
} from '../items/index.js'
import { ZONE_BY_HEALTH_PART, coversZone } from '../core/anatomy.js'
import { ARCHETYPES, FACTION_BY_INDEX } from '../ai/archetypes.js'

/*
 * ARMOUR — вероятностное пробитие и износ плит.
 *
 * До этого броня была аркадным порогом: pen >= armorClass * 10 — пробила,
 * иначе нет. Исход был детерминирован, а посчитанный урон броне выбрасывался:
 * жилет держал одинаково на первой и на сотой пуле.
 *
 * Здесь живёт вся математика брони. penetration.js только ветвится по её
 * ответу и шлёт события.
 */

/*
 *   classStep   единиц сопротивления на один класс брони
 *   centreBias  середина кривой: pen = 0.88 * сопротивление
 *   steepness   крутизна логисты
 *   floor/ceil  ни одного гарантированного исхода: свежая плита иногда
 *               пропускает, слабый патрон иногда везёт
 */
export const PEN_CURVE = Object.freeze({
  classStep: 10,
  centreBias: 0.88,
  steepness: 8,
  floor: 0.01,
  ceil: 0.99
})

/*
 * Канонический коэффициент износа: 121 - 5000 / (45 + 2D), D в процентах.
 *
 *   D = 100  ->  1.006   свежая плита держит свой класс целиком
 *   D =  50  ->  0.865
 *   D =  30  ->  0.734   треть ресурса — и класс фактически ниже на единицу
 *   D =   0  ->  0.099   убитая плита не держит почти ничего
 *
 * Именно здесь требование "30 процентов заметно хуже ста" становится цифрой.
 */
export function durabilityFactor(durabilityPercent) {
  const d = durabilityPercent < 0 ? 0 : durabilityPercent > 100 ? 100 : durabilityPercent
  return (121 - 5000 / (45 + d * 2)) / 100
}

/**
 * Шанс пробития брони класса armorClass на остатке ресурса durabilityPercent.
 *
 * Класс 4 против 5.45 БП (pen 37):
 *   100 процентов ресурса  ->  ~0.58
 *    30 процентов ресурса  ->  ~0.95
 *
 * @param {number} penPower пробивная способность патрона
 * @param {number} armorClass класс брони 1..6
 * @param {number} durabilityPercent остаток ресурса 0..100
 * @returns {number} вероятность 0..1
 */
export function penetrationChance(penPower, armorClass, durabilityPercent) {
  if (!(armorClass > 0)) return 1
  const resist = armorClass * PEN_CURVE.classStep * durabilityFactor(durabilityPercent)
  if (!(resist > 0)) return PEN_CURVE.ceil
  const x = penPower / resist
  const chance = 1 / (1 + Math.exp(-PEN_CURVE.steepness * (x - PEN_CURVE.centreBias)))
  if (chance < PEN_CURVE.floor) return PEN_CURVE.floor
  if (chance > PEN_CURVE.ceil) return PEN_CURVE.ceil
  return chance
}

/**
 * Сколько ресурса съедает одно попадание.
 *
 *   durLoss = penPower * ammoArmorDamagePercent * materialFactor / 100
 *
 * Заблокированная пуля бьёт плиту сильнее пробившей: вся энергия осталась
 * в материале. Керамика крошится, сталь мнётся, арамид терпит.
 */
export function armorDurabilityLoss(penPower, armorDamagePercent, material, penetrated) {
  const mat = armorMaterial(material)
  let loss = penPower * armorDamagePercent * mat.destruction / 100
  if (!penetrated) loss *= mat.blocked
  return loss > 0 ? loss : 0
}

/*
 * Синтетическая плита для ботов.
 *
 * У бота нет инвентаря — только число armorClass / helmetClass. Собираем ему
 * экземпляр при первом попадании, чтобы броня бота садилась за бой так же,
 * как игроцкая, а не держала весь рейд как новая.
 */
export function synthPlate(armorClass, zones, headZones) {
  const cls = Math.max(1, Math.min(6, Math.round(armorClass)))
  const durMax = 20 + cls * 32
  const material = cls <= 2 ? 'aramid' : cls <= 4 ? 'steel' : 'ceramic'
  const blunt = cls <= 2 ? 0.22 : cls <= 4 ? 0.16 : 0.1
  const id = 'synth_ac' + cls
  const def = {
    id,
    n: 'Class ' + cls + ' plate',
    t: 'armor',
    px: 0,
    armor: cls,
    dur: durMax,
    armorClass: cls,
    durMax,
    material,
    bluntThroughput: blunt,
    zones,
    synthetic: true
  }
  if (headZones) def.headZones = headZones
  return { item: { uid: -1, id, dur: durMax, durMax, synthetic: true }, def }
}

/* ------------------------------------------------------------------ *
 * Раскладка плит по фракции.
 *
 * src/ai/archetypes.js — единственный источник цифр бота, и это замороженный
 * лист данных без единого импорта, так что читать его отсюда безопасно:
 * циклов не будет. Берём оттуда armor.parts и armor.helmetDrop, чтобы
 * синтетическая плита совпадала с тем, что Anatomy.setArmor уже выдала тому же
 * актору, а не угадывала грудь с животом для всех подряд.
 *
 *   scav    class 0..2, только грудь          helmetDrop 2
 *   raider  class 4..6, голова/грудь/живот    helmetDrop 1
 *   pmc     class 3..5, голова/грудь/живот    helmetDrop 1
 *   boss    class 5..6, голова/грудь/живот    helmetDrop 1
 * ------------------------------------------------------------------ */

const DEFAULT_BODY_ZONES = Object.freeze(['thorax', 'stomach'])
const DEFAULT_HEAD_SUB_ZONES = Object.freeze(['top', 'nape', 'ears'])
const DEFAULT_HELMET_DROP = 2

/* Фракция приходит строкой ('raider'), целым из FACTION в src/ai/index.js, или
 * записью архетипа на самом акторе. Принимаем все три. */
function factionIdOf(actor) {
  const f = actor.faction
  if (typeof f === 'string' && f !== '') return f.toLowerCase()
  if (typeof f === 'number' && Number.isFinite(f)) {
    const id = FACTION_BY_INDEX[Math.trunc(f)]
    if (id !== undefined) return id
  }
  const a = actor.archetype
  if (typeof a === 'string' && a !== '') return a.toLowerCase()
  if (a && typeof a === 'object' && typeof a.id === 'string') return a.id.toLowerCase()
  return null
}

function archetypeOf(actor) {
  const rec = actor.archetype
  if (rec && typeof rec === 'object' && rec.armor) return rec
  const id = factionIdOf(actor)
  if (id === null) return null
  const a = ARCHETYPES[id]
  return a === undefined ? null : a
}

/* Списки прикрытия пишут в двух словарях: 'rarm' (health) и 'arm_right' (зона). */
function zoneIdOf(name) {
  if (typeof name !== 'string' || name === '') return null
  const mapped = ZONE_BY_HEALTH_PART[name]
  return mapped === undefined ? name : mapped
}

/* Что вообще прикрыто у этого актора: явный список на акторе важнее архетипа. */
function coveredZones(actor, arch) {
  if (Array.isArray(actor.armorParts) && actor.armorParts.length > 0) return actor.armorParts
  if (arch && arch.armor && Array.isArray(arch.armor.parts) && arch.armor.parts.length > 0) return arch.armor.parts
  return DEFAULT_BODY_ZONES
}

/* Зоны корпуса: голова уезжает на отдельную плиту со своим классом. */
function bodyZones(actor, arch) {
  const raw = coveredZones(actor, arch)
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const z = zoneIdOf(raw[i])
    if (z === null || z === 'head') continue
    if (out.indexOf(z) < 0) out.push(z)
  }
  return out
}

function coversHead(actor, arch) {
  const raw = coveredZones(actor, arch)
  for (let i = 0; i < raw.length; i++) {
    if (zoneIdOf(raw[i]) === 'head') return true
  }
  return false
}

/*
 * Каска никогда не держит полный класс жилета — ровно та же просадка, что
 * делает Anatomy.setArmor, иначе резолвер и модель урона разойдутся на голове.
 */
function helmetDropOf(actor, arch) {
  if (typeof actor.helmetDrop === 'number' && actor.helmetDrop >= 0) return actor.helmetDrop
  if (arch && arch.armor && typeof arch.armor.helmetDrop === 'number') return arch.armor.helmetDrop
  return DEFAULT_HELMET_DROP
}

function headSubZonesOf(actor) {
  if (Array.isArray(actor.headZones) && actor.headZones.length > 0) return actor.headZones
  return DEFAULT_HEAD_SUB_ZONES
}

/*
 * Кто именно прикрывает зону.
 *
 * Игрок — через надетые слоты инвентаря. Бот — через синтетику, которая
 * кэшируется на самом акторе. Возвращается ПУЛОВАЯ запись: в кадре
 * ничего не аллоцируется. Содержимое валидно до следующего resolve().
 */
export class ArmorResolver {
  constructor(ctx) {
    this.ctx = ctx || null
    this._out = { item: null, def: null }
  }

  attach(ctx) {
    if (ctx) this.ctx = ctx
    return this
  }

  /* peek() не бросает на незарегистрированной системе, get() бросает. */
  _sys(name) {
    const c = this.ctx
    if (!c) return null
    if (typeof c.peek === 'function') {
      const v = c.peek(name)
      if (v) return v
    }
    if (typeof c.get === 'function') {
      try {
        return c.get(name)
      } catch (e) {
        return null
      }
    }
    return null
  }

  _defOf(it) {
    const items = this._sys('items')
    if (items && typeof items.get === 'function') {
      const d = items.get(it.id)
      if (d) return d
    }
    return ITEMS[it.id]
  }

  /*
   * Надетое на игроке. При нескольких предметах на одной зоне (жилет плюс
   * разгрузка с плитами, каска плюс маска) решает старший класс:
   * пуля встречает самую серьёзную преграду.
   */
  _worn(zoneId, subZone) {
    const inv = this._sys('inventory')
    if (!inv || typeof inv.slotItem !== 'function') return null
    let bestItem = null
    let bestDef = null
    for (let i = 0; i < ARMOR_SLOTS.length; i++) {
      const it = inv.slotItem(ARMOR_SLOTS[i])
      if (!it) continue
      const d = this._defOf(it)
      if (!isArmorDef(d)) continue
      if (!coversZone(d, zoneId, subZone)) continue
      ensureArmorInstance(it, d)
      if (!(it.dur > 0)) continue
      if (bestDef === null || d.armorClass > bestDef.armorClass) {
        bestItem = it
        bestDef = d
      }
    }
    if (bestDef === null) return null
    this._out.item = bestItem
    this._out.def = bestDef
    return this._out
  }

  /*
   * Синтетика бота.
   *
   * Кэш строится один раз на актора и живёт на actor._armorZones. Записи
   * возвращаются как есть, поэтому penetration.js пишет новый ресурс прямо в
   * rec.item.dur — та же ссылка лежит в кэше, и следующая пуля видит уже
   * просевшую плиту. Ровно так же, как изнашивается надетая плита игрока.
   *
   * Одна запись на весь жилет: грудь и живот делят ОДИН экземпляр, потому что
   * это один предмет. Иначе жилет держал бы вдвое дольше, просто прикрывая две
   * зоны.
   */
  _synthetic(actor, zoneId, subZone) {
    let map = actor._armorZones
    if (!map) {
      map = Object.create(null)
      const arch = archetypeOf(actor)

      const body = typeof actor.armorClass === 'number' ? actor.armorClass : typeof actor.armor === 'number' ? actor.armor : 0
      if (body > 0) {
        const zones = bodyZones(actor, arch)
        if (zones.length > 0) {
          const plate = synthPlate(body, zones)
          for (let i = 0; i < zones.length; i++) map[zones[i]] = plate
        }
      }

      /*
       * Голова: явный helmetClass важнее всего, иначе выводим её из класса
       * корпуса через helmetDrop фракции — но только если фракция вообще носит
       * шлем. Скав с одной грудной пластиной остаётся с голой головой.
       */
      let head = typeof actor.helmetClass === 'number' ? actor.helmetClass : 0
      if (!(head > 0) && body > 0 && coversHead(actor, arch)) {
        head = body - helmetDropOf(actor, arch)
      }
      if (head > 0) map.head = synthPlate(head, ['head'], headSubZonesOf(actor))

      actor._armorZones = map
    }
    const rec = map[zoneId]
    if (!rec) return null
    if (!coversZone(rec.def, zoneId, subZone)) return null
    if (!(rec.item.dur > 0)) return null
    this._out.item = rec.item
    this._out.def = rec.def
    return this._out
  }

  /**
   * Плита, прикрывающая зону, или null.
   *
   * Обе ветки — надетое на игроке и синтетика бота — валидируют зону через
   * одну и ту же coversZone(def, zoneId, subZone) из core/anatomy.js, так что
   * подзоны шлема работают одинаково для игрока и для бота.
   *
   * @returns {{ item: object, def: object } | null} пуловая запись
   */
  resolve(actor, zoneId, subZone) {
    if (!actor) return null
    if (actor.isPlayer === true || actor.isLocalPlayer === true) return this._worn(zoneId, subZone)
    return this._synthetic(actor, zoneId, subZone)
  }

  dispose() {
    this.ctx = null
    this._out.item = null
    this._out.def = null
  }
}

export default ArmorResolver
