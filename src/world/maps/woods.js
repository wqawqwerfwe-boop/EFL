import { MapKit, normalizeBuildArgs, makeRng } from './_kit.js'

/*
 * Woods (Les) - organic massing, vertical topography, sniper sightlines.
 *
 * 1. Shturman's sawmill: three independent open ended plank hangars (no
 *    gable walls, so every one of them is a shooting gallery), circular
 *    log saw assemblies made of flat horizontal cylinders, log pyramids,
 *    the Common Fund stash and the blue metal worker cabin.
 * 2. Sniper rock: an organic mountain mass grown from rings of non
 *    aligned gravel / stone blocks with hashed height scales and yaw
 *    angles, plus a walkable spiral ramp so the high ground is steep but
 *    reachable.
 * 3. Foliage: golden angle annulus scatter of towering pines with POI
 *    exclusion, so hard cover grows everywhere except inside the camps.
 *
 * NOTE: _kit.js exposes no 'concrete_worn' key and no per instance tint,
 * so worn stone is bound to real keys below and the blue cabin uses the
 * 'metal' surface (a blue painted metal material would need a new key in
 * palette.js / _kit.js FALLBACK_PBR).
 */

const SIZE = 170
const HALF = 85
const LIGHT_CAP = 7
const TREE_COUNT = 240

const METAL_RUST = 'rust'
const CONCRETE_WORN = 'concrete'

const WEAR_WOOD = ['plank', 'wood', 'bark']
const WEAR_TRUNK = ['bark', 'wood']
const WEAR_STONE = ['gravel', 'concrete', 'kerb']
const WEAR_IRON = ['metal', 'corrugated', 'rust']

/* sawmill camp */
const MILL_X = -6
const MILL_Z = -12
/* three hangars: x z w d h name */
const HANGARS = [
	[-26, -16, 18, 11, 6.2, 'Ангар пиломатериалов'],
	[-2, -18, 14, 10, 5.8, 'Ангар сушилки'],
	[16, -10, 10, 16, 6, 'Ангар распиловки']
]
/* saw assemblies: x z seed */
const SAWS = [[-26, -16, 1.3], [-2, -18, 4.9], [16, -6, 7.7], [6, -14, 2.2]]
/* log pyramids: x z rows perRow yaw */
const LOGS = [[-34, -6, 4, 5, 0], [-18, -4, 3, 4, 0], [4, -4, 4, 5, 0], [22, -20, 3, 4, 1.5708], [-12, -26, 3, 5, 0], [28, 2, 4, 4, 1.5708]]

/* sniper rock */
const ROCK_X = 22
const ROCK_Z = 20
const ROCK_R = 19
const ROCK_H = 13.5

/* points of interest kept clear of trees: x z radius */
const POIS = [[-26, -16, 15], [-2, -18, 14], [16, -10, 15], [MILL_X, MILL_Z, 14], [ROCK_X, ROCK_Z, 24], [-52, 34, 16], [50, -40, 16], [58, 48, 16], [-62, -46, 14], [0, 62, 14], [-40, 0, 10], [40, 62, 12]]

/* grass mounds: x z radius height */
const HILLS = [[-46, -20, 22, 4.5], [44, -14, 20, 3.8], [-20, 44, 24, 5.2], [30, 44, 18, 3.4], [66, 10, 16, 4], [-70, 12, 16, 3.6]]

/* power line pylons along the clearing */
const PYLONS = [[-64, 66], [-38, 66], [-12, 66], [14, 66], [40, 66], [66, 66]]

