import { EFL } from '../core/config.js'
import { applyInventoryPersistence } from '../inventory/persistence.js'
import { armorMaterial, ensureArmorInstance, isArmorDef } from '../items/index.js'
import { rollScavKeycard, rollScavPockets, rollScavWeapon, scavCooldownMs, SCAV_ITEM_IDS } from './loadouts.js'

const SKEY = 'efl_ow_v1'

/**
 * Версия payload'а сейва.
 *
 * v1 — первая сборка: {p, inv, slots} без поля версии (inv/slots писались, но
 *      никогда не читались — тайник умирал на каждом F5).
 * v2 — то же плюс v, и с честной раскладкой inv/slots при загрузке.
 * v3 — в кортеже предмета появился durMax (индекс 12). Ремонт у торговца
 *      навсегда срезает потолок ресурса, и без этого поля вещь возвращалась с
 *      перезагрузки заводской: dur сохранялся, а потолок — нет.
 *
 * Старше — миграция (структура кортежей только дополнялась). Новее — отказ:
 * «починить» сейв из будущей сборки нельзя, можно только не трогать его.
 */
const SAVE_VERSION = 3

/** id блокирующей плашки — одна на документ, без стопки дублей. */
const WARN_ID = 'efl-save-fatal'
const BTN_CSS = 'padding:9px 20px;font:12px/1 "Oswald","Segoe UI",sans-serif;letter-spacing:.18em;color:#e8dcc0;background:rgba(30,35,36,.9);border:1px solid #3d4446;cursor:pointer'

const LLREQ = [
	{ lvl: 1,  rep: 0,    sp: 0 },
	{ lvl: 10, rep: 0.15, sp: 150000 },
	{ lvl: 20, rep: 0.35, sp: 900000 },
	{ lvl: 32, rep: 0.55, sp: 3500000 },
]

const TRADERS = [
	{ id:'prapor',     n:'Прапор',     buys:['weapon','ammo','mag','mod'], cur:'rub' },
	{ id:'therapist',  n:'Терапевт',  buys:['med','food'],               cur:'rub' },
	{ id:'fence',      n:'Скупщик',    buys:['*'],                        cur:'rub', karma: true },
	{ id:'skier',      n:'Лыжник',     buys:['weapon','barter'],          cur:'eur' },
	{ id:'peacekeeper',n:'Миротворец',buys:['weapon','mod','armor'],    cur:'usd' },
	{ id:'mechanic',   n:'Механик',    buys:['mod','mag'],                cur:'rub' },
	{ id:'ragman',     n:'Барахольщик',buys:['rig','backpack','armor'],  cur:'rub' },
	{ id:'jaeger',     n:'Егерь',      buys:['food','barter'],            cur:'rub' },
	{ id:'ref',        n:'Смотритель', buys:['barter'],                  cur:'rub' },
]

/**
 * РЕМОНТ. Мастер возвращает ресурс, но каждый заход навсегда съедает часть
 * потолка: настоящая цена ремонта не в рублях, а в том, что вещь становится
 * расходником. Дорогой мастер бережёт плиту, дешёвый добивает её за пять
 * заходов.
 *
 *   kinds    что берёт в работу; 'armor' — всё, что проходит isArmorDef(),
 *            '*' — Скупщик, он берётся за любую рухлядь
 *   degrade  базовая доля durMax, уходящая безвозвратно
 *   rate     наценка за работу
 *   cur      валюта расчёта
 */
const REPAIRERS = Object.freeze({
	prapor: Object.freeze({ kinds: Object.freeze(['weapon', 'mag']), degrade: 0.12, rate: 0.9, cur: 'rub' }),
	skier: Object.freeze({ kinds: Object.freeze(['weapon', 'armor']), degrade: 0.13, rate: 0.95, cur: 'eur' }),
	peacekeeper: Object.freeze({ kinds: Object.freeze(['weapon', 'armor']), degrade: 0.07, rate: 1.35, cur: 'usd' }),
	mechanic: Object.freeze({ kinds: Object.freeze(['weapon', 'mag', 'mod']), degrade: 0.06, rate: 1.25, cur: 'rub' }),
	ragman: Object.freeze({ kinds: Object.freeze(['armor', 'rig', 'backpack']), degrade: 0.1, rate: 1, cur: 'rub' }),
	fence: Object.freeze({ kinds: Object.freeze(['*']), degrade: 0.15, rate: 0.75, cur: 'rub' }),
})

/* Границы из брифа: за один заход теряется 5..15 процентов durMax. */
const DEGRADE_MIN = 0.05
const DEGRADE_MAX = 0.15
/* Насколько один уровень лояльности улучшает качество работы. */
const REPAIR_LL_QUALITY = 0.09
/* Полное восстановление убитой вещи стоит эту долю её цены. */
const REPAIR_RATE = 0.45
/* Запасной курс, если валюту вырезали из таблицы предметов. */
const FX_FALLBACK = Object.freeze({ usd: 145, eur: 160 })

/** Контейнеры тела. Восстанавливаются ПЕРВЫМИ: они создают сетки in:<uid>. */
const CONTAINER_SLOTS = ['secure', 'rig', 'backpack']

/**
 * Корпус Дикого. Генератор в loadouts.js стерилен и про слоты не знает, а
 * разгрузка нужна физически: сетка карманов 4x1, и в неё не влезает даже
 * собственный хлам Дикого, не говоря о запасном магазине.
 */
const SCAV_RIG = 'rig_bankrobber'
/** Ячеек в гриде 'pocket'. Всё, что не поместилось, уезжает в разгрузку. */
const POCKET_CELLS = 4
/** Ширина раскладки в разгрузке. Точные координаты — подсказка, не приказ:
 *  restore() сам вызовет findFree(), если предмет не встал. */
