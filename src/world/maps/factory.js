import { MapKit, normalizeBuildArgs, makeRng } from './_kit.js'

/*
 * Factory (Zavod) - tight industrial deathmatch.
 *
 * 1. Main production hall 64 x 48 x 16 with two iron gantry tiers at
 *    Y=6 and Y=12, container stacks, rusty vertical risers, machine
 *    bases and golden-angle debris piles.
 * 2. Three story office block standing inside the hall. A nested loop
 *    (floor x facade) forges every slab, sill, glazing band and lintel.
 *    The 3rd floor gets the narrow corridor with breakable office doors,
 *    layered drywall + concrete partitions and penetrable glass that
 *    overlooks the whole hall floor.
 * 3. Underpass matrix below Y=-3: four sections, alternating red / blue
 *    emergency light grid, flooded toxic water at the low points.
 *
 * Every surface is placed through construction loops and ends up in the
 * batched InstancedMesh set on kit.finalize(). Math.random() is never
 * used: only kit.rng and the deterministic positional wear hash.
 *
 * NOTE: _kit.js knows no 'metal_rust' / 'concrete_worn' material keys
 * (neither MATERIAL_SURFACE nor FALLBACK_PBR list them, so they would
 * silently resolve to plain grey concrete with concrete ballistics).
 * Those semantic names are bound to real kit keys right below.
 */

const SIZE = 96
const HALF = 48
const HALL_W = 64
const HALL_D = 48
const HALL_H = 16
const HALL_HW = 32
const HALL_HD = 24
const G_LOW = 6
const G_HIGH = 12
const OFF_X = 17
const OFF_Z = -13
const OFF_W = 26
const OFF_D = 15
const OFF_HW = 13
const OFF_HD = 7.5
const OFF_FLOORS = 3
const FLOOR_H = 3.4
const OFF_T = 0.36
const OFF_TOP = 10.2
const CORR = 1.3
const TUN_FLOOR = -4.4
const TUN_CEIL = -1.1
const LIGHT_CAP = 21

const METAL_RUST = 'rust'
const CONCRETE_WORN = 'concrete'

/* wear ladders: the higher the index, the more chewed up the surface */
const WEAR_IRON = ['metal', 'corrugated', 'rust']
const WEAR_CONC = ['concrete', 'kerb', 'brick']
const WEAR_DRY = ['wall', 'plaster', 'concrete']

/* perimeter fence, x1 z1 x2 z2 - the gaps are the armored gate openings */
const FENCE = [[-48, -48, 48, -48], [-48, 48, -10, 48], [2, 48, 48, 48], [-48, -48, -48, 48], [48, -48, 48, -5], [48, 6, 48, 48]]
/* hall shell, gaps are drive-in openings */
const WALLS = [[-32, -24, -6, -24], [6, -24, 32, -24], [-32, 24, -9, 24], [1, 24, 32, 24], [-32, -24, -32, 6], [-32, 14, -32, 24], [32, -24, 32, -5], [32, 5, 32, 24]]
/* gantry runs: x1 z1 x2 z2 width */
const RUNS_LOW = [[-29, -21, -29, 21, 3], [-29, 21, 29, 21, 3], [29, 21, 29, -21, 3], [-27, -2, 3, -2, 2.4], [-29, -21, -12, -21, 2.4]]
const RUNS_HIGH = [[-30, -22, 30, -22, 2.6], [-30, 22, 30, 22, 2.6], [-20, -22, -20, 22, 2.2], [20, -22, 20, 22, 2.2]]
/* stair flights: x z yaw fromY toY width */
const STAIRS = [[-29, -14, 1.5708, 0, 6, 1.6], [26, 21, 3.14159, 0, 6, 1.6], [-29, 14, 4.71239, 6, 12, 1.4], [26, -21, 0, 6, 12, 1.4], [6, -5, 4.71239, 10.2, 12, 1.4]]
/* container clusters: x z yaw tiers */
const CONTAINERS = [[-24, -15, 0, 2], [-24, -9, 0, 1], [-17, -15, 0, 1], [-22, 12, 1.5708, 2], [-16, 12, 1.5708, 1], [-4, 17, 0, 1], [3, 17, 0, 2], [14, 8, 0, 1], [21, 8, 0, 2], [26, 15, 1.5708, 1], [-40, 18, 0, 2], [-40, 24, 0, 1], [40, -18, 1.5708, 1], [40, -11, 1.5708, 2], [-42, -30, 0.7854, 1], [36, 34, 2.35619, 1]]
/* rusty riser pipes: x z radius */
const RISERS = [[-31, -22, 0.34], [-31, -8, 0.28], [-31, 8, 0.34], [-31, 22, 0.28], [31, -22, 0.34], [31, -14, 0.28], [31, 14, 0.34], [31, 22, 0.28], [-9, 23, 0.3], [9, 23, 0.3], [-20, -23, 0.26], [-2, -23, 0.26]]
/* debris piles: x z radius count seed */
const DEBRIS = [[-14, 3, 3.2, 15, 1.7], [6, -2, 2.6, 12, 4.1], [-26, 19, 2.4, 10, 8.3], [24, -1, 3, 14, 2.9], [-6, 10, 2.2, 9, 6.2], [12, 20, 2.8, 13, 3.3], [-30, -18, 2, 8, 9.4], [30, 30, 2.6, 11, 5.5], [-38, 6, 2.4, 10, 7.1]]
/* machine bases: x z w d h yaw */
const MACHINES = [[-20, 0, 3.4, 2.2, 1.5, 0], [-13, 0, 3.4, 2.2, 1.5, 0], [-6, 0, 3.4, 2.2, 1.5, 0], [-20, 7, 3.4, 2.2, 1.2, 0], [-13, 7, 3.4, 2.2, 1.2, 0], [-6, 7, 3.4, 2.2, 1.2, 0], [16, -2, 2.6, 2.6, 1.8, 0.7854], [24, 6, 2.6, 2.6, 1.8, 0.7854], [-27, -6, 2.2, 4.4, 1.4, 0], [27, -18, 2.2, 4.4, 1.4, 0]]
/* underpass sections: x1 z1 x2 z2 width flooded */
const TUNNELS = [[-26, 4, 26, 4, 5.4, 0], [-18, 4, -18, 20, 4.6, 1], [18, 4, 18, 20, 4.6, 0], [-18, 20, 18, 20, 4.6, 1]]
/* stair shafts down: x z yaw */
const SHAFTS = [[-26, 4, 1.5708], [26, 4, 4.71239], [0, 20, 0]]
const HALL_LAMPS = [[-22, -16], [-22, 8], [0, 16], [22, 14], [-6, -8], [26, -20]]

