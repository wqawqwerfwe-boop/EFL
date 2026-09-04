/* ==========================================================================
 * Escape-From-Larpov · src/meta/loadouts.js
 *
 * Генераторные таблицы СНАРЯЖЕНИЯ ДИКОГО. Только данные и броски.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Раньше таблицы дикого жили в src/raid/index.js —
 * то есть баланс экономики лежал внутри контроллера жизненного цикла рейда,
 * который не видит ни профиля, ни кармы и не имеет права их видеть.
 * Теперь владелец кита — MetaSystem (профиль), а этот файл — его данные.
 *
 * МОДУЛЬ СОЗНАТЕЛЬНО СТЕРИЛЕН: ни одного import, ни одного обращения к
 * системам, ни одного побочного эффекта. Его можно дёрнуть из теста с фейковым
 * rng и посчитать распределение за 10⁵ бросков, не собирая движок.
 *
 * ДИЗАЙН-ИД → ИД БАЗЫ. Техзадание описывало пулы именами вида wpn_ak74u и
 * item_cigarettes. В src/items/index.js таких ключей нет и никогда не было,
 * поэтому каждая строка несёт ОБА имени: `design` — ссылка на техзадание,
 * `id` — то, что реально есть в базе предметов. Подмены выполнены по роли и
 * габариту, а не по созвучию:
 *
 *   wpn_ak74u      -> aks74u      укороченный автомат 5.45
 *   wpn_toz        -> m870        помповое ружьё 12/70
 *   wpn_pm         -> pm          пистолет 9x18
 *   wpn_mosin      -> mosin       винтовка 7.62x54R
 *   item_cigarettes-> crackers    мелкий бартер 1x1 из кармана
 *   item_matches   -> gunpowder   мелкий горючий бартер 1x1
 *   item_screwdriver-> bolts      слесарный хлам 1x1
 *   item_tape      -> wires       ремонтный хлам 1x1
 *   item_roubles   -> rub         рубли, стек 500..4000
 *
 * КАРМА. P.karma живёт в [-1, 1] и сворачивается в один множитель k ∈ [0, 1]
 * (scavKarmaFactor). Он делает ровно четыре вещи, и больше ничего:
 *
 *   1. сдвигает веса пула оружия (karmaBias): внизу — ПМ и дробовик,
 *      вверху — автомат;
 *   2. поднимает ОБЕ границы прочности — высокая карма ГАРАНТИРУЕТ ствол
 *      лучше любого возможного при низкой, а не просто сдвигает среднее;
 *   3. увеличивает число и ценность карманного хлама и размер стека рублей;
 *   4. открывает редкий бросок ключа/карты доступа в верхней трети.
 *
 * Уровень игрока влияет слабо и намеренно: дикий — чужое тело, а не второй
 * прогресс-трек ПМС. Потолок от уровня — +6 прочности к 40 уровню.
 *
 * СЛОТЫ. Здесь нет ни одного имени слота и ни одного пути инвентаря:
 * бросок возвращает роль ('primary' | 'sidearm'), а раскладка по сеткам и
 * слотам — дело MetaSystem.generateScavLoadout(), который знает layout инвентаря.
 * ========================================================================== */

function deepFreeze(value) {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
	const keys = Object.keys(value)
	for (let i = 0; i < keys.length; i++) deepFreeze(value[keys[i]])
	return Object.freeze(value)
}

function clamp01(v) {
	const n = Number(v)
	if (!Number.isFinite(n)) return 0
	if (n < 0) return 0
	if (n > 1) return 1
	return n
}

function clamp(v, lo, hi) {
	if (v < lo) return lo
	if (v > hi) return hi
	return v
}

/**
 * Всё, что крутит баланс кита дикого. Одно место, один взгляд.
 *
 * durability   границы в процентах и прибавка от кармы/уровня
 * mag          доля заряженности магазина («полупустые» из техзадания)
 * pockets      сколько строк хлама и как растёт стек рублей
 * keycard      редкий бросок ключа на высокой карме
 * cooldown     таймер дикого, тоже от кармы
 */
