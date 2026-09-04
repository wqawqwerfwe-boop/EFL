/* ==========================================================================
 * Escape-From-Larpov · src/ui/lobbyWizard/wizard.js
 *
 * Класс LobbyWizard — все пять шагов пути от главного меню до высадки.
 * Публичная точка входа и мост в меню живут в ../lobbyWizard.js.
 *
 * Подсистемы берутся только через ctx.peek() — get() бросает исключение на
 * незарегистрированный id, а в меню боевые системы ещё не подняты.
 * Прямых импортов world/raid/ai здесь нет — запрет ARCHITECTURE.md.
 *
 * Идентификаторы систем берутся ровно те, под которыми main.js их
 * регистрирует: инвентарь — 'inventory', а не 'inv'.
 * ========================================================================== */

import { runRaidPrewarm, PREWARM_STAGES } from '../../core/raidPrewarm.js'
import {
	BRAND,
	rebrandText,
	applyGlobalRebranding,
	FACTIONS,
	findFaction,
	MAP_CATALOGUE,
	REAL_SECONDS_PER_GAME_MINUTE,
	CLOCK_FACTOR,
	HALF_DAY_SECONDS,
	gameClockSeconds,
	formatClock,
	isNightSeconds,
	formatDuration,
	formatStopwatch,
	AI_COUNT_OPTIONS,
	AI_DIFFICULTY_OPTIONS,
	AI_COUNT_SCALE,
	AI_DIFFICULTY_SCALE,
	optionLabel,
	defaultOfflineConfig
} from './data.js'
import { NS, ensureStyles } from './style.js'
import {
	el,
	button,
	svg,
	call,
	silhouetteSvg,
	mapThumbSvg,
	deployBackdropSvg,
	gearIcon,
	clockIcon,
	peopleIcon,
	gridIcon,
	alertIcon,
	daylightIcon
} from './art.js'

export const STEPS = [
	{ id: 'character', title: 'ВЫБЕРИТЕ ПЕРСОНАЖА' },
	{ id: 'location', title: 'ВЫБЕРИТЕ МЕСТО ДИСЛОКАЦИИ' },
	{ id: 'training', title: 'ТРЕНИРОВОЧНЫЙ РЕЖИМ ИГРЫ' },
	{ id: 'confirm', title: 'ПОДТВЕРЖДЕНИЕ' },
	{ id: 'deploy', title: 'ВЫСАДКА НА МЕСТО ДИСЛОКАЦИИ' }
]

const SLOT_LABELS = [
	{ slot: 'primary', label: 'ОСНОВНОЕ ОРУЖИЕ' },
	{ slot: 'secondary', label: 'ВТОРИЧНОЕ ОРУЖИЕ' },
	{ slot: 'holster', label: 'КОБУРА' },
	{ slot: 'helmet', label: 'ШЛЕМ' },
	{ slot: 'armor', label: 'БРОНЕЖИЛЕТ' },
	{ slot: 'rig', label: 'РАЗГРУЗКА' },
	{ slot: 'backpack', label: 'РЮКЗАК' }
]

/* Идентификатор инвентаря в реестре движка. main.js регистрирует
 * InventorySystem строго как 'inventory' — короткое 'inv' в реестре не
 * существует и всегда давало null, из-за чего ЛАБОРАТОРИЯ навсегда
 * оставалась под ложной блокировкой «НУЖЕН ПРОПУСК». */
const INVENTORY_ID = 'inventory'

export class LobbyWizard {
	constructor(engine, opts) {
		const o = opts || {}
		this.engine = engine || null
		this.ctx = engine && engine.ctx ? engine.ctx : null
		this.menuRoot = o.menuRoot || null
		this.mount = o.mount || document.body
		this.onDispose = typeof o.onDispose === 'function' ? o.onDispose : null

		this.index = 0
		this.busy = false
		this.deployed = false
		this.destroyed = false

		this.state = {
			faction: 'pmc',
			mapId: 'factory',
			clockSlot: 0,
			night: false,
			training: false,
			offline: defaultOfflineConfig()
		}

		this.catalogue = MAP_CATALOGUE.map(function (m) { return Object.assign({}, m) })

		this.root = null
		this.bodyEl = null
		this.titleEl = null
		this.pips = []
		this.nextBtn = null
		this.backBtn = null
		this.hintEl = null
		this.modal = null

		this.clockNodes = []
		this.clockRaf = 0
		this.clockCache = ['', '']
		this.watchTimer = 0
		this.watchStart = 0
		this.watchEl = null
		this.stageNodes = {}
		this.statusEl = null
		this.fillEl = null

		this._onKeyDown = this._onKeyDown.bind(this)
		this._tickClock = this._tickClock.bind(this)
	}

	/* ------------------------------------------------------- доступ к данным */

	_peek(id) {
		if (!this.ctx || typeof this.ctx.peek !== 'function') return null
		try {
			return this.ctx.peek(id) || null
		} catch (err) {
			return null
		}
	}