const RIG_ROW = 4

export class MetaSystem {
	static id = 'meta'
	static deps = ['items', 'inventory']

	async init(ctx) {
		this.ctx = ctx
		this.items = ctx.get('items')
		this.inv = ctx.get('inventory')
		this.rng = ctx.rng.fork('meta')

		/* clearAll/restore/commitRestore/applyLoadout живут в
		 * inventory/persistence.js: модель предметов не должна знать ни про формат
		 * сейва, ни про формат выдачи. Вызов идемпотентен. */
		applyInventoryPersistence()

		this.P = this._fresh()
		this._saveT = 0
		this._dirty = false
		/* Иды кита Дикого сверяются с базой предметов один раз за сессию. */
		this._scavChecked = false
		/* Запись сломана (квота, приватный режим, сейв из будущего). Автосейв
		 * разоружается до явного «ПОВТОРИТЬ»: иначе исключение прилетает в игровой
		 * кадр каждые 8 секунд. */
		this._saveBlocked = false
		this.load()

		ctx.events.on('inv:changed', () => { this._dirty = true })
		ctx.events.on('karma:scav', (e) => { this.P.karma = Math.max(-1, Math.min(1, this.P.karma + e.delta)); this._dirty = true })
		ctx.events.on('raid:end', (e) => this._afterRaid(e))
	}

	_fresh() {
		return {
			nick: 'MTDV_Fujiwara', lvl: 1, xp: 0, karma: 0,
			money: { rub: 800000, usd: 1200, eur: 600 },
			rep: { prapor: 0, therapist: 0, fence: 0, skier: 0, peacekeeper: 0, mechanic: 0, ragman: 0, jaeger: 0, ref: 0 },
			spent: {}, quests: {}, hideout: { stash: 1, gen: 0, med: 0, water: 0, bench: 0, intel: 0, sec: 0, rest: 0, nutr: 0, btc: 0, range: 0 },
			prod: {}, crafts: {}, insured: [], scavCd: 0, bp: { tier: 0, xp: 0 }, stats: { raids: 0, survived: 0, kills: 0 },
			stashRows: EFL.stash.rows,
		}
	}

	/* ---------- деньги и торговля ---------- */
	money(cur) { return this.P.money[cur] ?? 0 }
	spend(cur, sum) { if (this.P.money[cur] < sum) return false; this.P.money[cur] -= sum; this._dirty = true; return true }

	loyalty(traderId) {
		const rep = this.P.rep[traderId] ?? 0, sp = this.P.spent[traderId] ?? 0
		let ll = 1
		for (let i = 1; i < LLREQ.length; i++) {
			const r = LLREQ[i]
			if (this.P.lvl >= r.lvl && rep >= r.rep && sp >= r.sp) ll = i + 1
		}
		return ll
	}

	buyPrice(traderId, itemId) {
		const base = this.items.price(itemId)
		const ll = this.loyalty(traderId)
		return Math.round(base * (1.25 - ll * 0.05))
	}

	sellPrice(traderId, itemId) {
		const base = this.items.price(itemId)
		const t = TRADERS.find((x) => x.id === traderId)
		let k = 0.52 + this.loyalty(traderId) * 0.03
		if (t?.karma) k *= 1 + this.P.karma * 0.35         // Скупщик любит хорошую карму
		return Math.round(base * k)
	}

	deal(traderId, kind, sum, cur) {
		if (kind === 'buy') { if (!this.spend(cur, sum)) return false; this.P.spent[traderId] = (this.P.spent[traderId] ?? 0) + sum }
		else this.P.money[cur] += sum
		this.P.rep[traderId] = Math.min(1, (this.P.rep[traderId] ?? 0) + sum / 4000000)
		this._dirty = true
		this.ctx.events.emit('trader:deal', { traderId, kind, sum, currency: cur })
		return true
	}

	/* ---------- ремонт ---------- */

	/** Мастер по id, либо null: не каждый торговец берётся за работу. */
	_repairer(traderId) {
		const r = REPAIRERS[traderId]
		return r === undefined ? null : r
	}

	/**
	 * Курс валюты мастера в рублях.
	 *
	 * Цены в таблице предметов рублёвые, а Миротворец считает в долларах: без
	 * пересчёта ремонт у него стоил бы в 145 раз дороже. Курс берётся из самой
	 * таблицы (rub/usd/eur — обычные предметы со своей ценой), чтобы в проекте не
	 * появилось второе место, где живёт курс.
	 */
	_fx(cur) {
		if (cur === 'rub') return 1
		const p = Number(this.items.price(cur))
		if (Number.isFinite(p) && p > 1) return p
		return FX_FALLBACK[cur] ?? 1
	}

	/**
	 * Ресурс экземпляра: [dur, durMax].
	 *
	 * Броня добивается ensureArmorInstance() — предметы из стартового набора и из
	 * доармурных сейвов приходят вообще без полей. Для оружия потолком служит
	 * заводское d.dur. Ноль означает «ремонтировать нечего».
	 */
	_durability(it, d) {
		if (isArmorDef(d)) ensureArmorInstance(it, d)
		const maxRaw = Number(it.durMax ?? d.durMax ?? d.dur ?? 0)
		const durMax = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 0
		const curRaw = Number(it.dur ?? durMax)
		const dur = Number.isFinite(curRaw) ? Math.max(0, Math.min(durMax, curRaw)) : durMax
		return [dur, durMax]
	}

