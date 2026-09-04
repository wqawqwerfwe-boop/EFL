/* ==========================================================================
 * Escape-From-Larpov · src/inventory/persistence.js
 *
 * Раскладка сохранённого инвентаря обратно в модель.
 *
 * Живёт отдельным модулем и доставляется на InventorySystem.prototype ровно
 * так же, как applyMainMenuBridge() и applyTarkovBootstrap() доставляют свои
 * патчи: модель предметов (index.js) не должна знать ни про localStorage, ни
 * про формат кортежей MetaSystem.serialize(). Здесь — только обратная
 * операция к нему.
 *
 * Формат кортежа (MetaSystem.serialize):
 *   [uid, id, n, path, x, y, rot, mag, nm, am, dur, mods]
 *
 * Формат дескриптора выдачи (MetaSystem.generateScavLoadout):
 *   [uid, itemId, count, path, x, y, rotation, durability]
 *   Первые восемь полей — контракт. Стволы и магазины докладывают два
 *   необязательных хвостовых поля, без которых «полупустой магазин» не
 *   выразим вообще: [..., nm, am] — число патронов и ид патрона.
 *   Восьмиполевые кортежи остаются полностью валидными.
 *
 * Устанавливается идемпотентно: повторный вызов (HMR, второй заход в меню)
 * ничего не ломает.
 * ========================================================================== */

import { InventorySystem } from './index.js'
import { SLOT_ACCEPT } from './layout.js'

let installed = false

/** Сколько волн делать в applyLoadout(): ствол → разгрузка → её содержимое. */
const LOADOUT_WAVES = 4

export function applyInventoryPersistence() {
	if (installed) return InventorySystem
	installed = true
	Object.assign(InventorySystem.prototype, { clearAll, restore, commitRestore, applyLoadout })
	return InventorySystem
}

function counters(inv) {
	if (!inv._restoreStats) inv._restoreStats = { exact: 0, moved: 0, dropped: 0 }
	return inv._restoreStats
}

function int(v, fallback = 0) {
	const n = Math.round(Number(v))
	return Number.isFinite(n) ? n : fallback
}

/**
 * Полный снос модели перед раскладкой сейва.
 *
 * InventorySystem.init() успевает засеять стартовый набор (deps: meta идёт
 * ПОСЛЕ inventory), и без сноса сохранённые вещи легли бы поверх выданных —
 * ровно так тайник и «размножался» между перезагрузками.
 */
function clearAll() {
	/* Сетки контейнеров принадлежат предметам, которые сейчас исчезнут: их
	 * удаляем целиком, базовые (stash, pocket) только чистим — они создаются
	 * один раз в init() и на них ссылается вьюха. */
	for (const path of [...this.grids.keys()]) {
		if (path.startsWith('in:')) this.grids.delete(path)
		else this.grids.get(path)?.clear()
	}
	this.byUid.clear()
	this.slots.clear()
	this.all.length = 0
	this.quick.fill(null)
	this.quickPinned.fill(null)
	this._weight = 0
	this._weightDirty = true
	this._restoreStats = { exact: 0, moved: 0, dropped: 0 }
	return this
}

/**
 * Строгая раскладка ОДНОГО сохранённого предмета в его точные координаты.
 *
 * @param {{uid:number,id:string,n:number,path:string,x:number,y:number,
 *   rot:number,mag:*,nm:number,am:*,dur:*,mods:*}} rec
 * @returns {object|null} предмет, либо null.
 *
 * null НЕ означает «выбросить»: для пути in:<uid> он означает «сетки ещё нет,
 * контейнер-хозяин не восстановлен» — вызывающий обязан повторить попытку
 * следующей волной. Настоящие потери (предмет вырезали из базы, место в сетке
 * не нашлось) считаются в _restoreStats.dropped.
 */