const LOOT_HALL = [['crate', -27, 0, -20, 1], ['tool', -21, 0, -3, 1.2], ['crate', -12, 0, 6, 1], ['med', -3, 0, 13, 1.1], ['gun', 8, 0, -6, 1.4], ['crate', 19, 0, 19, 1], ['tool', 27, 0, 3, 1.2], ['jacket', -30, 0, 12, 1], ['crate', 30, 0, -8, 1], ['med', -16, 0, 22, 1.1], ['crate', -29, 6, 0, 1.3], ['tool', 29, 6, 6, 1.3], ['crate', 0, 12, 22, 1.5], ['jacket', -38, 0, 26, 1], ['crate', 40, 0, 26, 1], ['tool', -42, 0, -26, 1.1], ['med', 42, 0, -34, 1.1], ['crate', -34, 0, 41, 1], ['gun', 34, 0, 42, 1.2]]
const LOOT_OFFICE = [['crate', 9, 0.24, -17, 1], ['tool', 24, 0.24, -9, 1.1], ['jacket', 11, 3.64, -16, 1.4], ['med', 22, 3.64, -10, 1.3], ['crate', 15, 3.64, -17, 1.2], ['safe', 12, 7.04, -16.5, 2.6], ['jacket', 9, 7.04, -16.5, 2.2], ['jacket', 20, 7.04, -16.5, 2.2], ['gun', 24, 7.04, -9.5, 2.4], ['med', 15, 7.04, -9.5, 1.8], ['tool', 27, 7.04, -16.5, 1.6]]
const LOOT_TUNNEL = [['crate', -22, 4, 1.2], ['med', -18, 11, 1.5], ['tool', -18, 18, 1.3], ['crate', -8, 4, 1.2], ['gun', 6, 4, 1.6], ['crate', 18, 9, 1.2], ['safe', 18, 18, 2.1], ['med', 2, 20, 1.4], ['jacket', -10, 20, 1.3]]

