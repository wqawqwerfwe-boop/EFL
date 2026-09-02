import { MapKit, normalizeBuildArgs, makeRng } from './_kit.js'

/*
 * Customs (Tamozhnya) - the lane based tactical classic.
 *
 * 1. Dormitories: one parametric generator is instantiated twice, so the
 *    2-story and the 3-story blocks are completely separate structures
 *    with their own corridors, per-room doors and layered partitions.
 *    The top floor of the 3-story block carries the Marked Room:
 *    barricaded junk piles, indexed weapon spawns published through
 *    map.weaponSpawns, rich 2.5 loot and an external fire escape.
 * 2. Construction site: 4 level skeletal concrete framework in the
 *    middle of the map, open strip floors and exposed kit.cylinder rebar
 *    pillars that open long sightlines onto both bridges.
 * 3. Shipping terminal: algorithmic yard grid that scatters container
 *    stacks and industrial pallet stacks with aisles between them.
 *
 * NOTE: _kit.js has no 'metal_rust' / 'concrete_worn' material keys, and
 * per instance tinting is not exposed by kit.box either, so the semantic
 * names below are bound to real kit keys and container 'colors' are a
 * palette of real material keys.
 */

const SIZE = 150
const HALF = 75
const ROAD_Z = 0
const ROAD_W = 14
const DITCH_X = -40
const LIGHT_CAP = 10

const METAL_RUST = 'rust'
const CONCRETE_WORN = 'concrete'

const WEAR_CONC = ['concrete', 'kerb', 'brick']
const WEAR_IRON = ['metal', 'corrugated', 'rust']
const WEAR_BRICK = ['brick', 'plaster', 'wall']
const WEAR_DRY = ['wall', 'plaster', 'concrete']
/* container 'colors' - the kit has no per instance tint, so we vary keys */
const CRATE_PALETTE = ['rust', 'metal', 'corrugated', 'plastic', 'rubber', 'camo']

/* the two dorms: same generator, two very different buildings */
const DORM3 = { x: -16, z: -32, w: 34, d: 14, floors: 3, floorH: 3.2, rooms: 6, name: '3-этажка', marked: true, escape: true, keyId: 'key_dorm_305' }
const DORM2 = { x: 18, z: -38, w: 26, d: 13, floors: 2, floorH: 3.2, rooms: 5, name: '2-этажка', marked: false, escape: false, keyId: 'key_dorm_204' }

/* construction site */
const CS_X = -2
const CS_Z = -14
const CS_W = 30
const CS_D = 14
const CS_LEVELS = 4
const CS_H = 4

/* terminal yard grid */
const YARD_X = 26
const YARD_Z = 14
const YARD_COLS = 7
const YARD_ROWS = 5

const BUILDINGS = [
	{ x: -56, z: -16, w: 22, d: 12, h: 4.4, surf: 'concrete', t: 0.5, doorWidth: 2.6, name: 'Старая заправка', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'concrete', partitions: 2, lamp: true, lampColor: 0xffe6b8, lampIntensity: 0.55, lampRange: 18 },
	{ x: 52, z: -14, w: 20, d: 12, h: 4.4, surf: 'plaster', t: 0.45, doorWidth: 2.4, name: 'Новая заправка', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'concrete', partitions: 2, lamp: true, lampColor: 0xffe6b8, lampIntensity: 0.55, lampRange: 18 },
	{ x: -50, z: 26, w: 26, d: 16, h: 7, surf: 'corrugated', t: 0.5, doorWidth: 4.5, name: 'Склад 17', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'corrugated', partitions: 1, lamp: true, lampColor: 0xfff2d0, lampIntensity: 0.5, lampRange: 22 },
	{ x: -16, z: 30, w: 22, d: 14, h: 6.4, surf: 'corrugated', t: 0.5, doorWidth: 4, name: 'Склад 7', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'corrugated', partitions: 2, lamp: true, lampColor: 0xfff2d0, lampIntensity: 0.5, lampRange: 20 },
	{ x: 44, z: 48, w: 24, d: 14, h: 6.6, surf: 'metal', t: 0.5, doorWidth: 4.2, name: 'Портовый ангар', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'corrugated', partitions: 1, lamp: true, lampColor: 0xffe0a8, lampIntensity: 0.45, lampRange: 20 },
	{ x: 58, z: -46, w: 14, d: 10, h: 3.6, surf: 'brick', t: 0.4, doorWidth: 1.6, name: 'КПП военной базы', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'concrete', partitions: 1, lamp: true, lampColor: 0xfff0c8, lampIntensity: 0.45, lampRange: 12, keyId: 'key_customs_gate' },
	{ x: -58, z: 48, w: 9, d: 3.4, h: 2.9, surf: 'plastic', t: 0.25, doorWidth: 1, name: 'Трейлер 1', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'metal', partitions: 1, lamp: false },
	{ x: -58, z: 54, w: 9, d: 3.4, h: 2.9, surf: 'plastic', t: 0.25, doorWidth: 1, name: 'Трейлер 2', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'metal', partitions: 1, lamp: false },
	{ x: -47, z: 51, w: 9, d: 3.4, h: 2.9, surf: 'plastic', t: 0.25, doorWidth: 1, name: 'Трейлер 3', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'metal', partitions: 1, lamp: true, lampColor: 0xffd9a0, lampIntensity: 0.4, lampRange: 10 },
	{ x: -64, z: -50, w: 12, d: 9, h: 3.4, surf: 'brick', t: 0.4, doorWidth: 1.4, name: 'ЗБ-1011', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'concrete', partitions: 1, lamp: true, lampColor: 0xffdca0, lampIntensity: 0.4, lampRange: 12, keyId: 'key_customs_gate' },
	{ x: 8, z: 56, w: 12, d: 8, h: 3.2, surf: 'plank', t: 0.35, doorWidth: 1.3, name: 'Рыбацкая избушка', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'plank', partitions: 1, lamp: false }
]

