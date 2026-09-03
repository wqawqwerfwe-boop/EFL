import { EFL } from '../core/config.js'
import { clamp, ensureBus, getProfile, peek } from '../core/tarkovUtils.js'

export const PARTS = ['head', 'thorax', 'stomach', 'larm', 'rarm', 'lleg', 'rleg']
const MAXHP = new Float32Array([35, 85, 70, 60, 60, 65, 65])

export const E_BLEED_L = 1, E_BLEED_H = 2, E_FRACTURE = 4, E_PAIN = 8, E_HEALING = 16

const ARMOR_RES = new Float32Array([0, 14, 22, 32, 44, 58, 74])

/**
 * THE shared anatomy map.
 *
 * Exported because `player` maps incoming part strings to a partIndex with it.
 * A second copy of the limb order living in the player controller is exactly
 * how the two health models drifted apart in the first place.
 */
export const PART_INDEX = Object.fromEntries(PARTS.map((p, i) => [p, i]))

/** Everything a splint can mend. The skull and the chest are surgery. */
const SPLINTABLE = ['stomach', 'larm', 'rarm', 'lleg', 'rleg']

/**
 * Vertical extent of each part along the stance capsule, bottom-up, as a
 * fraction of its height. There is no skinned skeleton here - the capsule IS
 * the skeleton, so the split is authored. Arms overlap the chest and are
 * therefore never resolved from height alone.
 */
const PART_SPAN = [
	[0.88, 1.0],
	[0.6, 0.88],
	[0.44, 0.6],
	[0.55, 0.85],
	[0.55, 0.85],
	[0.0, 0.44],
	[0.0, 0.44],
]

/** Total-HP ratio under which the HUD and the screen treatment read "low". */
export const LOW_RATIO = 0.36

export const STAMINA_CFG = {
	sprintDrain: 7.5,
	jumpCost: 12,
	regen: 9,
	floor: 4,
}
export const PAIN_DECAY = 40

export function partId(part) {
	if (typeof part === 'number') return PARTS[part] ?? 'thorax'
	return PART_INDEX[part] !== undefined ? part : 'thorax'
}

/** Part name OR index -> index. The inverse of partId(), with the same fallback. */
export function partIndexOf(part) {
	if (typeof part === 'number') {
		return part >= 0 && part < PARTS.length ? part : PART_INDEX.thorax
	}
	const i = PART_INDEX[part]
	return i === undefined ? PART_INDEX.thorax : i
}

export class HealthSystem {
	static id = 'health'
	static deps = ['items', 'inventory']

	constructor(ctx = null, options = {}) {
		this.ctx = ctx
		this.bus = ensureBus(ctx)
		this.items = null
		this.inv = null
		this.rng = null
		this.options = Object.assign({ hudRate: 15 }, options)

		this.hp = new Float32Array(PARTS.length)
		this.max = new Float32Array(MAXHP)
		this.fx = new Uint8Array(PARTS.length)
		this.healTimer = new Float32Array(PARTS.length)
		this.eff = Object.create(null)
		this.energy = 100
		this.hydration = 100
		this.stamina = 100
		this.dead = false
		this.tremor = 0
		this._acc = 0
		this._hudAcc = 0
		this._painT = 0
		this._tickAcc = 0
		this.motion = { moving: false, sprinting: false, stance: 'stand', grounded: true, airborne: false }
		this.selectedPart = 'thorax'

		/* Live bone capsule, written in place by player._syncHitbox() every frame.
		 * `valid` stays false in harnesses that boot no player controller, and
		 * every reader falls back to the thorax in that case. The default height
		 * is a standing PMC; player/tuning.js is not imported here on purpose -
		 * the health model may not depend on the player's camera tuning. */
		this.skeleton = {
			valid: false,
			stance: 'stand',
			base: 0,
			height: 1.78,
			radius: 0.3,
			x0: 0, y0: 0, z0: 0,
			x1: 0, y1: 0, z1: 0,
		}

		this._snapshot = this._makeSnapshot()
		this.reset(true)
	}

