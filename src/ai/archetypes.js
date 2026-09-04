/**
 * Faction archetype matrix.
 *
 * One frozen record per faction, and it is the only place a bot's numbers come
 * from. Before this file an agent asked `variantName === 'irregular'` in three
 * different methods to decide its fire rate and its reload length, which meant a
 * *visual* choice - which soldier mesh to build - was silently driving
 * ballistics. The mesh variant is still in here, but now it is one field on a
 * record instead of the record itself.
 *
 * Fields are grouped by the system that reads them:
 *   body    - Anatomy: hp scale, bleed odds, whether a head hit is fatal
 *   armor   - Anatomy.setArmor: class band and which parts are plated
 *   senses  - Agent._sense: cone, range, how long before it commits to a target
 *   weapon  - Agent._shoot / _fireRound: rate, cone, sway, burst, reload, wear
 *   tactics - Agent._combat and Squad: cover, peeking, flanking, grenades
 *   voice   - src/ai/voice.js: which bank shouts, in which language, on radio
 *
 * Everything is deep frozen. A record is shared by every actor of that faction,
 * so a bot that wrote to its own archetype would retune the whole raid.
 */

function deepFreeze(o) {
	if (!o || typeof o !== 'object' || Object.isFrozen(o)) return o
	Object.freeze(o)
	for (const k of Object.keys(o)) deepFreeze(o[k])
	return o
}

/** String faction ids - the canonical spelling everywhere above the AI. */
export const FACTIONS = Object.freeze({
	SCAV: 'scav',
	RAIDER: 'raider',
	PMC: 'pmc',
	BOSS: 'boss',
})

/**
 * Bridge to the integer FACTION enum in src/ai/index.js. The two AI hosts have
 * to agree on what a raider is when karma and hostility resolve.
 */
export const FACTION_INDEX = Object.freeze({ scav: 0, raider: 1, pmc: 2, boss: 3 })
export const FACTION_BY_INDEX = Object.freeze(['scav', 'raider', 'pmc', 'boss'])

/**
 * Old spawn strings. Map builds and src/ai/preview.js still ask for the soldier
 * variants by name, and they must keep spawning the same silhouette they always
 * did - 'vanguard' was the kitted regular, 'irregular' the ragged one - so they
 * resolve onto the faction that wears that mesh.
 */
export const LEGACY_VARIANTS = Object.freeze({
	vanguard: 'pmc',
	irregular: 'scav',
	soldier: 'pmc',
	regular: 'pmc',
	civilian: 'scav',
	bandit: 'scav',
})

