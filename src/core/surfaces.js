/**
 * Canonical surface authority for Escape From Larpov.
 *
 * This file is the ONLY place a surface tag or a surface index may be
 * declared. Physics stores the index per triangle (one byte), the ballistics
 * solver indexes its struct-of-arrays with it, items keys its Float32Array
 * lanes off it, and fx / audio / footsteps switch on the name. Before this
 * file existed there were four tables with three different orderings, so an
 * index written by one subsystem was read as a different material by the
 * next: index 11 meant `plaster` to physics and `flesh` to the solver.
 *
 * Rules:
 *   1. SURFACE_NAMES is frozen and append-only. Never reorder it — the order
 *      IS the wire format for collider tags and for every Float32Array below.
 *   2. A new tag must declare where its physical data comes from, either as
 *      its own row in the BASE_* tables or as a DERIVED_FROM collapse target.
 *   3. A non-canonical name used by map geometry must be declared in
 *      SURFACE_ALIASES. An undeclared name is a live shader-recompilation
 *      trap, not a cosmetic warning — see the comment on that table.
 *   4. Nothing here imports another subsystem. This file sits under src/core/
 *      precisely so physics, items, materials and world can all depend on it
 *      without depending on each other.
 */

/**
 * The 20 canonical surface tags, in canonical index order.
 *
 * concrete 0  asphalt 1  brick 2   plaster 3  tile 4
 * metal 5     metal_thin 6  grate 7  wood 8  dirt 9
 * gravel 10   sand 11    grass 12  bark 13   glass 14
 * water 15    foliage 16 fabric 17 rubber 18 flesh 19
 */
export const SURFACE_NAMES = Object.freeze([
	'concrete',
	'asphalt',
	'brick',
	'plaster',
	'tile',
	'metal',
	'metal_thin',
	'grate',
	'wood',
	'dirt',
	'gravel',
	'sand',
	'grass',
	'bark',
	'glass',
	'water',
	'foliage',
	'fabric',
	'rubber',
	'flesh'
])

export const SURFACE_COUNT = SURFACE_NAMES.length

const indexOfName = Object.create(null)
for (let i = 0; i < SURFACE_NAMES.length; i++) indexOfName[SURFACE_NAMES[i]] = i

/** name -> canonical index. Frozen: nobody gets to add a 21st tag at runtime. */
export const SURFACE = Object.freeze(indexOfName)

/**
 * Non-canonical names that shipped map geometry actually uses.
 *
 * These reached MaterialSystem._resolve() as unknown surfaces on every map
 * build. The fallback to concrete looks harmless in the console, but the
 * material cache is keyed by the requested name, so each miss produced a new
 * cache entry and the renderer compiled a fresh program for geometry it had
 * already compiled — a permanent recompilation loop during deployment.
 *
 * Declared here rather than in the material library because a name that map
 * geometry can carry is a surface question first (physics, ballistics, impact
 * FX and footsteps all read it) and a shading question second.
 *
 *   kerb  -> concrete    kerbstone is cast concrete, not road tarmac
 *   rail  -> metal_thin  handrail and balustrade tube, thin pressed steel
 *   pipe  -> metal       structural steel pipework
 *   lamp  -> glass       a lamp reads as its diffuser, not as its bracket
 *   water -> water       already canonical; listed so the lookup is total
 */
export const SURFACE_ALIASES = Object.freeze({
	kerb: 'concrete',
	curb: 'concrete',
	kerbstone: 'concrete',
	rail: 'metal_thin',
	rails: 'metal_thin',
	railing: 'metal_thin',
	handrail: 'metal_thin',
	balustrade: 'metal_thin',
	pipe: 'metal',
	pipes: 'metal',
	piping: 'metal',
	lamp: 'glass',
	lamps: 'glass',
	lamppost: 'glass',
	streetlamp: 'glass',
	water: 'water',
	puddle: 'water'
})

/**
 * Where the physical data for each new tag comes from.
 *
 * The eight tags added by the unification had no measured numbers of their
 * own, and inventing ballistics would have been a guess dressed up as data.
 * Each one instead collapses onto the surface it was already being folded
 * into by the old guessSurface() regexes, so behaviour is unchanged on impact
 * and only the reported tag gets more specific:
 *
 *   brick, tile, asphalt -> concrete   (masonry / bound aggregate)
 *   gravel               -> dirt       (loose ground)
 *   grass                -> foliage    (thin organic, no real resistance)
 *   bark                 -> wood       (cellulose)
 *   metal_thin, grate    -> metal      (steel; thin sections differ visually)
 *
 * A tag listed here has no row of its own in the BASE_* tables. Give it one
 * and delete its line here the moment real numbers exist for it.
 */