	async init(ctx) {
		if (ctx) {
			this.ctx = ctx
			this.bus = ensureBus(ctx)
		}
		this.items = this.ctx.get('items')
		this.inv = this.ctx.get('inventory')
		this.rng = this.ctx.rng.fork('health')
		/* THE authority on incoming rounds. The penetration solver has already
		 * resolved which capsule was hit, so partIndex arrives solved and nothing
		 * else in the tree may apply this event as damage a second time. */
		this._onImpact = (e) => {
			if (!e?.target?.isPlayer) return
			const part = PARTS[e.partIndex ?? 1] ?? 'thorax'
			this.applyPlayerHit(part, e.damage ?? 0, { source: e.source ?? e.target ?? null, noBleed: !!e.penetrated })
		}
		this.bus.on('bullet:impact', this._onImpact)
		this.bus.emit('health:ready', this)
		return this
	}

	get profile() {
		return getProfile(this.ctx)
	}

	get skills() {
		return this.profile.skills || {}
	}

	get hideout() {
		return this.profile.hideout || {}
	}

	/** 0..1 across the whole body. The camera and the HUD read this. */
	get fraction() {
		return clamp(this.total() / Math.max(1, this.totalMax()), 0, 1)
	}

	/**
	 * Wounded enough for the screen to say so.
	 *
	 * Thorax and head are checked separately from the total on purpose: a summed
	 * pool hides a chest wound behind four healthy limbs, and the chest is what
	 * kills you.
	 */
	get low() {
		return this.fraction < LOW_RATIO || this.ratio('thorax') < 0.5 || this.ratio('head') < 0.5
	}

	/** Seeded once init() has run, so capture mode stays byte-identical. */
	_rand() {
		return this.rng && typeof this.rng.float === 'function' ? this.rng.float() : Math.random()
	}

	_makeSnapshot() {
		return {
			health: this.total(),
			maxHealth: this.totalMax(),
			energy: this.energy,
			hydration: this.hydration,
			stamina: this.stamina,
			pain: this._painT,
			tremor: 0,
			dead: this.dead,
			selectedPart: this.selectedPart,
			parts: Object.fromEntries(PARTS.map((p) => [p, { hp: this.hp[PART_INDEX[p]] ?? 0, max: this.max[PART_INDEX[p]] ?? 0 }])),
			effects: this.effList(),
		}
	}

	snapshot() {
		this._snapshot.health = this.total()
		this._snapshot.maxHealth = this.totalMax()
		this._snapshot.energy = this.energy
		this._snapshot.hydration = this.hydration
		this._snapshot.stamina = this.stamina
		this._snapshot.pain = this._painT
		this._snapshot.tremor = this.tremor || 0
		this._snapshot.dead = this.dead
		this._snapshot.selectedPart = this.selectedPart
		for (const p of PARTS) {
			const i = PART_INDEX[p]
			this._snapshot.parts[p].hp = this.hp[i]
			this._snapshot.parts[p].max = this.max[i]
		}
		this._snapshot.effects = this.effList()
		return this._snapshot
	}

	getHudState() {
		return this.snapshot()
	}

	/**
	 * Take the player's capsule for this frame.
	 *
	 * Called from player._syncHitbox() with a preallocated struct. Nothing is
	 * retained from it - the fields are copied - so the caller can keep reusing
	 * one object and pays no per-frame allocation.
	 *
	 * Stance is the point of this: crouching moves the head/thorax split down by
	 * more than half a metre, and a hit resolved against a standing skeleton
	 * would put a head shot in the stomach.
	 */
	syncSkeleton(c) {
		if (!c) return this.skeleton
		const s = this.skeleton
		s.x0 = c.x0 ?? 0
		s.y0 = c.y0 ?? 0
		s.z0 = c.z0 ?? 0
		s.x1 = c.x1 ?? s.x0
		s.y1 = c.y1 ?? s.y0
		s.z1 = c.z1 ?? s.z0
		if (c.radius > 0) s.radius = c.radius
		s.base = Number.isFinite(c.base) ? c.base : Math.min(s.y0, s.y1)
		s.height = c.height > 0 ? c.height : Math.max(0.1, s.y1 - s.base)
		s.stance = c.stance ?? s.stance
		s.valid = true
		return s
	}

