import { MapKit, normalizeBuildArgs, makeRng } from './_kit.js'

/*
 * Interchange (Razvyazka) - claustrophobic close quarters inside the
 * ULTRA mega-mall.
 *
 * The requested core enclosure is exactly:
 *     kit.box('concrete', 0, 4.5, 0, 90, 9.0, 60)
 * A single solid box would fill the whole playable volume with collision,
 * so CORE below carries those exact numbers and the shell is forged from
 * them: ground slab, roof grid and four segmented facades occupy precisely
 * the 90 x 9.0 x 60 envelope centred on y = 4.5, and the inside stays
 * hollow and playable.
 *
 * 1. Three anchor hypermarkets from procedural rows: GOSHAN (monolithic
 *    food counters plus a long cash register line), OLI (metal rack arrays
 *    loaded with toolboxes under dark green industrial lighting), IDEA
 *    (blue / yellow display arrays and a maze of furniture partitions).
 * 2. Underground parking tier at Y = -4 with a massive concrete pillar
 *    grid and broken low intensity safety lamps - most fixtures are
 *    emissive only, so the tier stays pitch dark for flashlight and NVG.
 *
 * NOTE: _kit.js has no per instance tint, so the IDEA 'color arrays' are
 * arrays of real material keys, and 'concrete_worn' is bound to a wear
 * ladder over existing keys.
 */

const SIZE = 160
const HALF = 80
/* exact core enclosure spec */
const CORE = { mat: 'concrete', x: 0, y: 4.5, z: 0, w: 90, h: 9.0, d: 60 }
const MALL_HW = CORE.w * 0.5
const MALL_HD = CORE.d * 0.5
const MALL_TOP = CORE.y + CORE.h * 0.5
const WALL_T = 0.6
const FLOOR2 = 4.6
const PARK_Y = -4
const LIGHT_CAP = 17

const METAL_RUST = 'rust'
const CONCRETE_WORN = 'concrete'

const WEAR_CONC = ['concrete', 'kerb', 'brick']
const WEAR_IRON = ['metal', 'corrugated', 'rust']
const WEAR_TILE = ['tile', 'plaster', 'concrete']
/* IDEA display palettes - material keys standing in for the blue/yellow arrays */
const IDEA_BLUE = ['plastic', 'glass', 'fabric']
const IDEA_YELLOW = ['wood', 'plank', 'sand']

/* anchor sections: id name x0 x1 */
const ANCHORS = [
	['goshan', 'ГОШАН', -43, -16],
	['oli', 'ОЛИ', -14, 14],
	['idea', 'ИДЕЯ', 16, 43]
]
/* facade openings per face index */
const OPENINGS = [[3, 11], [4, 10], [4], [5]]
const ENTRIES = ['Северный вход', 'Южный вход', 'Западный вход', 'Восточный вход']
/* slab wells for stairs and escalators: x z w d */
const WELLS = [[-34, -20, 6, 6], [0, 21, 8, 7], [34, -18, 6, 6], [-2, -24, 8, 6]]
/* atrium void: x z w d */
const ATRIUM = [0, 0, 20, 14]

const BUILDINGS = [
	{ x: -62, z: 42, w: 20, d: 14, h: 6.5, surf: 'concrete', t: 0.6, doorWidth: 2.2, name: 'Подстанция', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'concrete', partitions: 2, lamp: true, lampColor: 0xffe0a0, lampIntensity: 0.5, lampRange: 16, keyId: 'key_mall_west' },
	{ x: 60, z: -46, w: 16, d: 10, h: 4.2, surf: 'plaster', t: 0.45, doorWidth: 2.4, name: 'Заправка у развязки', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'concrete', partitions: 2, lamp: true, lampColor: 0xfff0cc, lampIntensity: 0.5, lampRange: 16 },
	{ x: -58, z: -50, w: 7, d: 5, h: 3, surf: 'tent', t: 0.24, doorWidth: 1.3, name: 'Лагерь Диких 1', floor: true, floorSurf: 'fabric', roof: true, roofSurf: 'tent', partitions: 1, lamp: false },
	{ x: -50, z: -56, w: 7, d: 5, h: 3, surf: 'camo', t: 0.24, doorWidth: 1.3, name: 'Лагерь Диких 2', floor: true, floorSurf: 'fabric', roof: true, roofSurf: 'camo', partitions: 1, lamp: true, lampColor: 0xffb070, lampIntensity: 0.35, lampRange: 10 },
	{ x: 66, z: 48, w: 12, d: 8, h: 3.4, surf: 'brick', t: 0.4, doorWidth: 1.4, name: 'КПП ЭМЕРКОМ', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'concrete', partitions: 1, lamp: true, lampColor: 0xffe4b4, lampIntensity: 0.45, lampRange: 12 },
	{ x: -70, z: -8, w: 9, d: 6, h: 3.2, surf: 'metal', t: 0.5, doorWidth: 1.2, name: 'Убежище', floor: true, floorSurf: 'concrete', roof: true, roofSurf: 'metal', partitions: 1, lamp: true, lampColor: 0x9fffc8, lampIntensity: 0.3, lampRange: 9, keyId: 'key_mall_west' }
]