export const DERIVED_FROM = Object.freeze({
	asphalt: 'concrete',
	brick: 'concrete',
	tile: 'concrete',
	gravel: 'dirt',
	grass: 'foliage',
	bark: 'wood',
	metal_thin: 'metal',
	grate: 'metal'
})

/**
 * Per-surface physical response, measured for the twelve original tags.
 *
 * penDepth      metres of material a reference round (power 1.0) fully defeats.
 * energyLoss    fraction of remaining damage lost per penDepth traversed.
 * deflect       radians of random yaw/pitch scatter per penDepth traversed.
 * friction      dry kinetic coefficient (rigid bodies, ragdolls, footing).
 * restitution   bounce factor for debris.
 * density       kg/m^3, used for the impulse a body of unknown mass receives.
 * hardness      0..1 - spark/chip likelihood, drives fx choice.
 * shatters      the surface breaks rather than absorbs (glass).
 */
const BASE_PROPS = {
	concrete: { penDepth: 0.055, energyLoss: 0.62, deflect: 0.055, friction: 0.92, restitution: 0.26, density: 2400, hardness: 0.95, shatters: false },
	plaster: { penDepth: 0.7, energyLoss: 0.12, deflect: 0.02, friction: 0.86, restitution: 0.14, density: 800, hardness: 0.25, shatters: false },
	metal: { penDepth: 0.022, energyLoss: 0.7, deflect: 0.075, friction: 0.52, restitution: 0.44, density: 7800, hardness: 1.0, shatters: false },
	wood: { penDepth: 0.32, energyLoss: 0.3, deflect: 0.03, friction: 0.72, restitution: 0.3, density: 620, hardness: 0.4, shatters: false },
	dirt: { penDepth: 0.26, energyLoss: 0.45, deflect: 0.05, friction: 0.96, restitution: 0.09, density: 1500, hardness: 0.2, shatters: false },
	sand: { penDepth: 0.19, energyLoss: 0.55, deflect: 0.06, friction: 1.05, restitution: 0.04, density: 1600, hardness: 0.12, shatters: false },
	glass: { penDepth: 0.45, energyLoss: 0.12, deflect: 0.012, friction: 0.32, restitution: 0.2, density: 2500, hardness: 0.85, shatters: true },
	water: { penDepth: 1.1, energyLoss: 0.5, deflect: 0.09, friction: 0.3, restitution: 0.0, density: 1000, hardness: 0.0, shatters: false },
	foliage: { penDepth: 3.0, energyLoss: 0.05, deflect: 0.008, friction: 0.62, restitution: 0.06, density: 300, hardness: 0.05, shatters: false },
	fabric: { penDepth: 2.2, energyLoss: 0.06, deflect: 0.01, friction: 0.8, restitution: 0.05, density: 400, hardness: 0.02, shatters: false },
	rubber: { penDepth: 0.28, energyLoss: 0.4, deflect: 0.04, friction: 1.25, restitution: 0.72, density: 1200, hardness: 0.1, shatters: false },
	flesh: { penDepth: 0.55, energyLoss: 0.35, deflect: 0.02, friction: 0.9, restitution: 0.05, density: 1050, hardness: 0.05, shatters: false }
}

/**
 * Ballistics, consumed by the penetration solver and by items.
 *
 * cost  units of penetration power consumed per metre of material.
 * ric   base ricochet chance.
 * ang   critical angle in degrees, below which a ricochet is possible.
 * pass  fraction of damage retained after the round exits.
 */
const BASE_BALLISTICS = {
	concrete: { cost: 42, ric: 0.06, ang: 14, pass: 0.3 },
	plaster: { cost: 18, ric: 0.02, ang: 10, pass: 0.62 },
	metal: { cost: 34, ric: 0.22, ang: 26, pass: 0.45 },
	wood: { cost: 12, ric: 0.02, ang: 9, pass: 0.8 },
	glass: { cost: 4, ric: 0.01, ang: 6, pass: 0.95 },
	dirt: { cost: 48, ric: 0.02, ang: 11, pass: 0.15 },
	sand: { cost: 52, ric: 0.01, ang: 9, pass: 0.1 },
	fabric: { cost: 6, ric: 0, ang: 0, pass: 0.92 },
	foliage: { cost: 3, ric: 0, ang: 0, pass: 0.97 },
	rubber: { cost: 20, ric: 0.04, ang: 16, pass: 0.55 },
	water: { cost: 30, ric: 0.1, ang: 8, pass: 0.35 },
	flesh: { cost: 8, ric: 0, ang: 0, pass: 0.75 }
}