export const SCAV_TUNING = deepFreeze({
	durability: {
		/* Сколько процентов прочности добавляет полная карма к границам. */
		karmaFloor: 22,
		karmaCeil: 30,
		/* Прибавка от уровня, выбирается на 40 уровне. */
		levelBonus: 6,
		levelCap: 40,
		/* Абсолютные границы: дикий никогда не несёт стоковый ствол. */
		hardMin: 5,
		hardMax: 84
	},
	mag: {
		/* Магазин вставлен, но набит частично. */
		loadedMin: 0.28,
		loadedMax: 0.62,
		/* Шанс второго магазина в кармане: база + карма. */
		spareChance: 0.18,
		spareKarma: 0.42,
		/* Рассыпные патроны для стволов без съёмного магазина. */
		looseMin: 4,
		looseMax: 13
	},
	pockets: {
		/* Сетка карманов в инвентаре 4x1, так что выше 4 строк смысла нет. */
		min: 1,
		max: 4,
		/* Стек рублей из техзадания, верх тянет карма. */
		roublesMin: 500,
		roublesMax: 4000,
		roublesKarmaShare: 0.65
	},
	keycard: {
		/* Ниже этого k ключей нет вообще. */
		gate: 0.5,
		chanceAtGate: 0.06,
		chanceAtMax: 0.19
	},
	cooldown: {
		baseMs: 900000,
		karmaShare: 0.4
	}
})

/**
 * Стволы дикого. Все — в состоянии «убито», вопрос только насколько.
 *
 * dur         базовые границы прочности при карме -1
 * karmaBias   сдвиг веса от кармы: >0 — чаще у доброго дикого
 * internal    вместимость несъёмного магазина (ружьё, винтовка)
 */
const WEAPONS = [
	{ design: 'wpn_ak74u', id: 'aks74u', role: 'primary', weight: 30, karmaBias: 0.95, dur: [12, 44], mag: 'mag_ak30', magCap: 30, ammo: '545ps', caliber: '5.45x39' },
	{ design: 'wpn_toz', id: 'm870', role: 'primary', weight: 26, karmaBias: -0.2, dur: [10, 40], mag: null, internal: 7, ammo: '12x70buck', caliber: '12/70' },
	{ design: 'wpn_mosin', id: 'mosin', role: 'primary', weight: 22, karmaBias: 0.25, dur: [14, 50], mag: null, internal: 5, ammo: '762x54lps', caliber: '7.62x54R' },
	{ design: 'wpn_pm', id: 'pm', role: 'sidearm', weight: 22, karmaBias: -0.8, dur: [8, 34], mag: 'mag_pm', magCap: 8, ammo: '9x18pmm', caliber: '9x18' }
]

/**
 * Карманный и разгрузочный хлам. `value` — относительная ценность строки,
 * от неё карма сдвигает вес: плохой дикий таскает гвозди, хороший — деньги.
 */
const POCKETS = [
	{ design: 'item_cigarettes', id: 'crackers', weight: 26, count: [1, 2], value: 1 },
	{ design: 'item_matches', id: 'gunpowder', weight: 22, count: [1, 1], value: 1 },
	{ design: 'item_screwdriver', id: 'bolts', weight: 20, count: [1, 2], value: 1 },
	{ design: 'item_tape', id: 'wires', weight: 18, count: [1, 2], value: 2 },
	{ design: 'item_roubles', id: 'rub', weight: 16, money: true, value: 3 }
]

/** Редкий бросок доступа. Верхняя строка требует почти полной кармы. */
const KEYCARDS = [
	{ design: 'key_cellar', id: 'key_cellar', weight: 74, minFactor: 0.5 },
	{ design: 'keycard_lab', id: 'tgcard', weight: 26, minFactor: 0.82 }
]

/** Медикамент в карман: единственная уступка играбельности в этом ките. */
const MEDS = [
	{ design: 'item_bandage', id: 'bandage', weight: 62, count: [1, 2] },
	{ design: 'item_analgin', id: 'analgin', weight: 24, count: [1, 1] },
	{ design: 'item_splint', id: 'splint', weight: 14, count: [1, 1] }
]

/**
 * Глубоко замороженные таблицы. Мутировать баланс в рантайме нельзя: один
 * рейд, переписавший вес в пуле, исказил бы все последующие выходы диким
 * до перезагрузки страницы — и не попал бы ни в один багрепорт.
 */
export const SCAV_LOOT_TABLES = deepFreeze({
	weapons: WEAPONS,
	pockets: POCKETS,
	keycards: KEYCARDS,
	meds: MEDS
})