/* street lamps along the lane: x z */
const STREET_LAMPS = [[-60, -8], [-40, 8], [-20, -8], [0, 8], [20, -8], [40, 8], [60, -8], [30, 30], [50, 20], [-50, 40]]

/* pallet stack seeds outside the yard grid: x z layers */
const PALLETS = [[-46, 18, 6], [-42, 22, 4], [-14, 22, 5], [-8, 26, 7], [40, 40, 6], [48, 36, 4], [-60, -22, 5], [46, -22, 4], [12, 46, 6], [-24, 46, 5]]

/* wrecked cars: x z yaw */
const CARS = [[-46, -4, 0.2], [-30, 4, 2.9], [-8, -3, 0.1], [10, 5, 3.05], [28, -4, 0.35], [46, 4, 2.8], [64, -3, 0.15], [-64, 3, 3.0], [-20, -18, 1.4], [22, -30, 1.9]]

const LOOT_GROUND = [['crate', -56, 0, -16, 1.2], ['med', -56, 0, -12, 1.3], ['crate', 52, 0, -14, 1.2], ['tool', 52, 0, -10, 1.2], ['crate', -50, 0, 26, 1.1], ['jacket', -50, 0, 30, 1.1], ['crate', -16, 0, 30, 1.1], ['tool', -16, 0, 34, 1.2], ['crate', 44, 0, 48, 1.1], ['gun', 44, 0, 52, 1.4], ['med', 58, 0, -46, 1.5], ['crate', -64, 0, -50, 1.4], ['jacket', -58, 0, 48, 1.2], ['crate', -58, 0, 54, 1.1], ['tool', -47, 0, 51, 1.2], ['crate', 8, 0, 56, 1.1], ['med', -30, 0, 4, 1], ['crate', 28, 0, -4, 1], ['jacket', -8, 0, -3, 1], ['crate', 64, 0, -3, 1]]
const LOOT_YARD = [['crate', 30, 18, 1.1], ['tool', 37, 26, 1.2], ['crate', 44, 34, 1.1], ['gun', 51, 22, 1.3], ['crate', 58, 30, 1.1], ['med', 65, 38, 1.2], ['crate', 33, 42, 1.1], ['jacket', 47, 46, 1.2], ['safe', 61, 14, 1.8], ['crate', 26, 30, 1.1]]
const LOOT_CS = [['crate', -12, 0.3, -14, 1.2], ['tool', 8, 0.3, -10, 1.3], ['crate', -6, 4.3, -18, 1.4], ['jacket', 4, 4.3, -12, 1.5], ['crate', -10, 8.3, -14, 1.6], ['gun', 6, 8.3, -16, 1.8], ['safe', 0, 12.3, -14, 2], ['med', -12, 12.3, -11, 1.6]]

const SPAWN_PMC = [[-70, 0, -60], [-70, 0, 60], [70, 0, -60], [70, 0, 62], [0, 0, 68], [-36, 0, 66], [36, 0, -66], [-4, 0, -68]]
const SPAWN_SCAV = [[-56, 0, -22], [52, 0, -20], [-50, 0, 34], [-16, 0, 38], [44, 0, 56], [58, 0, -52], [-58, 0, 60], [8, 0, 62], [26, 0, 22], [-30, 0, 10]]
const SPAWN_RAIDER = [[58, 0, -42], [62, 0, -50], [-64, 0, -46], [-60, 0, -54]]
const SPAWN_PMCBOT = [[-16, 6.4, -32], [18, 3.2, -38], [-2, 12.3, -14], [40, 0, 30]]
/* Reshala holds the gas stations */
const SPAWN_BOSS = [[-56, 0, -18], [52, 0, -16]]
const SPAWN_BOT = [[-60, 0, 0], [-40, 0, 12], [-20, 0, -6], [0, 0, 10], [20, 0, -6], [40, 0, 12], [60, 0, -6], [-30, 0, 30], [30, 0, 40], [-10, 0, 50], [10, 0, -50], [-46, 0, -34], [46, 0, 34], [66, 0, 10], [-66, 0, 20]]