	/**
	 * Смета ремонта. Ничего не меняет — это то, что экран торговца показывает до
	 * нажатия, и то, на чём считает repair().
	 *
	 * @param {number} uid uid экземпляра в инвентаре
	 * @param {string} traderId id мастера
	 * @returns {{ok:boolean,reason?:string,cost?:number,currency?:string,
	 *   dur?:number,durMax?:number,durAfter?:number,durMaxAfter?:number,
	 *   restored?:number,degrade?:number,loyalty?:number}}
	 */
	repairQuote(uid, traderId) {
		const rep = this._repairer(traderId)
		if (!rep) return { ok: false, reason: 'trader', uid, traderId }

		const it = this.inv?.get(uid) ?? null
		if (!it) return { ok: false, reason: 'item', uid, traderId }
		const d = this.items.get(it.id)
		if (!d) return { ok: false, reason: 'item', uid, traderId }

		/* Вид работы: броня опознаётся по схеме (armorClass + zones), а не по
		 * слоту, иначе шлем и разгрузка с плитами попали бы в разные списки. */
		const armor = isArmorDef(d)
		const type = String(d.t ?? '')
		const kind = armor ? 'armor' : type
		const kinds = rep.kinds
		if (kinds.indexOf('*') < 0 && kinds.indexOf(kind) < 0 && kinds.indexOf(type) < 0) {
			return { ok: false, reason: 'kind', uid, traderId, kind }
		}

		const pair = this._durability(it, d)
		const dur = pair[0]
		const durMax = pair[1]
		if (durMax <= 0) return { ok: false, reason: 'noDurability', uid, traderId, itemId: it.id }
		if (durMax - dur <= 0.01) return { ok: false, reason: 'intact', uid, traderId, itemId: it.id, dur, durMax }

		const ll = this.loyalty(traderId)

		/* Сколько потолка уйдёт навсегда: качество мастера, множитель материала
		 * (керамика после трещины уже не та плита) и скидка за лояльность. Итог
		 * зажат в мандатные 5..15 процентов. */
		const mat = armor ? armorMaterial(d.material) : null
		const wearRaw = Number(mat?.repairDegradation)
		const wear = Number.isFinite(wearRaw) && wearRaw > 0 ? wearRaw : 1
		let degrade = rep.degrade * wear * (1 - (ll - 1) * REPAIR_LL_QUALITY)
		if (degrade < DEGRADE_MIN) degrade = DEGRADE_MIN
		if (degrade > DEGRADE_MAX) degrade = DEGRADE_MAX

		/* Новый потолок и полное восстановление под него. Ресурс зажимается
		 * потолком, поэтому ремонт почти целой вещи — осознанно плохая сделка. */
		const durMaxAfter = Math.max(1, Math.round(durMax * (1 - degrade) * 100) / 100)
		const durAfter = durMaxAfter
		const restored = Math.max(0, Math.round((durAfter - dur) * 100) / 100)

		/* Цена: доля цены вещи за восстановленный ресурс, наценка мастера и
		 * скидка за уровень лояльности той же формы, что в buyPrice(). */
		const base = Number(this.items.price(it.id))
		const price = Number.isFinite(base) && base > 0 ? base : 0
		const share = restored / durMax
		const rub = price * share * REPAIR_RATE * rep.rate * (1.25 - ll * 0.05)
		const costRub = Math.max(1, Math.round(rub))
		const cost = Math.max(1, Math.round(costRub / this._fx(rep.cur)))

		return {
			ok: true, uid, traderId, itemId: it.id, kind,
			currency: rep.cur, cost, costRub, loyalty: ll,
			dur, durMax, durAfter, durMaxAfter, restored, degrade,
			material: armor ? d.material ?? null : null,
		}
	}

	/** Цена ремонта в валюте мастера, 0 — работать не станет. */
	repairCost(uid, traderId) {
		const q = this.repairQuote(uid, traderId)
		return q.ok ? q.cost : 0
	}

	canRepair(uid, traderId) {
		return this.repairQuote(uid, traderId).ok
	}

	/** Кто возьмётся за эту вещь, от самого дешёвого к самому дорогому. */
	repairTraders(uid) {
		const out = []
		for (const id in REPAIRERS) {
			const q = this.repairQuote(uid, id)
			if (q.ok) out.push(q)
		}
		out.sort((a, b) => a.costRub - b.costRub)
		return out
	}

	/**
	 * РЕМОНТ. Восстанавливает dur под потолок и навсегда срезает сам потолок.
	 *
	 * Ресурс живёт в экземпляре, а не в определении предмета, поэтому durMax
	 * пишется прямо в него и уезжает в сейв (кортеж v3, индекс 12).
	 *
	 * @param {number} uid uid экземпляра
	 * @param {string} traderId id мастера
	 * @returns {object} смета с applied: true, либо {ok:false, reason}
	 */
	repair(uid, traderId) {
		/* Услуги торговцев существуют только вне рейда: в бою мастера нет. */
		const raid = this.ctx?.peek ? this.ctx.peek('raid') : null
		if (raid?.active) return { ok: false, reason: 'raid', uid, traderId }

		const q = this.repairQuote(uid, traderId)
		if (!q.ok) return q
		if (this.money(q.currency) < q.cost) {
			return { ok: false, reason: 'funds', uid, traderId, currency: q.currency, cost: q.cost }
		}
		if (!this.spend(q.currency, q.cost)) {
			return { ok: false, reason: 'funds', uid, traderId, currency: q.currency, cost: q.cost }
		}

		const it = this.inv.get(uid)
		if (!it) {
			/* Вещь исчезла между сметой и оплатой — деньги назад. */
			this.P.money[q.currency] += q.cost
			return { ok: false, reason: 'item', uid, traderId }
		}

		it.durMax = q.durMaxAfter
		it.dur = q.durAfter

		/* Ремонт — это оборот у мастера: он двигает и репутацию, и порог
		 * следующего уровня лояльности, ровно как покупка в deal(). */
		this.P.spent[traderId] = (this.P.spent[traderId] ?? 0) + q.costRub
		this.P.rep[traderId] = Math.min(1, (this.P.rep[traderId] ?? 0) + q.costRub / 4000000)
		this._dirty = true

		const out = Object.assign({}, q, { applied: true, loyaltyAfter: this.loyalty(traderId) })
		/* Своего события ремонт не заводит: сделка идёт документированным
		 * trader:deal, изменение вещи — inv:changed. */
		this.ctx?.events?.emit('trader:deal', {
			traderId, kind: 'repair', sum: q.cost, currency: q.currency, uid, itemId: q.itemId,
		})
		this.ctx?.events?.emit('inv:changed', { reason: 'repair', weight: this.inv.weight() })
		return out
	}