const LOOT_GOSHAN = [['crate', -38, 0.4, -12, 1.3], ['crate', -30, 0.4, 6, 1.3], ['med', -22, 0.4, -6, 1.5], ['jacket', -34, 0.4, 18, 1.4], ['crate', -18, 0.4, -20, 1.2], ['tool', -26, 0.4, 22, 1.3]]
const LOOT_OLI = [['tool', -10, 0.4, -14, 1.6], ['tool', -2, 0.4, 8, 1.6], ['crate', 6, 0.4, -8, 1.4], ['gun', 10, 0.4, 16, 1.8], ['safe', 0, 0.4, -22, 2.2], ['med', -6, 0.4, 20, 1.4]]
const LOOT_IDEA = [['jacket', 20, 0.4, -10, 1.5], ['crate', 28, 0.4, 4, 1.3], ['jacket', 36, 0.4, -18, 1.5], ['crate', 40, 0.4, 16, 1.3], ['med', 24, 0.4, 22, 1.4], ['gun', 32, 0.4, -2, 1.7]]
const LOOT_MEZZ = [['safe', -30, 5, -24, 2.4], ['gun', 0, 5, 25, 2.2], ['jacket', 30, 5, -24, 1.9], ['crate', 40, 5, 24, 1.7], ['tool', -40, 5, 24, 1.7], ['med', 12, 5, -25, 1.6]]
const LOOT_PARK = [['crate', -36, -3.7, -20, 1.3], ['tool', -12, -3.7, 12, 1.4], ['crate', 18, -3.7, -14, 1.3], ['gun', 36, -3.7, 18, 1.9], ['jacket', 0, -3.7, -24, 1.5], ['safe', 30, -3.7, -24, 2.3], ['med', -24, -3.7, 22, 1.4], ['crate', 42, -3.7, 0, 1.2]]
const LOOT_OUT = [['crate', -62, 0, 42, 1.4], ['tool', -62, 0, 46, 1.5], ['crate', 60, 0, -46, 1.3], ['med', 66, 0, 48, 1.4], ['jacket', -58, 0, -50, 1.3], ['crate', -50, 0, -56, 1.2], ['crate', -70, 0, -8, 2], ['gun', 70, 0, 20, 1.6]]

const SPAWN_PMC = [[-74, 0, -70], [74, 0, -70], [-74, 0, 70], [74, 0, 70], [0, 0, -74], [0, 0, 74], [-76, 0, 20], [76, 0, -20]]
const SPAWN_SCAV = [[-38, 0, -20], [-20, 0, 20], [0, 0, -26], [22, 0, 24], [40, 0, -22], [-62, 0, 46], [60, 0, -50], [66, 0, 52], [-54, 0, -54], [12, 0, 34]]
const SPAWN_RAIDER = [[-30, -3.7, -18], [10, -3.7, 14], [-6, -3.7, -24], [34, -3.7, 20]]
const SPAWN_PMCBOT = [[-30, 5, -24], [30, 5, 24], [0, 5, 25], [-40, 0, 8]]
/* Killa holds the mall core */
const SPAWN_BOSS = [[-2, 0, 0], [-14, 0, -12]]
const SPAWN_BOT = [[-44, 0, 0], [44, 0, 0], [0, 0, -34], [0, 0, 34], [-56, 0, 24], [56, 0, -24], [-24, 0, -40], [24, 0, 40], [-70, 0, -30], [70, 0, 30], [-16, -3.7, 0], [16, -3.7, 0], [-40, 5, -20], [40, 5, 20], [8, 0, -20]]

const EXITS = [
	{ id: 'interchange:emercom', name: 'КПП ЭМЕРКОМ', x: 72, z: 54, radius: 4, afterSec: 600, note: 'Открывается со второй половины рейда' },
	{ id: 'interchange:railway', name: 'Железная дорога', x: 74, z: 8, radius: 4.2, noBotsNear: 16, note: 'Восточная ветка' },
	{ id: 'interchange:hole', name: 'Дыра в заборе', x: -76, z: 62, radius: 3.2, freeHands: true, note: 'Только с пустыми руками' },
	{ id: 'interchange:scavcamp', name: 'Лагерь Диких', x: -54, z: -62, radius: 3.6, faction: 'scav', note: 'Только за Дикого' },
	{ id: 'interchange:powerstation', name: 'Подстанция (платный)', x: -70, z: 38, radius: 3.4, cost: 8000, note: 'Платный выход' },
	{ id: 'interchange:saferoom', name: 'Убежище', x: -76, z: -8, radius: 2.8, needKey: 'key_mall_west', note: 'Нужен ключ от западного крыла' },
	{ id: 'interchange:parking', name: 'Выезд из паркинга', x: -34, z: 44, radius: 3.4, needKey: 'key_medblock', note: 'Гермодверь нижнего уровня' },
	{ id: 'interchange:transfer', name: 'Переход в Лабораторию', x: 34, z: 44, radius: 3.6, transfer: 'lab', cost: 12000, note: 'Лифт в TerraGroup Labs' }
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

function inRect(x, z, r) {
	return Math.abs(x - r[0]) < r[2] * 0.5 && Math.abs(z - r[1]) < r[3] * 0.5
}

function inWell(x, z) {
	for (let i = 0; i < WELLS.length; i++) {
		if (inRect(x, z, WELLS[i])) return true
	}
	return false
}

function railing(kit, x1, z1, x2, z2, y) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 0.6) return
	const yaw = Math.atan2(dx, dz)
	kit.box('rail', x1 + dx * 0.5, y + 1.04, z1 + dz * 0.5, 0.08, 0.08, len, yaw, 'decor')
	kit.box('glass', x1 + dx * 0.5, y + 0.56, z1 + dz * 0.5, 0.06, 0.9, len, yaw, 'glass')
	const posts = Math.max(2, Math.round(len / 2.4))
	for (let i = 0; i <= posts; i++) {
		kit.box('metal', x1 + dx * (i / posts), y + 0.55, z1 + dz * (i / posts), 0.1, 1.1, 0.1, yaw, 'decor')
	}
}

