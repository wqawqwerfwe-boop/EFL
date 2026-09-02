import { MapKit, normalizeBuildArgs, makeRng } from './_kit.js'

/*
 * Escape from Larpov — карта «Завод» (factory).
 *
 * Композиция:
 *   1. Главный производственный цех 64 x 48 x 16. Два яруса железных
 *      галерей на Y=6 и Y=12, кластеры морских контейнеров, стояки ржавых
 *      труб, кучи строительного мусора и станочные основания.
 *   2. Трёхэтажка стоит внутри цеха: вложенный цикл по трём этажам и
 *      четырём фасадам, узкий коридор третьего этажа с ломаемыми офисными
 *      дверями, слоистые перегородки гипсокартон + бетон и простреливаемое
 *      остекление, из которого простреливается весь пол цеха.
 *   3. Подземка: матрица из четырёх сбоек ниже Y=-3, сетка аварийных ламп
 *      с чередованием красного и синего и затопленные токсичной водой
 *      нижние точки.
 *
 * Вся геометрия строится один раз в конструкционных циклах и уезжает в
 * InstancedMesh на kit.finalize(). Math.random() не используется нигде:
 * только kit.rng и позиционный хеш wear().
 */

const SIZE = 96
const HALF = SIZE * 0.5

/* Главный производственный цех */
const HALL_W = 64
const HALL_D = 48
const HALL_H = 16
const HALL_HW = HALL_W * 0.5
const HALL_HD = HALL_D * 0.5

/* Ярусы железных галерей */
const GANTRY_LOW = 6
const GANTRY_HIGH = 12

/* Трёхэтажка */
const OFF_X = 17
const OFF_Z = -13
const OFF_W = 26
const OFF_D = 15
const OFF_HW = OFF_W * 0.5
const OFF_HD = OFF_D * 0.5
const OFF_FLOORS = 3
const FLOOR_H = 3.4
const OFF_T = 0.36
const OFF_TOP = OFF_FLOORS * FLOOR_H

/* Подземка: пол ниже Y=-3, потолок под плитой цеха */
const TUN_FLOOR = -4.4
const TUN_CEIL = -1.1

/* Потолок реальных источников света. Корпуса ламп рисуются всегда. */
const LIGHT_CAP = 22

/*
 * В _kit.js нет ключей metal_rust и concrete_worn: ни MATERIAL_SURFACE, ни
 * FALLBACK_PBR о них не знают, и resolveMaterial молча отдал бы серый бетон
 * с бетонной баллистикой вместо металла. Семантические имена из ТЗ привязаны
 * к реально существующим ключам кита.
 */
const METAL_RUST = 'rust'
const CONCRETE_WORN = 'concrete'

/* Лестницы износа: чем выше индекс, тем сильнее съедена поверхность. */
const WEAR_IRON = ['metal', 'corrugated', 'rust']
const WEAR_CONCRETE = ['concrete', 'kerb', 'brick']
const WEAR_DRYWALL = ['wall', 'plaster', 'concrete']

/* Забор по периметру: [x1, z1, x2, z2]. Разрывы — проёмы под ворота. */
const FENCE = [
	[-HALF, -HALF, HALF, -HALF],
	[-HALF, HALF, -10, HALF],
	[2, HALF, HALF, HALF],
	[-HALF, -HALF, -HALF, HALF],
	[HALF, -HALF, HALF, -5],
	[HALF, 6, HALF, HALF]
]

/* Стены цеха: [x1, z1, x2, z2]. Разрывы — въезды в цех. */
const HALL_WALLS = [
	[-HALL_HW, -HALL_HD, -6, -HALL_HD],
	[6, -HALL_HD, HALL_HW, -HALL_HD],
	[-HALL_HW, HALL_HD, -9, HALL_HD],
	[1, HALL_HD, HALL_HW, HALL_HD],
	[-HALL_HW, -HALL_HD, -HALL_HW, 6],
	[-HALL_HW, 14, -HALL_HW, HALL_HD],
	[HALL_HW, -HALL_HD, HALL_HW, -5],
	[HALL_HW, 5, HALL_HW, HALL_HD]
]