	/* ---------- страховка ---------- */
	insureCost(uid) { return Math.round(this.items.price(this.inv.get(uid).id) * 0.08) }
	insure(uid) {
		const cost = this.insureCost(uid)
		if (!this.spend('rub', cost)) return false
		this.P.insured.push(this.inv.get(uid).id)
		return true
	}

	keepLoadout() { this.P.insured.length = 0; this._dirty = true }

	loseLoadout(kind) {
		// снаряжение с тела теряется, кроме защитного контейнера
		const secure = this.inv.slotItem('secure')
		const keep = new Set()
		if (secure) { keep.add(secure.uid); for (const it of this.inv.grid('in:' + secure.uid)?.items ?? []) keep.add(it.uid) }

		const returned = []
		for (let i = this.inv.all.length - 1; i >= 0; i--) {
			const it = this.inv.all[i]
			if (!this.inv.onBody(it) || keep.has(it.uid)) continue
			// страховка: шанс возврата выше, если вещь не подобрали
			const insured = this.P.insured.includes(it.id)
			if (insured && this.rng.float() < (kind === 'mia' ? 0.85 : 0.42)) returned.push(it.id)
			this.inv.remove(it.uid)
		}
		this.P.pendingInsurance = returned              // придёт через N рейдов
		this.P.insured.length = 0
		this._dirty = true
	}

	/* ====================================================================== */
	/*                            кит Дикого                                  */
	/* ====================================================================== */

	/**
	 * Сколько миллисекунд осталось до следующего выхода Диким. 0 — можно идти.
	 *
	 * Метка P.scavCd абсолютная и лежит в профиле, то есть переживает и
	 * перезагрузку страницы, и закрытие вкладки — таймер Дикого нельзя
	 * обнулить через F5.
	 */
	scavCooldownLeft(nowMs) {
		const arg = Number(nowMs)
		const now = Number.isFinite(arg) ? arg : Date.now()
		const until = Number(this.P.scavCd)
		if (!Number.isFinite(until)) return 0
		const left = until - now
		if (left <= 0) return 0
		/* Метка из будущего: часы перевели назад, сейв приехал с другой машины.
		 * Ждать больше максимально возможного кулдауна не за что — иначе Дикий
		 * оказался бы заперт навсегда без единого способа это починить. */
		const max = scavCooldownMs(-1)
		if (left > max) {
			this.P.scavCd = now
			this._dirty = true
			return 0
		}
		return Math.round(left)
	}

	/** Пускать ли игрока в рейд за Дикого прямо сейчас. */
	canDeployScav(nowMs) {
		return this.scavCooldownLeft(nowMs) === 0
	}

	/**
	 * Разовая сверка пулов Дикого с базой предметов.
	 *
	 * Техзадание описывало кит именами wpn_ak74u / item_cigarettes, которых в
	 * ITEMS нет; подмены задокументированы в loadouts.js. Тихо промахнуться
	 * мимо базы всё же можно — например, вырезав предмет, — и тогда рейд узнает
	 * об этом одной строкой в консоли, а не пустым карманом без объяснений.
	 */
	_checkScavItems() {
		if (this._scavChecked) return
		this._scavChecked = true
		if (!this.items || typeof this.items.get !== 'function') return
		const missing = []
		const ids = SCAV_ITEM_IDS.concat([SCAV_RIG])
		for (let i = 0; i < ids.length; i++) {
			if (!this.items.get(ids[i])) missing.push(ids[i])
		}
		if (missing.length) console.warn('[meta] кит Дикого ссылается на отсутствующие предметы: ' + missing.join(', '))
	}