function restore(rec) {
	if (!rec || rec.id == null) return null
	const st = counters(this)
	const uid = int(rec.uid, 0)
	if (uid <= 0 || this.byUid.has(uid)) return null

	const d = this.items.get(rec.id)
	if (!d) {
		/* Предмет вырезали из базы между сборками — теряем ровно его, а не сейв. */
		console.warn('[inv] restore: неизвестный предмет ' + rec.id)
		st.dropped++
		return null
	}

	let path = String(rec.path ?? 'stash')
	let rerouted = false
	if (path.startsWith('slot:')) {
		const slot = path.slice(5)
		const accept = SLOT_ACCEPT[slot]
		if (this.slots.has(slot) || (accept && !accept.includes(d.t))) {
			/* Слот занят или не принимает этот тип (битый сейв, переехавшая
			 * таблица слотов). Вещь не теряем — уводим в тайник и честно
			 * считаем это переносом. */
			console.warn('[inv] restore: слот ' + slot + ' не принял ' + rec.id + ' — в тайник')
			path = 'stash'
			rerouted = true
		}
	}

	const isSlot = path.startsWith('slot:')
	const g = isSlot ? null : this.grids.get(path)
	if (!isSlot && !g) return null

	const stack = Math.max(1, d.stack ?? 1)
	const it = {
		uid,
		id: rec.id,
		n: Math.max(1, Math.min(stack, int(rec.n, 1))),
		path,
		x: isSlot ? 0 : Math.max(0, int(rec.x, 0)),
		y: isSlot ? 0 : Math.max(0, int(rec.y, 0)),
		rot: isSlot || !rec.rot ? 0 : 1,
		dur: rec.dur == null ? d.dur ?? null : Number(rec.dur),
		/* uses в снапшот не пишется: расход внутри одного предмета не переживает
		 * рейд, а вот тип предмета переживает — берём из базы. */
		uses: d.uses ?? null,
		mods: rec.mods && typeof rec.mods === 'object'
			? Object.assign(Object.create(null), rec.mods)
			: d.t === 'weapon' ? Object.create(null) : null,
		am: rec.am ?? null,
		nm: Math.max(0, int(rec.nm, 0)),
		mag: rec.mag ?? d.magId ?? null,
		heat: 0,
		mode: 0,
		fir: false,
	}

	if (!isSlot) {
		if (this.fits(g, it, it.x, it.y, it.rot)) {
			if (rerouted) st.moved++
			else st.exact++
		} else if (this.findFree(g, it, this._scratch)) {
			/* Сетку уменьшили (даунгрейд тайника) или геометрия предмета изменилась.
			 * Вещь оставляем, но не делаем вид, что координаты сохранились. */
			it.x = this._scratch.x
			it.y = this._scratch.y
			it.rot = this._scratch.rot
			st.moved++
		} else {
			console.warn('[inv] restore: в сетке ' + path + ' нет места для ' + rec.id)
			st.dropped++
			return null
		}
	} else {
		st.exact++
	}

	this.byUid.set(uid, it)
	this.all.push(it)
	/* Аллокатор uid обязан остаться впереди всех восстановленных: иначе
	 * следующий add() выдаст уже занятый uid и затрёт вещь из сейва. */
	if (uid >= this._uid) this._uid = uid + 1

	if (isSlot) {
		this.slots.set(path.slice(5), uid)
	} else {
		g.items.push(it)
		this._stamp(g, it, g.items.length - 1)
	}

	/* Контейнер получает свою сетку СРАЗУ: следующая волна кладёт в неё
	 * вложенные предметы по пути in:<uid>. */
	if (d.grid) this._ensureContainer(it)
	this._weightDirty = true
	return it
}

/**
 * Финализация раскладки: пересбор быстрых слотов, синхронизация оружия и ОДИН
 * inv:changed вместо шторма событий на каждый предмет.
 */
function commitRestore() {
	const st = counters(this)
	const out = {
		exact: st.exact,
		moved: st.moved,
		dropped: st.dropped,
		items: this.all.length,
		weight: this.weight(),
	}
	this._emit('restore')
	return out
}

/* ------------------------------------------------------------------ выдача -- */

/** Кортеж дескриптора → запись в формате restore(). Объекты пропускаются как есть. */
function loadoutRow(row) {
	if (Array.isArray(row)) {
		if (row.length < 4) return null
		return {
			uid: int(row[0], 0),
			id: row[1],
			n: int(row[2], 1),
			path: row[3] == null ? 'stash' : String(row[3]),
			x: int(row[4], 0),
			y: int(row[5], 0),
			rot: row[6] ? 1 : 0,
			dur: row[7] == null ? null : Number(row[7]),
			nm: row[8] == null ? 0 : int(row[8], 0),
			am: row[9] == null ? null : row[9]
		}
	}
	if (row && typeof row === 'object' && row.id != null) return row
	return null
}

/** Корень пути: для in:<uid> идём вверх до слота, кармана или тайника. */
function rootPath(inv, it) {
	let cur = it
	for (let guard = 0; cur && guard < 32; guard++) {
		const path = String(cur.path || '')
		if (!path.startsWith('in:')) return path
		cur = inv.byUid.get(int(path.slice(3), 0))
	}
	return ''
}

/** Глубина вложенности. Сносить надо с самых глубоких, иначе сетка уедет из-под детей. */
function pathDepth(inv, it) {
	let cur = it
	let depth = 0
	while (cur && depth < 32) {
		const path = String(cur.path || '')
		if (!path.startsWith('in:')) return depth
		cur = inv.byUid.get(int(path.slice(3), 0))
		depth++
	}
	return depth
}