/* Нижний ярус галерей: [x1, z1, x2, z2, ширина, перила слева, перила справа] */
const GANTRY_LOW_RUNS = [
	[-29, -21, -29, 21, 3, true, true],
	[-29, 21, 29, 21, 3, true, true],
	[29, 21, 29, -21, 3, true, true],
	[-27, -2, 3, -2, 2.4, true, true],
	[-29, -21, -12, -21, 2.4, true, true]
]

/* Верхний ярус галерей: [x1, z1, x2, z2, ширина, перила слева, перила справа] */
const GANTRY_HIGH_RUNS = [
	[-30, -22, 30, -22, 2.6, true, true],
	[-30, 22, 30, 22, 2.6, true, true],
	[-20, -22, -20, 22, 2.2, true, true],
	[20, -22, 20, 22, 2.2, true, true]
]

/* Лестничные марши: [x, z, yaw, снизу, сверху, ширина] */
const STAIRS = [
	[-29, -14, 1.5708, 0, GANTRY_LOW, 1.6],
	[26, 21, 3.14159, 0, GANTRY_LOW, 1.6],
	[-29, 14, 4.71239, GANTRY_LOW, GANTRY_HIGH, 1.4],
	[26, -21, 0, GANTRY_LOW, GANTRY_HIGH, 1.4],
	[6, -5, 4.71239, OFF_TOP, GANTRY_HIGH, 1.4]
]

/* Кластеры контейнеров: [x, z, yaw, ярусов] */
const CONTAINERS = [
	[-24, -15, 0, 2],
	[-24, -9, 0, 1],
	[-17, -15, 0, 1],
	[-22, 12, 1.5708, 2],
	[-16, 12, 1.5708, 1],
	[-4, 17, 0, 1],
	[3, 17, 0, 2],
	[14, 8, 0, 1],
	[21, 8, 0, 2],
	[26, 15, 1.5708, 1],
	[-40, 18, 0, 2],
	[-40, 24, 0, 1],
	[40, -18, 1.5708, 1],
	[40, -11, 1.5708, 2],
	[-42, -30, 0.7854, 1],
	[36, 34, 2.35619, 1]
]

/* Стояки ржавых труб: [x, z, радиус, высота] */
const RISERS = [
	[-31, -22, 0.34, 15],
	[-31, -8, 0.28, 15],
	[-31, 8, 0.34, 15],
	[-31, 22, 0.28, 15],
	[31, -22, 0.34, 15],
	[31, -14, 0.28, 15],
	[31, 14, 0.34, 15],
	[31, 22, 0.28, 15],
	[-9, 23, 0.3, 15],
	[9, 23, 0.3, 15],
	[-20, -23, 0.26, 15],
	[-2, -23, 0.26, 15]
]

/* Кучи мусора: [x, z, радиус, количество, зерно] */
const DEBRIS = [
	[-14, 3, 3.2, 15, 1.7],
	[6, -2, 2.6, 12, 4.1],
	[-26, 19, 2.4, 10, 8.3],
	[24, -1, 3, 14, 2.9],
	[-6, 10, 2.2, 9, 6.2],
	[12, 20, 2.8, 13, 3.3],
	[-30, -18, 2, 8, 9.4],
	[30, 30, 2.6, 11, 5.5],
	[-38, 6, 2.4, 10, 7.1]
]