/** Дизайн-ид → ид базы предметов. Для тестов и для документированности подмен. */
export const SCAV_ITEM_ALIASES = deepFreeze(
	[].concat(WEAPONS, POCKETS, KEYCARDS, MEDS).reduce((acc, row) => {
		acc[row.design] = row.id
		return acc
	}, {})
)

/** Все иды базы, которые могут выпасть. MetaSystem сверяет их с ItemsSystem на буте. */
export const SCAV_ITEM_IDS = deepFreeze(
	Array.from(
		new Set(
			[].concat(
				WEAPONS.map((w) => w.id),
				WEAPONS.map((w) => w.mag).filter(Boolean),
				WEAPONS.map((w) => w.ammo),
				POCKETS.map((p) => p.id),
				KEYCARDS.map((k) => k.id),
				MEDS.map((m) => m.id)
			)
		)
	)
)

/** P.karma ∈ [-1, 1] → k ∈ [0, 1]. Единственный легальный способ читать карму. */
export function scavKarmaFactor(karma) {
	const k = Number(karma)
	if (!Number.isFinite(k)) return 0.5
	return clamp01((clamp(k, -1, 1) + 1) / 2)
}

function levelFactor(level) {
	const n = Number(level)
	if (!Number.isFinite(n) || n <= 1) return 0
	return clamp01((n - 1) / (SCAV_TUNING.durability.levelCap - 1))
}

function rngFloat(rng) {
	if (rng && typeof rng.float === 'function') return clamp01(rng.float())
	if (rng && typeof rng.range === 'function') return clamp01(rng.range(0, 1))
	return Math.random()
}

function rngInt(rng, min, max) {
	const lo = Math.min(min, max) | 0
	const hi = Math.max(min, max) | 0
	if (lo === hi) return lo
	if (rng && typeof rng.int === 'function') return rng.int(lo, hi)
	return lo + Math.floor(rngFloat(rng) * (hi - lo + 1))
}

function rngRange(rng, min, max) {
	if (rng && typeof rng.range === 'function') return rng.range(min, max)
	return min + rngFloat(rng) * (max - min)
}

/**
 * Взвешенный выбор с карма-сдвигом.
 *
 * Вес умножается на (1 + bias * (2k - 1)) и зажимается в ноль снизу: биас ±1
 * даёт двукратное предпочтение на краю и никогда не выбрасывает строку из пула
 * полностью — маленький шанс вынести Мосинку с дна кармы остаётся.
 */
function pickWeighted(rng, pool, factor) {
	if (!pool || !pool.length) return null
	const bend = factor === undefined ? 0 : factor * 2 - 1
	let total = 0
	const weights = new Array(pool.length)
	for (let i = 0; i < pool.length; i++) {
		const row = pool[i]
		const bias = Number(row.karmaBias) || 0
		const w = Math.max(0.5, (Number(row.weight) || 1) * (1 + bias * bend))
		weights[i] = w
		total += w
	}
	let roll = rngFloat(rng) * total
	for (let i = 0; i < pool.length; i++) {
		roll -= weights[i]
		if (roll <= 0) return pool[i]
	}
	return pool[pool.length - 1]
}

/**
 * Границы прочности для конкретного ствола при данной карме и уровне.
 *
 * Поднимаются ОБЕ границы, причём нижняя — быстрее верхней. Это и есть
 * требование «высокая карма ГАРАНТИРУЕТ ствол лучше»: при k = 1 полученный
 * минимум выше базового максимума при k = 0, а не просто чаще выпадает.
 */
export function scavDurabilityRange(entry, karma, level) {
	const d = SCAV_TUNING.durability
	const k = scavKarmaFactor(karma)
	const lvl = levelFactor(level) * d.levelBonus
	const base = (entry && entry.dur) || [10, 40]
	const min = clamp(base[0] + d.karmaFloor * k + lvl, d.hardMin, d.hardMax)
	const max = clamp(base[1] + d.karmaCeil * k + lvl, min + 4, d.hardMax)
	return [Math.round(min * 10) / 10, Math.round(max * 10) / 10]
}

/**
 * Один ствол с патронами того же калибра.
 *
 * Возвращает ОПИСАНИЕ, а не предметы: ни одного uid, ни одного пути
 * инвентаря — ими занимается MetaSystem.generateScavLoadout().
 */