const BUILDINGS = [
	{ x: MILL_X, z: MILL_Z, w: 8, d: 3.6, h: 3, surf: 'metal', t: 0.28, doorWidth: 1.1, name: 'Синий вагончик рабочих', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'metal', partitions: 1, lamp: true, lampColor: 0xbfe0ff, lampIntensity: 0.45, lampRange: 12 },
	{ x: MILL_X + 12, z: MILL_Z + 6, w: 7, d: 5, h: 3.2, surf: 'plank', t: 0.3, doorWidth: 1.2, name: 'Контора лесопилки', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'corrugated', partitions: 1, lamp: true, lampColor: 0xffe0a8, lampIntensity: 0.4, lampRange: 10 },
	{ x: -52, z: 34, w: 12, d: 9, h: 3.4, surf: 'plank', t: 0.35, doorWidth: 1.3, name: 'Дом лесника', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'plank', partitions: 2, lamp: true, lampColor: 0xffd090, lampIntensity: 0.42, lampRange: 12 },
	{ x: -46, z: 44, w: 6, d: 4, h: 2.6, surf: 'plank', t: 0.28, doorWidth: 1, name: 'Сарай лесника', floor: true, floorSurf: 'dirt', roof: true, roofSurf: 'corrugated', partitions: 1, lamp: false },
	{ x: 50, z: -40, w: 6.5, d: 5, h: 2.9, surf: 'tent', t: 0.24, doorWidth: 1.4, name: 'Палатка USEC 1', floor: true, floorSurf: 'fabric', roof: true, roofSurf: 'tent', partitions: 1, lamp: false },
	{ x: 57, z: -34, w: 6.5, d: 5, h: 2.9, surf: 'tent', t: 0.24, doorWidth: 1.4, name: 'Палатка USEC 2', floor: true, floorSurf: 'fabric', roof: true, roofSurf: 'tent', partitions: 1, lamp: true, lampColor: 0xffcf9a, lampIntensity: 0.38, lampRange: 10 },
	{ x: 44, z: -46, w: 6.5, d: 5, h: 2.9, surf: 'camo', t: 0.24, doorWidth: 1.4, name: 'Штабная палатка USEC', floor: true, floorSurf: 'fabric', roof: true, roofSurf: 'camo', partitions: 1, lamp: false },
	{ x: 58, z: 48, w: 14, d: 10, h: 3.6, surf: 'concrete', t: 0.6, doorWidth: 1.5, name: 'Бункер ЗБ-016', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'concrete', partitions: 2, lamp: true, lampColor: 0xff6a4a, lampIntensity: 0.5, lampRange: 12, keyId: 'key_bunker_woods' },
	{ x: -62, z: -46, w: 11, d: 8, h: 3.2, surf: 'brick', t: 0.4, doorWidth: 1.3, name: 'Разрушенная ферма', floor: true, floorSurf: 'dirt', roof: false, partitions: 2, lamp: false },
	{ x: 0, z: 62, w: 10, d: 7, h: 3.2, surf: 'plank', t: 0.32, doorWidth: 1.2, name: 'Старая станция', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'corrugated', partitions: 1, lamp: true, lampColor: 0xffe4b0, lampIntensity: 0.4, lampRange: 12 }
]

const LOOT_MILL = [['safe', MILL_X + 1, 0, MILL_Z + 2, 2.6], ['crate', -26, 0, -16, 1.3], ['tool', -24, 0, -13, 1.4], ['crate', -2, 0, -18, 1.3], ['gun', 16, 0, -10, 1.6], ['crate', 16, 0, -6, 1.2], ['jacket', MILL_X, 0, MILL_Z + 1, 1.8], ['med', MILL_X + 12, 0, MILL_Z + 6, 1.5], ['tool', 6, 0, -14, 1.3], ['crate', -34, 0, -6, 1.2]]
const LOOT_WORLD = [['crate', -52, 0, 34, 1.3], ['jacket', -52, 0, 38, 1.4], ['med', 50, 0, -40, 1.4], ['gun', 44, 0, -46, 1.7], ['crate', 57, 0, -34, 1.3], ['safe', 58, 0, 48, 2.2], ['crate', 58, 0, 52, 1.5], ['tool', -62, 0, -46, 1.3], ['crate', 0, 0, 62, 1.2], ['med', -46, 0, 44, 1.2], ['crate', 66, 0, 12, 1.1], ['jacket', -70, 0, 14, 1.1]]
const LOOT_ROCK = [['crate', ROCK_X, 12.2, ROCK_Z, 1.9], ['gun', ROCK_X + 3, 12.2, ROCK_Z - 2, 2.1], ['med', ROCK_X - 3, 8.5, ROCK_Z + 3, 1.6], ['crate', ROCK_X + 6, 5.5, ROCK_Z + 6, 1.4]]