export const ARCHETYPES = deepFreeze({
	/* ------------------------------------------------------------------ *
	 * SCAV - ragged civilians with whatever they could scrape together.
	 * Cheap plates at best, a wandering muzzle, and a reaction delay long
	 * enough that a quiet player gets the first shot off.
	 * ------------------------------------------------------------------ */
	scav: {
		id: 'scav',
		label: 'Scav',
		faction: 'scav',
		variant: 'irregular',
		xp: 120,
		karma: -0.03,
		spawnWeight: 0.62,
		scale: { min: 0.94, max: 1.04 },
		body: { hpScale: 0.82, bleedChance: 0.38, heavyChance: 0.34, lethalHead: true },
		armor: { min: 0, max: 2, parts: ['thorax'], helmetDrop: 2 },
		senses: {
			viewRange: 46,
			fovDeg: 96,
			alertFovBonus: 0.25,
			reaction: 0.62,
			reactionJitter: 0.28,
			awarenessRate: 0.72,
			hearing: 0.9,
			forgetTime: 5.5,
		},
		weapon: {
			fireRate: 7.4,
			magSize: 30,
			spread: 0.055,
			damage: 15,
			range: 42,
			reload: 3.1,
			burstMin: 2,
			burstMax: 6,
			burstRestMin: 0.55,
			burstRestMax: 1.8,
			// high random sway: the muzzle never settles
			sway: { amp: 0.055, freq: 1.35, random: 0.75 },
			durability: { min: 0.35, max: 0.75, wear: 0.00042, spreadAtZero: 2.6 },
		},
		tactics: {
			coverPreference: 0.7,
			peekMin: 0.7,
			peekMax: 1.9,
			flankChance: 0.06,
			flankMin: 6,
			flankMax: 11,
			grenadeMin: 22,
			grenadeMax: 44,
			retreatFraction: 0.55,
			suppressionResist: 0.55,
			speedPatrol: 1.2,
			speedAlert: 1.4,
			speedAdvance: 3.6,
			speedFlank: 3.9,
		},
		voice: { bank: 'scav', lang: 'ru', radio: false, f0Min: 98, f0Max: 152, chatter: 0.75 },
	},

	/* ------------------------------------------------------------------ *
	 * RAIDER - ex-PMCs on a contract. Class 4-6 plates, disciplined fire,
	 * and the only archetype that flanks on its own initiative often enough
	 * to matter.
	 * ------------------------------------------------------------------ */
	raider: {
		id: 'raider',
		label: 'Raider',
		faction: 'raider',
		variant: 'vanguard',
		xp: 480,
		karma: 0.02,
		spawnWeight: 0.2,
		scale: { min: 1, max: 1.06 },
		body: { hpScale: 1.12, bleedChance: 0.28, heavyChance: 0.26, lethalHead: true },
		armor: { min: 4, max: 6, parts: ['head', 'thorax', 'stomach'], helmetDrop: 1 },
		senses: {
			viewRange: 78,
			fovDeg: 124,
			alertFovBonus: 0.3,
			reaction: 0.26,
			reactionJitter: 0.1,
			awarenessRate: 1.45,
			hearing: 1.25,
			forgetTime: 9,
		},
		weapon: {
			fireRate: 11.6,
			magSize: 30,
			spread: 0.019,
			damage: 21,
			range: 68,
			reload: 2.05,
			burstMin: 3,
			burstMax: 8,
			burstRestMin: 0.28,
			burstRestMax: 0.85,
			sway: { amp: 0.012, freq: 0.85, random: 0.12 },
			durability: { min: 0.82, max: 0.99, wear: 0.00018, spreadAtZero: 1.8 },
		},
		tactics: {
			coverPreference: 0.95,
			peekMin: 1.2,
			peekMax: 2.6,
			flankChance: 0.42,
			flankMin: 9,
			flankMax: 17,
			grenadeMin: 10,
			grenadeMax: 22,
			retreatFraction: 0.28,
			suppressionResist: 1.35,
			speedPatrol: 1.45,
			speedAlert: 1.7,
			speedAdvance: 4.5,
			speedFlank: 4.9,
		},
		voice: { bank: 'raider', lang: 'en', radio: true, f0Min: 86, f0Max: 124, chatter: 0.55 },
	},

	/* ------------------------------------------------------------------ *
	 * PMC - the player's own kind. Two sides that differ only in what they
	 * shout, which is the whole point: you cannot tell a USEC from a BEAR
	 * until one of them opens their mouth.
	 * ------------------------------------------------------------------ */
	pmc: {
		id: 'pmc',
		label: 'PMC',
		faction: 'pmc',
		variant: 'vanguard',
		xp: 560,
		karma: 0,
		spawnWeight: 0.15,
		scale: { min: 0.98, max: 1.05 },
		body: { hpScale: 1, bleedChance: 0.32, heavyChance: 0.3, lethalHead: true },
		armor: { min: 3, max: 5, parts: ['head', 'thorax', 'stomach'], helmetDrop: 1 },
		senses: {
			viewRange: 72,
			fovDeg: 118,
			alertFovBonus: 0.28,
			reaction: 0.32,
			reactionJitter: 0.14,
			awarenessRate: 1.2,
			hearing: 1.15,
			forgetTime: 8,
		},
		weapon: {
			fireRate: 10.5,
			magSize: 30,
			spread: 0.024,
			damage: 19,
			range: 64,
			reload: 2.3,
			burstMin: 3,
			burstMax: 7,
			burstRestMin: 0.34,
			burstRestMax: 1,
			sway: { amp: 0.018, freq: 0.95, random: 0.2 },
			durability: { min: 0.7, max: 0.96, wear: 0.00024, spreadAtZero: 2 },
		},
		tactics: {
			coverPreference: 0.9,
			peekMin: 1.1,
			peekMax: 2.4,
			flankChance: 0.3,
			flankMin: 8,
			flankMax: 15,
			grenadeMin: 14,
			grenadeMax: 28,
			retreatFraction: 0.34,
			suppressionResist: 1.1,
			speedPatrol: 1.4,
			speedAlert: 1.6,
			speedAdvance: 4.3,
			speedFlank: 4.7,
		},
		voice: { bank: 'usec', lang: 'en', radio: true, f0Min: 92, f0Max: 132, chatter: 0.5 },
		subtypes: [
			{ id: 'usec', label: 'USEC', weight: 0.5, voice: { bank: 'usec', lang: 'en' } },
			{ id: 'bear', label: 'BEAR', weight: 0.5, voice: { bank: 'bear', lang: 'ru' } },
		],
	},

	/* ------------------------------------------------------------------ *
	 * BOSS - a raider who does not miss and does not leave.
	 * ------------------------------------------------------------------ */
	boss: {
		id: 'boss',
		label: 'Boss',
		faction: 'boss',
		variant: 'vanguard',
		xp: 1500,
		karma: 0,
		spawnWeight: 0.03,
		scale: { min: 1.04, max: 1.1 },
		body: { hpScale: 1.55, bleedChance: 0.22, heavyChance: 0.22, lethalHead: true },
		armor: { min: 5, max: 6, parts: ['head', 'thorax', 'stomach'], helmetDrop: 1 },
		senses: {
			viewRange: 92,
			fovDeg: 140,
			alertFovBonus: 0.35,
			reaction: 0.2,
			reactionJitter: 0.06,
			awarenessRate: 1.8,
			hearing: 1.4,
			forgetTime: 12,
		},
		weapon: {
			fireRate: 12.4,
			magSize: 45,
			spread: 0.014,
			damage: 24,
			range: 82,
			reload: 1.9,
			burstMin: 4,
			burstMax: 10,
			burstRestMin: 0.22,
			burstRestMax: 0.7,
			sway: { amp: 0.009, freq: 0.75, random: 0.08 },
			durability: { min: 0.92, max: 1, wear: 0.00012, spreadAtZero: 1.6 },
		},
		tactics: {
			coverPreference: 0.8,
			peekMin: 1.4,
			peekMax: 3,
			flankChance: 0.26,
			flankMin: 7,
			flankMax: 14,
			grenadeMin: 8,
			grenadeMax: 18,
			// does not run
			retreatFraction: 0,
			suppressionResist: 1.9,
			speedPatrol: 1.35,
			speedAlert: 1.65,
			speedAdvance: 4.4,
			speedFlank: 4.6,
		},
		voice: { bank: 'boss', lang: 'ru', radio: false, f0Min: 74, f0Max: 104, chatter: 0.4 },
	},
})