	/**
	 * Resolve a world-space height to a limb, for damage that arrives with no
	 * solved part: a blast at ankle height takes a leg, one at chest height
	 * takes the chest.
	 */
	partIndexAtHeight(worldY) {
		const s = this.skeleton
		if (!s.valid || !Number.isFinite(worldY)) return PART_INDEX.thorax
		const t = clamp((worldY - s.base) / Math.max(0.1, s.height), 0, 1)
		if (t >= PART_SPAN[PART_INDEX.head][0]) return PART_INDEX.head
		if (t >= PART_SPAN[PART_INDEX.thorax][0]) return PART_INDEX.thorax
		if (t >= PART_SPAN[PART_INDEX.stomach][0]) return PART_INDEX.stomach
		/* Legs: prefer the one still standing, so a blast does not keep chewing a
		 * limb that is already blacked out. */
		const l = PART_INDEX.lleg
		const r = PART_INDEX.rleg
		if (this.hp[l] <= 0 && this.hp[r] > 0) return r
		if (this.hp[r] <= 0 && this.hp[l] > 0) return l
		return this._rand() < 0.5 ? l : r
	}

	/**
	 * Сегментированные ориентиры для экранных эффектов и звука сердца.
	 *
	 * Грудь считается ОТДЕЛЬНО от суммы: суммарный HP прячет тот факт, что
	 * прострелена именно грудь — а умирают от груди и головы, а не от «среднего
	 * по организму».
	 *
	 * @param {object|null} out — чужой объект под запись: вызывается каждый кадр,
	 *   аллоцировать здесь нельзя.
	 */
	vitals(out = null) {
		const o = out || {}
		const ti = PART_INDEX.thorax
		const hi = PART_INDEX.head
		o.thorax = clamp(this.hp[ti] / Math.max(1, this.max[ti]), 0, 1)
		o.head = clamp(this.hp[hi] / Math.max(1, this.max[hi]), 0, 1)
		o.live = clamp(this.total() / Math.max(1, this.totalMax()), 0, 1)
		const b = this.bleedCount()
		/* Сильное кровотечение весит вдвое: оно и убивает втрое быстрее. */
		o.bleeding = b.light + b.heavy * 2
		o.pain = clamp(this._painT / 240, 0, 1)
		o.blacked = this.blackedLegs() + this.blackedArms()
		o.dead = this.dead
		return o
	}

	reset(full = true) {
		const vit = this.skills.vit || 0
		for (const p of PARTS) this.max[PART_INDEX[p]] = MAXHP[PART_INDEX[p]] + vit * 0.4
		if (full || !this._hpSaved) {
			for (const p of PARTS) this.hp[PART_INDEX[p]] = this.max[PART_INDEX[p]]
			this.fx.fill(0)
			this.eff = Object.create(null)
			this.energy = 100
			this.hydration = 100
		} else {
			for (const p of PARTS) if (this.hp[PART_INDEX[p]] == null) this.hp[PART_INDEX[p]] = this.max[PART_INDEX[p]]
		}
		this.stamina = 100
		this.dead = false
		this._painT = 0
		this.tremor = 0
		this._acc = 0
		this._hudAcc = 0
		this._tickAcc = 0
		this._hpSaved = true
		this.bus.emit('health:reset', this.snapshot())
	}

	total() {
		let s = 0
		for (let i = 0; i < PARTS.length; i++) s += this.hp[i]
		return Math.round(s)
	}

	totalMax() {
		let s = 0
		for (let i = 0; i < PARTS.length; i++) s += this.max[i]
		return Math.round(s)
	}

	ratio(part) {
		const p = partId(part)
		const i = PART_INDEX[p]
		return clamp(this.hp[i] / Math.max(1, this.max[i]), 0, 1)
	}

	isBlacked(part) {
		return this.hp[PART_INDEX[partId(part)]] <= 0
	}

	blackedLegs() {
		return (this.isBlacked('lleg') ? 1 : 0) + (this.isBlacked('rleg') ? 1 : 0)
	}

	blackedArms() {
		return (this.isBlacked('larm') ? 1 : 0) + (this.isBlacked('rarm') ? 1 : 0)
	}

	hasEffect(part, kind) {
		return !!this.eff[this.effKey(partId(part), kind)]
	}

	effKey(part, kind) {
		return `${partId(part)}_${kind}`
	}

	fracturedLegs() {
		return (this.hasEffect('lleg', 'fracture') ? 1 : 0) + (this.hasEffect('rleg', 'fracture') ? 1 : 0)
	}

	fracturedArms() {
		return (this.hasEffect('larm', 'fracture') ? 1 : 0) + (this.hasEffect('rarm', 'fracture') ? 1 : 0)
	}