	/**
	 * Сверяет презентационный каталог с реальной таблицей карт движка.
	 * Если у локации нет билдера — она гаснет как НЕДОСТУПНО, а не роняет рейд.
	 */
	_syncCatalogue() {
		const world = this._peek('world')
		const table = world ? (world.constructor && world.constructor.MAPS ? world.constructor.MAPS : world.MAPS) : null
		if (table) {
			for (let i = 0; i < this.catalogue.length; i++) {
				const entry = this.catalogue[i]
				const real = table[entry.id]
				entry.available = entry.available && !!real
				if (real && typeof real.dur === 'number') entry.duration = real.dur
				if (real && typeof real.duration === 'number') entry.duration = real.duration
			}
		}
		if (!this._unlocked(this._map())) {
			for (let i = 0; i < this.catalogue.length; i++) {
				if (this._unlocked(this.catalogue[i])) {
					this.state.mapId = this.catalogue[i].id
					break
				}
			}
		}
	}

	/** Лежит ли предмет на теле — нужно для пропуска в Лабораторию. */
	_hasItem(id) {
		const inv = this._peek(INVENTORY_ID)
		if (!inv || !inv.all) return false
		const all = inv.all
		for (let i = 0; i < all.length; i++) {
			const it = all[i]
			if (!it || it.id !== id) continue
			if (typeof inv.onBody === 'function' && !inv.onBody(it)) continue
			return true
		}
		return false
	}

	_unlocked(map) {
		if (!map || !map.available) return false
		if (map.needCard && !this._hasItem(map.needCard)) return false
		return true
	}

	_map() {
		for (let i = 0; i < this.catalogue.length; i++) {
			if (this.catalogue[i].id === this.state.mapId) return this.catalogue[i]
		}
		return this.catalogue[0]
	}

	_faction() {
		return findFaction(this.state.faction)
	}

	_clockSeconds(slot) {
		return gameClockSeconds(Date.now(), slot === 1 ? HALF_DAY_SECONDS : 0)
	}

	/* ---------------------------------------------------------------- показ */

	async show() {
		if (this.destroyed || this.root) return this
		ensureStyles()
		this._syncCatalogue()
		await this._rotateMenuOut()
		if (this.destroyed) return this
		this._buildShell()
		this._renderStep()
		return this
	}

	/** Поворот меню на 90° влево. Ждём transitionend, но с таймаутом. */
	_rotateMenuOut() {
		const root = this.menuRoot
		if (!root || !root.classList) return Promise.resolve()
		root.classList.add(NS + '-menu-rotate')
		/* Раздельные кадры: иначе браузер склеит оба класса и анимации не будет. */
		return new Promise(function (resolve) {
			requestAnimationFrame(function () {
				requestAnimationFrame(function () {
					let settled = false
					const finish = function () {
						if (settled) return
						settled = true
						root.removeEventListener('transitionend', finish)
						resolve()
					}
					root.addEventListener('transitionend', finish)
					setTimeout(finish, 760)
					root.classList.add(NS + '-menu-out')
				})
			})
		})
	}

	_rotateMenuIn() {
		const root = this.menuRoot
		if (!root || !root.classList) return
		root.classList.remove(NS + '-menu-out')
		const cls = NS + '-menu-rotate'
		setTimeout(function () {
			if (root.classList) root.classList.remove(cls)
		}, 700)
	}

	_buildShell() {
		const root = el('div', NS)
		root.setAttribute('role', 'dialog')
		root.setAttribute('aria-modal', 'true')

		const head = el('div', NS + '-head')
		this.titleEl = el('div', NS + '-title', STEPS[0].title)
		head.appendChild(this.titleEl)
		head.appendChild(el('div', NS + '-zone', BRAND.ruUpper + ' · ' + BRAND.zone))

		const steps = el('div', NS + '-steps')
		this.pips = []
		for (let i = 0; i < STEPS.length; i++) {
			const pip = el('div', NS + '-pip')
			steps.appendChild(pip)
			this.pips.push(pip)
		}
		head.appendChild(steps)

		this.bodyEl = el('div', NS + '-body')

		const foot = el('div', NS + '-foot')
		this.hintEl = el('div', NS + '-hint', '')
		const self = this
		this.nextBtn = button(NS + '-nav primary', 'ДАЛЕЕ', function () { self.next() })
		this.backBtn = button(NS + '-nav', 'НАЗАД', function () { self.back() })
		foot.appendChild(this.hintEl)
		foot.appendChild(this.nextBtn)
		foot.appendChild(this.backBtn)

		root.appendChild(head)
		root.appendChild(this.bodyEl)
		root.appendChild(foot)

		this.root = root
		this.mount.appendChild(root)
		document.addEventListener('keydown', this._onKeyDown, true)

		/* Глобальный ребрендинг по живому DOM меню и визарда. */
		applyGlobalRebranding(this.menuRoot || document.body)

		requestAnimationFrame(function () {
			if (self.root) self.root.classList.add(NS + '-in')
		})
	}