/* Tarkov role spawns: x y z */
const SPAWN_PMC = [[-42, 0, -42], [42, 0, -42], [-42, 0, 42], [42, 0, 42], [0, 0, -42], [0, 0, 43]]
const SPAWN_SCAV = [[-40, 0, 0], [40, 0, 0], [-20, 0, 36], [20, 0, 36], [-36, 0, -20], [36, 0, -30]]
const SPAWN_RAIDER = [[-24, -4.3, 4], [24, -4.3, 4], [-18, -4.3, 18], [18, -4.3, 18], [0, -4.3, 20]]
const SPAWN_PMCBOT = [[-29, 6, -18], [29, 6, 18], [-20, 12, 0], [12, 7.1, -16]]
const SPAWN_BOSS = [[-8, 0, 8], [10, 0, 14]]
const SPAWN_BOT = [[-30, 0, -20], [30, 0, -20], [-30, 0, 20], [30, 0, 20], [0, 0, -20], [0, 0, 20], [-20, 0, 0], [20, 0, 0], [-44, 0, 8], [44, 0, -8], [8, 0, 44], [-8, 0, -44]]

const EXITS = [
	{ id: 'factory:gate3', name: 'Ворота 3', x: 44, z: 0.5, radius: 3.6, needKey: 'key_factory_gate3', noBotsNear: 14, note: 'Бронированные ворота, нужен ключ' },
	{ id: 'factory:gate0', name: 'Ворота 0', x: -4, z: 44, radius: 3.6, needKey: 'key_factory_gate0', note: 'Бронированные ворота, нужен ключ' },
	{ id: 'factory:cellar', name: 'Затопленный подвал', x: -18, y: TUN_FLOOR, z: 12, radius: 3, faction: 'scav', marker: false, note: 'Люк в затопленной сбойке' },
	{ id: 'factory:medtent', name: 'Медпалатка', x: -34, z: 40, radius: 3.2, freeHands: true, note: 'Только с пустыми руками' },
	{ id: 'factory:office', name: 'Окно кабинета', x: 42, z: -42, radius: 3, afterSec: 600, note: 'Открыт в последние 10 минут' },
	{ id: 'factory:transfer', name: 'Переход на Таможню', x: -44, z: -40, radius: 3.4, transfer: 'customs', cost: 4000, note: 'Платный переход' }
]

/* deterministic positional hash - one cube always gets one wear level */
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

/* two pipe runs plus posts every 2.2 m */
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
		const t = i / posts
		kit.box('metal', x1 + dx * t, y + 0.55, z1 + dz * t, 0.1, 1.1, 0.1, yaw, 'decor')
	}
}

/*
 * Gantry section: deck, two side channels, cross beams and supports.
 * support 'floor' drops columns to the slab, 'roof' hangs rods to the truss.
 */
function gantry(kit, x1, z1, x2, z2, y, width, support) {
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
		} else {
			kit.box('metal', px, (y + HALL_H) * 0.5, pz, 0.12, HALL_H - y, 0.12, yaw, 'decor')
		}
	}
	railing(kit, x1 + nx * hw, z1 + nz * hw, x2 + nx * hw, z2 + nz * hw, y)
	railing(kit, x1 - nx * hw, z1 - nz * hw, x2 - nx * hw, z2 - nz * hw, y)
}

/* steps, stringer, top landing and a side rail */
function stairFlight(kit, x, z, yaw, yFrom, yTo, width) {
	const dirX = Math.sin(yaw)
	const dirZ = Math.cos(yaw)
	const steps = Math.max(4, Math.round(Math.abs(yTo - yFrom) / 0.24))
	const rise = (yTo - yFrom) / steps
	const tread = 0.36
	for (let i = 0; i < steps; i++) {
		const t = (i + 0.5) * tread
		kit.box('metal', x + dirX * t, yFrom + rise * (i + 0.5), z + dirZ * t, width, Math.abs(rise) + 0.08, tread, yaw, 'floor')
	}
	const runLen = steps * tread
	const midY = yFrom + (yTo - yFrom) * 0.5
	kit.box('metal', x + dirX * runLen * 0.5, midY - 0.3, z + dirZ * runLen * 0.5, width + 0.16, 0.18, runLen, yaw, 'decor')
	kit.box(wear(WEAR_IRON, x, yTo, z, 0.15), x + dirX * (runLen + 0.8), yTo, z + dirZ * (runLen + 0.8), width + 0.4, 0.2, 1.6, yaw, 'roof')
	railing(kit, x + dirZ * width * 0.5, z - dirX * width * 0.5, x + dirX * runLen + dirZ * width * 0.5, z + dirZ * runLen - dirX * width * 0.5, midY)
}

/* shipping container, stacked when tiers > 1 */
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