	bleedCount() {
		let light = 0
		let heavy = 0
		for (const k in this.eff) {
			if (k.endsWith('_light')) light++
			else if (k.endsWith('_heavy')) heavy++
		}
		return { light, heavy }
	}

	effList() {
		const a = []
		for (const k in this.eff) {
			const [p, kind] = k.split('_')
			const what = kind === 'light' ? 'Лёгкое кровотечение' : kind === 'heavy' ? 'Сильное кровотечение' : kind === 'fracture' ? 'Перелом' : kind
			const where = p === 'head' ? 'Голова' : p === 'thorax' ? 'Грудная клетка' : p === 'stomach' ? 'Живот' : p === 'larm' ? 'Левая рука' : p === 'rarm' ? 'Правая рука' : p === 'lleg' ? 'Левая нога' : 'Правая нога'
			a.push(what + ' — ' + where)
		}
		if (this._painT > 0) a.push('Боль')
		if (this.energy < 20) a.push('Голод')
		if (this.hydration < 20) a.push('Обезвоживание')
		if (this.stamina < 20) a.push('Истощение')
		return a
	}

	selectPart(part) {
		const p = partId(part)
		this.selectedPart = p
		this.bus.emit('health:select', { part: p })
		return p
	}

	healCost(part = this.selectedPart) {
		const p = partId(part)
		const i = PART_INDEX[p]
		return Math.max(0, Math.round((this.max[i] - this.hp[i]) * 12))
	}

	speedMultiplier(motion = this.motion) {
		if (this.dead) return 0
		let p = 1
		const legs = this.blackedLegs()
		if (legs === 1) p *= 0.62
		else if (legs >= 2) p *= 0.28
		const fractures = this.fracturedLegs()
		if (fractures) p *= fractures === 1 ? 0.82 : 0.68
		if (motion?.sprinting && legs > 0) p *= 0.45
		if (this.energy < 20 || this.hydration < 20) p *= 0.72
		if (this.stamina < 20) p *= 0.75
		if (this._painT > 0) p *= 0.88
		return clamp(p, 0.12, 1)
	}

	addEffect(part, kind) {
		return this.setEffect(part, kind, true)
	}

	removeEffect(part, kind) {
		return this.setEffect(part, kind, false)
	}

	damage(part, amount, opts = {}) {
		if (this.dead || !(amount > 0)) return 0
		const original = partId(part)
		let target = original
		let amt = amount
		const guard = new Set()
		while (this.hp[PART_INDEX[target]] <= 0 && this._overflow(target) && !guard.has(target)) {
			guard.add(target)
			amt *= this._overflow(target).k
			target = this._overflow(target).to
		}

		const idx = PART_INDEX[target]
		const before = this.hp[idx]
		this.hp[idx] = Math.max(0, before - amt)
		const dealt = before - this.hp[idx]
		const blocked = Math.max(0, amount - dealt)

		if (this.hp[idx] <= 0 && before > 0) {
			if (target === 'head' || target === 'thorax') {
				this.bus.emit('health:damage', { part: target, amount: amt, dealt, blocked, source: opts.source || null })
				this.die(opts.source || (target === 'head' ? 'Ранение в голову' : 'Ранение в грудь'))
				return dealt
			}
			this.setEffect(target, 'fracture', true)
			this._painT = Math.max(this._painT, 240)
			this.bus.emit('health:blacked', { part: target })
		}

		/* Seeded, not Math.random: this runs on every round that lands and the
		 * capture harness has to reproduce it frame for frame. */
		if (!opts.noBleed && amt > 4 && this._rand() < 0.32) {
			this.addEffect(target, this._rand() < 0.3 ? 'heavy' : 'light')
		}
		this.tremor = Math.max(this.tremor || 0, Math.min(1, 0.15 + dealt / 100))
		this.bus.emit('health:damage', { part: target, amount: amt, dealt, blocked, source: opts.source || null })
		return dealt
	}

	applyPlayerHit(part, amount, opts = {}) {
		return this.damage(part, amount, opts)
	}

	dmg(part, amount, opts = {}) {
		return this.damage(part, amount, opts)
	}