/* Станочные основания цеха: [x, z, ширина, глубина, высота, yaw] */
const MACHINES = [
	[-20, 0, 3.4, 2.2, 1.5, 0],
	[-13, 0, 3.4, 2.2, 1.5, 0],
	[-6, 0, 3.4, 2.2, 1.5, 0],
	[-20, 7, 3.4, 2.2, 1.2, 0],
	[-13, 7, 3.4, 2.2, 1.2, 0],
	[-6, 7, 3.4, 2.2, 1.2, 0],
	[16, -2, 2.6, 2.6, 1.8, 0.7854],
	[24, 6, 2.6, 2.6, 1.8, 0.7854],
	[-27, -6, 2.2, 4.4, 1.4, 0],
	[27, -18, 2.2, 4.4, 1.4, 0]
]

/* Сбойки подземки: [x1, z1, x2, z2, ширина, затоплена] */
const TUNNELS = [
	[-26, 4, 26, 4, 5.4, false],
	[-18, 4, -18, 20, 4.6, true],
	[18, 4, 18, 20, 4.6, false],
	[-18, 20, 18, 20, 4.6, true]
]

/* Шахты спуска в подземку: [x, z, yaw] */
const SHAFTS = [
	[-26, 4, 1.5708],
	[26, 4, 4.71239],
	[0, 20, 0]
]

/* Светильники цеха: [x, z] */
const HALL_LIGHTS = [
	[-22, -16],
	[-22, 8],
	[0, 16],
	[22, 14],
	[-6, -8],
	[26, -20]
]

/* Лут цеха и двора: [тип, x, y, z, множитель] */
const LOOT_HALL = [
	['crate', -27, 0, -20, 1],
	['tool', -21, 0, -3, 1.2],
	['crate', -12, 0, 6, 1],
	['med', -3, 0, 13, 1.1],
	['gun', 8, 0, -6, 1.4],
	['crate', 19, 0, 19, 1],
	['tool', 27, 0, 3, 1.2],
	['jacket', -30, 0, 12, 1],
	['crate', 30, 0, -8, 1],
	['med', -16, 0, 22, 1.1],
	['crate', -29, 6, 0, 1.3],
	['tool', 29, 6, 6, 1.3],
	['crate', 0, 12, 22, 1.5],
	['jacket', -38, 0, 26, 1],
	['crate', 40, 0, 26, 1],
	['tool', -42, 0, -26, 1.1],
	['med', 42, 0, -34, 1.1],
	['crate', -34, 0, 41, 1],
	['gun', 34, 0, 42, 1.2]
]

/* Лут трёхэтажки: третий этаж заметно богаче */
const LOOT_OFFICE = [
	['crate', 9, 0.24, -17, 1],
	['tool', 24, 0.24, -9, 1.1],
	['jacket', 11, 3.64, -16, 1.4],
	['med', 22, 3.64, -10, 1.3],
	['crate', 15, 3.64, -17, 1.2],
	['safe', 12, 7.04, -16.5, 2.6],
	['jacket', 9, 7.04, -16.5, 2.2],
	['jacket', 20, 7.04, -16.5, 2.2],
	['gun', 24, 7.04, -9.5, 2.4],
	['med', 15, 7.04, -9.5, 1.8],
	['tool', 27, 7.04, -16.5, 1.6]
]

/* Лут подземки: [тип, x, z, множитель] */
const LOOT_TUNNEL = [
	['crate', -22, 4, 1.2],
	['med', -18, 11, 1.5],
	['tool', -18, 18, 1.3],
	['crate', -8, 4, 1.2],
	['gun', 6, 4, 1.6],
	['crate', 18, 9, 1.2],
	['safe', 18, 18, 2.1],
	['med', 2, 20, 1.4],
	['jacket', -10, 20, 1.3]
]

/* Спавны по ролям Таркова: [x, y, z] */
const SPAWN_PMC = [
	[-42, 0, -42],
	[42, 0, -42],
	[-42, 0, 42],
	[42, 0, 42],
	[0, 0, -42],
	[0, 0, 43]
]

const SPAWN_SCAV = [
	[-40, 0, 0],
	[40, 0, 0],
	[-20, 0, 36],
	[20, 0, 36],
	[-36, 0, -20],
	[36, 0, -30]
]