const EXITS = [
	{ id: 'customs:ruaf', name: 'Блокпост ВС РФ', x: -71, z: 2, radius: 4, noBotsNear: 16, note: 'Западный выход вдоль дороги' },
	{ id: 'customs:crossroads', name: 'Перекрёсток', x: 71, z: -4, radius: 4, noBotsNear: 16, note: 'Восточный выход вдоль дороги' },
	{ id: 'customs:zb1011', name: 'ЗБ-1011', x: -64, z: -56, radius: 3.4, needKey: 'key_customs_gate', note: 'Бункер, нужен ключ' },
	{ id: 'customs:zb1012', name: 'ЗБ-1012', x: 66, z: -60, radius: 3.4, afterSec: 900, note: 'Открывается во второй половине рейда' },
	{ id: 'customs:trailer', name: 'Трейлерный парк', x: -58, z: 62, radius: 3.6, faction: 'scav', note: 'Только за Дикого' },
	{ id: 'customs:oldgas', name: 'Старая заправка', x: -56, z: -26, radius: 3.4, faction: 'scav', note: 'Только за Дикого' },
	{ id: 'customs:boat', name: 'Лодка контрабандистов', x: 20, z: 70, radius: 3.2, freeHands: true, note: 'Только с пустыми руками' },
	{ id: 'customs:dorms', name: 'Общаги (платный)', x: -16, z: -46, radius: 3.2, cost: 6000, note: 'Платный выход за общагами' },
	{ id: 'customs:emercom', name: 'Машина ЭМЕРКОМ', x: 40, z: -62, radius: 3.2, needKey: 'key_emercom', note: 'Нужен ключ ЭМЕРКОМ' },
	{ id: 'customs:transfer', name: 'Переход на Развязку', x: 71, z: 40, radius: 3.6, transfer: 'interchange', cost: 5000, note: 'Платный переход' }
]

function hashNoise(x, y, z) {
	const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
	return s - Math.floor(s)
}

function wear(ladder, x, y, z, bias) {
	const b = bias === undefined ? 0 : bias
	let i = Math.floor((hashNoise(x, y, z) * 0.999 + b) * ladder.length)
	if (i < 0) i = 0
	if (i >= ladder.length) i = ladder.length - 1
	return ladder[i]
}

function railing(kit, x1, z1, x2, z2, y) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 0.6) return
	const yaw = Math.atan2(dx, dz)
	kit.box('rail', x1 + dx * 0.5, y + 1.04, z1 + dz * 0.5, 0.08, 0.08, len, yaw, 'decor')
	kit.box('rail', x1 + dx * 0.5, y + 0.58, z1 + dz * 0.5, 0.06, 0.06, len, yaw, 'decor')
	const posts = Math.max(2, Math.round(len / 2.2))
	for (let i = 0; i <= posts; i++) {
		kit.box('metal', x1 + dx * (i / posts), y + 0.55, z1 + dz * (i / posts), 0.1, 1.1, 0.1, yaw, 'decor')
	}
}

function stairFlight(kit, x, z, yaw, yFrom, yTo, width) {
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const steps = Math.max(4, Math.round(Math.abs(yTo - yFrom) / 0.24))
	const rise = (yTo - yFrom) / steps
	const tread = 0.36
	for (let i = 0; i < steps; i++) {
		const t = (i + 0.5) * tread
		kit.box('concrete', x + dirX * t, yFrom + rise * (i + 0.5), z + dirZ * t, width, Math.abs(rise) + 0.08, tread, yaw, 'floor')
	}
	const runLen = steps * tread
	const midY = yFrom + (yTo - yFrom) * 0.5
	kit.box('metal', x + dirX * runLen * 0.5, midY - 0.3, z + dirZ * runLen * 0.5, width + 0.14, 0.16, runLen, yaw, 'decor')
	kit.box(wear(WEAR_CONC, x, yTo, z, 0.1), x + dirX * (runLen + 0.8), yTo, z + dirZ * (runLen + 0.8), width + 0.4, 0.22, 1.6, yaw, 'roof')
	railing(kit, x + dirZ * width * 0.5, z - dirX * width * 0.5, x + dirX * runLen + dirZ * width * 0.5, z + dirZ * runLen - dirX * width * 0.5, midY)
}

function windowBand(kit, cx, cy, cz, len, yaw, height, thickness) {
	const panes = Math.max(2, Math.round(len / 2.4))
	const step = len / panes
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	for (let i = 0; i < panes; i++) {
		const t = -len * 0.5 + step * (i + 0.5)
		const broken = hashNoise(cx + t, cy, cz) > 0.62
		if (!broken) kit.box('glass', cx + dirX * t, cy, cz + dirZ * t, thickness, height, step - 0.22, yaw, 'glass')
		else kit.box('glass', cx + dirX * t, cy + height * 0.34, cz + dirZ * t, thickness, height * 0.32, step - 0.22, yaw, 'glass')
	}
	for (let i = 0; i <= panes; i++) {
		const t = -len * 0.5 + step * i
		kit.box(wear(WEAR_BRICK, cx + t, cy, cz, 0.2), cx + dirX * t, cy, cz + dirZ * t, thickness + 0.12, height + 0.1, 0.22, yaw, 'wall')
	}
}