	/**
	 * Give HP back.
	 *
	 * The only non-item heal path, used by player.heal(a) and the hideout. There
	 * is deliberately no passive caller: nothing in a raid ticks this.
	 *
	 * Spends the pool on the target limb first and then on whatever is worst
	 * hurt, because a single number handed to a seven-limb body has to choose
	 * somewhere and the worst wound is the one the player wants closed. Blacked
	 * limbs are skipped: bringing one back is surgery, not first aid.
	 *
	 * @returns {number} HP actually restored.
	 */
	heal(amount, part = this.selectedPart) {
		if (this.dead || !(amount > 0)) return 0
		let left = amount
		let healed = 0
		for (const i of this._healOrder(part)) {
			if (left <= 0) break
			if (this.hp[i] <= 0) continue
			const room = this.max[i] - this.hp[i]
			if (room <= 0) continue
			const take = Math.min(room, left)
			this.hp[i] += take
			left -= take
			healed += take
			this.bus.emit('health:changed', { part: PARTS[i], hp: this.hp[i], dead: false })
		}
		if (healed <= 0) return 0
		this.bus.emit('health:heal', { uid: null, itemId: null, part: partId(part), amount: healed })
		return healed
	}

	/** Target limb first, then the rest worst-wounded first. */
	_healOrder(part) {
		const first = partIndexOf(part)
		const rest = []
		for (let i = 0; i < PARTS.length; i++) if (i !== first) rest.push(i)
		rest.sort((a, b) => this.hp[a] / Math.max(1, this.max[a]) - this.hp[b] / Math.max(1, this.max[b]))
		rest.unshift(first)
		return rest
	}

	_overflow(part) {
		return {
			larm: { to: 'thorax', k: 0.7 },
			rarm: { to: 'thorax', k: 0.7 },
			lleg: { to: 'stomach', k: 0.8 },
			rleg: { to: 'stomach', k: 0.8 },
			stomach: { to: 'thorax', k: 1.0 },
		}[part] || null
	}

	/**
	 * Instance durability.
	 *
	 * `uses` lives on the INSTANCE - inventory.add() seeds it from the item def -
	 * so it is decremented on the instance and RESET when the stack rolls onto a
	 * fresh unit.
	 *
	 * The old body left `uses` at 0 after burning a unit out of a stack, so the
	 * next press walked straight past the `> 0` test and ate a whole second
	 * Salewa in one use. Only ever called once the med has actually done
	 * something, so nothing is spent on a no-op.
	 */
	_consume(it, d) {
		const max = d.uses ?? null
		if (it.uses == null && max != null) it.uses = max
		if (it.uses != null) {
			it.uses--
			if (it.uses > 0) return
		}
		if (it.n > 1) {
			it.n--
			it.uses = max
			return
		}
		this.inv?.remove(it.uid)
	}

	/**
	 * Consume a med or a ration.
	 *
	 * `part` is the limb the PLAYER pointed at: the inventory mirrors its doll
	 * selection through health:select, and the quick-use path passes it
	 * explicitly. Every branch below prefers that limb and only then falls back
	 * to scanning the body, so a targeted Salewa cannot spend itself on the
	 * wrong leg.
	 *
	 * Nothing is consumed unless something actually changed: `did` gates
	 * _consume(), so a bandage tapped against an arterial bleed it cannot close
	 * stays in the rig instead of vanishing for free.
	 *
	 * @returns {number} seconds of use animation, or 0 if the item did nothing.
	 */
	useMed(uid, part = this.selectedPart) {
		const it = this.inv?.get(uid)
		if (!it) return 0
		const d = this.items?.get?.(it.id)
		if (!d) return 0
		if (d.t !== 'med' && d.t !== 'food') return 0

		const preferred = partId(part)

		if (d.t === 'food') {
			const before = this.energy + this.hydration
			this.energy = clamp(this.energy + (d.energy ?? 0), 0, 100)
			this.hydration = clamp(this.hydration + (d.hydra ?? 0), 0, 100)
			/* Full up: do not burn the last water bottle for nothing. */
			if (this.energy + this.hydration === before) return 0
			this._consume(it, d)
			this.bus.emit('health:heal', { uid, part: preferred, itemId: it.id })
			return d.time ?? 2.5
		}

		let did = false

		/* ---- bleeds: HEAVY first, and only what the item can actually close ----
		 * stopsBleed 1 = light only (Bandage), 2+ = heavy as well (Salewa, IFAK,
		 * AFAK, CALOK-B). The old loop stopped at the first part carrying EITHER
		 * bit and then always cleared 'light', so a bandage thrown at a heavy
		 * bleed reported success, consumed itself and left the player still
		 * draining - while a Salewa could spend itself on a scratch on the far
		 * side of the body with an arterial bleed open in the chest. */
		if (d.stopsBleed) {
			if (d.stopsBleed > 1 && this._closeBleed(preferred, 'heavy')) did = true
			else if (this._closeBleed(preferred, 'light')) did = true
		}

		if (d.splint && this._mendFracture(preferred)) did = true

		if (d.hp && this._applyMedHp(preferred, d.hp)) did = true

		if (!did) return 0
		this._consume(it, d)
		this.bus.emit('health:heal', { uid, part: preferred, itemId: it.id })
		return d.time ?? 3
	}