/* Рейдеры сидят в подземке, штурмуют цех снизу */
const SPAWN_RAIDER = [
	[-24, TUN_FLOOR + 0.1, 4],
	[24, TUN_FLOOR + 0.1, 4],
	[-18, TUN_FLOOR + 0.1, 18],
	[18, TUN_FLOOR + 0.1, 18],
	[0, TUN_FLOOR + 0.1, 20]
]

/* ЧВК-боты держат галереи и третий этаж */
const SPAWN_PMCBOT = [
	[-29, GANTRY_LOW, -18],
	[29, GANTRY_LOW, 18],
	[-20, GANTRY_HIGH, 0],
	[12, OFF_TOP - FLOOR_H + 0.3, -16]
]

/* Тагилла — босс Завода, спавнится в главном цеху */
const SPAWN_BOSS = [
	[-8, 0, 8],
	[10, 0, 14]
]

/* Общий пул для систем, которые знают только kind = 'bot' */
const SPAWN_BOT = [
	[-30, 0, -20],
	[30, 0, -20],
	[-30, 0, 20],
	[30, 0, 20],
	[0, 0, -20],
	[0, 0, 20],
	[-20, 0, 0],
	[20, 0, 0],
	[-44, 0, 8],
	[44, 0, -8],
	[8, 0, 44],
	[-8, 0, -44]
]

const EXITS = [
	{ id: 'factory:gate3', name: 'Ворота 3', x: 44, z: 0.5, radius: 3.6, needKey: 'key_factory_gate3', noBotsNear: 14, note: 'Бронированные ворота. Нужен ключ от Ворот 3.' },
	{ id: 'factory:gate0', name: 'Ворота 0', x: -4, z: 44, radius: 3.6, needKey: 'key_factory_gate0', note: 'Бронированные ворота. Нужен ключ от Ворот 0.' },
	{ id: 'factory:cellar', name: 'Затопленный подвал', x: -18, y: TUN_FLOOR, z: 12, radius: 3, faction: 'scav', marker: false, note: 'Люк в затопленной сбойке. Только за Дикого.' },
	{ id: 'factory:medtent', name: 'Медпалатка', x: -34, z: 40, radius: 3.2, freeHands: true, note: 'Пролезть под тентом можно только с пустыми руками.' },
	{ id: 'factory:office', name: 'Окно кабинета', x: 42, z: -42, radius: 3, afterSec: 600, note: 'Открыт в последние 10 минут рейда.' },
	{ id: 'factory:transfer', name: 'Переход на Таможню', x: -44, z: -40, radius: 3.4, transfer: 'customs', cost: 4000, note: 'Платный переход в соседнюю локацию.' }
]

/* Детерминированный позиционный шум: один и тот же куб — один и тот же износ. */
function hashNoise(x, y, z) {
	const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
	return s - Math.floor(s)
}

/* Выбор материала по лестнице износа со смещением bias в сторону старения. */
function wear(ladder, x, y, z, bias) {
	const b = bias === undefined ? 0 : bias
	let i = Math.floor((hashNoise(x, y, z) * 0.999 + b) * ladder.length)
	if (i < 0) i = 0
	if (i >= ladder.length) i = ladder.length - 1
	return ladder[i]
}

/* Перила: две нитки трубы и стойки через каждые 2.2 м. */
function railing(kit, x1, z1, x2, z2, y) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 0.6) return
	const yaw = Math.atan2(dx, dz)
	const cx = x1 + dx * 0.5
	const cz = z1 + dz * 0.5
	kit.box('rail', cx, y + 1.04, cz, 0.08, 0.08, len, yaw, 'decor')
	kit.box('rail', cx, y + 0.58, cz, 0.06, 0.06, len, yaw, 'decor')
	const posts = Math.max(2, Math.round(len / 2.2))
	for (let i = 0; i <= posts; i++) {
		const t = i / posts
		kit.box('metal', x1 + dx * t, y + 0.55, z1 + dz * t, 0.1, 1.1, 0.1, yaw, 'decor')
	}
}