function containerStack(kit, x, z, yaw, tiers, matKey) {
	const cs = Math.cos(yaw)
	const sn = Math.sin(yaw)
	kit.box('gravel', x, 0.05, z, 6.4, 0.1, 2.8, yaw, 'floor')
	for (let t = 0; t < tiers; t++) {
		const y = 1.26 + t * 2.62
		kit.box(matKey, x, y, z, 6.06, 2.5, 2.44, yaw, 'container')
		kit.box('corrugated', x, y + 1.32, z, 6.16, 0.14, 2.54, yaw, 'roof')
		for (let r = -2; r <= 2; r++) {
			const ox = r * 1.18
			kit.box(matKey, x + cs * ox, y, z - sn * ox, 0.1, 2.42, 2.5, yaw, 'decor')
		}
	}
}

function palletStack(kit, x, z, layers) {
	for (let i = 0; i < layers; i++) {
		const yaw = (i % 2) * 1.5708
		const y = 0.09 + i * 0.19
		kit.box('plank', x, y, z, 1.24, 0.13, 0.86, yaw, 'crate')
		kit.box('wood', x, y + 0.08, z, 1.28, 0.05, 0.9, yaw, 'roof')
	}
}

/* barricade junk: planks, rags and plastic thrown into a rough heap */
function junkPile(kit, cx, cz, baseY, radius, count, seed) {
	for (let i = 0; i < count; i++) {
		const a = i * 2.39996 + seed
		const r = radius * Math.sqrt((i + 0.5) / count)
		const x = cx + Math.cos(a) * r
		const z = cz + Math.sin(a) * r
		const h = 0.28 + hashNoise(x, seed, z) * 0.72
		const key = i % 3 === 0 ? 'plank' : i % 3 === 1 ? 'fabric' : 'plastic'
		kit.box(key, x, baseY + h * 0.5, z, 0.7 + hashNoise(z, seed, x) * 0.55, h, 0.5 + hashNoise(x, z, seed) * 0.45, a, 'debris')
	}
}

function lampFixture(kit, state, x, y, z, color, power, range, hz) {
	kit.box('metal', x, y + 0.18, z, 0.44, 0.14, 0.34, 0, 'decor')
	kit.box('lamp', x, y, z, 0.34, 0.16, 0.26, 0, 'decor')
	if (state.used >= state.budget) return null
	state.used++
	const light = kit.lamp(x, y, z, color, power, range)
	if (light && hz > 0) {
		const spec = { hz: hz, min: power * 0.2, max: power, phase: state.used * 0.618034 }
		state.flicker.push({ light: light, hz: spec.hz, min: spec.min, max: spec.max, phase: spec.phase })
		if (light.userData) light.userData.flicker = spec
	}
	return light
}

/*
 * Parametric dorm generator. Nested floor x facade loop forges slabs,
 * brick sills, glazing and lintels, then the corridor loop cuts rooms
 * with doors on both sides. On the top floor of a marked block one room
 * becomes the Marked Room.
 */