	/** Close one bleed of `kind`, the target limb first. */
	_closeBleed(preferred, kind) {
		const bit = kind === 'heavy' ? E_BLEED_H : E_BLEED_L
		if (this.fx[PART_INDEX[preferred]] & bit) return this.setEffect(preferred, kind, false)
		for (let i = 0; i < PARTS.length; i++) {
			if (this.fx[i] & bit) return this.setEffect(PARTS[i], kind, false)
		}
		return false
	}

	/**
	 * Splint one fracture, the target limb first.
	 *
	 * Scans SPLINTABLE rather than counting from index 3: damage() and
	 * _blackout() both set a fracture on ANY blacked part that is not the head or
	 * the chest, stomach included, and the old `i = 3` loop could never reach a
	 * stomach fracture - it stayed on the character for the rest of the raid.
	 */
	_mendFracture(preferred) {
		if (SPLINTABLE.includes(preferred) && this.fx[PART_INDEX[preferred]] & E_FRACTURE) {
			return this.setEffect(preferred, 'fracture', false)
		}
		for (const p of SPLINTABLE) {
			if (this.fx[PART_INDEX[p]] & E_FRACTURE) return this.setEffect(p, 'fracture', false)
		}
		return false
	}

	/**
	 * One limb per use, the target limb first. Blacked limbs are skipped - they
	 * need surgery, and letting a Salewa top one up would make the blackout
	 * meaningless.
	 */
	_applyMedHp(preferred, pool) {
		const i = PART_INDEX[preferred]
		if (this.hp[i] > 0 && this.hp[i] < this.max[i]) {
			this.hp[i] += Math.min(pool, this.max[i] - this.hp[i])
			this.bus.emit('health:changed', { part: preferred, hp: this.hp[i], dead: false })
			return true
		}
		/* Nothing to do on the chosen limb: fall back to the WORST wounded one
		 * rather than the first in anatomy order. */
		let worst = -1
		let worstRatio = 1
		for (let k = 0; k < PARTS.length; k++) {
			if (this.hp[k] <= 0) continue
			const rr = this.hp[k] / Math.max(1, this.max[k])
			if (rr < worstRatio) {
				worstRatio = rr
				worst = k
			}
		}
		if (worst < 0 || worstRatio >= 1) return false
		this.hp[worst] += Math.min(pool, this.max[worst] - this.hp[worst])
		this.bus.emit('health:changed', { part: PARTS[worst], hp: this.hp[worst], dead: false })
		return true
	}

	use(uid, part) {
		return this.useMed(uid, part)
	}