/**
 * Выдача ГОТОВОГО кита на тело игрока.
 *
 * Единственный легальный вход для сгенерированного снаряжения (сейчас — кит
 * дикого из MetaSystem.generateScavLoadout). Раньше рейд вкладывал предметы
 * поодиночке через add()/equip(), каждый в своём try/catch и с событием на
 * каждый — отсюда и половина молчаливых потерь кита.
 *
 * Семантика:
 *   1. всё, что сейчас НА ТЕЛЕ (слоты, карманы и всё вложенное в них),
 *      удаляется — дикий идёт в рейд в чужом теле, а не со своим ПМС-китом;
 *   2. ТАЙНИК НЕ ТРОГАЕМ НИКОГДА — ошибка здесь стоила бы игроку всего сейва;
 *   3. uid из дескриптора локальны и перенумеруются в живые, а пути in:<uid>
 *      переписываются на новые номера: генератору не нужно знать ничего о
 *      состоянии инвентаря;
 *   4. раскладка идёт через restore(), то есть одной и той же дорогой, что и
 *      загрузка сейва: точные координаты, прочность, сетки контейнеров и
 *      findFree() как запасной вариант — одна реализация, один набор багов;
 *   5. ОДИН inv:changed в конце — именно он заставляет MetaSystem сохранить
 *      кит со всеми его dur, так что выданное снаряжение переживает F5.
 *
 * @param {Array<Array|object>} descriptor кортежи [uid,id,n,path,x,y,rot,dur,(nm),(am)]
 * @returns {{items:number,exact:number,moved:number,dropped:number,stripped:number,weight:number}}
 */
function applyLoadout(descriptor) {
	const rows = (Array.isArray(descriptor) ? descriptor : descriptor && descriptor.items) || []

	/* Статистика загрузки сейва — не наша: берём свои счётчики и возвращаем её. */
	const saved = this._restoreStats
	this._restoreStats = { exact: 0, moved: 0, dropped: 0 }

	/* 1. Снос тела, с самых глубоких вложений. */
	const doomed = []
	for (let i = 0; i < this.all.length; i++) {
		const it = this.all[i]
		const root = rootPath(this, it)
		if (root !== 'pocket' && !root.startsWith('slot:')) continue
		doomed.push({ uid: it.uid, n: it.n, depth: pathDepth(this, it) })
	}
	doomed.sort((a, b) => b.depth - a.depth)
	for (let i = 0; i < doomed.length; i++) {
		const d = doomed[i]
		if (!this.byUid.has(d.uid)) continue
		this.remove(d.uid, d.n)
		if (this.byUid.has(d.uid)) this.remove(d.uid)
	}

	/* 2. Перенумерация uid и путей in:<uid> дескриптора в живые номера. */
	const remap = new Map()
	const queue = []
	for (let i = 0; i < rows.length; i++) {
		const rec = loadoutRow(rows[i])
		if (!rec) continue
		const local = int(rec.uid, 0)
		const fresh = this._uid++
		if (local > 0) remap.set(local, fresh)
		queue.push(Object.assign({}, rec, { uid: fresh }))
	}

	let orphans = 0
	const ready = []
	for (let i = 0; i < queue.length; i++) {
		const rec = queue[i]
		const path = String(rec.path || 'stash')
		if (!path.startsWith('in:')) {
			ready.push(rec)
			continue
		}
		const owner = remap.get(int(path.slice(3), 0))
		if (!owner) {
			/* Контейнера-хозяина нет в дескрипторе. В тайник такое не уводим:
			 * кит должен быть внутренне целым, а не течь в сторону хранилища. */
			console.warn('[inv] applyLoadout: сирота ' + rec.id + ' — путь ' + path + ' не разрешён')
			orphans++
			continue
		}
		rec.path = 'in:' + owner
		ready.push(rec)
	}

	/* 3. Волны: сначала слоты и карманы, потом содержимое контейнеров, чьи
	 *    сетки появились только что. */
	let pending = ready
	let placed = 0
	for (let wave = 0; wave < LOADOUT_WAVES && pending.length; wave++) {
		const next = []
		for (let i = 0; i < pending.length; i++) {
			const rec = pending[i]
			if (this.restore(rec)) {
				placed++
				continue
			}
			if (String(rec.path || '').startsWith('in:')) next.push(rec)
		}
		if (next.length >= pending.length) {
			pending = next
			break
		}
		pending = next
	}

	for (let i = 0; i < pending.length; i++) {
		console.warn('[inv] applyLoadout: некуда положить ' + pending[i].id + ' (' + pending[i].path + ')')
	}

	const st = counters(this)
	const out = {
		items: placed,
		exact: st.exact,
		moved: st.moved,
		dropped: st.dropped + orphans + pending.length,
		stripped: doomed.length,
		weight: this.weight()
	}
	this._restoreStats = saved
	this._weightDirty = true
	this._emit('loadout')
	return out
}

export default applyInventoryPersistence