function buildDorm(kit, spec, weapons) {
	const hw = spec.w * 0.5
	const hd = spec.d * 0.5
	const roomW = (spec.w - 0.8) / spec.rooms
	const corr = 1.4
	const sides = [[0, -hd, spec.w, 1.5708], [0, hd, spec.w, 1.5708], [-hw, 0, spec.d, 0], [hw, 0, spec.d, 0]]
	const top = spec.floors * spec.floorH
	for (let f = 0; f < spec.floors; f++) {
		const y0 = f * spec.floorH
		kit.box(wear(WEAR_CONC, spec.x, y0, spec.z, 0.1), spec.x, y0 + 0.14, spec.z, spec.w, 0.28, spec.d, 0, 'floor')
		for (let s = 0; s < 4; s++) {
			const sd = sides[s]
			const cx = spec.x + sd[0]
			const cz = spec.z + sd[1]
			kit.box(wear(WEAR_BRICK, cx, y0 + 1, cz, 0.05), cx, y0 + 0.76, cz, 0.42, 1.05, sd[2], sd[3], 'wall')
			windowBand(kit, cx, y0 + 1.92, cz, sd[2], sd[3], 1.28, 0.24)
			kit.box(wear(WEAR_BRICK, cx, y0 + 3, cz, 0.05), cx, y0 + 2.94, cz, 0.42, 0.76, sd[2], sd[3], 'wall')
		}
		/* corridor walls, room partitions and doors */
		for (let side = 0; side < 2; side++) {
			const sgn = side === 0 ? -1 : 1
			const wz = spec.z + sgn * corr
			for (let r = 0; r < spec.rooms; r++) {
				const x0 = spec.x - hw + 0.4 + r * roomW
				const xc = x0 + roomW * 0.5
				if (r > 0) {
					kit.box(wear(WEAR_DRY, x0, y0, wz, 0.1), x0, y0 + 1.6, spec.z + sgn * (hd + corr) * 0.5, 0.14, 3.2, hd - corr, 0, 'wall')
					kit.box(CONCRETE_WORN, x0, y0 + 1.6, spec.z + sgn * (hd - 0.5), 0.3, 3.2, 0.7, 0, 'column')
				}
				const marked = spec.marked && f === spec.floors - 1 && side === 0 && r === 3
				const half = (roomW - 1.05) * 0.5
				kit.box(wear(WEAR_DRY, xc, y0, wz, 0.15), x0 + half * 0.5, y0 + 1.6, wz, 0.16, 3.2, half, 1.5708, 'wall')
				kit.box(wear(WEAR_DRY, xc, y0 + 1, wz, 0.15), x0 + roomW - half * 0.5, y0 + 1.6, wz, 0.16, 3.2, half, 1.5708, 'wall')
				kit.box(CONCRETE_WORN, xc, y0 + 2.8, wz, 0.16, 1, 1.1, 1.5708, 'wall')
				const num = (f + 1) * 100 + side * spec.rooms + r + 1
				const locked = marked ? null : num % 5 === 0 ? spec.keyId : null
				const door = kit.door(xc, y0, wz, 3.14159, 1.02, spec.name + ' ' + num, locked)
				door.breakable = true
				door.hp = marked ? 60 : 100
				door.surface = 'wood'
				if (marked) door.marked = true
				if (!marked) {
					/* ordinary room dressing: bunk plus locker */
					const rz = spec.z + sgn * (hd + corr) * 0.5
					kit.box('plank', xc - roomW * 0.25, y0 + 0.55, rz, 1.9, 0.55, 0.9, 1.5708, 'crate')
					kit.box('metal', xc + roomW * 0.28, y0 + 1.05, rz + sgn * 1.2, 0.9, 1.8, 0.5, 0, 'crate')
					if (num % 3 === 0) kit.loot('crate', xc, y0 + 0.3, rz, spec.name + ' ' + num, 1.15)
					if (num % 4 === 0) kit.loot('jacket', xc + 1, y0 + 0.3, rz - sgn * 1.4, spec.name + ' ' + num, 1.25)
					continue
				}
				/* Marked Room: barricades, indexed weapon spawns, rich loot */
				const mz = spec.z + sgn * (hd + corr) * 0.5
				junkPile(kit, xc - 1.5, mz - 1.3, y0 + 0.28, 1.5, 10, 3.7)
				junkPile(kit, xc + 1.7, mz + 1.5, y0 + 0.28, 1.3, 8, 8.1)
				kit.box('plank', xc, y0 + 0.75, mz - hd * 0.5, 2.6, 1.5, 0.3, 0, 'wall')
				kit.box('plank', xc - 1.2, y0 + 1.5, mz - hd * 0.55, 0.3, 1.4, 2.2, 0.6, 'wall')
				for (let w = 0; w < 4; w++) {
					const wx = xc - 1.5 + w
					const spot = kit.loot('gun', wx, y0 + 0.28, mz, 'Меченая комната', 2.5)
					if (spot && typeof spot === 'object') spot.weaponIndex = w
					weapons.push({ index: w, x: wx, y: y0 + 0.28, z: mz, rich: 2.5, tier: 3, room: 'marked', map: 'customs' })
				}
				kit.loot('safe', xc + 2.2, y0 + 0.28, mz - 1.9, 'Меченая комната', 2.5)
				kit.loot('jacket', xc - 2.3, y0 + 0.28, mz + 2, 'Меченая комната', 2.5)
				kit.loot('crate', xc, y0 + 0.28, mz + 2.3, 'Меченая комната', 2.5)
				kit.loot('tool', xc + 1.6, y0 + 0.28, mz + 1.1, 'Меченая комната', 2.5)
			}
		}
		/* internal flight, alternating direction each floor */
		if (f < spec.floors - 1) {
			const up = f % 2 === 0
			stairFlight(kit, spec.x + hw - 2.2, up ? spec.z - hd + 1.4 : spec.z + hd - 1.4, up ? 0 : 3.14159, y0, y0 + spec.floorH, 1.2)
		}
		/* door onto the fire escape */
		if (spec.escape) {
			const esc = kit.door(spec.x - hw + 4, y0, spec.z - hd, 3.14159, 1.1, spec.name + ': пожарный выход', null)
			esc.breakable = true
			esc.hp = 80
			esc.surface = 'metal'
		}
	}
	/* roof slab, parapet and vent boxes */
	kit.box(wear(WEAR_CONC, spec.x, top, spec.z, 0.15), spec.x, top + 0.16, spec.z, spec.w, 0.32, spec.d, 0, 'roof')
	for (let s = 0; s < 4; s++) {
		const sd = sides[s]
		kit.box(wear(WEAR_BRICK, spec.x + sd[0], top, spec.z + sd[1], 0.2), spec.x + sd[0], top + 0.8, spec.z + sd[1], 0.3, 1, sd[2], sd[3], 'wall')
	}
	for (let i = 0; i < 3; i++) {
		kit.box('metal', spec.x - spec.w * 0.25 + i * spec.w * 0.25, top + 0.75, spec.z + 1.5, 1.4, 0.9, 1.2, 0, 'machine')
	}
	/* external fire escape: landings, flights and posts */
	if (spec.escape) {
		const ex = spec.x - hw + 4
		const ez = spec.z - hd - 1.7
		for (let f = 0; f < spec.floors; f++) {
			const y = f * spec.floorH
			kit.box('metal', ex, y + 0.12, ez, 7.4, 0.22, 2.9, 0, 'roof')
			railing(kit, ex - 3.7, ez - 1.45, ex + 3.7, ez - 1.45, y + 0.22)
			if (f > 0) stairFlight(kit, ex - 3.4, ez, 1.5708, y - spec.floorH, y, 1.2)
		}
		for (let p = 0; p < 4; p++) {
			kit.box('metal', ex - 3.5 + (p % 2) * 7, top * 0.5, ez - 1.35 + Math.floor(p / 2) * 2.7, 0.18, top, 0.18, 0, 'column')
		}
	}
}