/**
 * Nominal thickness in metres, used to price a penetration when the collider
 * is a single-sided triangle and there is no exit hit to measure against.
 */
const BASE_THICKNESS = {
	concrete: 0.3,
	plaster: 0.12,
	metal: 0.05,
	wood: 0.08,
	glass: 0.01,
	dirt: 0.5,
	sand: 0.5,
	fabric: 0.02,
	foliage: 0.05,
	rubber: 0.1,
	water: 1,
	flesh: 0.25
}

/**
 * Expand a base table over all 20 tags, following DERIVED_FROM for the ones
 * without measured data. Throws at module load if a tag resolves to nothing,
 * which makes a missing row a boot failure instead of an undefined that turns
 * into NaN damage several frames into a raid.
 */
function expand(table, label) {
	const out = Object.create(null)
	for (let i = 0; i < SURFACE_NAMES.length; i++) {
		const name = SURFACE_NAMES[i]
		const source = DERIVED_FROM[name] === undefined ? name : DERIVED_FROM[name]
		const row = table[source]
		if (row === undefined) {
			throw new Error('[surfaces] ' + label + ' has no row for "' + name + '" (collapse target "' + source + '")')
		}
		out[name] = row !== null && typeof row === 'object' ? Object.freeze(Object.assign({}, row)) : row
	}
	return Object.freeze(out)
}

function listOf(byName) {
	const out = new Array(SURFACE_NAMES.length)
	for (let i = 0; i < SURFACE_NAMES.length; i++) out[i] = byName[SURFACE_NAMES[i]]
	return Object.freeze(out)
}

/* An alias that points at nothing is the exact failure this table exists to
 * prevent, so it is a boot failure and not a runtime warning. */
for (const alias in SURFACE_ALIASES) {
	if (SURFACE[SURFACE_ALIASES[alias]] === undefined) {
		throw new Error('[surfaces] alias "' + alias + '" points at unknown tag "' + SURFACE_ALIASES[alias] + '"')
	}
}

/** Physical response by tag name, all 20 present. */
export const SURFACE_PROPS_BY_NAME = expand(BASE_PROPS, 'SURFACE_PROPS')

/** Physical response by canonical index. */
export const SURFACE_PROPS = listOf(SURFACE_PROPS_BY_NAME)

/** Ballistics by tag name, all 20 present. */
export const SURFACE_BALLISTICS = expand(BASE_BALLISTICS, 'SURFACE_BALLISTICS')

/** Ballistics by canonical index. */
export const SURFACE_BALLISTICS_LIST = listOf(SURFACE_BALLISTICS)

/** Nominal thickness in metres by tag name. */
export const SURFACE_THICKNESS_BY_NAME = expand(BASE_THICKNESS, 'SURFACE_THICKNESS')

/** Nominal thickness in metres by canonical index. */
export const SURFACE_THICKNESS = listOf(SURFACE_THICKNESS_BY_NAME)

/**
 * Canonical tag -> nearest material library key (src/materials/library.js).
 *
 * The library is a visual asset set and does not have one entry per physical
 * tag: there is no water shader, no flesh shader, and thin steel differs from
 * structural steel only in how it looks. MaterialSystem._resolve() consults
 * this table so a legitimate canonical tag can never crash a map build, while
 * a genuine typo still throws in development.
 *
 * metal_thin -> corrugated    thin pressed sheet, the closest thing to it
 * grate      -> metal_rust    bar grating is bare rusting steel, never painted
 * grass      -> foliage       alpha-masked organic with sheen
 * bark       -> wood          same cellulose grain
 * water      -> glass         the only transmissive, low-roughness surface
 * flesh      -> fabric        soft, sheened, non-metallic; used for bodies
 */
export const SURFACE_MATERIAL = Object.freeze({
	concrete: 'concrete',
	asphalt: 'asphalt',
	brick: 'brick',
	plaster: 'plaster',
	tile: 'tile',
	metal: 'metal_painted',
	metal_thin: 'corrugated',
	grate: 'metal_rust',
	wood: 'wood',
	dirt: 'dirt',
	gravel: 'gravel',
	sand: 'sand',
	grass: 'foliage',
	bark: 'wood',
	glass: 'glass',
	water: 'glass',
	foliage: 'foliage',
	fabric: 'fabric',
	rubber: 'rubber',
	flesh: 'fabric'
})