/*
 * Секция галереи: настил, два продольных швеллера, поперечины и опоры.
 * support = 'floor' — стойки до пола, 'roof' — подвесы до фермы кровли.
 */
function gantry(kit, x1, z1, x2, z2, y, width, railLeft, railRight, support) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 1) return
	const yaw = Math.atan2(dx, dz)
	const cx = x1 + dx * 0.5
	const cz = z1 + dz * 0.5
	const nx = dz / len
	const nz = -dx / len
	const hw = width * 0.5
	kit.box(wear(WEAR_IRON, cx, y, cz, 0.12), cx, y, cz, width, 0.22, len, yaw, 'roof')
	kit.box('metal', cx + nx * hw, y - 0.3, cz + nz * hw, 0.16, 0.5, len, yaw, 'decor')
	kit.box('metal', cx - nx * hw, y - 0.3, cz - nz * hw, 0.16, 0.5, len, yaw, 'decor')
	const bays = Math.max(2, Math.round(len / 4))
	for (let i = 0; i <= bays; i++) {
		const t = i / bays
		const px = x1 + dx * t
		const pz = z1 + dz * t
		kit.box('metal', px, y - 0.42, pz, width + 0.24, 0.2, 0.22, yaw, 'decor')
		if (support === 'floor') {
			kit.box(wear(WEAR_IRON, px, y, pz, 0.2), px, y * 0.5, pz, 0.24, y - 0.5, 0.24, yaw, 'column')
		} else if (support === 'roof') {
			kit.box('metal', px, (y + HALL_H) * 0.5, pz, 0.12, HALL_H - y, 0.12, yaw, 'decor')
		}
	}
	if (railLeft) railing(kit, x1 + nx * hw, z1 + nz * hw, x2 + nx * hw, z2 + nz * hw, y)
	if (railRight) railing(kit, x1 - nx * hw, z1 - nz * hw, x2 - nx * hw, z2 - nz * hw, y)
}

/* Марш лестницы со ступенями, косоуром, верхней площадкой и перилом. */
function stairFlight(kit, x, z, yaw, yFrom, yTo, width) {
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const steps = Math.max(4, Math.round(Math.abs(yTo - yFrom) / 0.24))
	const rise = (yTo - yFrom) / steps
	const tread = 0.36
	for (let i = 0; i < steps; i++) {
		const t = (i + 0.5) * tread
		const y = yFrom + rise * (i + 0.5)
		kit.box('metal', x + dirX * t, y, z + dirZ * t, width, Math.abs(rise) + 0.08, tread, yaw, 'floor')
	}
	const runLen = steps * tread
	const midY = yFrom + (yTo - yFrom) * 0.5
	kit.box('metal', x + dirX * runLen * 0.5, midY - 0.3, z + dirZ * runLen * 0.5, width + 0.16, 0.18, runLen, yaw, 'decor')
	kit.box(wear(WEAR_IRON, x, yTo, z, 0.15), x + dirX * (runLen + 0.8), yTo, z + dirZ * (runLen + 0.8), width + 0.4, 0.2, 1.6, yaw, 'roof')
	const nx = dirZ * width * 0.5
	const nz = -dirX * width * 0.5
	railing(kit, x + nx, z + nz, x + dirX * runLen + nx, z + dirZ * runLen + nz, midY)
}