	/**
	 * ВЫДАЧА КИТА ДИКОГО. Единственный владелец снаряжения Дикого в проекте.
	 *
	 * Раньше этого метода не существовало вовсе, и RaidSystem перебирал семь
	 * возможных имён, а не найдя ни одного — собирал кит сам, из статических
	 * таблиц, не видя ни кармы, ни уровня. Теперь баланс живёт в данных
	 * (loadouts.js), раскладка — в инвентаре (applyLoadout), а профиль
	 * связывает их и платит за это таймером.
	 *
	 * Формат возврата — кортежи
	 *   [uid, itemId, count, path, x, y, rotation, durability]
	 * плюс два необязательных хвостовых поля [nm, am] для стволов и магазинов:
	 * без них «полупустой магазин» из техзадания не выразим вообще. uid здесь
	 * локальные, 1..N, и нужны только чтобы связать вложение с контейнером
	 * через path 'in:<uid>' — живые номера выдаст applyLoadout().
	 *
	 * Прочность ствола пишется экземпляру строго внутри границ, выкаченных
	 * scavDurabilityRange(), и переживает сейв: serialize() кладёт i.dur в
	 * кортеж (индекс 10), а _restoreInventory() читает его обратно.
	 *
	 * @param {object} rng поток рейда; форк от него делается здесь
	 * @returns {Array<Array>} дескриптор для InventorySystem.applyLoadout()
	 * @throws {Error} если таймер Дикого ещё не вышел
	 */
	generateScavLoadout(rng) {
		const left = this.scavCooldownLeft()
		if (left > 0) throw new Error('[meta] Дикий на кулдауне ещё ' + Math.ceil(left / 1000) + ' с')

		this._checkScavItems()

		/* Свой поток: кит не должен сдвигать ни одну последующую выборку рейда,
		 * иначе один лишний бросок в кармане менял бы весь лут на карте. */
		const source = rng && typeof rng.fork === 'function' ? rng : this.rng
		const stream = source.fork('scav:' + (this.P.stats?.raids ?? 0))

		const karma = Math.max(-1, Math.min(1, Number(this.P.karma) || 0))
		const lvl = Math.max(1, Math.round(Number(this.P.lvl) || 1))

		const rows = []
		let uid = 1
		const put = (id, n, path, x, y, dur, nm, am) => {
			const own = uid++
			rows.push([
				own,
				id,
				Math.max(1, Math.round(Number(n) || 1)),
				path,
				Math.max(0, Math.round(Number(x) || 0)),
				Math.max(0, Math.round(Number(y) || 0)),
				0,
				dur == null ? null : Math.round(Number(dur) * 10) / 10,
				nm == null ? 0 : Math.max(0, Math.round(Number(nm) || 0)),
				am == null ? null : am
			])
			return own
		}

		/* Разгрузка идёт первой строкой: applyLoadout() кладёт вещи волнами, и
		 * сетка 'in:<uid>' появляется только после того, как ляжет сам контейнер. */
		const rigUid = put(SCAV_RIG, 1, 'slot:rig', 0, 0, null)
		const rigPath = 'in:' + rigUid
		let rigCell = 0
		const intoRig = (id, n, dur, nm, am) => {
			const cell = rigCell++
			return put(id, n, rigPath, cell % RIG_ROW, Math.floor(cell / RIG_ROW), dur, nm, am)
		}

		/* Ствол. Роль решает пул, а не этот файл: ПМ уходит в кобуру, остальное
		 * на ремень. */
		const gun = rollScavWeapon(stream, karma, lvl)
		const gunSlot = gun.role === 'sidearm' ? 'slot:holster' : 'slot:primary'
		const internal = gun.ammo ? Math.max(0, Number(gun.ammo.internal) || 0) : 0
		const loadedRaw = gun.mag ? gun.mag.loaded : Math.min(internal, gun.ammo ? gun.ammo.count : 0)
		const loaded = Math.max(0, Math.round(Number(loadedRaw) || 0))
		const gunAmmo = gun.mag ? gun.mag.ammo : (gun.ammo ? gun.ammo.id : null)
		/* dur экземпляра — ровно из брошенного диапазона, потолок остаётся
		 * заводским: Дикий несёт убитую вещь, а не вещь с другим ресурсом. */
		put(gun.id, 1, gunSlot, 0, 0, gun.durability, loaded, gunAmmo)

		if (gun.spareMag) intoRig(gun.spareMag.id, 1, null, gun.spareMag.loaded, gun.spareMag.ammo)
		if (gun.ammo) {
			const loose = Math.max(0, (Number(gun.ammo.count) || 0) - loaded)
			if (loose > 0) intoRig(gun.ammo.id, loose, null, 0, null)
		}

		/* Карманы. Ключ доступа кладётся первым: он и самый ценный, и 1x1. */
		const pockets = rollScavPockets(stream, karma, lvl)
		const keycard = rollScavKeycard(stream, karma)
		if (keycard) pockets.unshift(keycard)

		let cell = 0
		for (let i = 0; i < pockets.length; i++) {
			const row = pockets[i]
			if (cell < POCKET_CELLS) put(row.id, row.count, 'pocket', cell++, 0, null)
			else intoRig(row.id, row.count, null)
		}

		/* Таймер. Ставится на КАЖДУЮ выдачу, до всякой высадки: если рейд упадёт
		 * после этой точки, перекатывать кит до посинения всё равно нельзя. */
		const now = Date.now()
		const cooldown = scavCooldownMs(karma)
		this.P.scavCd = now + cooldown
		this._dirty = true
		try {
			this.save()
		} catch (e) {
			/* Плашка уже поднята внутри save(). Высадку это не отменяет: кит выдан,
			 * профиль в памяти корректен, потерян только диск. */
			console.error('[meta] таймер Дикого не записан на диск', e)
		}

		this.ctx?.events?.emit('meta:scavkit', {
			rows: rows.length,
			karma,
			lvl,
			weapon: gun.id,
			durability: gun.durability,
			durabilityRange: gun.durabilityRange,
			keycard: keycard ? keycard.id : null,
			cooldownMs: cooldown
		})
		console.info('[meta] кит Дикого: ' + gun.id + ' ' + gun.durability + '/' + gun.durabilityRange[1] + ', предметов ' + rows.length + ', таймер ' + Math.round(cooldown / 60000) + ' мин')
		return rows
	}

	/* ---------- квесты ---------- */
	questProgress(questId, index, value) {
		const q = (this.P.quests[questId] ??= { i: 0, done: false, prog: [0, 0, 0, 0] })
		q.prog[index] = (q.prog[index] ?? 0) + value
		this._dirty = true
		this.ctx.events.emit('quest:progress', { questId, index, value: q.prog[index], done: q.done })
	}

	/* ---------- убежище ---------- */
	upgrade(zoneId) {
		const lvl = this.P.hideout[zoneId] ?? 0
		const cost = 25000 * Math.pow(3.1, lvl)
		if (!this.spend('rub', cost)) return false
		this.P.hideout[zoneId] = lvl + 1
		if (zoneId === 'stash') {
			this.P.stashRows = [30, 38, 46, 60][Math.min(3, lvl + 1)]
			this.inv.grid('stash').resize(EFL.stash.width, this.P.stashRows)
		}
		this._dirty = true
		return true
	}