function stairFlight(kit, x, z, yaw, yFrom, yTo, width) {
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const steps = Math.max(4, Math.round(Math.abs(yTo - yFrom) / 0.24))
	const rise = (yTo - yFrom) / steps
	for (let i = 0; i < steps; i++) {
		const t = (i + 0.5) * 0.36
		kit.box('concrete', x + dirX * t, yFrom + rise * (i + 0.5), z + dirZ * t, width, Math.abs(rise) + 0.08, 0.36, yaw, 'floor')
	}
	const runLen = steps * 0.36
	const midY = yFrom + (yTo - yFrom) * 0.5
	kit.box('metal', x + dirX * runLen * 0.5, midY - 0.3, z + dirZ * runLen * 0.5, width + 0.14, 0.16, runLen, yaw, 'decor')
	kit.box(wear(WEAR_TILE, x, yTo, z, 0.1), x + dirX * (runLen + 0.9), yTo, z + dirZ * (runLen + 0.9), width + 0.4, 0.22, 1.8, yaw, 'roof')
	return runLen
}

/* escalator: a flight plus glass balustrades and a comb plate */
function escalator(kit, x, z, yaw, yFrom, yTo, width) {
	const runLen = stairFlight(kit, x, z, yaw, yFrom, yTo, width)
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const midY = yFrom + (yTo - yFrom) * 0.5
	for (let s = -1; s <= 1; s += 2) {
		kit.box('glass', x + dirX * runLen * 0.5 + dirZ * s * width * 0.55, midY + 0.75, z + dirZ * runLen * 0.5 - dirX * s * width * 0.55, 0.08, 1.05, runLen, yaw, 'glass')
		kit.box(METAL_RUST, x + dirX * runLen * 0.5 + dirZ * s * width * 0.55, midY + 1.32, z + dirZ * runLen * 0.5 - dirX * s * width * 0.55, 0.22, 0.14, runLen, yaw, 'decor')
	}
	kit.box('metal', x - dirX * 0.5, yFrom + 0.12, z - dirZ * 0.5, width, 0.2, 1, yaw, 'floor')
}

function windowBand(kit, cx, cy, cz, len, yaw, height, thickness) {
	const panes = Math.max(2, Math.round(len / 2.2))
	const step = len / panes
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	for (let i = 0; i < panes; i++) {
		const t = -len * 0.5 + step * (i + 0.5)
		if (hashNoise(cx + t, cy, cz) > 0.7) continue
		kit.box('glass', cx + dirX * t, cy, cz + dirZ * t, thickness, height, step - 0.2, yaw, 'glass')
	}
	for (let i = 0; i <= panes; i++) {
		const t = -len * 0.5 + step * i
		kit.box('metal', cx + dirX * t, cy, cz + dirZ * t, thickness + 0.1, height + 0.08, 0.16, yaw, 'decor')
	}
}

/* fixture housing always renders, the real light is optional and budgeted */
function lampFixture(kit, state, x, y, z, color, power, range, hz, real) {
	kit.box('metal', x, y + 0.16, z, 0.5, 0.12, 0.36, 0, 'decor')
	kit.box('lamp', x, y, z, 0.4, 0.14, 0.28, 0, 'decor')
	if (!real || state.used >= state.budget) return null
	state.used++
	const light = kit.lamp(x, y, z, color, power, range)
	if (light && hz > 0) {
		const spec = { hz: hz, min: power * 0.15, max: power, phase: state.used * 0.618034 }
		state.flicker.push({ light: light, hz: spec.hz, min: spec.min, max: spec.max, phase: spec.phase })
		if (light.userData) light.userData.flicker = spec
	}
	return light
}