/** True when `name` is one of the 20 canonical tags. */
export function isSurface(name) {
	return typeof name === 'string' && SURFACE[name] !== undefined
}

/**
 * Canonical tag for a canonical name or a declared alias, else null.
 *
 * This is the total, allocation-free lookup every other subsystem should use
 * before it falls back to guessing: null means "nobody declared this name",
 * which is a content bug worth reporting once, not a name to cache a material
 * under.
 */
export function resolveSurfaceAlias(name) {
	if (typeof name !== 'string' || name.length === 0) return null
	if (SURFACE[name] !== undefined) return name
	const key = name.toLowerCase()
	if (SURFACE[key] !== undefined) return key
	const alias = SURFACE_ALIASES[key]
	return alias === undefined ? null : alias
}

/**
 * Best-effort surface inference from a mesh or material name.
 *
 * Ordered specific -> generic: `grate` has to win over `metal`, `bark` over
 * `foliage`, and `asphalt` over `concrete`, so the first match wins and the
 * narrow patterns come first.
 */
const GUESS = [
	[/grate|grating|catwalk|duckboard/i, 'grate'],
	[/metal_thin|thin_metal|sheet_?metal|corrugat|locker|ducting|duct|vent|tin_/i, 'metal_thin'],
	[/kerb|curb/i, 'concrete'],
	[/handrail|balustrade|railing|guardrail/i, 'metal_thin'],
	[/pipe|piping/i, 'metal'],
	[/lamppost|streetlamp|lamp/i, 'glass'],
	[/brick|masonry/i, 'brick'],
	[/tile|tiling|ceramic|porcelain/i, 'tile'],
	[/asphalt|tarmac|road/i, 'asphalt'],
	[/gravel|shingle|ballast|rubble/i, 'gravel'],
	[/grass|lawn|turf|meadow/i, 'grass'],
	[/bark|trunk|stump/i, 'bark'],
	[/plaster|drywall|gypsum|stucco|wall|ceiling|partition/i, 'plaster'],
	[/concrete|cement|stone|rock|marble|barrier/i, 'concrete'],
	[/metal|steel|iron|alu|aluminium|aluminum|rail|car|vehicle|chassis|barrel|drum|sign/i, 'metal'],
	[/wood|timber|plank|crate|pallet|door|plywood|fence|log|furnit/i, 'wood'],
	[/dirt|mud|soil|earth|ground|terrain/i, 'dirt'],
	[/sand|dune|beach/i, 'sand'],
	[/glass|window|mirror|screen|pane/i, 'glass'],
	[/water|pool|puddle|liquid/i, 'water'],
	[/foliage|leaf|leaves|bush|tree|plant|hedge|shrub/i, 'foliage'],
	[/fabric|cloth|canvas|tarp|curtain|carpet|rug|sofa|awning/i, 'fabric'],
	[/flesh|body|skin|head|torso|limb|enemy|actor|char/i, 'flesh'],
	[/rubber|tyre|tire|hose|mat/i, 'rubber']
]

/** Infer a canonical index from a mesh/material name. */
export function guessSurface(name, fallback = SURFACE.concrete) {
	if (!name) return fallback
	/* A declared name never goes through the regex ladder: the ladder is a
	 * heuristic and the alias table is a decision. */
	const canon = resolveSurfaceAlias(name)
	if (canon !== null) return SURFACE[canon]
	for (let i = 0; i < GUESS.length; i++) {
		if (GUESS[i][0].test(name)) return SURFACE[GUESS[i][1]]
	}
	return fallback
}

/** Resolve a surface name, index or undefined to a valid canonical index. */
export function surfaceIndex(s, fallback = SURFACE.concrete) {
	if (typeof s === 'number') return s >= 0 && s < SURFACE_NAMES.length ? s | 0 : fallback
	if (typeof s === 'string') {
		const canon = resolveSurfaceAlias(s)
		if (canon !== null) return SURFACE[canon]
		return guessSurface(s, fallback)
	}
	return fallback
}

/** Canonical index -> tag name, concrete for anything out of range. */
export function surfaceName(i) {
	return SURFACE_NAMES[i] ?? 'concrete'
}

/**
 * Nearest material library key for a canonical tag or a declared alias, or
 * null if the name was never declared anywhere.
 */
export function surfaceMaterial(name) {
	const canon = resolveSurfaceAlias(name)
	if (canon !== null) return SURFACE_MATERIAL[canon] ?? null
	return SURFACE_MATERIAL[name] ?? null
}
