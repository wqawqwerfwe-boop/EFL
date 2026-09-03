import { EFL } from '../core/config.js'
import { clamp, ensureBus, getProfile, peek } from '../core/tarkovUtils.js'

export const PARTS = ['head', 'thorax', 'stomach', 'larm', 'rarm', 'lleg', 'rleg']
const MAXHP = new Float32Array([35, 85, 70, 60, 60, 65, 65])

export const E_BLEED_L = 1, E_BLEED_H = 2, E_FRACTURE = 4, E_PAIN = 8, E_HEALING = 16

const ARMOR_RES = new Float32Array([0, 14, 22, 32, 44, 58, 74])

const PART_INDEX = Object.fromEntries(PARTS.map((p, i) => [p, i]))

export const STAMINA_CFG = {
	sprintDrain: 7.5,
	jumpCost: 12,
	regen: 9,
	floor: 4,
}
export const PAIN_DECAY = 40

function partId(part) {
	if (typeof part === 'number') return PARTS[part] ?? 'thorax'
	return PART_INDEX[part] !== undefined ? part : 'thorax'
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

		if (!opts.noBleed && amt > 4 && Math.random() < 0.32) this.addEffect(target, Math.random() < 0.3 ? 'heavy' : 'light')
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

	_overflow(part) {
		return {
			larm: { to: 'thorax', k: 0.7 },
			rarm: { to: 'thorax', k: 0.7 },
			lleg: { to: 'stomach', k: 0.8 },
			rleg: { to: 'stomach', k: 0.8 },
			stomach: { to: 'thorax', k: 1.0 },
		}[part] || null
	}

	_consume(it, d) {
		if (it.uses != null && --it.uses > 0) return
		if (it.n > 1) it.n--
		else this.inv.remove(it.uid)
	}

	useMed(uid, part = this.selectedPart) {
		const it = this.inv?.get(uid)
		if (!it) return 0
		const d = this.items?.get?.(it.id)
		if (!d) return 0
		if (d.t !== 'med' && d.t !== 'food') return 0

		if (d.t === 'food') {
			this.energy = Math.min(100, this.energy + (d.energy ?? 0))
			this.hydration = Math.min(100, this.hydration + (d.hydra ?? 0))
			this._consume(it, d)
			return d.time ?? 2.5
		}

		let did = false
		if (d.stopsBleed) {
			for (let i = 0; i < PARTS.length; i++) {
				if (this.fx[i] & (E_BLEED_L | E_BLEED_H)) {
					this.setEffect(PARTS[i], 'light', false)
					if (d.stopsBleed > 1) this.setEffect(PARTS[i], 'heavy', false)
					did = true
					break
				}
			}
		}
		if (d.splint) {
			for (let i = 3; i < PARTS.length; i++) {
				if (this.fx[i] & E_FRACTURE) {
					this.setEffect(PARTS[i], 'fracture', false)
					did = true
					break
				}
			}
		}
		if (d.hp) {
			const preferred = partId(part)
			const order = [preferred, ...PARTS.filter((p) => p !== preferred)]
			for (const p of order) {
				const i = PART_INDEX[p]
				const rr = this.hp[i] / this.max[i]
				if (this.hp[i] > 0 && rr < 1) {
					const heal = Math.min(d.hp, this.max[i] - this.hp[i])
					if (heal > 0) {
						this.hp[i] += heal
						did = true
						this.bus.emit('health:changed', { part: p, hp: this.hp[i], dead: false })
						break
					}
				}
			}
		}
		if (!did) return 0
		this._consume(it, d)
		this.bus.emit('health:heal', { uid, part: partId(part), itemId: it.id })
		return d.time ?? 3
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
			ctx.events.emit('health:changed', { part: PARTS[target], hp: this.hp[target], dead: this.dead })
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
		 * вода. Восстановление между рейдами живёт в убежище, а не здесь. */
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