/* GOSHAN: monolithic counter run with chillers and produce crates */
function counterRow(kit, cx, cz, len) {
	kit.box(wear(WEAR_TILE, cx, 1, cz, 0.1), cx, 0.55, cz, 1.6, 1.1, len, 0, 'crate')
	kit.box('metal', cx, 1.14, cz, 1.7, 0.12, len, 0, 'roof')
	kit.box('glass', cx, 1.55, cz, 1.5, 0.7, len, 0, 'glass')
	const bays = Math.max(4, Math.round(len / 3))
	for (let i = 0; i < bays; i++) {
		const z = cz - len * 0.5 + (len / bays) * (i + 0.5)
		const n = hashNoise(cx, i, z)
		kit.box(n > 0.5 ? 'plastic' : 'fabric', cx, 1.32, z, 1.2, 0.24, (len / bays) - 0.4, 0, 'crate')
		if (n > 0.72) kit.box('metal', cx, 2.3, z, 1.4, 1.2, 1.6, 0, 'machine')
	}
}

/* GOSHAN: till desk, belt, monitor and queue rails */
function tillLine(kit, x, z) {
	kit.box('plastic', x, 0.5, z, 1.4, 1, 3.4, 0, 'crate')
	kit.box('metal', x, 1.05, z - 0.6, 1.2, 0.12, 2, 0, 'roof')
	kit.box('rubber', x, 1.12, z - 0.6, 0.9, 0.06, 1.9, 0, 'decor')
	kit.box('plastic', x + 0.4, 1.45, z + 1.2, 0.5, 0.7, 0.5, 0.4, 'machine')
	kit.box('glass', x + 0.4, 1.5, z + 1.2, 0.06, 0.5, 0.42, 0.4, 'glass')
	for (let i = 0; i < 3; i++) {
		kit.box('rail', x - 1.6, 0.55, z - 1.4 + i * 1.4, 0.08, 1.1, 1.3, 0, 'decor')
	}
}

/* OLI: warehouse rack with three loaded shelf levels */
function rackRow(kit, cx, cz, len, levels) {
	for (let s = -1; s <= 1; s += 2) {
		const posts = Math.max(3, Math.round(len / 3))
		for (let p = 0; p <= posts; p++) {
			kit.box(METAL_RUST, cx + s * 0.6, 1.9, cz - len * 0.5 + (len / posts) * p, 0.16, 3.8, 0.16, 0, 'column')
		}
	}
	for (let lv = 0; lv < levels; lv++) {
		kit.box('metal', cx, 0.35 + lv * 1.4, cz, 1.5, 0.12, len, 0, 'roof')
		kit.box('rail', cx, 0.35 + lv * 1.4 + 0.55, cz - len * 0.5, 1.5, 0.1, 0.1, 0, 'decor')
	}
	kit.box('metal', cx, 3.85, cz, 1.6, 0.14, len, 0, 'roof')
}

/* parked or wrecked car body */
function carBody(kit, x, z, yaw, key) {
	kit.box(key, x, 0.72, z, 4.4, 1, 1.9, yaw, 'container')
	kit.box(key, x, 1.5, z, 2.4, 0.78, 1.8, yaw, 'container')
	kit.box('glass', x, 1.5, z, 2.42, 0.5, 1.84, yaw, 'glass')
	for (let w = 0; w < 4; w++) {
		const ox = w < 2 ? -1.5 : 1.5
		const oz = w % 2 === 0 ? -0.95 : 0.95
		kit.cylinder('rubber', x + Math.cos(yaw) * ox + Math.sin(yaw) * oz, 0.34, z - Math.sin(yaw) * ox + Math.cos(yaw) * oz, 0.34, 0.3, 'decor', false)
	}
}

export const interchangeMeta = {
	id: 'interchange',
	name: 'Развязка',
	size: SIZE,
	duration: 35 * 60,
	minLevel: 8,
	lightBudget: 22,
	lootCount: LOOT_GOSHAN.length + LOOT_OLI.length + LOOT_IDEA.length + LOOT_MEZZ.length + LOOT_PARK.length + LOOT_OUT.length,
	lootRich: 1.45,
	indoor: true,
	bots: { scav: [8, 12], raider: [2, 4], pmcbot: [1, 2], boss: [0, 1] }
}