const SPAWN_PMC = [[-78, 0, -78], [78, 0, -78], [-78, 0, 78], [78, 0, 78], [0, 0, -80], [0, 0, 80], [-80, 0, 0], [80, 0, 0]]
const SPAWN_SCAV = [[-26, 0, -22], [16, 0, -4], [-52, 0, 40], [50, 0, -34], [58, 0, 54], [0, 0, 56], [-62, 0, -40], [30, 0, 34], [-30, 0, 20], [40, 0, 66]]
const SPAWN_RAIDER = [[58, 0, 44], [62, 0, 52], [54, 0, 52]]
const SPAWN_PMCBOT = [[ROCK_X, 12.2, ROCK_Z], [ROCK_X - 8, 6, ROCK_Z + 8], [-46, 4.5, -20], [44, 3.8, -14]]
/* Shturman and his two guards hold the sawmill */
const SPAWN_BOSS = [[MILL_X + 2, 0, MILL_Z - 2], [-2, 0, -18]]
const SPAWN_BOT = [[-40, 0, -30], [40, 0, -30], [-40, 0, 30], [40, 0, 30], [0, 0, -40], [0, 0, 40], [-60, 0, 0], [60, 0, 0], [-20, 0, -50], [20, 0, 50], [70, 0, -60], [-70, 0, 60], [10, 0, 8], [-14, 0, 6], [34, 0, -60]]

