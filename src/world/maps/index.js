import buildCustoms, { customsMeta } from './customs.js'
import buildFactory, { factoryMeta } from './factory.js'
import buildWoods, { woodsMeta } from './woods.js'
import buildInterchange, { interchangeMeta } from './interchange.js'
import buildLab, { labMeta } from './lab.js'

/*
 * Реестр карт Escape from Larpov.
 *
 * Единственная точка входа для WorldSystem и UI выбора рейда.
 * Строго без побочных эффектов на импорте: только таблицы и чистые функции.
 */

/* Таблица билдеров: id карты -> функция построения. */
const BUILDERS = {
	customs: buildCustoms,
	factory: buildFactory,
	woods: buildWoods,
	interchange: buildInterchange,
	lab: buildLab,
}

/* Таблица метаданных: id карты -> meta из файла карты. */
const META = {
	customs: customsMeta,
	factory: factoryMeta,
	woods: woodsMeta,
	interchange: interchangeMeta,
	lab: labMeta,
}

/*
 * Порядок показа в меню рейда и порядок прогрессии по уровню.
 * Таможня идёт первой: minLevel 1, стартовая локация без карты доступа.
 * Завод сразу за ней: тоже minLevel 1, но короткий рейд на 20 минут.
 */
const ORDER = ['customs', 'factory', 'woods', 'interchange', 'lab']

export const MAP_IDS = ORDER.slice()
export const MAP_META = META
export const MAP_BUILDERS = BUILDERS

/* Карта зарегистрирована только если есть и id в таблице, и вызываемый билдер. */
export function hasMap(id) {
	if (typeof id !== 'string' || id === '') return false
	if (!Object.prototype.hasOwnProperty.call(BUILDERS, id)) return false
	return typeof BUILDERS[id] === 'function'
}

export function getMapMeta(id) {
	if (typeof id !== 'string' || id === '') return null
	return META[id] || null
}

/* Лёгкий список для UI: ничего не строит, только метаданные. */
export function listMaps() {
	const out = []
	for (let i = 0; i < ORDER.length; i++) {
		const id = ORDER[i]
		const m = META[id]
		if (!m) continue
		if (!hasMap(id)) continue
		out.push({
			id: id,
			name: m.name || id,
			size: m.size,
			duration: m.duration,
			minLevel: m.minLevel === undefined ? 1 : m.minLevel,
			needCard: m.needCard || null,
			lootCount: m.lootCount === undefined ? 0 : m.lootCount,
			bots: m.bots,
		})
	}
	return out
}

/* Карты, доступные на данном уровне и с учётом карты доступа в инвентаре. */
export function availableMaps(level, hasCard) {
	const lvl = Number.isFinite(level) ? level : 1
	const check = typeof hasCard === 'function' ? hasCard : null
	const out = []
	const all = listMaps()
	for (let i = 0; i < all.length; i++) {
		const m = all[i]
		if (m.minLevel > lvl) continue
		if (m.needCard && !(check && check(m.needCard))) continue
		out.push(m)
	}
	return out
}

export function nextMapId(id) {
	const i = ORDER.indexOf(id)
	if (i < 0 || i + 1 >= ORDER.length) return ORDER[0]
	return ORDER[i + 1]
}

/*
 * Главная точка входа.
 *
 * buildMap('customs', world, ctx, { night: true, rng })
 * Возвращает дескриптор карты из MapKit.finalize() с добавленным meta.
 */
export function buildMap(id, world, ctx, opts) {
	const fn = BUILDERS[id]
	if (typeof fn !== 'function') {
		const known = ORDER.join(', ')
		throw new Error('[maps] неизвестная карта "' + id + '". Доступны: ' + known)
	}
	const map = fn(world, ctx, opts || {})
	if (map && !map.meta) map.meta = META[id] || null
	return map
}

/* Подключение новой карты без правки этого файла. */
export function registerMap(meta, builder) {
	if (!meta || !meta.id) throw new Error('[maps] registerMap: в meta нет поля id')
	if (typeof builder !== 'function') throw new Error('[maps] registerMap: builder не функция')
	BUILDERS[meta.id] = builder
	META[meta.id] = meta
	if (ORDER.indexOf(meta.id) < 0) {
		ORDER.push(meta.id)
		MAP_IDS.push(meta.id)
	}
	return meta.id
}

/*
 * Снос карты между рейдами.
 * Диспозятся только собственные ресурсы кита: материалы с owFallback / owCloned
 * и геометрия его пула. Материалы из подсистемы materials не трогаются.
 */
export function disposeMap(map) {
	if (!map) return

	const group = map.group || map.root
	if (group) {
		if (group.parent) group.parent.remove(group)
		group.traverse(function visit(o) {
			if (o.isInstancedMesh && o.instanceMatrix) o.instanceMatrix.array = null
			if (o.isLight && typeof o.dispose === 'function') o.dispose()
		})
		group.clear()
	}

	const mats = map.materials
	if (mats) {
		for (let i = 0; i < mats.length; i++) {
			const m = mats[i]
			if (!m || typeof m.dispose !== 'function') continue
			if (m.userData && (m.userData.owFallback || m.userData.owCloned)) m.dispose()
		}
		mats.length = 0
	}

	const geos = map.geometries
	if (geos) {
		for (let i = 0; i < geos.length; i++) {
			const g = geos[i]
			if (g && typeof g.dispose === 'function') g.dispose()
		}
		geos.length = 0
	}

	if (map.colliders) map.colliders.length = 0
	if (map.lootSpots) map.lootSpots.length = 0
	if (map.doors) map.doors.length = 0
	if (map.exits) map.exits.length = 0
	if (map.lights) map.lights.length = 0
	map.navGrid = null
}

/*
 * Детерминированный выбор точки спавна без аллокаций:
 * результат копируется в переданный out.
 */
export function pickSpawn(map, kind, rng, out) {
	if (!map || !map.spawnZones) return false
	const list = map.spawnZones[kind]
	if (!list || list.length === 0) return false
	const r = typeof rng === 'function' ? rng() : 0
	let i = (r * list.length) | 0
	if (i >= list.length) i = list.length - 1
	const v = list[i]
	if (!out) return true
	out.set(v.x, v.y, v.z)
	return true
}

export default {
	MAP_IDS: MAP_IDS,
	MAP_META: MAP_META,
	MAP_BUILDERS: MAP_BUILDERS,
	hasMap: hasMap,
	getMapMeta: getMapMeta,
	listMaps: listMaps,
	availableMaps: availableMaps,
	nextMapId: nextMapId,
	buildMap: buildMap,
	registerMap: registerMap,
	disposeMap: disposeMap,
	pickSpawn: pickSpawn,
}