export const ARCHETYPE_IDS = Object.freeze(Object.keys(ARCHETYPES))
export const DEFAULT_ARCHETYPE = 'scav'

/* ------------------------------------------------------------------ *
 * rng helpers - tolerate any of the generators in the codebase
 * ------------------------------------------------------------------ */

function rfloat(rng) {
	if (rng && typeof rng.float === 'function') return rng.float()
	return Math.random()
}

function rrange(rng, lo, hi) {
	if (hi <= lo) return lo
	if (rng && typeof rng.range === 'function') return rng.range(lo, hi)
	return lo + rfloat(rng) * (hi - lo)
}

function rint(rng, lo, hi) {
	if (hi <= lo) return lo
	if (rng && typeof rng.int === 'function') return rng.int(lo, hi)
	return lo + Math.floor(rfloat(rng) * (hi - lo + 1))
}

/* ------------------------------------------------------------------ *
 * lookup
 * ------------------------------------------------------------------ */

/** Exact lookup by id. Returns null rather than guessing. */
export function archetype(id) {
	if (!id) return null
	const a = ARCHETYPES[String(id).toLowerCase()]
	return a === undefined ? null : a
}

export function factionIndex(id) {
	const i = FACTION_INDEX[String(id || '').toLowerCase()]
	return i === undefined ? 0 : i
}

/** Weighted spawn roll across the whole matrix. */
export function rollArchetype(rng) {
	let total = 0
	for (let i = 0; i < ARCHETYPE_IDS.length; i++) {
		total += ARCHETYPES[ARCHETYPE_IDS[i]].spawnWeight
	}
	let r = rfloat(rng) * total
	for (let i = 0; i < ARCHETYPE_IDS.length; i++) {
		const a = ARCHETYPES[ARCHETYPE_IDS[i]]
		r -= a.spawnWeight
		if (r <= 0) return a
	}
	return ARCHETYPES[DEFAULT_ARCHETYPE]
}

/**
 * Turn whatever a spawner passed into a record.
 *
 * Accepts a record, an id, an integer from the FACTION enum, or a legacy mesh
 * variant name. Falls back to a weighted roll when an rng is available, so a
 * spawn point with no faction still produces a sensible raid population instead
 * of a street full of scavs.
 */