	/** Оффлайн-прогресс крафтов и генератора — считается от метки времени, а не тиками. */
	tickProduction(nowMs) {
		const last = this.P.lastSeen ?? nowMs
		const sec = Math.min(86400, (nowMs - last) / 1000)
		this.P.lastSeen = nowMs
		if (sec < 1) return
		for (const id in this.P.crafts) {
			const c = this.P.crafts[id]
			if (c.done) continue
			c.left -= sec
			if (c.left <= 0) { c.left = 0; c.done = true }
		}
		this._dirty = true
	}

	/* ---------- сейв ---------- */
	serialize() {
		return JSON.stringify({
			v: SAVE_VERSION,
			p: this.P,
			/* durMax идёт последним (индекс 12): ремонт срезает потолок навсегда, и
			 * без него плита возвращалась с перезагрузки заводской. */
			inv: this.inv.all.map((i) => [i.uid, i.id, i.n, i.path, i.x, i.y, i.rot, i.mag, i.nm, i.am, i.dur, i.mods, i.durMax]),
			slots: [...this.inv.slots],
		})
	}

	/**
	 * Запись профиля. Провал НЕ глотается.
	 *
	 * Раньше здесь был console.warn: setItem() бросал по квоте, игра ехала дальше
	 * с видом, что всё сохранено, а игрок узнавал об утрате тайника только после F5.
	 *
	 * @returns {boolean} true — записано; false — запись была разоружена ранее.
	 * @throws любую ошибку localStorage — после показа блокирующей плашки.
	 */
	save() {
		if (this._saveBlocked) return false

		let payload = ''
		try {
			payload = this.serialize()
		} catch (e) {
			this._saveBlocked = true
			this._saveFatal('Профиль не удалось упаковать в JSON.', e)
			throw e
		}

		try {
			localStorage.setItem(SKEY, payload)
		} catch (e) {
			this._saveBlocked = true
			this._saveFatal(
				this._isQuota(e)
					? 'Хранилище браузера переполнено: профиль весит ' + Math.ceil(payload.length / 1024) + ' КБ и не поместился в localStorage.'
					: 'Браузер запретил запись в localStorage (приватный режим или заблокированные данные сайтов).',
				e
			)
			throw e
		}

		this._dirty = false
		return true
	}

	/** Квота приходит под четырьмя разными именами — проверяем все. */
	_isQuota(e) {
		const name = e?.name ?? ''
		const code = e?.code ?? 0
		return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
	}

	load() {
		let raw = null
		try {
			raw = localStorage.getItem(SKEY)
		} catch (e) {
			console.warn('[meta] localStorage недоступен — играем без профиля', e)
			return false
		}
		if (!raw) return false

		let d = null
		try {
			d = JSON.parse(raw)
		} catch (e) {
			console.warn('[meta] сейв повреждён — стартуем с чистого профиля', e)
			return false
		}
		if (!d || typeof d !== 'object') return false

		const v = Math.max(1, Math.round(Number(d.v ?? 1)) || 1)
		if (v > SAVE_VERSION) {
			/* Сейв из более новой сборки. Разобрать его частично — тихо потерять
			 * непонятные нам данные, а потом затереть их своим v3. Поэтому
			 * профиль остаётся дефолтным, а запись — разоруженной. */
			this._saveBlocked = true
			console.warn('[meta] отказ загружать сейв версии ' + v + ' (поддерживается ' + SAVE_VERSION + ')')
			this._saveFatal('Сохранение создано более новой версией игры (формат v' + v + ', эта сборка понимает v' + SAVE_VERSION + '). Профиль не загружен, запись отключена, чтобы не затереть его.', null)
			return false
		}

		try {
			if (d.p && typeof d.p === 'object') Object.assign(this.P, d.p)
			const stats = this._restoreInventory(d)
			/* Раскладка сама шлёт inv:changed и снова помечает профиль грязным —
			 * гасим: только что прочитанное состояние сохранять не нужно. */
			this._dirty = false
			this._saveT = 0
			console.info('[meta] профиль v' + v + ': lvl ' + this.P.lvl + ', ' + Math.round(this.P.money?.rub ?? 0) + ' ₽' + (stats
				? ', предметов ' + stats.items + ' (точно ' + stats.exact + ', перенесено ' + stats.moved + ', потеряно ' + stats.dropped + ')'
				: ', снапшот инвентаря отсутствует'))
			if (v < SAVE_VERSION) console.info('[meta] сейв v' + v + ' будет перезаписан как v' + SAVE_VERSION)
			return true
		} catch (e) {
			console.error('[meta] load failed', e)
			return false
		}
	}