/* Морской контейнер с рёбрами жёсткости, при tiers > 1 — штабелем. */
function containerStack(kit, x, z, yaw, tiers) {
	const cs = Math.cos(yaw)
	const sn = Math.sin(yaw)
	kit.box('rust', x, 0.06, z, 6.2, 0.12, 2.6, yaw, 'floor')
	for (let t = 0; t < tiers; t++) {
		const y = 1.26 + t * 2.62
		const key = wear(WEAR_IRON, x, y, z, 0.3)
		kit.box(key, x, y, z, 6.06, 2.5, 2.44, yaw, 'container')
		kit.box('corrugated', x, y + 1.32, z, 6.16, 0.14, 2.54, yaw, 'roof')
		for (let r = -2; r <= 2; r++) {
			const ox = r * 1.18
			kit.box(key, x + cs * ox, y, z - sn * ox, 0.1, 2.42, 2.5, yaw, 'decor')
		}
	}
}

/* Куча мусора по золотому углу: к краю обломки мельчают. */
function debrisPile(kit, cx, cz, radius, count, seed, baseY) {
	for (let i = 0; i < count; i++) {
		const a = i * 2.39996 + seed
		const r = radius * Math.sqrt((i + 0.6) / count)
		const x = cx + Math.cos(a) * r
		const z = cz + Math.sin(a) * r
		const falloff = 1 - r / (radius + 0.01)
		const h = 0.16 + hashNoise(x, seed, z) * 0.85 * falloff
		const w = 0.4 + hashNoise(z, seed + 3.1, x) * 1.15
		kit.box(wear(WEAR_CONCRETE, x, h, z, 0.12), x, baseY + h * 0.5, z, w, h, w * 0.75, a, 'debris')
	}
}

/*
 * Светильник. Корпус и линза рисуются всегда и стоят одну инстанцию,
 * реальный PointLight создаётся только пока не выбран бюджет.
 * hz > 0 добавляет запись в map.flickerLights для мерцания в рантайме.
 */
function lampFixture(kit, state, x, y, z, color, power, range, hz) {
	kit.box('metal', x, y + 0.17, z, 0.46, 0.14, 0.34, 0, 'decor')
	kit.box('lamp', x, y, z, 0.36, 0.16, 0.26, 0, 'decor')
	if (state.used >= state.budget) return null
	state.used++
	const light = kit.lamp(x, y, z, color, power, range)
	if (light && hz > 0) {
		const phase = state.used * 0.618034
		state.flicker.push({ light: light, hz: hz, min: power * 0.18, max: power, phase: phase })
		if (light.userData) light.userData.flicker = { hz: hz, min: power * 0.18, max: power, phase: phase }
	}
	return light
}

/* Ленточное остекление: панели с металлическими импостами. */
function windowBand(kit, cx, cy, cz, len, yaw, height, thickness) {
	const panes = Math.max(2, Math.round(len / 2.6))
	const step = len / panes
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	for (let i = 0; i < panes; i++) {
		const t = -len * 0.5 + step * (i + 0.5)
		kit.box('glass', cx + dirX * t, cy, cz + dirZ * t, thickness, height, step - 0.18, yaw, 'glass')
	}
	for (let i = 0; i <= panes; i++) {
		const t = -len * 0.5 + step * i
		kit.box('metal', cx + dirX * t, cy, cz + dirZ * t, thickness + 0.08, height + 0.08, 0.18, yaw, 'decor')
	}
}

/* Трёхслойная стена цеха: бетонный цоколь, профлист, вертикальные рёбра. */
function hallWall(kit, x1, z1, x2, z2, h) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 0.4) return
	const yaw = Math.atan2(dx, dz)
	const cx = x1 + dx * 0.5
	const cz = z1 + dz * 0.5
	kit.box(wear(WEAR_CONCRETE, cx, 1.5, cz, 0.05), cx, 1.5, cz, 0.7, 3, len, yaw, 'wall')
	kit.box(wear(WEAR_IRON, cx, h, cz, 0.3), cx, 3 + (h - 3) * 0.5, cz, 0.44, h - 3, len, yaw, 'wall')
	const ribs = Math.max(2, Math.round(len / 4))
	for (let i = 0; i <= ribs; i++) {
		const t = i / ribs
		kit.box('metal', x1 + dx * t, h * 0.5, z1 + dz * t, 0.58, h, 0.28, yaw, 'decor')
	}
}

