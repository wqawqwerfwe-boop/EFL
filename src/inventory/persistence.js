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
 * Устанавливается идемпотентно: повторный вызов (HMR, второй заход в меню)
 * ничего не ломает.
 * ========================================================================== */

import { InventorySystem } from './index.js'
import { SLOT_ACCEPT } from './layout.js'

let installed = false

export function applyInventoryPersistence() {
	if (installed) return InventorySystem
	installed = true
	Object.assign(InventorySystem.prototype, { clearAll, restore, commitRestore })
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

export default applyInventoryPersistence