export function rollScavWeapon(rng, karma, level) {
	const k = scavKarmaFactor(karma)
	const entry = pickWeighted(rng, WEAPONS, k)
	const range = scavDurabilityRange(entry, karma, level)
	const dur = Math.round(rngRange(rng, range[0], range[1]) * 10) / 10
	const m = SCAV_TUNING.mag

	const out = {
		design: entry.design,
		id: entry.id,
		role: entry.role,
		caliber: entry.caliber,
		durability: clamp(dur, range[0], range[1]),
		durabilityRange: range,
		mag: null,
		spareMag: null,
		ammo: null
	}

	if (entry.mag) {
		const cap = entry.magCap || 30
		const loaded = rngInt(rng, Math.ceil(cap * m.loadedMin), Math.floor(cap * m.loadedMax))
		out.mag = { id: entry.mag, cap, loaded: clamp(loaded, 1, cap), ammo: entry.ammo }
		if (rngFloat(rng) < m.spareChance + m.spareKarma * k) {
			const spare = rngInt(rng, 0, Math.floor(cap * m.loadedMax))
			out.spareMag = { id: entry.mag, cap, loaded: clamp(spare, 0, cap), ammo: entry.ammo }
		}
	} else {
		/* Несъёмный магазин: патроны идут россыпью в карман. */
		const lo = m.looseMin
		const hi = Math.max(lo, Math.round(m.looseMax * (0.6 + 0.4 * k)))
		out.ammo = { id: entry.ammo, count: rngInt(rng, lo, hi), internal: entry.internal || 0 }
	}

	return out
}

/**
 * Карманный хлам. Строк тем больше и дороже, чем выше карма.
 *
 * Стек рублей из техзадания (500..4000) всегда лежит в своих границах, но
 * верхнюю часть диапазона открывает только карма.
 */
export function rollScavPockets(rng, karma, level) {
	const k = scavKarmaFactor(karma)
	const p = SCAV_TUNING.pockets
	const rows = clamp(p.min + Math.round(k * (p.max - p.min)), p.min, p.max)
	const out = []

	for (let i = 0; i < rows; i++) {
		const entry = pickWeighted(rng, POCKETS, k)
		if (!entry) break
		if (entry.money) {
			const span = p.roublesMax - p.roublesMin
			const top = p.roublesMin + span * (1 - p.roublesKarmaShare * (1 - k))
			const amount = rngInt(rng, p.roublesMin, Math.round(top))
			out.push({ design: entry.design, id: entry.id, count: clamp(amount, p.roublesMin, p.roublesMax), money: true })
		} else {
			const c = entry.count || [1, 1]
			out.push({ design: entry.design, id: entry.id, count: rngInt(rng, c[0], c[1]) })
		}
	}

	/* Один медикамент: без него выход диким превращается в одно кровотечение. */
	if (rngFloat(rng) < 0.45 + 0.35 * k) {
		const med = pickWeighted(rng, MEDS, k)
		if (med) {
			const c = med.count || [1, 1]
			out.push({ design: med.design, id: med.id, count: rngInt(rng, c[0], c[1]), med: true })
		}
	}

	return out
}

/**
 * Редкий ключ или карта доступа. null — не выпало (обычный случай).
 *
 * Ниже gate шанс ровно нуль: залетевший в карму дикий не приносит лабу.
 */
export function rollScavKeycard(rng, karma) {
	const k = scavKarmaFactor(karma)
	const cfg = SCAV_TUNING.keycard
	if (k < cfg.gate) return null
	const t = (k - cfg.gate) / (1 - cfg.gate)
	const chance = cfg.chanceAtGate + (cfg.chanceAtMax - cfg.chanceAtGate) * t
	if (rngFloat(rng) >= chance) return null
	const pool = KEYCARDS.filter((c) => k >= c.minFactor)
	const entry = pickWeighted(rng, pool, k)
	if (!entry) return null
	return { design: entry.design, id: entry.id, count: 1, keycard: true }
}

/**
 * Длительность таймера дикого в миллисекундах.
 *
 * 15 минут базы, ±40% от кармы: при karma = 1 это 9 минут, при karma = -1 — 21.
 * Карма таким образом платит дважды — китом и частотой выходов.
 */
export function scavCooldownMs(karma) {
	const cfg = SCAV_TUNING.cooldown
	const k = scavKarmaFactor(karma)
	return Math.round(cfg.baseMs * (1 - cfg.karmaShare * (k * 2 - 1)))
}

export default SCAV_LOOT_TABLES