	_onKeyDown(e) {
		if (!this.root || this.busy) return
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			if (this.modal) this._closeOfflineModal()
			else this.close({ restoreMenu: true })
			return
		}
		if (this.modal) return
		if (e.key === 'Enter') {
			e.preventDefault()
			this.next()
		}
	}

	/* -------------------------------------------------------------- рендер */

	_renderStep() {
		if (!this.root) return
		const step = STEPS[this.index]
		this._stopClock()
		this.titleEl.textContent = step.title
		this.bodyEl.textContent = ''
		this.bodyEl.scrollTop = 0
		this.hintEl.textContent = ''

		for (let i = 0; i < this.pips.length; i++) {
			this.pips[i].className = NS + '-pip' + (i === this.index ? ' on' : i < this.index ? ' done' : '')
		}

		if (step.id === 'character') this._stepCharacter()
		else if (step.id === 'location') this._stepLocation()
		else if (step.id === 'training') this._stepTraining()
		else if (step.id === 'confirm') this._stepConfirm()
		else this._stepDeploy()

		const last = step.id === 'deploy'
		const confirm = step.id === 'confirm'
		this.nextBtn.style.display = last ? 'none' : ''
		this.backBtn.style.display = last ? 'none' : ''
		this.nextBtn.textContent = confirm ? 'ГОТОВ' : 'ДАЛЕЕ'
		this.nextBtn.className = NS + '-nav primary' + (confirm ? ' ready' : '')
		this.nextBtn.disabled = !this._canAdvance()
	}

	/* ──────────────────────────────── шаг 1: персонаж ────── */

	_stepCharacter() {
		const wrap = el('div', NS + '-chars')
		const self = this
		for (let i = 0; i < FACTIONS.length; i++) {
			const f = FACTIONS[i]
			const card = button(NS + '-char' + (f.id === this.state.faction ? ' sel' : ''), null, function () {
				if (self.state.faction === f.id) return
				self.state.faction = f.id
				self._renderStep()
			})
			const art = el('div', NS + '-char-art')
			art.appendChild(svg(silhouetteSvg(f.id, f.accent)))
			card.appendChild(art)
			card.appendChild(el('div', NS + '-char-name', f.label))
			card.appendChild(el('div', NS + '-char-tag', f.tag))
			card.appendChild(el('div', NS + '-char-desc', rebrandText(f.desc)))
			wrap.appendChild(card)
		}
		this.bodyEl.appendChild(wrap)
	}

	/* ───────────────────────── шаг 2: локация и время ────── */

	_stepLocation() {
		const wrap = el('div', NS + '-loc')
		const maps = el('div', NS + '-maps')
		const self = this

		for (let i = 0; i < this.catalogue.length; i++) {
			const map = this.catalogue[i]
			const unlocked = this._unlocked(map)
			const cls = NS + '-map' + (map.id === this.state.mapId ? ' sel' : '') + (unlocked ? '' : ' locked')
			const card = button(cls, null, function () {
				if (!unlocked) {
					self.hintEl.textContent = map.available ? 'ДЛЯ ВЫСАДКИ НУЖЕН ПРОПУСК' : 'ЛОКАЦИЯ ВРЕМЕННО НЕДОСТУПНА'
					return
				}
				self.state.mapId = map.id
				self._renderStep()
			})
			card.appendChild(el('div', NS + '-map-name', map.label))
			card.appendChild(el('div', NS + '-map-sub', map.en + ' · ' + formatDuration(map.duration)))
			if (!map.available) card.appendChild(el('div', NS + '-map-lock', 'НЕДОСТУПНО'))
			else if (map.needCard && !this._hasItem(map.needCard)) card.appendChild(el('div', NS + '-map-lock', 'НУЖЕН ПРОПУСК'))
			maps.appendChild(card)
		}

		const detail = el('div', NS + '-detail')
		wrap.appendChild(maps)
		wrap.appendChild(detail)
		this.bodyEl.appendChild(wrap)
		this._renderMapDetail(detail)
	}

	/** При клике на локацию впрыскивается превью, длительность и метаданные. */
	_renderMapDetail(host) {
		const map = this._map()
		host.textContent = ''
		host.appendChild(el('div', NS + '-detail-title', 'Настройки сервера'))

		const thumb = el('div', NS + '-thumb')
		thumb.appendChild(svg(mapThumbSvg(map)))
		host.appendChild(thumb)

		host.appendChild(el('div', NS + '-detail-name', map.label))
		host.appendChild(el('div', NS + '-detail-desc', rebrandText(map.desc)))

		const meta = el('div', NS + '-detail-meta')
		const rows = [
			[clockIcon(), formatDuration(map.duration)],
			[daylightIcon(this.state.night), map.weather],
			[peopleIcon(), map.players],
			[gridIcon(), map.size ? map.size + ' М' : '—']
		]
		for (let i = 0; i < rows.length; i++) {
			const chip = el('div', NS + '-chip')
			chip.appendChild(svg(rows[i][0]))
			chip.appendChild(el('span', null, rows[i][1]))
			meta.appendChild(chip)
		}
		host.appendChild(meta)

		host.appendChild(el('div', NS + '-clock-head', 'ВЫБЕРИТЕ ВРЕМЯ СУТОК:'))
		const clocks = el('div', NS + '-clocks')
		this.clockNodes = []
		this.clockCache = ['', '']
		const self = this

		for (let slot = 0; slot < 2; slot++) {
			const captured = slot
			const seconds = this._clockSeconds(captured)
			const night = isNightSeconds(seconds)
			const card = button(NS + '-clock' + (captured === this.state.clockSlot ? ' sel' : ''), null, function () {
				self.state.clockSlot = captured
				self.state.night = isNightSeconds(self._clockSeconds(captured))
				self._renderStep()
			})
			card.appendChild(el('div', NS + '-box'))
			const val = el('div', NS + '-clock-val', formatClock(seconds))
			card.appendChild(val)
			const tag = el('div', NS + '-clock-tag')
			const icon = svg(daylightIcon(night))
			tag.appendChild(icon)
			const tagText = el('span', null, night ? 'НОЧЬ' : 'ДЕНЬ')
			tag.appendChild(tagText)
			card.appendChild(tag)
			clocks.appendChild(card)
			this.clockNodes.push({ slot: captured, val: val, tag: tagText, icon: icon, host: tag, night: night })
		}

		host.appendChild(clocks)
		host.appendChild(el(
			'div',
			NS + '-clock-note',
			'Сжатие времени 1:' + REAL_SECONDS_PER_GAME_MINUTE + ' · 1 минута в рейде = ' +
				REAL_SECONDS_PER_GAME_MINUTE + ' секунд реального времени (×' + CLOCK_FACTOR.toFixed(2) + ')'
		))

		this.state.night = isNightSeconds(this._clockSeconds(this.state.clockSlot))
		this._startClock()
	}

	_startClock() {
		if (this.clockRaf || !this.clockNodes.length) return
		this.clockRaf = requestAnimationFrame(this._tickClock)
	}

	_stopClock() {
		if (this.clockRaf) cancelAnimationFrame(this.clockRaf)
		this.clockRaf = 0
		this.clockNodes = []
	}

	/** Тик часов. Запись в DOM только когда строка изменилась — нуль аллокаций впустую. */
	_tickClock() {
		if (!this.root || !this.clockNodes.length) {
			this.clockRaf = 0
			return
		}
		const now = Date.now()
		for (let i = 0; i < this.clockNodes.length; i++) {
			const node = this.clockNodes[i]
			const seconds = gameClockSeconds(now, node.slot === 1 ? HALF_DAY_SECONDS : 0)
			const text = formatClock(seconds)
			if (text !== this.clockCache[i]) {
				this.clockCache[i] = text
				node.val.textContent = text
				const night = isNightSeconds(seconds)
				if (night !== node.night) {
					node.night = night
					node.tag.textContent = night ? 'НОЧЬ' : 'ДЕНЬ'
					const fresh = svg(daylightIcon(night))
					node.host.replaceChild(fresh, node.icon)
					node.icon = fresh
					if (node.slot === this.state.clockSlot) this.state.night = night
				}
			}
		}
		this.clockRaf = requestAnimationFrame(this._tickClock)
	}

	/* ─────────────────── шаг 3: тренировочный режим ────── */

	_stepTraining() {
		const wrap = el('div', NS + '-offline')
		const cfg = this.state.offline
		const self = this

		wrap.appendChild(el(
			'div',
			NS + '-lede',
			'Тренировочный режим запускает рейд локально, без сетевых игроков. Настройки ниже влияют только на эту высадку.'
		))

		const row = el('div', NS + '-toggle-row')
		const check = button(NS + '-check' + (this.state.training ? ' on' : ''), null, function () {
			self.state.training = !self.state.training
			self._renderStep()
		})
		check.appendChild(el('span', NS + '-box'))
		check.appendChild(el('span', null, 'Включить тренировочный режим для этого рейда'))
		row.appendChild(check)

		const gear = button(NS + '-gear', null, function () { self._openOfflineModal() })
		gear.appendChild(svg(gearIcon()))
		gear.appendChild(el('span', null, 'НАСТРОЙКИ РЕЙДА'))
		gear.disabled = !this.state.training
		row.appendChild(gear)
		wrap.appendChild(row)

		const rows = el('div', NS + '-rows')
		const dim = this.state.training ? '' : ' dim'
		const summary = [
			['Кооперативный режим', this.state.training ? 'Выключен' : '—'],
			['Количество ИИ', optionLabel(AI_COUNT_OPTIONS, cfg.aiCount)],
			['Сложность ИИ', optionLabel(AI_DIFFICULTY_OPTIONS, cfg.aiDifficulty)],
			['Вкл. Боссов', cfg.bosses ? 'Да' : 'Нет'],
			['Отключить расход воды и энергии', cfg.noDrain ? 'Да' : 'Нет'],
			['Время', formatClock(this._clockSeconds(this.state.clockSlot)) + ' · ' + (this.state.night ? 'Ночь' : 'День')],
			['Течение времени', '×' + CLOCK_FACTOR.toFixed(2) + ' — как в онлайне'],
			['Локация', this._map().label]
		]
		for (let i = 0; i < summary.length; i++) {
			const line = el('div', NS + '-row' + (i > 0 && i < 5 ? dim : ''))
			line.appendChild(el('span', null, summary[i][0]))
			line.appendChild(el('span', NS + '-row-val', summary[i][1]))
			rows.appendChild(line)
		}
		wrap.appendChild(rows)

		if (this.state.training) {
			const warn = el('div', NS + '-warn')
			warn.appendChild(svg(alertIcon()))
			const text = el('div')
			text.appendChild(el('b', null, 'Внимание!'))
			text.appendChild(el('span', null, 'В тренировочном режиме не предусмотрено сохранение прогресса!'))
			warn.appendChild(text)
			wrap.appendChild(warn)
		}

		this.bodyEl.appendChild(wrap)
	}

	_openOfflineModal() {
		if (this.modal || !this.state.training) return
		const cfg = this.state.offline
		const self = this

		const wrap = el('div', NS + '-modal-wrap')
		const modal = el('div', NS + '-modal')
		const bar = el('div', NS + '-modal-bar')
		bar.appendChild(el('span', null, 'Настройки тренировочного режима'))
		bar.appendChild(button(NS + '-x', '×', function () { self._closeOfflineModal() }))
		modal.appendChild(bar)

		const inner = el('div', NS + '-modal-in')
		inner.appendChild(el('div', NS + '-modal-h', 'Настройки ИИ'))

		const select = function (label, options, current, onPick) {
			const field = el('div', NS + '-field')
			field.appendChild(el('div', NS + '-field-l', label))
			const sel = el('select', NS + '-sel')
			for (let i = 0; i < options.length; i++) {
				const opt = document.createElement('option')
				opt.value = options[i].value
				opt.textContent = options[i].label
				if (options[i].value === current) opt.selected = true
				sel.appendChild(opt)
			}
			sel.addEventListener('change', function () { onPick(sel.value) })
			field.appendChild(sel)
			return field
		}

		const toggle = function (label, current, onPick) {
			const field = el('div', NS + '-field')
			field.appendChild(el('div', NS + '-field-l', label))
			const btn = button(NS + '-check' + (current ? ' on' : ''), null, function () {
				const next = !btn.classList.contains('on')
				btn.classList.toggle('on', next)
				labelText.textContent = next ? 'Включено' : 'Выключено'
				onPick(next)
			})
			btn.appendChild(el('span', NS + '-box'))
			const labelText = el('span', null, current ? 'Включено' : 'Выключено')
			btn.appendChild(labelText)
			field.appendChild(btn)
			return field
		}

		inner.appendChild(select('Количество ИИ', AI_COUNT_OPTIONS, cfg.aiCount, function (v) { cfg.aiCount = v }))
		inner.appendChild(select('Сложность ИИ', AI_DIFFICULTY_OPTIONS, cfg.aiDifficulty, function (v) { cfg.aiDifficulty = v }))
		inner.appendChild(toggle('Вкл. Боссов', cfg.bosses, function (v) { cfg.bosses = v }))
		inner.appendChild(toggle('Отключить расход воды и энергии', cfg.noDrain, function (v) { cfg.noDrain = v }))

		modal.appendChild(inner)
		wrap.appendChild(modal)
		wrap.addEventListener('click', function (e) {
			if (e.target === wrap) self._closeOfflineModal()
		})

		this.root.appendChild(wrap)
		this.modal = wrap
	}

	_closeOfflineModal() {
		if (!this.modal) return
		if (this.modal.parentNode) this.modal.parentNode.removeChild(this.modal)
		this.modal = null
		this._renderStep()
	}

	/* ────────────────────── шаг 4: подтверждение ────── */

	_loadoutRows() {
		const inv = this._peek(INVENTORY_ID)
		const items = this._peek('items')
		const out = []
		if (this.state.faction === 'scav') {
			out.push(['Снаряжение', 'Случайный набор Дикого'])
			out.push(['Выдача', 'На точке высадки'])
			return out
		}
		if (!inv || typeof inv.slotItem !== 'function') {
			out.push(['Снаряжение', 'Стандартный набор ЧВК'])
			return out
		}
		for (let i = 0; i < SLOT_LABELS.length; i++) {
			const entry = SLOT_LABELS[i]
			const it = call(inv, 'slotItem', entry.slot)
			if (!it) continue
			const name = it.name || it.title || it.id || '—'
			out.push([entry.label, rebrandText(name)])
		}
		if (!out.length) out.push(['Снаряжение', 'Слоты пусты'])
		if (items && typeof items.price === 'function' && inv.all) {
			let total = 0
			for (let i = 0; i < inv.all.length; i++) {
				const it = inv.all[i]
				if (!it) continue
				if (typeof inv.onBody === 'function' && !inv.onBody(it)) continue
				const price = call(items, 'price', it.id)
				if (typeof price === 'number') total += price
			}
			if (total > 0) out.push(['Страховая ценность', Math.round(total).toLocaleString('ru-RU') + ' ₽'])
		}
		return out
	}

	_stepConfirm() {
		const faction = this._faction()
		const map = this._map()
		const wrap = el('div', NS + '-confirm')

		const left = el('div')
		const raidPanel = el('div', NS + '-panel')
		raidPanel.appendChild(el('div', NS + '-panel-h', 'Параметры рейда'))
		const raidRows = [
			['Локация', map.label],
			['Длительность', formatDuration(map.duration)],
			['Игроков', map.players],
			['Тренировка', this.state.training ? 'Включена' : 'Выключена'],
			['Сложность ИИ', optionLabel(AI_DIFFICULTY_OPTIONS, this.state.offline.aiDifficulty)],
			['Боссы', this.state.offline.bosses ? 'Да' : 'Нет']
		]
		for (let i = 0; i < raidRows.length; i++) {
			const kv = el('div', NS + '-kv')
			kv.appendChild(el('span', null, raidRows[i][0]))
			kv.appendChild(el('span', null, raidRows[i][1]))
			raidPanel.appendChild(kv)
		}
		left.appendChild(raidPanel)

		const middle = el('div', NS + '-silhouette')
		const meta = this._peek('meta')
		const level = meta && meta.P && typeof meta.P.lvl === 'number' ? meta.P.lvl : 42
		const mainMenu = this.engine ? this.engine.mainMenu : null
		const nickRaw = mainMenu && mainMenu.opts && mainMenu.opts.nickname
			? mainMenu.opts.nickname
			: mainMenu && mainMenu.nickname ? mainMenu.nickname : BRAND.shortEn
		middle.appendChild(el('div', NS + '-badge', String(level)))
		middle.appendChild(svg(silhouetteSvg(faction.id, faction.accent)))
		middle.appendChild(el('div', NS + '-nick', rebrandText(String(nickRaw)) + ' · ' + faction.label))

		const right = el('div')
		const kitPanel = el('div', NS + '-panel')
		kitPanel.appendChild(el('div', NS + '-panel-h', 'Снаряжение'))
		const kit = this._loadoutRows()
		for (let i = 0; i < kit.length; i++) {
			const kv = el('div', NS + '-kv')
			kv.appendChild(el('span', null, kit[i][0]))
			kv.appendChild(el('span', null, kit[i][1]))
			kitPanel.appendChild(kv)
		}
		right.appendChild(kitPanel)

		const status = el('div', NS + '-status-bar')
		const loc = el('div')
		loc.appendChild(el('span', null, 'ТЕКУЩАЯ ЛОКАЦИЯ:'))
		loc.appendChild(el('b', null, map.label))
		const time = el('div')
		time.appendChild(el('span', null, 'ТЕКУЩЕЕ ВРЕМЯ В ИГРЕ:'))
		time.appendChild(el('b', null, formatClock(this._clockSeconds(this.state.clockSlot))))
		const weather = el('div')
		weather.appendChild(el('span', null, 'ТЕКУЩИЕ ПОГОДНЫЕ УСЛОВИЯ:'))
		weather.appendChild(svg(daylightIcon(this.state.night)))
		status.appendChild(loc)
		status.appendChild(time)
		status.appendChild(weather)

		wrap.appendChild(left)
		wrap.appendChild(middle)
		wrap.appendChild(right)
		wrap.appendChild(status)
		this.bodyEl.appendChild(wrap)
	}

	/* ────────────────────────── шаг 5: высадка ────── */

	_stepDeploy() {
		const map = this._map()
		const deploy = el('div', NS + '-deploy')

		const bg = el('div', NS + '-deploy-bg')
		bg.appendChild(svg(deployBackdropSvg(map)))
		deploy.appendChild(bg)

		const inner = el('div', NS + '-deploy-in')
		inner.appendChild(el('div', NS + '-deploy-h', 'ВЫСАДКА НА МЕСТО ДИСЛОКАЦИИ'))
		inner.appendChild(el(
			'div',
			NS + '-deploy-sub',
			map.label + ' · ' + this._faction().label + ' · ' + formatClock(this._clockSeconds(this.state.clockSlot)) +
				' · ' + (this.state.night ? 'НОЧЬ' : 'ДЕНЬ')
		))

		const grid = el('div', NS + '-deploy-grid')

		const left = el('div')
		const stages = el('div', NS + '-stages')
		this.stageNodes = {}
		for (let i = 0; i < PREWARM_STAGES.length; i++) {
			const stage = PREWARM_STAGES[i]
			const line = el('div', NS + '-stage')
			line.appendChild(el('div', NS + '-stage-dot'))
			line.appendChild(el('span', null, rebrandText(stage.label || stage.id)))
			stages.appendChild(line)
			this.stageNodes[stage.id] = line
		}
		left.appendChild(stages)

		this.statusEl = el('div', NS + '-status', 'ЗАГРУЗКА ДАННЫХ...')
		left.appendChild(this.statusEl)

		const bar = el('div', NS + '-bar')
		this.fillEl = el('div', NS + '-bar-fill')
		bar.appendChild(this.fillEl)
		left.appendChild(bar)

		this.watchEl = el('div', NS + '-watch', 'ЗАГРУЗКА: 00:00')
		left.appendChild(this.watchEl)

		const sum = el('div', NS + '-sum')
		sum.appendChild(el('div', NS + '-panel-h', 'Сводка локации'))
		const sumRows = [
			['Локация', map.label + ' / ' + map.en],
			['Длительность', formatDuration(map.duration)],
			['Погода', map.weather],
			['Сжатие времени', '1:' + REAL_SECONDS_PER_GAME_MINUTE + ' (×' + CLOCK_FACTOR.toFixed(2) + ')'],
			['Тренировка', this.state.training ? 'Включена' : 'Выключена']
		]
		for (let i = 0; i < sumRows.length; i++) {
			const kv = el('div', NS + '-kv')
			kv.appendChild(el('span', null, sumRows[i][0]))
			kv.appendChild(el('span', null, sumRows[i][1]))
			sum.appendChild(kv)
		}
		sum.appendChild(el('div', NS + '-detail-desc', rebrandText(map.desc)))

		grid.appendChild(left)
		grid.appendChild(sum)
		inner.appendChild(grid)
		deploy.appendChild(inner)
		this.bodyEl.appendChild(deploy)

		this._startStopwatch()
	}

	_setStage(id, label, index, total) {
		if (this.statusEl) this.statusEl.textContent = rebrandText(label || 'ЗАГРУЗКА ДАННЫХ...')
		const keys = Object.keys(this.stageNodes)
		for (let i = 0; i < keys.length; i++) {
			const node = this.stageNodes[keys[i]]
			if (keys[i] === id) node.className = NS + '-stage on'
			else if (node.className.indexOf(' on') >= 0) node.className = NS + '-stage done'
		}
		if (typeof index === 'number' && typeof total === 'number' && total > 0) {
			this._setProgress(index / total)
		}
	}

	_setProgress(t) {
		if (!this.fillEl) return
		const clamped = Math.max(0, Math.min(1, Number(t) || 0))
		this.fillEl.style.width = (clamped * 100).toFixed(1) + '%'
	}

	_startStopwatch() {
		const self = this
		this.watchStart = Date.now()
		this._stopStopwatch()
		this.watchTimer = setInterval(function () {
			if (!self.watchEl) return
			self.watchEl.textContent = 'ЗАГРУЗКА: ' + formatStopwatch(Date.now() - self.watchStart)
		}, 250)
	}

	_stopStopwatch() {
		if (this.watchTimer) clearInterval(this.watchTimer)
		this.watchTimer = 0
	}

	/* ─────────────────── навигация и запуск ────── */

	_canAdvance() {
		const step = STEPS[this.index]
		if (this.busy) return false
		if (step.id === 'location') return this._unlocked(this._map())
		return true
	}

	next() {
		if (this.busy || !this.root) return
		if (!this._canAdvance()) {
			const map = this._map()
			this.hintEl.textContent = map.available ? 'ДЛЯ ВЫСАДКИ НУЖЕН ПРОПУСК' : 'ВЫБЕРИТЕ ДОСТУПНУЮ ЛОКАЦИЮ'
			return
		}
		if (STEPS[this.index].id === 'confirm') {
			this.index++
			this._renderStep()
			this._deploy()
			return
		}
		if (this.index >= STEPS.length - 1) return
		this.index++
		this._renderStep()
	}

	back() {
		if (this.busy || !this.root) return
		if (this.index === 0) {
			this.close({ restoreMenu: true })
			return
		}
		this.index--
		this._renderStep()
	}

	/** Прокидывает настройки тренировки в подсистемы через опциональные сеттеры. */
	_applyOfflineConfig() {
		const cfg = this.state.offline
		const engine = this.engine
		if (engine) {
			engine.__eflOffline = {
				training: this.state.training,
				aiCount: cfg.aiCount,
				aiDifficulty: cfg.aiDifficulty,
				bosses: cfg.bosses,
				noDrain: cfg.noDrain,
				mapId: this.state.mapId,
				faction: this.state.faction,
				night: this.state.night
			}
		}
		if (!this.state.training) return

		const ai = this._peek('ai')
		if (ai) {
			const countScale = AI_COUNT_SCALE[cfg.aiCount] || 1
			if (typeof ai.setBotBudget === 'function') call(ai, 'setBotBudget', countScale)
			else call(ai, 'setBotCount', countScale)
			call(ai, 'setDifficulty', AI_DIFFICULTY_SCALE[cfg.aiDifficulty] || 1)
			call(ai, 'setBossesEnabled', !!cfg.bosses)
		}
		const health = this._peek('health')
		if (health) call(health, 'setSurvivalDrain', !cfg.noDrain)
	}

	/**
	 * Цепочка высадки.
	 *
	 * enterLoading() → runRaidPrewarm() → raid.start() внутри afterTerrain →
	 * закрытие меню → enterGameplay(). Компиляция шейдеров, пул трассеров и
	 * прогрев геометрии оружия гарантированно завершаются ДО того, как
	 * состояние станет STATE.GAMEPLAY — иначе первый выстрел и первая
	 * очередь бота давали бы тот самый микрофриз.
	 *
	 * engine.startRaid() сознательно НЕ используется: он уходит в
	 * enterGameplay() сразу после raid.start(), то есть до преварма.
	 */
	async _deploy() {
		if (this.busy || this.deployed) return
		this.busy = true
		this.deployed = true

		const engine = this.engine
		const map = this._map()
		const faction = this.state.faction
		const night = this.state.night
		const self = this

		this._applyOfflineConfig()

		/* Дикому выдаётся случайный кит через детерминированный rng движка. */
		if (faction === 'scav') {
			const meta = this._peek('meta')
			const rng = this.ctx && this.ctx.rng ? call(this.ctx.rng, 'fork') || this.ctx.rng : null
			if (meta && rng) call(meta, 'equipScavKit', rng)
		}

		call(engine, 'enterLoading')

		const result = await runRaidPrewarm(engine, {
			onStage: function (id, label, index, total) { self._setStage(id, label, index, total) },
			onProgress: function (t) { self._setProgress(t) },
			/*
			 * Промис raid.start() ОБЯЗАН уехать наружу.
			 *
			 * raid.start() полностью асинхронный: он строит геометрию уровня.
			 * Без return преварм считал хук выполненным сразу и уходил в
			 * runMaterialHooks(), компилируя шейдерные пайплайны по пустой
			 * сцене — то есть впустую, а первый выстрел на живой геометрии
			 * снова давал микрофриз. Теперь runRaidPrewarm() ждёт карту.
			 */
			afterTerrain: async function () {
				const raid = self._peek('raid')
				if (!raid) return null
				return await call(raid, 'start', map.id, faction, night, {
					isTraining: self.state.training === true,
					offline: self.state.training === true,
					insurance: true,
				})
			}
		})

		if (this.destroyed) return

		this._setProgress(1)
		this._stopStopwatch()

		if (result && result.ok === false && this.statusEl) {
			this.statusEl.textContent = 'ЗАГРУЗКА ЗАВЕРШЕНА С ОГРАНИЧЕНИЯМИ'
			const err = el('div', NS + '-err', 'Преварм не дошёл до конца: ' + rebrandText(String(result.reason || 'неизвестная причина')))
			if (this.statusEl.parentNode) this.statusEl.parentNode.appendChild(err)
		}

		/* Главное меню гасим без destroy — оно понадобится после рейда. */
		if (engine && engine.mainMenu) call(engine.mainMenu, 'close', { fade: 700, destroy: false })

		call(engine, 'enterGameplay')
		call(engine, 'requestPointerLock')

		this.busy = false
		this.close({ restoreMenu: false })
	}

	/* -------------------------------------------------------------- теардаун */

	close(opts) {
		const o = opts || {}
		if (o.restoreMenu !== false) this._rotateMenuIn()
		this.dispose()
	}

	dispose() {
		if (this.destroyed) return
		this.destroyed = true
		this._stopClock()
		this._stopStopwatch()
		document.removeEventListener('keydown', this._onKeyDown, true)
		if (this.modal && this.modal.parentNode) this.modal.parentNode.removeChild(this.modal)
		this.modal = null
		if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root)
		this.root = null
		this.bodyEl = null
		this.titleEl = null
		this.pips = []
		this.nextBtn = null
		this.backBtn = null
		this.hintEl = null
		this.statusEl = null
		this.fillEl = null
		this.watchEl = null
		this.stageNodes = {}
		if (this.onDispose) this.onDispose(this)
	}
}