export const customsMeta = {
	id: 'customs',
	name: 'Таможня',
	size: SIZE,
	duration: 35 * 60,
	minLevel: 1,
	lightBudget: 22,
	lootCount: LOOT_GROUND.length + LOOT_YARD.length + LOOT_CS.length,
	lootRich: 1.2,
	bots: { scav: [7, 10], raider: [2, 3], pmcbot: [1, 2], boss: [0, 1] }
}

export function buildCustoms(world, ctx, opts) {
	const a = normalizeBuildArgs(world, ctx, opts)
	const night = !!(a.opts && a.opts.night)
	const kit = new MapKit(a.world, a.ctx, {
		id: 'customs',
		name: 'Таможня',
		size: SIZE,
		night: night,
		duration: customsMeta.duration,
		lightBudget: customsMeta.lightBudget,
		rng: (a.opts && a.opts.rng) || makeRng(a.ctx, 'map:customs')
	})
	const state = { used: 0, budget: LIGHT_CAP, flicker: [] }
	const weapons = []

	kit.setFog(night ? 0x0a0e12 : 0x8d939a, night ? 0.012 : 0.0055)
	kit.setAmbient({
		color: night ? 0x1a2333 : 0x8fa0b0,
		intensity: night ? 0.18 : 0.62,
		sunColor: night ? 0x6d84ad : 0xfff0d4,
		sunIntensity: night ? 0.08 : 0.85,
		sunPosition: [-90, 120, 60]
	})

	kit.ground('dirt')
	kit.perimeter('corrugated', 7, 0.6)

	/* the lane: asphalt, worn kerbs and a dashed centre line */
	kit.box('asphalt', 0, 0.06, ROAD_Z, 146, 0.12, ROAD_W, 0, 'floor')
	kit.box('kerb', 0, 0.16, ROAD_Z - ROAD_W * 0.5, 146, 0.3, 0.5, 0, 'floor')
	kit.box('kerb', 0, 0.16, ROAD_Z + ROAD_W * 0.5, 146, 0.3, 0.5, 0, 'floor')
	for (let i = 0; i < 36; i++) {
		kit.box('plaster', -70 + i * 4, 0.13, ROAD_Z, 2.2, 0.03, 0.3, 0, 'floor')
	}
	/* service road up to the dorms and the yard */
	kit.box('asphalt', -16, 0.06, -20, 8, 0.12, 26, 0, 'floor')
	kit.box('asphalt', 34, 0.06, 24, 8, 0.12, 34, 0, 'floor')

	/* stream in a concrete ditch with two bridges over it */
	kit.box('gravel', DITCH_X, -0.35, 20, 9, 0.7, 100, 0, 'floor')
	kit.box('water', DITCH_X, -0.12, 20, 7.4, 0.5, 100, 0, 'floor')
	for (let i = 0; i < 26; i++) {
		const z = -28 + i * 4
		kit.box(wear(WEAR_CONC, DITCH_X, 0.2, z, 0.25), DITCH_X - 4.7, 0.25, z, 0.6, 1, 3.9, 0, 'wall')
		kit.box(wear(WEAR_CONC, DITCH_X, 0.4, z, 0.25), DITCH_X + 4.7, 0.25, z, 0.6, 1, 3.9, 0, 'wall')
	}
	const BRIDGES = [[DITCH_X, ROAD_Z, ROAD_W + 4], [DITCH_X, 44, 6]]
	for (let i = 0; i < BRIDGES.length; i++) {
		const b = BRIDGES[i]
		kit.box(CONCRETE_WORN, b[0], 0.28, b[1], 13, 0.56, b[2], 0, 'floor')
		railing(kit, b[0] - 6.5, b[1] - b[2] * 0.5, b[0] + 6.5, b[1] - b[2] * 0.5, 0.56)
		railing(kit, b[0] - 6.5, b[1] + b[2] * 0.5, b[0] + 6.5, b[1] + b[2] * 0.5, 0.56)
		kit.box(CONCRETE_WORN, b[0] - 5.5, -0.3, b[1], 1.2, 1.4, b[2], 0, 'column')
		kit.box(CONCRETE_WORN, b[0] + 5.5, -0.3, b[1], 1.2, 1.4, b[2], 0, 'column')
	}

	/* railway along the south edge with ballast, sleepers and wagons */
	kit.box('gravel', 0, 0.12, 60, 142, 0.24, 7.4, 0, 'floor')
	for (let i = 0; i < 2; i++) {
		kit.box('rail', 0, 0.3, 58.4 + i * 3.2, 142, 0.16, 0.2, 0, 'decor')
	}
	for (let i = 0; i < 47; i++) {
		kit.box('plank', -69 + i * 3, 0.2, 60, 0.32, 0.16, 5.4, 0, 'floor')
	}
	for (let i = 0; i < 3; i++) {
		const x = -30 + i * 22
		kit.box(METAL_RUST, x, 2, 60, 14, 3.2, 3.1, 0, 'container')
		kit.box('metal', x, 0.5, 60, 14.4, 0.6, 3.4, 0, 'decor')
		kit.box('corrugated', x, 3.7, 60, 14.2, 0.24, 3.2, 0, 'roof')
	}

	/* the two dorm blocks */
	buildDorm(kit, DORM3, weapons)
	buildDorm(kit, DORM2, weapons)

	/*
	 * Construction site: skeletal frame, open strip floors, exposed rebar
	 * pillars. Every third strip is skipped so the floors stay unfinished
	 * and shooters can drop or see through them.
	 */
	for (let lv = 0; lv < CS_LEVELS; lv++) {
		const y = lv * CS_H
		for (let sx = 0; sx < 8; sx++) {
			if (lv > 0 && sx % 3 === 2) continue
			const px = CS_X - CS_W * 0.5 + 1.9 + sx * 3.75
			kit.box(wear(WEAR_CONC, px, y, CS_Z, 0.1), px, y + 0.15, CS_Z, 3.6, 0.3, CS_D, 0, 'floor')
		}
		/* edge beams on all four sides */
		kit.box(CONCRETE_WORN, CS_X, y + 0.45, CS_Z - CS_D * 0.5, CS_W, 0.9, 0.5, 0, 'wall')
		kit.box(CONCRETE_WORN, CS_X, y + 0.45, CS_Z + CS_D * 0.5, CS_W, 0.9, 0.5, 0, 'wall')
		kit.box(CONCRETE_WORN, CS_X - CS_W * 0.5, y + 0.45, CS_Z, 0.5, 0.9, CS_D, 0, 'wall')
		kit.box(CONCRETE_WORN, CS_X + CS_W * 0.5, y + 0.45, CS_Z, 0.5, 0.9, CS_D, 0, 'wall')
		/* rebar pillar grid */
		for (let gx = 0; gx < 5; gx++) {
			for (let gz = 0; gz < 3; gz++) {
				const px = CS_X - CS_W * 0.5 + 3 + gx * 6
				const pz = CS_Z - CS_D * 0.5 + 3 + gz * 4
				kit.cylinder(CONCRETE_WORN, px, y + CS_H * 0.5, pz, 0.42, CS_H, 'column')
				if (lv === CS_LEVELS - 1) {
					for (let b = 0; b < 4; b++) {
						const ba = b * 1.5708 + 0.4
						kit.cylinder('rail', px + Math.cos(ba) * 0.24, y + CS_H + 0.6, pz + Math.sin(ba) * 0.24, 0.05, 1.2, 'decor', false)
					}
				}
			}
		}
		/* scaffolding ring and a flight up to the next level */
		if (lv < CS_LEVELS - 1) {
			stairFlight(kit, CS_X - CS_W * 0.5 + 2, CS_Z + (lv % 2 === 0 ? -CS_D * 0.5 + 2 : CS_D * 0.5 - 2), lv % 2 === 0 ? 1.5708 : 4.71239, y, y + CS_H, 1.4)
		}
		for (let i = 0; i < 6; i++) {
			const px = CS_X - CS_W * 0.5 + 2.5 + i * 5
			kit.box('rail', px, y + CS_H * 0.5, CS_Z - CS_D * 0.5 - 1, 0.12, CS_H, 0.12, 0, 'decor')
			kit.box('plank', px, y + CS_H - 0.4, CS_Z - CS_D * 0.5 - 1, 4.8, 0.12, 0.9, 0, 'roof')
		}
	}
	/* tower crane mast beside the frame */
	for (let i = 0; i < 9; i++) {
		kit.box(METAL_RUST, CS_X + 20, 1 + i * 2.4, CS_Z - 2, 1.6, 2.3, 1.6, i * 0.12, 'column')
	}
	kit.box(METAL_RUST, CS_X + 8, 22.4, CS_Z - 2, 28, 0.7, 0.7, 0, 'decor')
	kit.box('metal', CS_X - 4, 21.6, CS_Z - 2, 1.4, 1.2, 1.4, 0, 'crate')

	/* algorithmic terminal grid: containers, aisles and pallet stacks */
	for (let gx = 0; gx < YARD_COLS; gx++) {
		for (let gz = 0; gz < YARD_ROWS; gz++) {
			const x = YARD_X + gx * 7
			const z = YARD_Z + gz * 8
			const n = hashNoise(x, gx + gz, z)
			if (n < 0.16) continue
			const tiers = n > 0.74 ? 3 : n > 0.44 ? 2 : 1
			const yaw = n > 0.56 ? 1.5708 : 0
			containerStack(kit, x, z, yaw, tiers, CRATE_PALETTE[(gx * YARD_ROWS + gz) % CRATE_PALETTE.length])
			if (n > 0.3 && n < 0.52) palletStack(kit, x + 3.6, z + 3.4, 3 + Math.floor(n * 7))
		}
	}
	for (let i = 0; i < PALLETS.length; i++) {
		palletStack(kit, PALLETS[i][0], PALLETS[i][1], PALLETS[i][2])
	}

	for (let i = 0; i < BUILDINGS.length; i++) {
		kit.building(BUILDINGS[i])
	}

	/* fuel canopies over both gas stations */
	const CANOPY = [[-56, -26], [52, -24]]
	for (let i = 0; i < CANOPY.length; i++) {
		const c = CANOPY[i]
		kit.box('metal', c[0], 5, c[1], 20, 0.6, 10, 0, 'roof')
		for (let p = 0; p < 4; p++) {
			kit.box('metal', c[0] - 8 + (p % 2) * 16, 2.5, c[1] - 3.5 + Math.floor(p / 2) * 7, 0.5, 5, 0.5, 0, 'column')
		}
		for (let p = 0; p < 3; p++) {
			kit.box('plastic', c[0] - 6 + p * 6, 0.7, c[1], 1.2, 1.4, 0.8, 0, 'machine')
		}
		lampFixture(kit, state, c[0], 4.4, c[1], 0xfff4d8, 0.6, 20, i === 0 ? 5.5 : 0)
	}

	/* wrecked cars along the lane */
	for (let i = 0; i < CARS.length; i++) {
		const c = CARS[i]
		const key = wear(WEAR_IRON, c[0], 1, c[1], 0.35)
		kit.box(key, c[0], 0.7, c[1], 4.4, 1, 1.9, c[2], 'container')
		kit.box(key, c[0], 1.5, c[1], 2.4, 0.8, 1.8, c[2], 'container')
		kit.box('glass', c[0], 1.5, c[1], 2.42, 0.5, 1.84, c[2], 'glass')
		for (let w = 0; w < 4; w++) {
			const ox = w < 2 ? -1.5 : 1.5
			const oz = w % 2 === 0 ? -0.95 : 0.95
			kit.cylinder('rubber', c[0] + Math.cos(c[2]) * ox + Math.sin(c[2]) * oz, 0.34, c[1] - Math.sin(c[2]) * ox + Math.cos(c[2]) * oz, 0.34, 0.3, 'decor', false)
		}
	}

	/* street lighting, one broken pole flickers */
	for (let i = 0; i < STREET_LAMPS.length; i++) {
		const l = STREET_LAMPS[i]
		kit.box('metal', l[0], 3.4, l[1], 0.26, 6.8, 0.26, 0, 'column')
		kit.box('metal', l[0], 6.7, l[1] + 0.6, 0.2, 0.2, 1.4, 0, 'decor')
		lampFixture(kit, state, l[0], 6.5, l[1] + 1.2, 0xffe8bc, 0.5, 22, i === 3 ? 6.5 : 0)
	}

	/* concrete blocks and sandbags at the roadblocks */
	for (let i = 0; i < 10; i++) {
		const x = -68 + i * 1.9
		kit.box(CONCRETE_WORN, x, 0.6, 4 + (i % 2) * 1.4, 1.7, 1.2, 0.9, (i % 3) * 0.2, 'wall')
	}
	for (let i = 0; i < 12; i++) {
		const x = 60 + (i % 4) * 2.2
		kit.box('fabric', x, 0.3 + Math.floor(i / 4) * 0.45, -8 - (i % 3) * 0.9, 1.4, 0.45, 0.8, (i % 5) * 0.15, 'wall')
	}

	for (let i = 0; i < LOOT_GROUND.length; i++) {
		const l = LOOT_GROUND[i]
		kit.loot(l[0], l[1], l[2], l[3], null, l[4])
	}
	for (let i = 0; i < LOOT_YARD.length; i++) {
		const l = LOOT_YARD[i]
		kit.loot(l[0], l[1], 0, l[2], null, l[3])
	}
	for (let i = 0; i < LOOT_CS.length; i++) {
		const l = LOOT_CS[i]
		kit.loot(l[0], l[1], l[2], l[3], null, l[4])
	}

	for (let i = 0; i < EXITS.length; i++) {
		kit.exit(EXITS[i])
	}

	for (let i = 0; i < SPAWN_PMC.length; i++) kit.spawn('pmc', SPAWN_PMC[i][0], SPAWN_PMC[i][1], SPAWN_PMC[i][2])
	for (let i = 0; i < SPAWN_SCAV.length; i++) kit.spawn('scav', SPAWN_SCAV[i][0], SPAWN_SCAV[i][1], SPAWN_SCAV[i][2])
	for (let i = 0; i < SPAWN_RAIDER.length; i++) kit.spawn('raider', SPAWN_RAIDER[i][0], SPAWN_RAIDER[i][1], SPAWN_RAIDER[i][2])
	for (let i = 0; i < SPAWN_PMCBOT.length; i++) kit.spawn('pmcbot', SPAWN_PMCBOT[i][0], SPAWN_PMCBOT[i][1], SPAWN_PMCBOT[i][2])
	for (let i = 0; i < SPAWN_BOSS.length; i++) kit.spawn('boss', SPAWN_BOSS[i][0], SPAWN_BOSS[i][1], SPAWN_BOSS[i][2])
	for (let i = 0; i < SPAWN_BOT.length; i++) kit.spawn('bot', SPAWN_BOT[i][0], SPAWN_BOT[i][1], SPAWN_BOT[i][2])

	const map = kit.finalize()
	map.meta = customsMeta
	map.flickerLights = state.flicker
	map.weaponSpawns = weapons
	return map
}

export default buildCustoms