/* golden angle debris scatter, chunks shrink towards the rim */
function debrisPile(kit, cx, cz, radius, count, seed, baseY) {
	for (let i = 0; i < count; i++) {
		const a = i * 2.39996 + seed
		const r = radius * Math.sqrt((i + 0.6) / count)
		const x = cx + Math.cos(a) * r
		const z = cz + Math.sin(a) * r
		const h = 0.16 + hashNoise(x, seed, z) * 0.85 * (1 - r / (radius + 0.01))
		const w = 0.4 + hashNoise(z, seed + 3.1, x) * 1.15
		kit.box(wear(WEAR_CONC, x, h, z, 0.12), x, baseY + h * 0.5, z, w, h, w * 0.75, a, 'debris')
	}
}

/*
 * Housing and lens are always batched, the real PointLight is only spent
 * while the budget lasts. hz > 0 registers the light in map.flickerLights.
 */
function lampFixture(kit, state, x, y, z, color, power, range, hz) {
	kit.box('metal', x, y + 0.17, z, 0.46, 0.14, 0.34, 0, 'decor')
	kit.box('lamp', x, y, z, 0.36, 0.16, 0.26, 0, 'decor')
	if (state.used >= state.budget) return null
	state.used++
	const light = kit.lamp(x, y, z, color, power, range)
	if (light && hz > 0) {
		const spec = { hz: hz, min: power * 0.18, max: power, phase: state.used * 0.618034 }
		state.flicker.push({ light: light, hz: spec.hz, min: spec.min, max: spec.max, phase: spec.phase })
		if (light.userData) light.userData.flicker = spec
	}
	return light
}

/* glazing band split into panes with metal mullions */
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

/* three layers: concrete plinth, profiled sheet, vertical ribs */
function hallWall(kit, x1, z1, x2, z2, h) {
	const dx = x2 - x1
	const dz = z2 - z1
	const len = Math.sqrt(dx * dx + dz * dz)
	if (len < 0.4) return
	const yaw = Math.atan2(dx, dz)
	const cx = x1 + dx * 0.5
	const cz = z1 + dz * 0.5
	kit.box(wear(WEAR_CONC, cx, 1.5, cz, 0.05), cx, 1.5, cz, 0.7, 3, len, yaw, 'wall')
	kit.box(wear(WEAR_IRON, cx, h, cz, 0.3), cx, 3 + (h - 3) * 0.5, cz, 0.44, h - 3, len, yaw, 'wall')
	const ribs = Math.max(2, Math.round(len / 4))
	for (let i = 0; i <= ribs; i++) {
		const t = i / ribs
		kit.box('metal', x1 + dx * t, h * 0.5, z1 + dz * t, 0.58, h, 0.28, yaw, 'decor')
	}
}

/*
 * Armored gate. wallYaw follows the wall convention (length along local Z),
 * the door leaf is turned by 90 deg because kit.door lays width on local X.
 */