export function buildInterchange(world, ctx, opts) {
	const a = normalizeBuildArgs(world, ctx, opts)
	const night = !!(a.opts && a.opts.night)
	const kit = new MapKit(a.world, a.ctx, {
		id: 'interchange',
		name: 'Развязка',
		size: SIZE,
		night: night,
		duration: interchangeMeta.duration,
		lightBudget: interchangeMeta.lightBudget,
		rng: (a.opts && a.opts.rng) || makeRng(a.ctx, 'map:interchange')
	})
	const state = { used: 0, budget: LIGHT_CAP, flicker: [] }

	kit.setFog(night ? 0x05070a : 0x7c848c, night ? 0.014 : 0.006)
	kit.setAmbient({
		color: night ? 0x131a24 : 0x7f8b96,
		intensity: night ? 0.14 : 0.5,
		sunColor: night ? 0x5c74a0 : 0xffeed0,
		sunIntensity: night ? 0.06 : 0.78,
		sunPosition: [110, 150, -70],
		indoor: true
	})

	kit.ground('asphalt')
	kit.perimeter('corrugated', 6.5, 0.6)

	/*
	 * Ground slab of the core enclosure, laid as a tile grid so the stair
	 * and escalator wells stay open down to the parking tier.
	 */
	for (let sx = 0; sx < 15; sx++) {
		const px = -MALL_HW + 3 + sx * 6
		for (let sz = 0; sz < 10; sz++) {
			const pz = -MALL_HD + 3 + sz * 6
			if (inWell(px, pz)) continue
			kit.box(wear(WEAR_TILE, px, 0, pz, 0.05), px, 0.1, pz, 6, 0.4, 6, 0, 'floor')
		}
	}
	/* roof grid: corrugated deck with glazed skylights over the atrium */
	for (let sx = 0; sx < 15; sx++) {
		const px = -MALL_HW + 3 + sx * 6
		for (let sz = 0; sz < 10; sz++) {
			const pz = -MALL_HD + 3 + sz * 6
			const sky = Math.abs(px) < 24 && Math.abs(pz) < 12 && (sx + sz) % 2 === 0
			kit.box(sky ? 'glass' : 'corrugated', px, MALL_TOP - 0.2, pz, 6, 0.4, 6, 0, sky ? 'glass' : 'roof')
		}
	}
	/* roof plant: AC blocks and a parapet ring */
	for (let i = 0; i < 10; i++) {
		kit.box(wear(WEAR_IRON, i, MALL_TOP, i * 2, 0.2), -36 + i * 8, MALL_TOP + 0.9, -18 + (i % 3) * 16, 3.4, 1.4, 2.6, (i % 4) * 0.1, 'machine')
	}

	/* four segmented facades of the enclosure */
	const FACES = [[0, -MALL_HD, CORE.w, 1.5708], [0, MALL_HD, CORE.w, 1.5708], [-MALL_HW, 0, CORE.d, 0], [MALL_HW, 0, CORE.d, 0]]
	for (let i = 0; i < FACES.length; i++) {
		const f = FACES[i]
		const dirX = Math.sin(f[3])
		const dirZ = Math.cos(f[3])
		const segs = Math.round(f[2] / 6)
		for (let s = 0; s < segs; s++) {
			const t = -f[2] * 0.5 + 6 * (s + 0.5)
			const sx = f[0] + dirX * t
			const sz = f[1] + dirZ * t
			const open = OPENINGS[i].indexOf(s) >= 0
			if (open) {
				kit.box(CONCRETE_WORN, sx, 3.7, sz, WALL_T, 1.4, 5.96, f[3], 'wall')
				const door = kit.door(sx, 0, sz, f[3] + 1.5708, 2.6, ENTRIES[i], null)
				door.breakable = true
				door.hp = 70
				door.surface = 'glass'
			} else {
				kit.box(wear(WEAR_CONC, sx, 1, sz, 0.05), sx, 1.6, sz, WALL_T, 3.2, 5.96, f[3], 'wall')
				windowBand(kit, sx, 3.9, sz, 5.96, f[3], 1.1, WALL_T * 0.6)
			}
			kit.box(wear(WEAR_CONC, sx, 6, sz, 0.1), sx, 6.6, sz, WALL_T, 4.4, 5.96, f[3], 'wall')
			if (s % 2 === 0) windowBand(kit, sx, 6.4, sz, 5.96, f[3], 2.4, WALL_T * 0.5)
			kit.box(wear(WEAR_CONC, sx, MALL_TOP, sz, 0.2), sx, MALL_TOP + 0.7, sz, WALL_T + 0.3, 1.4, 5.96, f[3], 'wall')
		}
	}

	/* interior structural columns on both levels */
	for (let gx = 0; gx < 8; gx++) {
		for (let gz = 0; gz < 5; gz++) {
			const px = -MALL_HW + 6 + gx * 11
			const pz = -MALL_HD + 6 + gz * 12
			if (inRect(px, pz, ATRIUM)) continue
			kit.cylinder('concrete', px, 2.3, pz, 0.5, 4.6, 'column')
			kit.cylinder('concrete', px, FLOOR2 + 2.1, pz, 0.44, 4.2, 'column')
		}
	}

	/* GOSHAN: long monolithic counters plus the cash register line */
	for (let i = 0; i < 6; i++) {
		const cx = ANCHORS[0][2] + 2.5 + i * 4.4
		counterRow(kit, cx, -2, 44)
	}
	for (let i = 0; i < 9; i++) {
		tillLine(kit, ANCHORS[0][2] + 2 + i * 3.1, 25)
	}
	for (let i = 0; i < 3; i++) {
		lampFixture(kit, state, ANCHORS[0][2] + 6 + i * 9, 4.2, -6 + i * 12, 0xfff4dc, 0.4, 18, i === 2 ? 5 : 0, true)
	}
	/* trolley park at the entrance */
	for (let i = 0; i < 8; i++) {
		kit.box('rail', -40 + i * 1.3, 0.6, 27, 0.9, 1, 1.7, 0.1, 'crate')
	}

	/* OLI: rack arrays loaded with toolboxes, dark green industrial light */
	for (let i = 0; i < 7; i++) {
		const rx = ANCHORS[1][2] + 2 + i * 4
		rackRow(kit, rx, 0, 46, 3)
		for (let s = 0; s < 3; s++) {
			for (let b = 0; b < 8; b++) {
				const bz = -22 + b * 6.2
				const n = hashNoise(rx, s + b, bz)
				if (n < 0.2) continue
				kit.box(n > 0.6 ? 'metal' : 'plastic', rx + (b % 2 === 0 ? 0.36 : -0.36), 0.62 + s * 1.4, bz, 0.78, 0.46, 0.62, 0, 'crate')
				if ((i + b + s) % 7 === 0) kit.loot('tool', rx, 0.62 + s * 1.4, bz, 'ОЛИ: стеллаж', 1.6)
			}
		}
		lampFixture(kit, state, rx, 4.2, (i % 2 === 0 ? -14 : 14), 0x2fff9a, 0.24, 13, 4.5, i % 3 === 0)
	}
	/* OLI tool counter and pallet jacks */
	kit.box(METAL_RUST, 0, 0.55, -26, 24, 1.1, 1.4, 0, 'crate')
	for (let i = 0; i < 5; i++) {
		kit.box('metal', -8 + i * 4, 0.3, 26, 1.9, 0.6, 0.9, (i % 2) * 0.2, 'machine')
	}

	/* IDEA: blue/yellow display arrays inside a maze of partitions */
	for (let c = 0; c < 8; c++) {
		for (let r = 0; r < 6; r++) {
			const cw = (ANCHORS[2][3] - ANCHORS[2][2]) / 8
			const cd = 48 / 6
			const cx = ANCHORS[2][2] + cw * (c + 0.5)
			const cz = -24 + cd * (r + 0.5)
			const n = hashNoise(c * 3.1, r * 1.7, 7.7)
			const pal = (c + r) % 2 === 0 ? IDEA_BLUE : IDEA_YELLOW
			/* maze partition wall, orientation and presence both hashed */
			if (n > 0.3) {
				const vert = n > 0.65
				kit.box(pal[0], cx, 1.15, cz, vert ? 0.3 : cw * 0.82, 2.3, vert ? cd * 0.82 : 0.3, 0, 'wall')
				kit.box(pal[1], cx, 2.36, cz, vert ? 0.34 : cw * 0.84, 0.12, vert ? cd * 0.84 : 0.34, 0, 'roof')
			}
			/* display furniture: wardrobe, sofa set, table set or shelf wall */
			const v = Math.floor(n * 4) % 4
			if (v === 0) {
				kit.box(pal[2], cx - 1.4, 1.05, cz + 1.2, 1.2, 2.1, 0.7, n, 'crate')
				kit.box(pal[0], cx + 1.2, 1.05, cz + 1.2, 1.2, 2.1, 0.7, n + 0.2, 'crate')
			} else if (v === 1) {
				kit.box('fabric', cx, 0.42, cz - 1.4, 2.2, 0.85, 0.95, n, 'crate')
				kit.box('fabric', cx - 1.5, 0.42, cz, 0.95, 0.85, 1.9, n + 1.5, 'crate')
				kit.box(pal[1], cx, 0.3, cz + 0.4, 1.3, 0.6, 0.8, n, 'crate')
			} else if (v === 2) {
				kit.box(pal[1], cx, 0.4, cz, 2.1, 0.8, 1.1, n, 'crate')
				for (let k = 0; k < 4; k++) {
					kit.box(pal[2], cx - 0.9 + (k % 2) * 1.8, 0.28, cz - 0.9 + Math.floor(k / 2) * 1.8, 0.5, 0.55, 0.5, n + k, 'crate')
				}
			} else {
				for (let k = 0; k < 4; k++) {
					kit.box(pal[k % 3], cx + 1, 0.35 + k * 0.62, cz, 1.6, 0.14, 2.4, 0, 'roof')
				}
				kit.box(pal[0], cx + 1.8, 1.3, cz, 0.2, 2.6, 2.4, 0, 'wall')
			}
			if ((c + r) % 6 === 0) kit.loot('crate', cx, 0.4, cz, 'ИДЕЯ: витрина', 1.35)
		}
	}
	for (let i = 0; i < 3; i++) {
		lampFixture(kit, state, 20 + i * 10, 4.2, -16 + i * 16, 0xffe27a, 0.34, 15, i === 1 ? 6 : 0, i !== 2)
	}

	/* mezzanine ring around the atrium void, with escalators */
	for (let sx = 0; sx < 15; sx++) {
		const px = -MALL_HW + 3 + sx * 6
		for (let sz = 0; sz < 10; sz++) {
			const pz = -MALL_HD + 3 + sz * 6
			if (Math.abs(px) < 27 && Math.abs(pz) < 18) continue
			if (inRect(px, pz, WELLS[1])) continue
			kit.box(wear(WEAR_TILE, px, FLOOR2, pz, 0.05), px, FLOOR2 + 0.15, pz, 6, 0.3, 6, 0, 'floor')
		}
	}
	railing(kit, -27, -18, 27, -18, FLOOR2 + 0.3)
	railing(kit, -27, 18, 27, 18, FLOOR2 + 0.3)
	railing(kit, -27, -18, -27, 18, FLOOR2 + 0.3)
	railing(kit, 27, -18, 27, 18, FLOOR2 + 0.3)
	escalator(kit, -6, 20, 3.14159, 0.4, FLOOR2, 2.4)
	escalator(kit, 6, -20, 0, 0.4, FLOOR2, 2.4)
	/* upper level kiosks */
	for (let i = 0; i < 10; i++) {
		const kx = -40 + i * 9
		const kz = i % 2 === 0 ? -24 : 24
		kit.box(wear(WEAR_TILE, kx, FLOOR2, kz, 0.2), kx, FLOOR2 + 1.6, kz, 7, 2.8, 0.3, 0, 'wall')
		kit.box('glass', kx, FLOOR2 + 1.5, kz + (i % 2 === 0 ? 0.9 : -0.9), 6.4, 2.2, 0.12, 0, 'glass')
		kit.box('plastic', kx, FLOOR2 + 0.6, kz + (i % 2 === 0 ? 1.8 : -1.8), 3.4, 1, 0.9, 0, 'crate')
	}

	/*
	 * Underground parking tier at Y = -4. Deliberately underlit: 24
	 * fixtures, only a handful driving a real low intensity lamp, so the
	 * bays stay pitch black for flashlight and night vision play.
	 */
	kit.box('concrete', 0, PARK_Y - 0.25, 0, CORE.w, 0.5, CORE.d, 0, 'floor')
	const PFACES = [[0, -MALL_HD, CORE.w, 1.5708, [7]], [0, MALL_HD, CORE.w, 1.5708, [2, 12]], [-MALL_HW, 0, CORE.d, 0, [5]], [MALL_HW, 0, CORE.d, 0, [4]]]
	for (let i = 0; i < PFACES.length; i++) {
		const f = PFACES[i]
		const dirX = Math.sin(f[3])
		const dirZ = Math.cos(f[3])
		const segs = Math.round(f[2] / 6)
		for (let s = 0; s < segs; s++) {
			if (f[4].indexOf(s) >= 0) continue
			const t = -f[2] * 0.5 + 6 * (s + 0.5)
			kit.box(wear(WEAR_CONC, f[0] + dirX * t, PARK_Y, f[1] + dirZ * t, 0.1), f[0] + dirX * t, PARK_Y + 1.8, f[1] + dirZ * t, 0.7, 3.6, 5.96, f[3], 'wall')
		}
	}
	/* massive supporting pillar grid: 15 x 9 */
	for (let gx = 0; gx < 15; gx++) {
		for (let gz = 0; gz < 9; gz++) {
			const px = -42 + gx * 6
			const pz = -27.5 + gz * 6.875
			kit.cylinder('concrete', px, PARK_Y + 1.8, pz, 0.55, 3.6, 'column')
			kit.box('plaster', px, PARK_Y + 3.5, pz, 1.7, 0.3, 1.7, 0, 'roof')
			if ((gx + gz) % 5 === 0) kit.box('plaster', px, PARK_Y + 1.1, pz, 1.24, 0.5, 1.24, 0.6, 'decor')
		}
	}
	/* bay markings, parked wrecks and service cages */
	for (let i = 0; i < 60; i++) {
		const bx = -42 + (i % 15) * 6
		const bz = -24 + Math.floor(i / 15) * 16
		kit.box('plaster', bx, PARK_Y + 0.02, bz, 0.16, 0.04, 5, 0, 'floor')
		const n = hashNoise(bx, 2.2, bz)
		if (n > 0.62) carBody(kit, bx + 2.9, bz, 0, wear(WEAR_IRON, bx, n, bz, 0.3))
	}
	for (let i = 0; i < 24; i++) {
		const lx = -40 + (i % 8) * 11.4
		const lz = -22 + Math.floor(i / 8) * 22
		const broken = hashNoise(lx, 3.3, lz) > 0.45
		lampFixture(kit, state, lx, PARK_Y + 3.3, lz, 0xbcd2e8, 0.18, 9, broken ? 7.5 : 0, i % 4 === 0)
	}
	for (let i = 0; i < 6; i++) {
		const cx = -36 + i * 15
		for (let b = 0; b < 5; b++) {
			kit.box('rail', cx - 2 + b, PARK_Y + 1.2, 27, 0.1, 2.4, 0.1, 0, 'wall')
		}
		kit.box('rail', cx, PARK_Y + 2.45, 27, 5, 0.12, 0.12, 0, 'decor')
		kit.box(METAL_RUST, cx, PARK_Y + 0.6, 25.6, 2.2, 1.2, 1.4, 0, 'crate')
	}
	/* stair shafts up into the wells, plus the two vehicle ramps */
	for (let i = 0; i < WELLS.length; i++) {
		const w = WELLS[i]
		stairFlight(kit, w[0] - 2, w[1] - 2, i % 2 === 0 ? 1.5708 : 0, PARK_Y, 0.4, 1.6)
		kit.box(wear(WEAR_CONC, w[0], PARK_Y, w[1], 0.2), w[0], PARK_Y + 1.8, w[1] + w[3] * 0.5, w[2], 3.6, 0.4, 0, 'wall')
	}
	for (let i = 0; i < 2; i++) {
		const rx = i === 0 ? -34 : 34
		for (let s = 0; s < 18; s++) {
			const t = s / 17
			kit.box('concrete', rx, PARK_Y + 3.6 * t, 40 - s * 1.2, 7, 0.5, 1.3, 0, 'floor')
		}
		railing(kit, rx - 3.5, 40, rx - 3.5, 19, PARK_Y + 1.8)
		railing(kit, rx + 3.5, 40, rx + 3.5, 19, PARK_Y + 1.8)
		const gate = kit.door(rx, PARK_Y, 30, 1.5708, 6, i === 0 ? 'Гермоворота паркинга' : 'Ворота лифтового блока', i === 0 ? 'key_medblock' : 'key_mall_west')
		gate.armored = true
		gate.hp = 700
	}

	/* outer ring road, kerbs and the namesake overpass */
	kit.box('asphalt', 0, 0.05, -50, 150, 0.1, 12, 0, 'floor')
	kit.box('asphalt', 0, 0.05, 50, 150, 0.1, 12, 0, 'floor')
	kit.box('asphalt', -62, 0.05, 0, 12, 0.1, 88, 0, 'floor')
	kit.box('asphalt', 62, 0.05, 0, 12, 0.1, 88, 0, 'floor')
	for (let i = 0; i < 7; i++) {
		const px = -66 + i * 22
		kit.box(CONCRETE_WORN, px, 3.4, -64, 2.4, 6.8, 2.4, 0, 'column')
		kit.box(CONCRETE_WORN, px, 7.1, -64, 4.6, 0.9, 4.6, 0, 'roof')
	}
	kit.box('asphalt', 0, 7.9, -64, 148, 0.7, 13, 0, 'floor')
	railing(kit, -74, -70.5, 74, -70.5, 8.25)
	railing(kit, -74, -57.5, 74, -57.5, 8.25)
	for (let i = 0; i < 9; i++) {
		carBody(kit, -64 + i * 16, -64 + (i % 3 - 1) * 3.4, 1.5708 + (i % 2) * 0.06, wear(WEAR_IRON, i, 8, i * 3, 0.3))
	}
	/* surface car park grid south of the mall */
	for (let i = 0; i < 40; i++) {
		const px = -44 + (i % 10) * 9.8
		const pz = 38 + Math.floor(i / 10) * 5.6
		kit.box('plaster', px, 0.09, pz, 0.16, 0.04, 4.8, 0, 'floor')
		if (hashNoise(px, 1.4, pz) > 0.5) carBody(kit, px + 2.6, pz, 0, wear(WEAR_IRON, px, 1, pz, 0.25))
	}
	/* railway spur on the east side */
	kit.box('gravel', 74, 0.12, 0, 8, 0.24, 150, 0, 'floor')
	for (let i = 0; i < 2; i++) {
		kit.box('rail', 72.4 + i * 3.2, 0.3, 0, 0.2, 0.16, 150, 0, 'decor')
	}
	for (let i = 0; i < 50; i++) {
		kit.box('plank', 74, 0.2, -73.5 + i * 3, 5.6, 0.16, 0.32, 0, 'floor')
	}
	for (let i = 0; i < 3; i++) {
		kit.box(METAL_RUST, 74, 2, -20 + i * 22, 3.1, 3.2, 14, 0, 'container')
		kit.box('corrugated', 74, 3.7, -20 + i * 22, 3.2, 0.24, 14.2, 0, 'roof')
	}

	for (let i = 0; i < BUILDINGS.length; i++) {
		kit.building(BUILDINGS[i])
	}

	for (let i = 0; i < LOOT_GOSHAN.length; i++) {
		const l = LOOT_GOSHAN[i]
		kit.loot(l[0], l[1], l[2], l[3], 'ГОШАН', l[4])
	}
	for (let i = 0; i < LOOT_OLI.length; i++) {
		const l = LOOT_OLI[i]
		kit.loot(l[0], l[1], l[2], l[3], 'ОЛИ', l[4])
	}
	for (let i = 0; i < LOOT_IDEA.length; i++) {
		const l = LOOT_IDEA[i]
		kit.loot(l[0], l[1], l[2], l[3], 'ИДЕЯ', l[4])
	}
	for (let i = 0; i < LOOT_MEZZ.length; i++) {
		const l = LOOT_MEZZ[i]
		kit.loot(l[0], l[1], l[2], l[3], 'Второй этаж', l[4])
	}
	for (let i = 0; i < LOOT_PARK.length; i++) {
		const l = LOOT_PARK[i]
		kit.loot(l[0], l[1], l[2], l[3], 'Паркинг', l[4])
	}
	for (let i = 0; i < LOOT_OUT.length; i++) {
		const l = LOOT_OUT[i]
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
	map.meta = interchangeMeta
	map.flickerLights = state.flicker
	return map
}

export default buildInterchange