/* Бронированные ворота: рама, направляющая, створка на ключе. */
function armoredGate(kit, x, z, yaw, width, name, keyId) {
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const hw = width * 0.5
	kit.box(CONCRETE_WORN, x + dirX * (hw + 0.5), 2.6, z + dirZ * (hw + 0.5), 1.2, 5.2, 1, yaw, 'wall')
	kit.box(CONCRETE_WORN, x - dirX * (hw + 0.5), 2.6, z - dirZ * (hw + 0.5), 1.2, 5.2, 1, yaw, 'wall')
	kit.box(METAL_RUST, x, 4.6, z, 0.6, 1.2, width + 2, yaw, 'wall')
	kit.box('rail', x, 3.9, z, 0.24, 0.24, width + 1.6, yaw, 'decor')
	kit.box(METAL_RUST, x, 2.75, z, 0.5, 1.3, width, yaw, 'wall')
	const door = kit.door(x, 0, z, yaw, width, name, keyId)
	door.armored = true
	door.breakable = false
	door.hp = 1200
	return door
}

export const factoryMeta = {
	id: 'factory',
	name: 'Завод',
	size: SIZE,
	duration: 20 * 60,
	minLevel: 1,
	lightBudget: 24,
	lootCount: LOOT_HALL.length + LOOT_OFFICE.length + LOOT_TUNNEL.length,
	lootRich: 1.35,
	indoor: true,
	bots: { scav: [6, 9], raider: [1, 3], pmcbot: [1, 2], boss: [0, 1] }
}