export function resolveArchetype(opts, rng) {
	const o = opts === undefined || opts === null ? {} : opts
	const want =
		typeof o === 'string' || typeof o === 'number'
			? o
			: o.archetype !== undefined
				? o.archetype
				: o.faction !== undefined
					? o.faction
					: o.variant

	if (want && typeof want === 'object' && want.id && ARCHETYPES[want.id]) return ARCHETYPES[want.id]
	if (typeof want === 'number' && Number.isFinite(want)) {
		const id = FACTION_BY_INDEX[Math.trunc(want)]
		if (id && ARCHETYPES[id]) return ARCHETYPES[id]
	}
	if (typeof want === 'string' && want) {
		const key = want.toLowerCase()
		if (ARCHETYPES[key]) return ARCHETYPES[key]
		const legacy = LEGACY_VARIANTS[key]
		if (legacy && ARCHETYPES[legacy]) return ARCHETYPES[legacy]
	}
	if (rng) return rollArchetype(rng)
	return ARCHETYPES[DEFAULT_ARCHETYPE]
}

/** USEC or BEAR. Returns null for archetypes that have no sides. */
export function rollSubtype(a, rng) {
	const list = a && a.subtypes
	if (!Array.isArray(list) || list.length === 0) return null
	let total = 0
	for (let i = 0; i < list.length; i++) total += list[i].weight === undefined ? 1 : list[i].weight
	let r = rfloat(rng) * total
	for (let i = 0; i < list.length; i++) {
		r -= list[i].weight === undefined ? 1 : list[i].weight
		if (r <= 0) return list[i]
	}
	return list[list.length - 1]
}

/** Which voice bank this actor actually uses, honouring the USEC/BEAR split. */
export function voiceFor(a, subtype) {
	const base = a && a.voice ? a.voice : null
	if (!base) return { bank: 'scav', lang: 'ru', radio: false, f0Min: 100, f0Max: 150, chatter: 0.6 }
	if (!subtype || !subtype.voice) return base
	return {
		bank: subtype.voice.bank === undefined ? base.bank : subtype.voice.bank,
		lang: subtype.voice.lang === undefined ? base.lang : subtype.voice.lang,
		radio: base.radio,
		f0Min: base.f0Min,
		f0Max: base.f0Max,
		chatter: base.chatter,
	}
}

/* ------------------------------------------------------------------ *
 * per-actor rolls - called once at spawn
 * ------------------------------------------------------------------ */

export function armorClassFor(a, rng) {
	const ar = a && a.armor ? a.armor : null
	if (!ar) return 0
	return rint(rng, ar.min === undefined ? 0 : ar.min, ar.max === undefined ? 0 : ar.max)
}

export function scaleFor(a, rng) {
	const s = a && a.scale ? a.scale : null
	if (!s) return 1
	return rrange(rng, s.min === undefined ? 1 : s.min, s.max === undefined ? 1 : s.max)
}

export function durabilityFor(a, rng) {
	const d = a && a.weapon ? a.weapon.durability : null
	if (!d) return 1
	return rrange(rng, d.min === undefined ? 1 : d.min, d.max === undefined ? 1 : d.max)
}

/** Reaction delay in seconds, jittered so a squad never fires in unison. */
export function reactionFor(a, rng) {
	const s = a && a.senses ? a.senses : null
	if (!s) return 0.4
	const j = s.reactionJitter === undefined ? 0 : s.reactionJitter
	return Math.max(0.05, s.reaction + (rfloat(rng) * 2 - 1) * j)
}

export function burstLength(a, rng) {
	const w = a && a.weapon ? a.weapon : null
	if (!w) return 4
	return rint(rng, w.burstMin === undefined ? 3 : w.burstMin, w.burstMax === undefined ? 6 : w.burstMax)
}

export function burstRest(a, rng) {
	const w = a && a.weapon ? a.weapon : null
	if (!w) return 0.8
	return rrange(
		rng,
		w.burstRestMin === undefined ? 0.4 : w.burstRestMin,
		w.burstRestMax === undefined ? 1.2 : w.burstRestMax
	)
}

export function peekWindow(a, rng, peeking) {
	const t = a && a.tactics ? a.tactics : null
	if (!t) return peeking ? 1.4 : 1
	const lo = t.peekMin === undefined ? 1 : t.peekMin
	const hi = t.peekMax === undefined ? 2 : t.peekMax
	// a peek that was refused is retried sooner than one that was taken
	return peeking ? rrange(rng, lo, hi) : rrange(rng, lo * 0.6, hi * 0.7)
}

export function grenadeDelay(a, rng) {
	const t = a && a.tactics ? a.tactics : null
	if (!t) return 20
	return rrange(rng, t.grenadeMin === undefined ? 14 : t.grenadeMin, t.grenadeMax === undefined ? 30 : t.grenadeMax)
}

export function flankOffset(a, rng) {
	const t = a && a.tactics ? a.tactics : null
	if (!t) return 10
	return rrange(rng, t.flankMin === undefined ? 8 : t.flankMin, t.flankMax === undefined ? 15 : t.flankMax)
}

export default ARCHETYPES