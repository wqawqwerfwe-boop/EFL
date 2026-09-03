import { EFL } from '../core/config.js'
import { applyInventoryPersistence } from '../inventory/persistence.js'

const SKEY = 'efl_ow_v1'

/**
 * Версия payload'а сейва.
 *
 * v1 — первая сборка: {p, inv, slots} без поля версии (inv/slots писались, но
 *      никогда не читались — тайник умирал на каждом F5).
 * v2 — то же плюс v, и с честной раскладкой inv/slots при загрузке.
 *
 * Старше — миграция (структура кортежей не менялась). Новее — отказ: «починить»
 * сейв из будущей сборки нельзя, можно только не трогать его.
 */
const SAVE_VERSION = 2

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

/** Контейнеры тела. Восстанавливаются ПЕРВЫМИ: они создают сетки in:<uid>. */
const CONTAINER_SLOTS = ['secure', 'rig', 'backpack']

export class MetaSystem {
	static id = 'meta'
	static deps = ['items', 'inventory']

	async init(ctx) {
		this.ctx = ctx
		this.items = ctx.get('items')
		this.inv = ctx.get('inventory')
		this.rng = ctx.rng.fork('meta')

		/* clearAll/restore/commitRestore живут в inventory/persistence.js: модель
		 * предметов не должна знать про формат сейва. Вызов идемпотентен. */
		applyInventoryPersistence()

		this.P = this._fresh()
		this._saveT = 0
		this._dirty = false
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
			inv: this.inv.all.map((i) => [i.uid, i.id, i.n, i.path, i.x, i.y, i.rot, i.mag, i.nm, i.am, i.dur, i.mods]),
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
			 * непонятные нам данные, а потом затереть их своим v2. Поэтому
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