	fixedUpdate(h, ctx = this.ctx) {
		if (this.dead) return
		this._painT = Math.max(0, this._painT - h * PAIN_DECAY)
		this._acc += h
		if (this._acc < 1) return
		const dt = this._acc
		this._acc = 0

		const S = EFL.survival
		const sprinting = !!this.motion?.sprinting
		const energyDrain = S.energyDrain + (sprinting ? STAMINA_CFG.sprintDrain * 0.01 : 0)
		const hydraDrain = S.hydraDrain + (sprinting ? STAMINA_CFG.sprintDrain * 0.012 : 0)

		let bleed = 0
		for (let i = 0; i < PARTS.length; i++) {
			const f = this.fx[i]
			if (f & E_BLEED_H) bleed += S.bleedHeavy
			else if (f & E_BLEED_L) bleed += S.bleedLight
		}
		if (bleed > 0) {
			const target = this.hp[PART_INDEX.thorax] > 0 ? PART_INDEX.thorax : PART_INDEX.stomach
			this.hp[target] = Math.max(0, this.hp[target] - bleed * dt)
			this.hydration = Math.max(0, this.hydration - bleed * dt * 0.4)
			if (this.hp[target] <= 0) this._blackout(PARTS[target])
			/* this.bus, not ctx.events: ensureBus() already resolved the one true
			 * bus in the constructor, and fixedUpdate must not fall over in a
			 * harness that hands us a ctx with no events on it. */
			this.bus.emit('health:changed', { part: PARTS[target], hp: this.hp[target], dead: this.dead })
		}

		this.energy = Math.max(0, this.energy - energyDrain * dt)
		this.hydration = Math.max(0, this.hydration - hydraDrain * dt)
		if (sprinting && this.stamina > 0) this.stamina = Math.max(0, this.stamina - STAMINA_CFG.sprintDrain * dt)
		else this.stamina = Math.min(100, this.stamina + STAMINA_CFG.regen * dt)

		if (this.energy <= 0 || this.hydration <= 0) {
			this.hp[PART_INDEX.thorax] = Math.max(0, this.hp[PART_INDEX.thorax] - S.starveDamage * dt)
			if (this.hp[PART_INDEX.thorax] <= 0) this.die()
		}

		/* Пассивной регенерации здесь больше нет.
		 *
		 * Раньше ветка energy > 55 && bleed === 0 лечила все части тела на
		 * 0.12 хп/с бесплатно: достаточно было отсидеться в углу две минуты,
		 * и аптечки, жгуты и шины становились мертвым грузом. В рейде HP
		 * возвращает только useMed(); голод и обезвоживание — только еда и
		 * вода. Восстановление между рейдами живёт в убежище, а не здесь.
		 *
		 * Аркадный пул игрока (src/player/health.js) со своим собственным
		 * CoD-регеном удалён целиком — вместе с ним ушла вторая, независимая
		 * модель здоровья, которая молча возвращала HP в обход этой. */
	}

	update(dt) {
		if (this.dead) return
		this._hudAcc += dt
		this._tickAcc += dt
		if (this._tickAcc >= 1 / (this.options.hudRate || 15)) {
			this._tickAcc = 0
			this.bus.emit('health:tick', this.snapshot())
		}
		this.tremor = Math.max(0, (this.tremor || 0) - dt * 0.8)
	}

	_blackout(part) {
		const p = partId(part)
		if (p === 'head' || p === 'thorax') {
			this.die()
			return
		}
		this.setEffect(p, 'fracture', true)
		if (p === 'stomach') this.energy = Math.min(this.energy, 40)
	}

	setEffect(part, kind, on) {
		const p = partId(part)
		const bit = kind === 'light' ? E_BLEED_L : kind === 'heavy' ? E_BLEED_H : kind === 'fracture' ? E_FRACTURE : kind === 'pain' ? E_PAIN : kind === 'healing' ? E_HEALING : 0
		const idx = PART_INDEX[p]
		const had = (this.fx[idx] & bit) !== 0
		if (had === on) return false
		if (on) this.fx[idx] |= bit
		else this.fx[idx] &= ~bit
		const key = this.effKey(p, kind)
		if (on) this.eff[key] = 1
		else delete this.eff[key]
		this.bus.emit('health:effect', { key, part: p, kind, added: on })
		return true
	}

	die(by = null) {
		if (this.dead) return
		this.dead = true
		this.bus.emit('health:death', { by })
		this.bus.emit('actor:death', { actor: null, isPlayer: true, by })
	}

	legPenalty() {
		let p = 1
		const blacked = this.blackedLegs()
		if (blacked === 1) p *= 0.68
		else if (blacked >= 2) p *= 0.42
		if (this.fx[PART_INDEX.lleg] & E_FRACTURE) p *= 0.7
		if (this.fx[PART_INDEX.rleg] & E_FRACTURE) p *= 0.7
		return p
	}

	armPenalty() {
		let p = 1
		if (this.blackedArms() > 0) p *= 0.6
		if ((this.fx[PART_INDEX.larm] | this.fx[PART_INDEX.rarm]) & E_FRACTURE) p *= 0.75
		if (this._painT > 0) p *= 0.85
		return p
	}

	dispose() {
		this.bus.off('bullet:impact', this._onImpact)
	}
}

export default HealthSystem