export function buildFactory(world, ctx, opts) {
	const a = normalizeBuildArgs(world, ctx, opts)
	const night = !!(a.opts && a.opts.night)
	const kit = new MapKit(a.world, a.ctx, {
		id: 'factory',
		name: 'Завод',
		size: SIZE,
		night: night,
		duration: factoryMeta.duration,
		lightBudget: factoryMeta.lightBudget,
		rng: (a.opts && a.opts.rng) || makeRng(a.ctx, 'map:factory')
	})
	const state = { used: 0, budget: LIGHT_CAP, flicker: [] }

	/* Внутри цеха всегда сумрак: плотный холодный туман, солнце почти не работает. */
	kit.setFog(night ? 0x090c0f : 0x1b1f22, night ? 0.024 : 0.016)
	kit.setAmbient({
		color: night ? 0x1b2430 : 0x2f373c,
		intensity: night ? 0.16 : 0.34,
		sunColor: night ? 0x5c7093 : 0xd8e3ea,
		sunIntensity: night ? 0.05 : 0.22,
		sunPosition: [40, 110, -30],
		indoor: true
	})

	/* Плита двора и бетонный пол цеха */
	kit.ground('asphalt')
	kit.box(CONCRETE_WORN, 0, 0.05, 0, HALL_W, 0.1, HALL_D, 0, 'floor')
	for (let i = 0; i < 8; i++) {
		const x = -28 + i * 8
		kit.box(wear(WEAR_CONCRETE, x, 0.07, 0, 0.2), x, 0.07, 0, 7.4, 0.04, HALL_D - 3, 0, 'floor')
	}

	/* Забор по периметру с проёмами под ворота */
	for (let i = 0; i < FENCE.length; i++) {
		const f = FENCE[i]
		const dx = f[2] - f[0]
		const dz = f[3] - f[1]
		const len = Math.sqrt(dx * dx + dz * dz)
		const yaw = Math.atan2(dx, dz)
		kit.box('corrugated', f[0] + dx * 0.5, 3, f[1] + dz * 0.5, 0.5, 6, len, yaw, 'wall')
		const posts = Math.max(2, Math.round(len / 6))
		for (let p = 0; p <= posts; p++) {
			const t = p / posts
			kit.box('metal', f[0] + dx * t, 3.1, f[1] + dz * t, 0.34, 6.4, 0.34, yaw, 'decor')
		}
	}

	/* Бронированные ворота на выходах */
	armoredGate(kit, HALF - 0.4, 0.5, 0, 10, 'Ворота 3', 'key_factory_gate3')
	armoredGate(kit, -4, HALF - 0.4, 1.5708, 11, 'Ворота 0', 'key_factory_gate0')

	/* Стены главного цеха */
	for (let i = 0; i < HALL_WALLS.length; i++) {
		const w = HALL_WALLS[i]
		hallWall(kit, w[0], w[1], w[2], w[3], HALL_H)
	}

	/* Кровля, фермы и световые фонари */
	kit.box('corrugated', 0, HALL_H + 0.35, 0, HALL_W + 2.4, 0.5, HALL_D + 2.4, 0, 'roof')
	for (let i = 0; i < 9; i++) {
		const x = -28 + i * 7
		kit.box('metal', x, HALL_H - 0.7, 0, 0.34, 0.9, HALL_D, 0, 'decor')
		kit.box('metal', x, HALL_H - 1.6, 0, 0.22, 0.9, HALL_D - 6, 0, 'decor')
		if (i % 2 === 1) kit.box('glass', x, HALL_H + 0.1, 0, 2.6, 0.14, HALL_D - 10, 0, 'glass')
	}
	for (let i = 0; i < 5; i++) {
		const z = -20 + i * 10
		kit.box('metal', 0, HALL_H - 1.15, z, HALL_W, 0.26, 0.26, 0, 'decor')
	}

	/* Несущие колонны цеха, кроме пятна под трёхэтажкой */
	for (let ix = -1; ix <= 2; ix++) {
		for (let iz = -1; iz <= 1; iz++) {
			const x = ix * 16 - 8
			const z = iz * 16
			const insideOffice = x > OFF_X - OFF_HW - 1 && x < OFF_X + OFF_HW + 1 && z > OFF_Z - OFF_HD - 1 && z < OFF_Z + OFF_HD + 1
			if (insideOffice) continue
			kit.box(CONCRETE_WORN, x, HALL_H * 0.5, z, 1.1, HALL_H, 1.1, 0, 'column')
			kit.box(wear(WEAR_CONCRETE, x, 0.5, z, 0.25), x, 0.45, z, 1.7, 0.9, 1.7, 0, 'column')
			kit.box('metal', x, HALL_H - 0.9, z, 1.6, 0.3, 1.6, 0, 'decor')
		}
	}

	/* Нижний ярус галерей на Y=6, опоры до пола */
	for (let i = 0; i < GANTRY_LOW_RUNS.length; i++) {
		const g = GANTRY_LOW_RUNS[i]
		gantry(kit, g[0], g[1], g[2], g[3], GANTRY_LOW, g[4], g[5], g[6], 'floor')
	}

	/* Верхний ярус галерей на Y=12, подвесы к кровле */
	for (let i = 0; i < GANTRY_HIGH_RUNS.length; i++) {
		const g = GANTRY_HIGH_RUNS[i]
		gantry(kit, g[0], g[1], g[2], g[3], GANTRY_HIGH, g[4], g[5], g[6], 'roof')
	}

	/* Лестничные марши между ярусами */
	for (let i = 0; i < STAIRS.length; i++) {
		const s = STAIRS[i]
		stairFlight(kit, s[0], s[1], s[2], s[3], s[4], s[5])
	}

	/* Кластеры контейнеров */
	for (let i = 0; i < CONTAINERS.length; i++) {
		const c = CONTAINERS[i]
		containerStack(kit, c[0], c[1], c[2], c[3])
	}

	/* Стояки ржавых труб и горизонтальные нитки под галереями */
	for (let i = 0; i < RISERS.length; i++) {
		const r = RISER