function armoredGate(kit, x, z, wallYaw, width, name, keyId) {
	const dirX = Math.sin(wallYaw)
	const dirZ = Math.cos(wallYaw)
	const off = width * 0.5 + 0.6
	kit.box(CONCRETE_WORN, x + dirX * off, 2.6, z + dirZ * off, 1.2, 5.2, 1.1, wallYaw, 'wall')
	kit.box(CONCRETE_WORN, x - dirX * off, 2.6, z - dirZ * off, 1.2, 5.2, 1.1, wallYaw, 'wall')
	kit.box(METAL_RUST, x, 4.6, z, 0.6, 1.2, width + 2, wallYaw, 'wall')
	kit.box('rail', x, 3.9, z, 0.26, 0.26, width + 1.6, wallYaw, 'decor')
	kit.box(METAL_RUST, x, 2.8, z, 0.5, 1.2, width, wallYaw, 'wall')
	const door = kit.door(x, 0, z, wallYaw + 1.5708, width, name, keyId)
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

	/* the plant is always gloomy: dense cold fog, the sun barely works */
	kit.setFog(night ? 0x090c0f : 0x1b1f22, night ? 0.024 : 0.016)
	kit.setAmbient({
		color: night ? 0x1b2430 : 0x2f373c,
		intensity: night ? 0.16 : 0.34,
		sunColor: night ? 0x5c7093 : 0xd8e3ea,
		sunIntensity: night ? 0.05 : 0.22,
		sunPosition: [40, 110, -30],
		indoor: true
	})

	/* yard asphalt plus the poured hall slab with expansion strips */
	kit.ground('asphalt')
	kit.box(CONCRETE_WORN, 0, 0.05, 0, HALL_W, 0.1, HALL_D, 0, 'floor')
	for (let i = 0; i < 8; i++) {
		const x = -28 + i * 8
		kit.box(wear(WEAR_CONC, x, 0.07, 0, 0.2), x, 0.07, 0, 7.4, 0.04, HALL_D - 3, 0, 'floor')
	}

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

	armoredGate(kit, HALF - 0.4, 0.5, 0, 10, 'Ворота 3', 'key_factory_gate3')
	armoredGate(kit, -4, HALF - 0.4, 1.5708, 11, 'Ворота 0', 'key_factory_gate0')

	for (let i = 0; i < WALLS.length; i++) {
		const w = WALLS[i]
		hallWall(kit, w[0], w[1], w[2], w[3], HALL_H)
	}

	/* roof deck, trusses, purlins and skylight strips */
	kit.box('corrugated', 0, HALL_H + 0.35, 0, HALL_W + 2.4, 0.5, HALL_D + 2.4, 0, 'roof')
	for (let i = 0; i < 9; i++) {
		const x = -28 + i * 7
		kit.box('metal', x, HALL_H - 0.7, 0, 0.34, 0.9, HALL_D, 0, 'decor')
		kit.box('metal', x, HALL_H - 1.6, 0, 0.22, 0.9, HALL_D - 6, 0, 'decor')
		if (i % 2 === 1) kit.box('glass', x, HALL_H + 0.12, 0, 2.6, 0.14, HALL_D - 10, 0, 'glass')
	}
	for (let i = 0; i < 5; i++) {
		kit.box('metal', 0, HALL_H - 1.15, -20 + i * 10, HALL_W, 0.26, 0.26, 0, 'decor')
	}

	/* hall columns, skipped where the office block stands */
	for (let ix = -1; ix <= 2; ix++) {
		for (let iz = -1; iz <= 1; iz++) {
			const x = ix * 16 - 8
			const z = iz * 16
			if (x > OFF_X - OFF_HW - 1 && x < OFF_X + OFF_HW + 1 && z > OFF_Z - OFF_HD - 1 && z < OFF_Z + OFF_HD + 1) continue
			kit.box(CONCRETE_WORN, x, HALL_H * 0.5, z, 1.1, HALL_H, 1.1, 0, 'column')
			kit.box(wear(WEAR_CONC, x, 0.5, z, 0.25), x, 0.45, z, 1.7, 0.9, 1.7, 0, 'column')
			kit.box('metal', x, HALL_H - 0.9, z, 1.6, 0.3, 1.6, 0, 'decor')
		}
	}

	for (let i = 0; i < RUNS_LOW.length; i++) {
		const g = RUNS_LOW[i]
		gantry(kit, g[0], g[1], g[2], g[3], G_LOW, g[4], 'floor')
	}
	for (let i = 0; i < RUNS_HIGH.length; i++) {
		const g = RUNS_HIGH[i]
		gantry(kit, g[0], g[1], g[2], g[3], G_HIGH, g[4], 'roof')
	}
	for (let i = 0; i < STAIRS.length; i++) {
		const s = STAIRS[i]
		stairFlight(kit, s[0], s[1], s[2], s[3], s[4], s[5])
	}

	for (let i = 0; i < CONTAINERS.length; i++) {
		const c = CONTAINERS[i]
		containerStack(kit, c[0], c[1], c[2], c[3])
	}

	/* vertical rusty risers with a horizontal tie under the low gantry */
	for (let i = 0; i < RISERS.length; i++) {
		const r = RISERS[i]
		kit.cylinder(METAL_RUST, r[0], 7.5, r[1], r[2], 15, 'pipe')
		kit.box(METAL_RUST, r[0], 5.2, r[1], r[2] * 2.4, r[2] * 2.4, 1.6, 0, 'decor')
	}
	kit.box(METAL_RUST, -31, 13.2, 0, 0.46, 0.46, HALL_D - 4, 0, 'decor')
	kit.box(METAL_RUST, 31, 13.2, 0, 0.46, 0.46, HALL_D - 4, 0, 'decor')
	kit.box('pipe', 0, 13.6, -23, 0.34, 0.34, HALL_W - 6, 1.5708, 'decor')

	for (let i = 0; i < MACHINES.length; i++) {
		const m = MACHINES[i]
		kit.box(wear(WEAR_IRON, m[0], m[4], m[1], 0.25), m[0], m[4] * 0.5, m[1], m[2], m[4], m[3], m[5], 'machine')
		kit.box('metal', m[0], m[4] + 0.12, m[1], m[2] + 0.3, 0.24, m[3] + 0.3, m[5], 'roof')
		kit.cylinder(METAL_RUST, m[0], m[4] + 0.9, m[1], 0.22, 1.6, 'pipe')
	}

	for (let i = 0; i < DEBRIS.length; i++) {
		const d = DEBRIS[i]
		debrisPile(kit, d[0], d[1], d[2], d[3], d[4], 0.1)
	}

	/* three story office block: nested floor x facade loop */
	const SIDES = [[0, -OFF_HD, OFF_W, 1.5708], [0, OFF_HD, OFF_W, 1.5708], [-OFF_HW, 0, OFF_D, 0], [OFF_HW, 0, OFF_D, 0]]
	const roomW = (OFF_W - 2 * OFF_T) / 4
	for (let f = 0; f < OFF_FLOORS; f++) {
		const y0 = f * FLOOR_H
		kit.box(wear(WEAR_CONC, OFF_X, y0, OFF_Z, 0.1), OFF_X, y0 + 0.12, OFF_Z, OFF_W, 0.24, OFF_D, 0, 'floor')
		for (let s = 0; s < 4; s++) {
			const sd = SIDES[s]
			const cx = OFF_X + sd[0]
			const cz = OFF_Z + sd[1]
			const len = sd[2]
			const yaw = sd[3]
			if (f === 0 && s === 2) {
				const seg = (len - 1.6) * 0.5
				const dirX = Math.sin(yaw)
				const dirZ = Math.cos(yaw)
				const back = 0.8 + seg * 0.5
				kit.box(wear(WEAR_CONC, cx, y0, cz - 3, 0.1), cx + dirX * back, y0 + 1.7, cz + dirZ * back, OFF_T, 3.4, seg, yaw, 'wall')
				kit.box(wear(WEAR_CONC, cx, y0, cz + 3, 0.1), cx - dirX * back, y0 + 1.7, cz - dirZ * back, OFF_T, 3.4, seg, yaw, 'wall')
				kit.box(CONCRETE_WORN, cx, y0 + 2.85, cz, OFF_T, 1.1, 1.7, yaw, 'wall')
				const entry = kit.door(cx, y0, cz, yaw + 1.5708, 1.5, 'Вход в трёхэтажку', null)
				entry.breakable = true
				entry.hp = 90
				entry.surface = 'metal'
				continue
			}
			kit.box(wear(WEAR_CONC, cx, y0 + 1, cz, 0.05), cx, y0 + 0.765, cz, OFF_T, 1.05, len, yaw, 'wall')
			windowBand(kit, cx, y0 + 1.94, cz, len, yaw, 1.3, OFF_T * 0.55)
			kit.box(wear(WEAR_CONC, cx, y0 + 3, cz, 0.05), cx, y0 + 2.995, cz, OFF_T, 0.81, len, yaw, 'wall')
		}
		/* interior: layered partitions on every floor, corridor on the 3rd */
		for (let side = 0; side < 2; side++) {
			const sgn = side === 0 ? -1 : 1
			const wz = OFF_Z + sgn * CORR
			for (let r = 0; r < 4; r++) {
				const x0 = OFF_X - OFF_HW + OFF_T + r * roomW
				const xc = x0 + roomW * 0.5
				if (r > 0) {
					kit.box(wear(WEAR_DRY, x0, y0, wz, 0.1), x0, y0 + 1.7, OFF_Z + sgn * (OFF_HD + CORR) * 0.5, 0.14, 3.4, OFF_HD - CORR, 0, 'wall')
					kit.box(CONCRETE_WORN, x0, y0 + 1.7, OFF_Z + sgn * (OFF_HD - 0.5), 0.32, 3.4, 0.7, 0, 'column')
				}
				if (f < 2) continue
				const half = (roomW - 1.1) * 0.5
				const skin = side === 1 && r % 2 === 0 ? 'glass' : wear(WEAR_DRY, xc, y0, wz, 0.15)
				kit.box(skin, x0 + half * 0.5, y0 + 1.7, wz, 0.16, 3.4, half, 1.5708, 'wall')
				kit.box(skin, x0 + roomW - half * 0.5, y0 + 1.7, wz, 0.16, 3.4, half, 1.5708, 'wall')
				kit.box(CONCRETE_WORN, xc, y0 + 2.9, wz, 0.16, 1, 1.15, 1.5708, 'wall')
				const door = kit.door(xc, y0, wz, 3.14159, 1.05, 'Кабинет ' + (301 + side * 4 + r), side === 0 && r === 1 ? 'key_factory_office' : null)
				door.breakable = true
				door.hp = 110
				door.surface = 'wood'
			}
		}
	}

	/* office corners, internal flights, roof deck and parapet */
	for (let i = 0; i < 4; i++) {
		const px = OFF_X + (i < 2 ? -OFF_HW : OFF_HW)
		const pz = OFF_Z + (i % 2 === 0 ? -OFF_HD : OFF_HD)
		kit.box(CONCRETE_WORN, px, OFF_TOP * 0.5, pz, 0.72, OFF_TOP, 0.72, 0, 'column')
	}
	for (let f = 0; f < OFF_FLOORS - 1; f++) {
		const up = f % 2 === 0
		stairFlight(kit, OFF_X + OFF_HW - 2, up ? OFF_Z - OFF_HD + 1.2 : OFF_Z + OFF_HD - 1.2, up ? 0 : 3.14159, f * FLOOR_H, (f + 1) * FLOOR_H, 1.3)
	}
	kit.box(CONCRETE_WORN, OFF_X, OFF_TOP + 0.15, OFF_Z, OFF_W, 0.3, OFF_D, 0, 'roof')
	for (let s = 0; s < 4; s++) {
		const sd = SIDES[s]
		kit.box(wear(WEAR_CONC, OFF_X + sd[0], OFF_TOP, OFF_Z + sd[1], 0.2), OFF_X + sd[0], OFF_TOP + 0.75, OFF_Z + sd[1], 0.28, 0.9, sd[2], sd[3], 'wall')
	}
	for (let i = 0; i < 3; i++) {
		kit.box('metal', OFF_X - 7 + i * 7, OFF_TOP + 0.9, OFF_Z + 2, 2.2, 1.2, 1.8, 0, 'machine')
		kit.box('rail', OFF_X - 7 + i * 7, OFF_TOP + 1.56, OFF_Z + 2, 2.3, 0.12, 1.9, 0, 'roof')
	}

	/* underpass matrix below Y=-3 */
	for (let i = 0; i < TUNNELS.length; i++) {
		const t = TUNNELS[i]
		const dx = t[2] - t[0]
		const dz = t[3] - t[1]
		const len = Math.sqrt(dx * dx + dz * dz)
		const yaw = Math.atan2(dx, dz)
		const cx = t[0] + dx * 0.5
		const cz = t[1] + dz * 0.5
		const w = t[4]
		const nx = dz / len
		const nz = -dx / len
		const off = w * 0.5 + 0.3
		kit.box(wear(WEAR_CONC, cx, TUN_FLOOR, cz, 0.2), cx, TUN_FLOOR - 0.15, cz, w + 1.2, 0.3, len, yaw, 'floor')
		kit.box(CONCRETE_WORN, cx, TUN_CEIL + 0.2, cz, w + 1.2, 0.4, len, yaw, 'roof')
		kit.box(wear(WEAR_CONC, cx, -3, cz, 0.15), cx + nx * off, -2.75, cz + nz * off, 0.6, 3.3, len, yaw, 'wall')
		kit.box(wear(WEAR_CONC, cx, -2, cz, 0.15), cx - nx * off, -2.75, cz - nz * off, 0.6, 3.3, len, yaw, 'wall')
		const bays = Math.max(2, Math.round(len / 4))
		for (let b = 0; b <= bays; b++) {
			const p = b / bays
			kit.box(CONCRETE_WORN, t[0] + dx * p, TUN_CEIL - 0.16, t[1] + dz * p, w + 0.4, 0.32, 0.3, yaw, 'decor')
		}
		kit.box(METAL_RUST, cx + nx * (w * 0.5 - 0.3), TUN_CEIL - 0.5, cz + nz * (w * 0.5 - 0.3), 0.34, 0.34, len - 0.4, yaw, 'decor')
		kit.box('pipe', cx - nx * (w * 0.5 - 0.3), TUN_CEIL - 0.5, cz - nz * (w * 0.5 - 0.3), 0.26, 0.26, len - 0.4, yaw, 'decor')
		/* alternating red / blue emergency grid */
		const lamps = Math.max(2, Math.round(len / 7))
		for (let l = 0; l <= lamps; l++) {
			const p = l / lamps
			const red = (i + l) % 2 === 0
			lampFixture(kit, state, t[0] + dx * p, TUN_CEIL - 0.55, t[1] + dz * p, red ? 0xff2a1e : 0x2a5cff, red ? 0.5 : 0.42, 9, red ? 7.5 : 4.5)
		}
		/* flooded toxic sections at the lowest points */
		if (t[5]) {
			kit.box('water', cx, TUN_FLOOR + 0.28, cz, w, 0.56, len, yaw, 'floor')
			kit.box('water', cx, TUN_FLOOR + 0.32, cz, w * 0.62, 0.6, len * 0.5, yaw, 'floor')
		}
	}

	/* stair shafts from the hall slab down into the underpass */
	for (let i = 0; i < SHAFTS.length; i++) {
		const s = SHAFTS[i]
		const dX = Math.sin(s[2])
		const dZ = Math.cos(s[2])
		stairFlight(kit, s[0], s[1], s[2], 0, TUN_FLOOR + 0.2, 1.6)
		kit.box(wear(WEAR_CONC, s[0], -2, s[1], 0.2), s[0] - dX * 1.2, -2.2, s[1] - dZ * 1.2, 3.4, 4.4, 0.4, s[2], 'wall')
		railing(kit, s[0] + dZ * 1.1, s[1] - dX * 1.1, s[0] + dX * 6.6 + dZ * 1.1, s[1] + dZ * 6.6 - dX * 1.1, 0)
		railing(kit, s[0] - dZ * 1.1, s[1] + dX * 1.1, s[0] + dX * 6.6 - dZ * 1.1, s[1] + dZ * 6.6 + dX * 1.1, 0)
	}

	/* hall work lights, steady but weak */
	for (let i = 0; i < HALL_LAMPS.length; i++) {
		const h = HALL_LAMPS[i]
		lampFixture(kit, state, h[0], HALL_H - 2.2, h[1], 0xffe2b0, 0.62, 26, i === 4 ? 3.2 : 0)
		kit.box('metal', h[0], HALL_H - 1.6, h[1], 0.14, 1.2, 0.14, 0, 'decor')
	}

	/* med tent in the yard, the free hands extract */
	kit.building({
		x: -34, z: 40, w: 11, d: 8, h: 3, surf: 'tent', t: 0.3, doorWidth: 1.8,
		name: 'Медпалатка', floor: true, floorSurf: 'plank', roof: true, roofSurf: 'tent',
		partitions: 1, lamp: true, lampColor: 0xffd9a0, lampIntensity: 0.5, lampRange: 12
	})

	/* guard shack by the transfer point */
	kit.building({
		x: -40, z: -40, w: 7, d: 6, h: 3.2, surf: 'brick', t: 0.35, doorWidth: 1.2,
		name: 'КПП', floor: true, floorSurf: 'tile', roof: true, roofSurf: 'corrugated',
		partitions: 1, lamp: true, lampColor: 0xfff0c8, lampIntensity: 0.45, lampRange: 10
	})

	for (let i = 0; i < LOOT_HALL.length; i++) {
		const l = LOOT_HALL[i]
		kit.loot(l[0], l[1], l[2], l[3], null, l[4])
	}
	for (let i = 0; i < LOOT_OFFICE.length; i++) {
		const l = LOOT_OFFICE[i]
		kit.loot(l[0], l[1], l[2], l[3], null, l[4])
	}
	for (let i = 0; i < LOOT_TUNNEL.length; i++) {
		const l = LOOT_TUNNEL[i]
		kit.loot(l[0], l[1], TUN_FLOOR + 0.1, l[2], null, l[3])
	}

	for (let i = 0; i < EXITS.length; i++) {
		kit.exit(EXITS[i])
	}
	/* hand drawn marker for the underground extract */
	kit.box('lamp', -18, TUN_FLOOR + 0.08, 12, 2.6, 0.14, 2.6, 0, 'floor')

	for (let i = 0; i < SPAWN_PMC.length; i++) kit.spawn('pmc', SPAWN_PMC[i][0], SPAWN_PMC[i][1], SPAWN_PMC[i][2])
	for (let i = 0; i < SPAWN_SCAV.length; i++) kit.spawn('scav', SPAWN_SCAV[i][0], SPAWN_SCAV[i][1], SPAWN_SCAV[i][2])
	for (let i = 0; i < SPAWN_RAIDER.length; i++) kit.spawn('raider', SPAWN_RAIDER[i][0], SPAWN_RAIDER[i][1], SPAWN_RAIDER[i][2])
	for (let i = 0; i < SPAWN_PMCBOT.length; i++) kit.spawn('pmcbot', SPAWN_PMCBOT[i][0], SPAWN_PMCBOT[i][1], SPAWN_PMCBOT[i][2])
	for (let i = 0; i < SPAWN_BOSS.length; i++) kit.spawn('boss', SPAWN_BOSS[i][0], SPAWN_BOSS[i][1], SPAWN_BOSS[i][2])
	for (let i = 0; i < SPAWN_BOT.length; i++) kit.spawn('bot', SPAWN_BOT[i][0], SPAWN_BOT[i][1], SPAWN_BOT[i][2])

	const map = kit.finalize()
	map.meta = factoryMeta
	map.flickerLights = state.flicker
	return map
}

export default buildFactory