	/**
	 * Раскладка снапшота инвентаря обратно в модель.
	 *
	 * Порядок жёсткий, иначе половина вещей уйдёт в никуда:
	 *   1. снести стартовый набор (его засеял InventorySystem.init());
	 *   2. растянуть тайник до P.stashRows — Grid.resize() обнуляет ячейки;
	 *   3. контейнеры тела (secure/rig/backpack) — они создают сетки in:<uid>;
	 *   4. остальные слоты тела;
	 *   5. базовые сетки (stash, pocket);
	 *   6. содержимое контейнеров — волнами, пока есть прогресс: контейнер
	 *      внутри рюкзака получает свою сетку только после того, как лёг сам.
	 *
	 * @returns {{items:number,exact:number,moved:number,dropped:number,weight:number}|null}
	 */
	_restoreInventory(d) {
		const inv = this.inv
		if (!inv || typeof inv.restore !== 'function' || typeof inv.clearAll !== 'function') {
			console.warn('[meta] inventory без restore() — снапшот пропущен')
			return null
		}

		const rows = Math.max(1, Math.min(EFL.stash.maxRows, Math.round(Number(this.P.stashRows) || EFL.stash.rows)))
		this.P.stashRows = rows

		const tuples = Array.isArray(d?.inv) ? d.inv : []
		if (!tuples.length) {
			/* Ни одного кортежа: это не «пустой тайник», а сейв без снапшота.
			 * Стартовый набор оставляем — менять его не на что. */
			inv.grid('stash')?.resize(EFL.stash.width, rows)
			return null
		}

		inv.clearAll()
		inv.grid('stash')?.resize(EFL.stash.width, rows)

		const recs = new Map()
		for (const t of tuples) {
			if (!Array.isArray(t) || t.length < 4) continue
			const rec = {
				uid: t[0], id: t[1], n: t[2], path: t[3],
				x: t[4], y: t[5], rot: t[6], mag: t[7],
				nm: t[8], am: t[9], dur: t[10], mods: t[11],
				/* v1/v2 не знали про потолок — там будет undefined, и его добьёт
				 * ensureArmorInstance() из заводского определения. */
				durMax: t[12],
			}
			if (rec.uid == null || rec.id == null) continue
			recs.set(rec.uid, rec)
		}

		/* slots — это [...Map], то есть массив пар [slot, uid]. */
		const bySlot = new Map()
		for (const pair of Array.isArray(d?.slots) ? d.slots : []) {
			if (!Array.isArray(pair) || pair.length < 2) continue
			if (pair[0] == null || pair[1] == null) continue
			bySlot.set(String(pair[0]), pair[1])
		}

		const done = new Set()
		const place = (rec, path) => {
			if (!rec || done.has(rec.uid)) return false
			const it = inv.restore({
				uid: rec.uid, id: rec.id, n: rec.n, path,
				x: rec.x, y: rec.y, rot: rec.rot, mag: rec.mag,
				nm: rec.nm, am: rec.am, dur: rec.dur, mods: rec.mods,
			})
			if (!it) return false
			/* Потолок ресурса — свойство экземпляра, а inventory/persistence.js про
			 * броню намеренно ничего не знает: досыпаем здесь и зажимаем dur, чтобы
			 * отремонтированная вещь не «выросла» обратно. */
			const dm = Number(rec.durMax)
			if (Number.isFinite(dm) && dm > 0) {
				it.durMax = dm
				if (typeof it.dur === 'number' && it.dur > dm) it.dur = dm
			}
			done.add(rec.uid)
			return true
		}

		for (const slot of CONTAINER_SLOTS) {
			const uid = bySlot.get(slot)
			if (uid != null) place(recs.get(uid), 'slot:' + slot)
		}

		for (const [slot, uid] of bySlot) {
			if (CONTAINER_SLOTS.includes(slot)) continue
			place(recs.get(uid), 'slot:' + slot)
		}
		/* Старый сейв мог не донести карту слотов — добираем по самому path. */
		for (const rec of recs.values()) {
			if (done.has(rec.uid)) continue
			const path = String(rec.path ?? '')
			if (path.startsWith('slot:')) place(rec, path)
		}

		for (const rec of recs.values()) {
			if (done.has(rec.uid)) continue
			const path = String(rec.path ?? 'stash')
			if (!path.startsWith('in:')) place(rec, path)
		}

		let pending = []
		for (const rec of recs.values()) {
			if (!done.has(rec.uid) && String(rec.path ?? '').startsWith('in:')) pending.push(rec)
		}
		let guard = 0
		while (pending.length && guard++ < 24) {
			const next = []
			let progress = false
			for (const rec of pending) {
				if (place(rec, String(rec.path))) progress = true
				else next.push(rec)
			}
			pending = next
			if (!progress) break
		}
		for (const rec of pending) {
			console.warn('[meta] ' + rec.id + ': контейнер ' + rec.path + ' не восстановлен, предмет потерян')
		}

		const stats = inv.commitRestore()
		if (stats.dropped > 0) console.warn('[meta] при загрузке потеряно предметов: ' + stats.dropped)
		return stats
	}