const EXITS = [
	{ id: 'woods:ruaf', name: 'Ворота ВС РФ', x: -80, z: -70, radius: 4, noBotsNear: 18, note: 'Северо-западный выезд' },
	{ id: 'woods:outskirts', name: 'Окраина', x: 80, z: 72, radius: 4.2, noBotsNear: 18, note: 'Юго-восточная кромка леса' },
	{ id: 'woods:unroadblock', name: 'Северный блокпост ООН', x: 8, z: -80, radius: 3.8, afterSec: 720, note: 'Открывается во второй половине рейда' },
	{ id: 'woods:bunker', name: 'Гермодверь бункера', x: 58, z: 42, radius: 3, needKey: 'key_bunker_woods', note: 'Нужен ключ от бункера ЗБ-016' },
	{ id: 'woods:scavbridge', name: 'Мост Диких', x: -80, z: 30, radius: 3.4, faction: 'scav', note: 'Только за Дикого' },
	{ id: 'woods:sawmill', name: 'Тропа за лесопилкой', x: -34, z: -76, radius: 3.2, faction: 'scav', note: 'Только за Дикого' },
	{ id: 'woods:eastrocks', name: 'Восточные скалы', x: 80, z: -20, radius: 3.4, freeHands: true, note: 'Пролезти можно только с пустыми руками' },
	{ id: 'woods:transfer', name: 'Переход на Таможню', x: -76, z: 76, radius: 3.6, transfer: 'customs', cost: 3500, note: 'Платный переход' }
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

function nearPoi(x, z) {
	for (let i = 0; i < POIS.length; i++) {
		const p = POIS[i]
		const dx = x - p[0]
		const dz = z - p[1]
		if (dx * dx + dz * dz < p[2] * p[2]) return true
	}
	return false
}

function lampFixture(kit, state, x, y, z, color, power, range, hz) {
	kit.box('metal', x, y + 0.18, z, 0.42, 0.14, 0.32, 0, 'decor')
	kit.box('lamp', x, y, z, 0.32, 0.16, 0.24, 0, 'decor')
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

/* towering pine: trunk, root flare and four tapering foliage tiers */
function pineTree(kit, x, z, scale, seed) {
	const h = 13 * scale
	kit.box('wood', x, 0.12, z, 1.9 * scale, 0.24, 1.9 * scale, seed, 'floor')
	kit.box(wear(WEAR_TRUNK, x, h, z, 0.1), x, h * 0.44, z, 0.86 * scale, h * 0.88, 0.86 * scale, seed, 'tree')
	for (let i = 0; i < 4; i++) {
		const t = i / 3
		const cw = (5.4 - t * 3.6) * scale
		kit.box('foliage', x, h * (0.5 + t * 0.44), z, cw, h * 0.24, cw, seed + i * 0.7, 'decor')
	}
}

/* bush / low cover blob */
function bush(kit, x, z, r, seed) {
	kit.box('foliage', x, r * 0.5, z, r * 2, r, r * 1.7, seed, 'decor')
	kit.box('foliage', x + r * 0.4, r * 0.35, z - r * 0.3, r * 1.4, r * 0.7, r * 1.2, seed + 1.1, 'decor')
}

/*
 * Open ended plank hangar: two long plank walls with missing boards,
 * post rows, roof trusses and a stepped ridge. Both ends stay open.
 */
function hangar(kit, x, z, w, d, h, name) {
	const hwv = w * 0.5
	const hdv = d * 0.5
	kit.box('gravel', x, 0.06, z, w + 2, 0.12, d + 2, 0, 'floor')
	kit.box('dirt', x, 0.1, z, w, 0.12, d, 0, 'floor')
	for (let s = -1; s <= 1; s += 2) {
		const wz = z + s * hdv
		for (let b = 0; b < 8; b++) {
			const by = 0.4 + b * (h - 0.6) / 8
			if (hashNoise(x + b, by, wz) > 0.84) continue
			kit.box(wear(WEAR_WOOD, x, by, wz, 0.15), x, by, wz, w, (h - 0.6) / 8 - 0.04, 0.22, 0, 'wall')
		}
		const posts = Math.max(3, Math.round(w / 3.5))
		for (let p = 0; p <= posts; p++) {
			kit.box('wood', x - hwv + (w / posts) * p, h * 0.5, wz, 0.34, h, 0.34, 0, 'column')
		}
	}
	/* roof deck, trusses and stepped ridge */
	kit.box(wear(WEAR_WOOD, x, h, z, 0.1), x, h + 0.2, z, w + 1.4, 0.26, d + 1.4, 0, 'roof')
	kit.box('plank', x, h + 0.62, z, w + 0.8, 0.24, d * 0.62, 0, 'roof')
	kit.box('plank', x, h + 1.02, z, w + 0.4, 0.24, d * 0.3, 0, 'roof')
	const trusses = Math.max(3, Math.round(w / 3))
	for (let t = 0; t <= trusses; t++) {
		kit.box('wood', x - hwv + (w / trusses) * t, h - 0.25, z, 0.22, 0.4, d, 0, 'decor')
	}
	for (let t = 0; t < 3; t++) {
		kit.box('wood', x, h - 0.8, z - hdv + (d / 2) * t, w, 0.2, 0.2, 0, 'decor')
	}
}

/*
 * Circular saw assembly. The blade and the pulley are flat horizontal
 * cylinders (kit.cylinder is Y axis only, a large radius and a tiny
 * height gives exactly the lying disc we need).
 */
function sawAssembly(kit, x, z, seed) {
	kit.box(wear(WEAR_IRON, x, 1, z, 0.2), x, 0.45, z, 3.4, 0.9, 2.3, 0, 'machine')
	kit.box('metal', x, 0.95, z, 3.5, 0.14, 2.4, 0, 'roof')
	kit.cylinder('rail', x, 1.12, z, 1.4, 0.07, 'decor', false)
	kit.cylinder('metal', x, 1.14, z, 0.24, 0.36, 'machine')
	kit.cylinder(METAL_RUST, x - 1.55, 0.78, z, 0.52, 0.42, 'machine')
	kit.box('rubber', x - 0.8, 0.82, z, 1.6, 0.1, 0.16, 0, 'decor')
	kit.box('bark', x + 1.9, 1.2, z, 4, 0.52, 0.52, 0.04, 'crate')
	for (let i = 0; i < 9; i++) {
		const a = i * 2.39996 + seed
		const r = 1.6 + hashNoise(x, i, z) * 1.4
		kit.box('sand', x + Math.cos(a) * r, 0.08, z + Math.sin(a) * r, 1.5, 0.06, 1.2, a, 'floor')
	}
}

/* log pyramid: each row holds one less trunk than the row below */
function logPile(kit, x, z, rows, perRow, yaw) {
	const cs = Math.cos(yaw)
	const sn = Math.sin(yaw)
	for (let r = 0; r < rows; r++) {
		const y = 0.55 + r * 0.94
		const n = perRow - r
		if (n < 1) continue
		for (let i = 0; i < n; i++) {
			const ox = (i - (n - 1) * 0.5) * 1.04
			kit.box(wear(WEAR_TRUNK, x + ox, y, z, 0.1), x + cs * ox, y, z - sn * ox, 0.94, 0.9, 7.4, yaw, 'crate')
		}
	}
}

/*
 * Organic rock mass. Rings of blocks step upward, each block gets a
 * hashed height scale and a non aligned yaw so nothing reads as a grid,
 * then a spiral of flat slabs makes the summit walkable.
 */
function rockMass(kit, cx, cz, radius, height, rings, seed) {
	for (let ring = 0; ring < rings; ring++) {
		const t = ring / (rings - 1)
		const r = radius * (1 - t * 0.84)
		const baseY = height * t * 0.84
		const count = Math.max(5, Math.round(6.28318 * r / 4))
		for (let i = 0; i < count; i++) {
			const a = (i / count) * 6.28318 + ring * 0.83 + seed
			const n = hashNoise(cx + Math.cos(a) * r, ring, cz + Math.sin(a) * r)
			const m = hashNoise(cz + Math.sin(a) * r, ring + 2.3, cx)
			const px = cx + Math.cos(a) * r * (0.86 + n * 0.3)
			const pz = cz + Math.sin(a) * r * (0.86 + n * 0.3)
			const h = 1.7 + n * 3
			const w = 3.2 + m * 2.8
			kit.box(wear(WEAR_STONE, px, h, pz, 0.1), px, baseY + h * 0.5, pz, w, h, w * (0.68 + m * 0.55), a + n * 1.7, 'rock')
		}
	}
	/* summit plateau plus two firing perches */
	kit.box('gravel', cx, height * 0.86, cz, radius * 0.52, 1.8, radius * 0.46, seed, 'rock')
	kit.box(CONCRETE_WORN, cx - radius * 0.2, height * 0.9 + 0.9, cz + radius * 0.16, 3.2, 1, 2.4, seed + 1.2, 'wall')
	kit.box(CONCRETE_WORN, cx + radius * 0.22, height * 0.9 + 0.9, cz - radius * 0.18, 2.8, 1, 2.2, seed + 2.4, 'wall')
	/* walkable spiral ramp up the flank */
	for (let i = 0; i <= 28; i++) {
		const a = seed + 1.2 + i * 0.235
		const rr = radius * (0.97 - i * 0.0245)
		kit.box('gravel', cx + Math.cos(a) * rr, (height * 0.84) * (i / 28), cz + Math.sin(a) * rr, 3.6, 0.72, 3.1, a, 'floor')
	}
}

/* soft grass mound built from flat concentric slabs */
function hill(kit, cx, cz, radius, height, seed) {
	const rings = 5
	for (let ring = 0; ring < rings; ring++) {
		const t = ring / (rings - 1)
		const r = radius * (1 - t * 0.78)
		const y = height * t * 0.9
		const count = Math.max(4, Math.round(6.28318 * r / 6))
		for (let i = 0; i < count; i++) {
			const a = (i / count) * 6.28318 + ring * 0.7 + seed
			const n = hashNoise(cx + r, ring + i, cz - r)
			kit.box(n > 0.78 ? 'dirt' : 'grass', cx + Math.cos(a) * r * 0.82, y, cz + Math.sin(a) * r * 0.82, 6.5 + n * 3, height * 0.5, 5.5 + n * 3, a, 'floor')
		}
	}
	kit.box('grass', cx, height * 0.9, cz, radius * 0.7, height * 0.5, radius * 0.62, seed, 'floor')
}

export const woodsMeta = {
	id: 'woods',
	name: 'Лес',
	size: SIZE,
	duration: 40 * 60,
	minLevel: 5,
	lightBudget: 14,
	lootCount: LOOT_MILL.length + LOOT_WORLD.length + LOOT_ROCK.length,
	lootRich: 1.15,
	bots: { scav: [8, 12], raider: [1, 2], pmcbot: [1, 2], boss: [0, 1] }
}

export function buildWoods(world, ctx, opts) {
	const a = normalizeBuildArgs(world, ctx, opts)
	const night = !!(a.opts && a.opts.night)
	const kit = new MapKit(a.world, a.ctx, {
		id: 'woods',
		name: 'Лес',
		size: SIZE,
		night: night,
		duration: woodsMeta.duration,
		lightBudget: woodsMeta.lightBudget,
		rng: (a.opts && a.opts.rng) || makeRng(a.ctx, 'map:woods')
	})
	const state = { used: 0, budget: LIGHT_CAP, flicker: [] }

	kit.setFog(night ? 0x080d0a : 0x9fb0a4, night ? 0.01 : 0.0045)
	kit.setAmbient({
		color: night ? 0x16241c : 0x93ab92,
		intensity: night ? 0.2 : 0.66,
		sunColor: night ? 0x7d92c4 : 0xfff3d0,
		sunIntensity: night ? 0.1 : 0.92,
		sunPosition: [70, 130, -80]
	})

	kit.ground('grass')
	/* impassable treeline instead of a fence */
	kit.perimeter('foliage', 9, 1.4)

	/* dirt road: sawmill - forester house - old station */
	kit.box('dirt', -10, 0.05, 6, 120, 0.1, 7, 0.06, 'floor')
	kit.box('dirt', -46, 0.05, 26, 7, 0.1, 46, 0, 'floor')
	kit.box('dirt', 20, 0.05, 44, 7, 0.1, 52, 0.04, 'floor')
	for (let i = 0; i < 30; i++) {
		const x = -68 + i * 4.6
		kit.box('gravel', x, 0.08, 6 + Math.sin(i * 0.7) * 1.2, 3.4, 0.06, 2.6, i * 0.3, 'floor')
	}

	/* rolling topography */
	for (let i = 0; i < HILLS.length; i++) {
		const h = HILLS[i]
		hill(kit, h[0], h[1], h[2], h[3], i * 1.9)
	}

	/* the lake in the south east with reed cover */
	kit.box('sand', 62, 0.04, 30, 34, 0.08, 30, 0, 'floor')
	kit.box('water', 62, -0.1, 30, 30, 0.5, 26, 0, 'floor')
	for (let i = 0; i < 26; i++) {
		const a2 = i * 2.39996
		const r = 13 + hashNoise(i, 2.2, i) * 4
		bush(kit, 62 + Math.cos(a2) * r, 30 + Math.sin(a2) * r, 0.8 + hashNoise(r, i, 3.3) * 0.7, a2)
	}

	/* sniper rock in the middle of the forest */
	rockMass(kit, ROCK_X, ROCK_Z, ROCK_R, ROCK_H, 9, 0.6)
	/* scattered boulder field around its feet */
	for (let i = 0; i < 34; i++) {
		const a2 = i * 2.39996 + 0.4
		const r = ROCK_R + 3 + hashNoise(i, 1.1, i) * 12
		const bx = ROCK_X + Math.cos(a2) * r
		const bz = ROCK_Z + Math.sin(a2) * r
		const n = hashNoise(bx, 4.4, bz)
		kit.box(wear(WEAR_STONE, bx, n, bz, 0.05), bx, 0.35 + n * 0.9, bz, 1.8 + n * 2.4, 0.9 + n * 1.8, 1.6 + n * 2, a2 + n, 'rock')
	}

	/* three independent open ended hangars */
	for (let i = 0; i < HANGARS.length; i++) {
		const hg = HANGARS[i]
		hangar(kit, hg[0], hg[1], hg[2], hg[3], hg[4], hg[5])
		lampFixture(kit, state, hg[0], hg[4] - 0.6, hg[1], 0xffdca8, 0.5, 16, i === 1 ? 6 : 0)
	}
	for (let i = 0; i < SAWS.length; i++) {
		sawAssembly(kit, SAWS[i][0], SAWS[i][1], SAWS[i][2])
	}
	for (let i = 0; i < LOGS.length; i++) {
		const l = LOGS[i]
		logPile(kit, l[0], l[1], l[2], l[3], l[4])
	}
	/* sawmill yard: plank stacks, fuel drums, sawdust heaps */
	for (let i = 0; i < 10; i++) {
		const px = MILL_X - 16 + i * 3.6
		const layers = 4 + Math.floor(hashNoise(px, 1.4, MILL_Z) * 5)
		for (let b = 0; b < layers; b++) {
			kit.box(wear(WEAR_WOOD, px, b, MILL_Z + 8, 0.1), px, 0.14 + b * 0.24, MILL_Z + 8, 3.2, 0.22, 1.3, (b % 2) * 0.04, 'crate')
		}
	}
	for (let i = 0; i < 8; i++) {
		const a2 = i * 0.785
		kit.cylinder(METAL_RUST, MILL_X + 8 + Math.cos(a2) * 2.6, 0.45, MILL_Z - 6 + Math.sin(a2) * 2.6, 0.42, 0.9, 'crate')
	}

	/* power line clearing across the north */
	for (let i = 0; i < PYLONS.length; i++) {
		const p = PYLONS[i]
		for (let s = 0; s < 5; s++) {
			const y = 2 + s * 3.4
			const spread = 2.6 - s * 0.36
			kit.box(METAL_RUST, p[0] - spread, y, p[1], 0.26, 3.4, 0.26, 0, 'column')
			kit.box(METAL_RUST, p[0] + spread, y, p[1], 0.26, 3.4, 0.26, 0, 'column')
			kit.box('rail', p[0], y + 1.7, p[1], spread * 2, 0.14, 0.14, 0, 'decor')
		}
		kit.box(METAL_RUST, p[0], 18.4, p[1], 7.4, 0.3, 0.3, 0, 'decor')
		if (i < PYLONS.length - 1) {
			kit.box('rubber', (p[0] + PYLONS[i + 1][0]) * 0.5, 17.4, p[1] + 2.6, 26, 0.1, 0.1, 0, 'decor')
			kit.box('rubber', (p[0] + PYLONS[i + 1][0]) * 0.5, 17.4, p[1] - 2.6, 26, 0.1, 0.1, 0, 'decor')
		}
	}

	for (let i = 0; i < BUILDINGS.length; i++) {
		kit.building(BUILDINGS[i])
	}

	/* bunker berm and hermetic door frame */
	kit.box('dirt', 58, 1.2, 44, 20, 2.4, 5, 0, 'wall')
	kit.box(CONCRETE_WORN, 58, 1.4, 41.6, 5.4, 2.8, 1.2, 0, 'wall')
	const bunkerDoor = kit.door(58, 0, 41, 0, 2.2, 'Гермодверь ЗБ-016', 'key_bunker_woods')
	bunkerDoor.armored = true
	bunkerDoor.breakable = false
	bunkerDoor.hp = 900
	lampFixture(kit, state, 58, 3, 41, 0xff5a3c, 0.45, 10, 8)

	/*
	 * Foliage: golden angle annulus scatter. POI radii are punched out so
	 * the camps stay open while the whole perimeter fills with hard cover.
	 */
	let placed = 0
	for (let i = 0; i < 480 && placed < TREE_COUNT; i++) {
		const ang = i * 2.39996
		const r = 30 + Math.sqrt((i + 0.5) / 480) * 50
		const x = Math.cos(ang) * r + (hashNoise(i, 1.7, r) - 0.5) * 8
		const z = Math.sin(ang) * r + (hashNoise(r, 3.3, i) - 0.5) * 8
		if (x < -81 || x > 81 || z < -81 || z > 81) continue
		if (nearPoi(x, z)) continue
		pineTree(kit, x, z, 0.72 + hashNoise(x, 5.1, z) * 0.62, ang)
		placed++
		if (i % 3 === 0) bush(kit, x + 2.4, z - 2.1, 0.7 + hashNoise(z, 6.2, x) * 0.8, ang + 0.9)
	}
	/* inner groves between the points of interest */
	const GROVES = [[-40, -40], [34, -28], [-14, 24], [46, 8], [-66, 60], [10, -52]]
	for (let g = 0; g < GROVES.length; g++) {
		for (let i = 0; i < 9; i++) {
			const ang = i * 2.39996 + g
			const r = 2 + Math.sqrt((i + 0.5) / 9) * 9
			const x = GROVES[g][0] + Math.cos(ang) * r
			const z = GROVES[g][1] + Math.sin(ang) * r
			if (nearPoi(x, z)) continue
			pineTree(kit, x, z, 0.8 + hashNoise(x, g, z) * 0.5, ang)
		}
	}
	/* fallen trunks as low cover on the sightlines */
	const FALLEN = [[-18, 10, 0.4], [8, 30, 1.2], [-34, 52, 2.6], [40, -8, 0.8], [-58, -14, 1.9], [26, -46, 2.2], [66, -14, 0.5], [-8, -62, 1.1]]
	for (let i = 0; i < FALLEN.length; i++) {
		const f = FALLEN[i]
		kit.box('bark', f[0], 0.55, f[1], 1.1, 1.1, 9.5, f[2], 'tree')
		kit.box('foliage', f[0] + Math.sin(f[2]) * 5.4, 0.9, f[1] + Math.cos(f[2]) * 5.4, 3.4, 1.8, 3.4, f[2], 'decor')
	}

	for (let i = 0; i < LOOT_MILL.length; i++) {
		const l = LOOT_MILL[i]
		kit.loot(l[0], l[1], l[2], l[3], l[0] === 'safe' ? 'Общак Штурмана' : null, l[4])
	}
	for (let i = 0; i < LOOT_WORLD.length; i++) {
		const l = LOOT_WORLD[i]
		kit.loot(l[0], l[1], l[2], l[3], null, l[4])
	}
	for (let i = 0; i < LOOT_ROCK.length; i++) {
		const l = LOOT_ROCK[i]
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
	map.meta = woodsMeta
	map.flickerLights = state.flicker
	return map
}

export default buildWoods