	/**
	 * Громкая блокирующая плашка: персистентность потеряна.
	 *
	 * Перехватывает ввод на capture-фазе, чтобы клики и клавиши не уходили в игру
	 * под ней (включая захват курсора по клику по canvas).
	 */
	_saveFatal(reason, err) {
		const detail = err ? String(err?.message ?? err) : ''
		console.error('[meta] ПРОФИЛЬ НЕ СОХРАНЁН: ' + reason, err ?? '')
		this.ctx?.events?.emit('meta:saveFailed', { reason, detail })

		if (typeof document === 'undefined' || !document.body) {
			if (typeof alert === 'function') alert('ПРОФИЛЬ НЕ СОХРАНЁН\n\n' + reason)
			return
		}
		if (document.getElementById(WARN_ID)) return

		const wrap = document.createElement('div')
		wrap.id = WARN_ID
		wrap.setAttribute('role', 'alertdialog')
		wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(6,7,8,.88);font:13px/1.5 "Oswald","Segoe UI",sans-serif;letter-spacing:.06em;color:#e8dcc0'

		const card = document.createElement('div')
		card.style.cssText = 'max-width:560px;padding:26px 30px;border:1px solid #a33;background:linear-gradient(160deg,rgba(30,18,18,.98),rgba(12,10,10,.98));box-shadow:0 24px 60px rgba(0,0,0,.7)'

		const title = document.createElement('div')
		title.textContent = 'ПРОФИЛЬ НЕ СОХРАНЁН'
		title.style.cssText = 'font-size:18px;letter-spacing:.22em;color:#e2544a;margin-bottom:14px'

		const body = document.createElement('div')
		body.textContent = reason
		body.style.cssText = 'margin-bottom:10px;color:#d7dbd3'

		const hint = document.createElement('div')
		hint.textContent = 'Тайник, деньги и прогресс этой сессии не переживут перезагрузку страницы. Автосейв остановлен. Освободите место в хранилище браузера и нажмите ПОВТОРИТЬ.'
		hint.style.cssText = 'margin-bottom:14px;font-size:12px;color:#9aa29a'

		const tech = document.createElement('div')
		tech.textContent = detail
		tech.style.cssText = 'max-height:96px;overflow:auto;margin-bottom:18px;font:11px/1.4 Consolas,monospace;color:#7f877f;word-break:break-word'

		const row = document.createElement('div')
		row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'

		const EVT = ['keydown', 'keyup', 'keypress', 'mousedown', 'mouseup', 'click', 'wheel', 'contextmenu']
		const swallow = (e) => { if (!wrap.contains(e.target)) e.stopPropagation() }
		const close = () => {
			for (const t of EVT) window.removeEventListener(t, swallow, true)
			wrap.remove()
		}

		const retry = document.createElement('button')
		retry.type = 'button'
		retry.textContent = 'ПОВТОРИТЬ'
		retry.style.cssText = BTN_CSS
		retry.addEventListener('click', () => {
			close()
			this._saveBlocked = false
			this._dirty = true
			this._saveT = 0
			try {
				this.save()
			} catch (e) {
				/* Не прошло снова — save() уже поднял плашку заново. */
			}
		})

		const ignore = document.createElement('button')
		ignore.type = 'button'
		ignore.textContent = 'ИГРАТЬ БЕЗ СЕЙВА'
		ignore.style.cssText = BTN_CSS
		ignore.addEventListener('click', close)

		row.append(retry, ignore)
		card.append(title, body, hint, tech, row)
		wrap.append(card)
		for (const t of EVT) window.addEventListener(t, swallow, true)
		document.body.appendChild(wrap)
		retry.focus()
	}

	/** Сейв не чаще раза в 8 секунд и никогда во время боя. */
	update(dt, ctx) {
		if (!this._dirty || this._saveBlocked) return
		this._saveT += dt
		if (this._saveT < 8) return
		const raid = ctx.peek('raid')
		if (raid?.active && ctx.peek('ai')?.bots?.some((b) => b.state === 3)) return
		this._saveT = 0
		this.save()
	}

	/**
	 * Публичное начисление опыта и фиксация его в профиль.
	 *
	 * До этого опыт умел зачислять только приватный _afterRaid() по событию
	 * raid:end, так что ни один экран UI не мог записать прогресс в профиль:
	 * meta.addExperience() просто не существовало.
	 *
	 * @param {number} amount — опыт за рейд (мусор и отрицательные гасятся в 0,
	 *   иначе undefined превратил бы P.xp в NaN и убил сейв).
	 * @param {{ commit?: boolean }} [opts] — commit: false откладывает запись на диск.
	 * @returns {{ lvl: number, xp: number, gained: number, leveledUp: boolean }}
	 */
	addExperience(amount, opts = {}) {
		const gained = Math.max(0, Math.round(Number(amount) || 0))
		const lvlBefore = this.P.lvl
		if (gained <= 0) return { lvl: this.P.lvl, xp: this.P.xp, gained: 0, leveledUp: false }

		/* Старые сейвы могли прийти без bp — иначе P.bp.xp упал бы с TypeError. */
		if (!this.P.bp || typeof this.P.bp !== 'object') this.P.bp = { tier: 0, xp: 0 }

		this.P.xp += gained
		while (this.P.xp >= this._need(this.P.lvl)) { this.P.xp -= this._need(this.P.lvl); this.P.lvl++ }

		this.P.bp.xp += gained
		while (this.P.bp.xp >= 1200 && this.P.bp.tier < 53) { this.P.bp.xp -= 1200; this.P.bp.tier++ }

		this._dirty = true
		const leveledUp = this.P.lvl > lvlBefore
		this.ctx?.events?.emit('meta:xp', { gained, lvl: this.P.lvl, xp: this.P.xp, leveledUp })
		if (opts.commit !== false) {
			try {
				this.save()                                    // фиксация в localStorage
			} catch (e) {
				/* Плашка уже поднята в save(). Откатывать начисление нечего:
				 * профиль в памяти корректен, потерян только диск. */
				console.error('[meta] опыт начислен, но не сохранён', e)
			}
		}
		return { lvl: this.P.lvl, xp: this.P.xp, gained, leveledUp }
	}

	_afterRaid({ kind, summary }) {
		const s = summary || {}
		this.P.stats.raids++
		if (kind === 'survived') this.P.stats.survived++
		this.P.stats.kills += Math.max(0, Math.round(Number(s.kills) || 0))
		/* Опыт, боевой пропуск, уровни и коммит — внутри addExperience():
		 * единая точка начисления, чтобы экран итогов не посчитал тот же
		 * опыт второй раз. */
		this.addExperience(s.xp)
		this._dirty = true
		try {
			this.save()                                      // после рейда — сразу, кадры уже не важны
		} catch (e) {
			console.error('[meta] сейв после рейда не прошёл', e)
		}
	}
	_need(lvl) { return Math.round(1000 * Math.pow(lvl, 1.35)) }

	dispose() {
		if (!this._dirty || this._saveBlocked) return
		try {
			this.save()
		} catch (e) {
			/* Бросать из dispose() нельзя: его зовут при HMR и закрытии страницы,
			 * исключение оставит движок недоразобранным. Плашка уже показана. */
			console.error('[meta] финальный сейв не прошёл', e)
		}
	}
}
