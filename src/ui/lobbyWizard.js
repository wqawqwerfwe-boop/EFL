/* ==========================================================================
 * Escape-From-Larpov · src/ui/lobbyWizard.js
 *
 * ПУБЛИЧНАЯ ТОЧКА ВХОДА визарда высадки и МОСТ в главное меню.
 *
 * Пять шагов пути от главного меню до рейда живут в ./lobbyWizard/wizard.js:
 *
 *   1. ВЫБЕРИТЕ ПЕРСОНАЖА         — ДИКИЙ / ЧВК, колонки с описаниями
 *   2. ВЫБЕРИТЕ МЕСТО ДИСЛОКАЦИИ  — ЗАВОД / ТАМОЖНЯ / ЛЕС / РАЗВЯЗКА /
 *                                   ЛАБОРАТОРИЯ плюс сжатые часы 1:9
 *   3. ТРЕНИРОВОЧНЫЙ РЕЖИМ ИГРЫ   — чекбокс и модалка шестерёнки
 *   4. ПОДТВЕРЖДЕНИЕ              — силуэт во всю высоту и ГОТОВ
 *   5. ВЫСАДКА НА МЕСТО ДИСЛОКАЦИИ — runRaidPrewarm() перед STATE.GAMEPLAY
 *
 * РАЗДЕЛЕНИЕ ОТВЕТСТВЕННОСТИ. Здесь сознательно нет ни одного шага: класс
 * лежит в ./lobbyWizard/wizard.js, данные, бренд и часы — в
 * ./lobbyWizard/data.js, весь CSS — в ./lobbyWizard/style.js, процедурный
 * SVG — в ./lobbyWizard/art.js. Модуль держит ровно пять вещей:
 *
 *   - реэкспорт публичной поверхности для внешних импортёров;
 *   - жизненный цикл единственного живого визарда (activeWizard);
 *   - resolveMenuRoot() — поиск контейнера меню, который надо повернуть;
 *   - resetMenuTransform() — плоский сброс этого контейнера;
 *   - делегированный мост с клика «ПОБЕГ ИЗ ЛАРПОВА» в openLobbyWizard().
 *
 * ЗАЧЕМ МОСТ ПЕРЕХВАТЫВАЕТ КЛИК. Штатный обработчик меню уходит в
 * engine.startRaid(), а тот выставляет STATE.GAMEPLAY сразу после
 * raid.start() — то есть ДО компиляции шейдеров и до пре-пула трассеров.
 * Ровно это давало многосекундный стоп на первом выстреле и на первой
 * очереди бота. Поэтому слушатель висит в фазе ПЕРЕХВАТА и гасит событие, а
 * высадкой дальше правит шаг 5: он ждёт runRaidPrewarm() и только потом
 * отдаёт движку enterGameplay().
 *
 * ── ЧТО БЫЛО СЛОМАНО В ЖИЗНЕННОМ ЦИКЛЕ ──────────────────────────────────
 *
 * 1. ПОВОРОТ И БЛЮР НЕ СБРАСЫВАЛИСЬ. Поворот меню — это два класса из
 *    style.js: .efl-lw-menu-rotate (транзишен) и .efl-lw-menu-out
 *    (transform: rotate(-90deg) scale(.82), filter: blur(6px) saturate(.4),
 *    opacity: 0, pointer-events: none). Снимает их только _rotateMenuIn(),
 *    а он зовётся исключительно из close({ restoreMenu: true }). Высадка же
 *    закрывает визард с restoreMenu: false — и это правильно, меню обязано
 *    остаться убранным на время рейда. Но снять классы после рейда было
 *    некому: ни выход через «ПОКИНУТЬ РЕЙД», ни экран итогов, ни возврат в
 *    убежище к этому модулю не обращались. Игрок возвращался на повёрнутое
 *    на 90°, размытое, прозрачное и полностью некликабельное меню.
 *    Лечится resetMenuTransform() — он снимает классы И пушит инлайновый
 *    плоский сброс, чтобы интерфейс встал ровно в этом же кадре.
 *
 * 2. МОСТ НИКОГДА НЕ СНИМАЛСЯ. applyLobbyWizardBridge() ставился при
 *    импорте модуля и жил до конца сессии, а findLaunchNode() поднимался на
 *    восемь родителей вверх и матчил КОНТЕЙНЕР меню: его textContent
 *    содержит подпись «ПОБЕГ ИЗ ЛАРПОВА» целиком, а на обёртках висят
 *    data-атрибуты вида raid/play. Поэтому клик по ПЕРСОНАЖ, БАРАХОЛКА,
 *    УБЕЖИЩЕ или ВЫХОД доезжал до этого контейнера и уходил в новую
 *    последовательность лобби. Теперь: вторичные пункты обрываю обход
 *    сразу, подпись матчится только на реальном контроле, обход
 *    останавливается на корне меню, клик вне меню игнорируется, а сам мост
 *    снимается ровно тем токеном, которым был поставлен.
 *
 * ARCHITECTURE.md. Правило 1: этот файл живёт в src/ui/ и не трогает чужие
 * каталоги. Правило 2: чужие подсистемы не импортируются — world, raid, ai,
 * inventory и meta визард берёт через ctx.peek() в рантайме. Наружу отсюда
 * торчит только STATE из core/engine.js, где он и заморожен, — строковые
 * литералы состояний в src/ui/ запрещены.
 * ========================================================================== */

import { STATE } from '../core/engine.js'
import { LobbyWizard } from './lobbyWizard/wizard.js'
import { NS, removeStyles } from './lobbyWizard/style.js'

/* --------------------------------------------------------------------------
 * Публичная поверхность модуля.
 *
 * Внешние импортёры (dev-харнессы, ui/preview.mjs, будущие кнопки меню)
 * должны видеть визард целиком через один путь, не зная о внутреннем
 * каталоге ./lobbyWizard/. Реэкспорт держит этот контракт.
 * ----------------------------------------------------------------------- */

export { LobbyWizard }
export { STEPS } from './lobbyWizard/wizard.js'
export { NS, STYLE_ID, Z_INDEX, ensureStyles, removeStyles } from './lobbyWizard/style.js'
export {
	BRAND,
	rebrandText,
	applyGlobalRebranding,
	FACTIONS,
	findFaction,
	MAP_CATALOGUE,
	REAL_SECONDS_PER_GAME_MINUTE,
	CLOCK_FACTOR,
	DAY_SECONDS,
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
} from './lobbyWizard/data.js'

/* ------------------------------------------------------------- константы */

/* Корни чужих оверлеев и самого визарда — клики внутри них мост не трогает. */
const SKIP_ROOTS = '.efl-esc, .efl-set, #eftInv, .' + NS

/* Кандидаты в контейнер главного меню, если инстанс не отдал свой узел. */
const MENU_SELECTORS = ['.efl-mm', '.efl-menu', '#eflMainMenu', '[data-efl-main-menu]']

/*
 * Подпись кнопки запуска рейда.
 *
 * Ловим и ребрендированную, и исходную форму: applyGlobalRebranding() и
 * core/branding.js переписывают живой DOM меню, но на первом клике
 * ребрендинг мог ещё не дойти до этого узла, а MENU_ITEMS в mainMenu.js
 * по-прежнему отдаёт английский заголовок. Пропустить клик из-за падежа
 * нельзя — игрок останется на неработающей кнопке.
 */
const LAUNCH_RE = /побег\s+из\s+(ларпова|таркова)|escape\s+from\s+(larpov|tarkov)/i

/*
 * Вторичные пункты меню и всё, что рейд не запускает.
 *
 * ЭТО ГЛАВНЫЙ ПРЕДОХРАНИТЕЛЬ от перехвата чужих кнопок. Совпадение здесь
 * обрывает обход дерева НЕМЕДЛЕННО, не поднимаясь к родителям: над пунктом
 * почти всегда висит контейнер меню, который сам по себе выглядит пусковым,
 * и ровно через него клик по ПЕРСОНАЖ уезжал в новое лобби. Отдельно ловим
 * «ПОКИНУТЬ РЕЙД» и «ВЫХОД» — им место в своих системах, а не в визарде.
 */
const SECONDARY_RE = /персонаж|инвентар|снаряжен|барахолк|торгов|скупщик|убежищ|характеристик|задани|квест|карт[аы]|друз|почт|сообщен|настройк|параметр|статистик|выход|выйти|покинуть|дезертир|назад|отмена|закрыть|character|inventory|stash|gear|flea|market|trade|trading|trader|hideout|quest|task|setting|option|profile|stat|exit|quit|leave|logout|back|cancel|close|friend|mail|message|map/i

/* Машинные метки действия: MENU_ACTION.RAID из mainMenu.js — это 'raid'. */
const LAUNCH_ACTS = /^(play|raid|deploy|start|startraid|launch|escape)$/i

const LAUNCH_ATTRS = [
	'data-act',
	'data-action',
	'data-nav',
	'data-screen',
	'data-menu',
	'data-role',
	'data-view',
	'id',
	'aria-label'
]

/* Роли и классы, по которым узел считается настоящим контролом, а не обёрткой. */
const CONTROL_ROLES = /^(button|link|menuitem|menuitemradio|menuitemcheckbox|tab|option)$/i
const CONTROL_CLASS_RE = /(^|[\s_-])(btn|button|item|entry|link|tile|card|row|cell|nav|opt)([\s_-]|$)/i

/* Сколько родителей проходим от кликнутого узла вверх. */
const MAX_WALK = 8

/* Длиннее этого текст считаем контейнером, а не подписью кнопки. */
const MAX_LABEL = 60

/*
 * Плоское состояние главного меню.
 *
 * Значения ровно те, что требует ТЗ: нулевой поворот и нулевой блюр. opacity
 * и pointer-events идут вместе с ними не для красоты: .efl-lw-menu-out гасит
 * меню в ноль прозрачности и снимает с него события мыши, поэтому сброс
 * одного transform оставил бы игрока перед невидимым и некликабельным хабом.
 */
const FLAT_TRANSFORM = 'rotateY(0deg)'
const FLAT_FILTER = 'blur(0px)'

/* --------------------------------------------------------------- хелперы */

function logWarn(message, err) {
	if (typeof console === 'undefined') return
	if (err) console.warn('[EFL/lobby] ' + message, err)
	else console.warn('[EFL/lobby] ' + message)
}

function logError(message, err) {
	if (typeof console === 'undefined') return
	console.error('[EFL/lobby] ' + message, err)
}

/** Движок из аргумента, иначе дев-хендл из main.js. */
function resolveEngine(engine) {
	if (engine) return engine
	if (typeof window !== 'undefined' && window.__ENGINE__) return window.__ENGINE__
	return null
}

/**
 * Пускать визард можно только со стартового экрана.
 *
 * Молчащий движок (дев-харнесс без state) не блокируем: там визард
 * поднимают вручную.
 */
function stateAllowsWizard(engine) {
	if (!engine || typeof engine.state !== 'string') return true
	return engine.state === STATE.MENU || engine.state === STATE.BOOT
}

function attrOf(node, name) {
	if (!node || typeof node.getAttribute !== 'function') return null
	const raw = node.getAttribute(name)
	return raw == null ? null : String(raw)
}

function textOf(node) {
	if (!node || typeof node.textContent !== 'string') return ''
	return node.textContent.replace(/\s+/g, ' ').trim()
}

/**
 * Ищет контейнер главного меню, который надо повернуть на 90° влево.
 *
 * MainMenuSystem монтируется в document.body из main.js, поэтому сначала
 * смотрим поля инстанса, потом поднимаемся от кликнутого узла до прямого
 * ребёнка body, и только потом пробуем селекторы. Порядок важен: селектор
 * может поймать вложенную панель вместо корня, и тогда повернётся половина
 * экрана.
 */
export function resolveMenuRoot(instance, fromNode) {
	const fields = ['root', 'el', 'node', 'container', 'dom', 'wrap', 'overlay']
	for (let i = 0; i < fields.length; i++) {
		const candidate = instance ? instance[fields[i]] : null
		if (candidate && candidate.nodeType === 1) return candidate
	}
	if (fromNode && fromNode.nodeType === 1 && typeof document !== 'undefined' && document.body) {
		let node = fromNode
		let guard = 0
		while (node && node.parentNode && node.parentNode !== document.body && guard < 24) {
			node = node.parentNode
			guard++
		}
		if (node && node.nodeType === 1 && node.parentNode === document.body) return node
	}
	if (typeof document === 'undefined') return null
	for (let i = 0; i < MENU_SELECTORS.length; i++) {
		const found = document.querySelector(MENU_SELECTORS[i])
		if (found) return found
	}
	return null
}

/* ====================================================================== */
/*              плоский сброс контейнера главного меню                    */
/* ====================================================================== */

/**
 * Снимает поворот и блюр с ОДНОГО узла — сразу, без ожидания транзишена.
 *
 * Порядок операций тут не декоративный:
 *   1. классы снимаем первыми, иначе CSS продолжит держать rotate/blur;
 *   2. transition глушим ДО записи значений — с ним игрок увидел бы, как
 *      меню доворачивается 620 мс уже после возврата из рейда;
 *   3. инлайновые transform/filter пишем явно, потому что инлайн бьёт любой
 *      селектор: даже если чужой CSS всё ещё считает меню повёрнутым,
 *      контейнер встанет ровно;
 *   4. opacity и pointer-events возвращаем, иначе меню останется невидимым
 *      и не принимающим клики;
 *   5. форсируем reflow, чтобы снимок применился в этом же кадре;
 *   6. инлайновый transition снимаем следующим кадром — дальше меню снова
 *      анимируется своими средствами.
 */
function applyFlatMenuStyle(node) {
	if (!node || node.nodeType !== 1) return false

	if (node.classList) {
		node.classList.remove(NS + '-menu-out')
		node.classList.remove(NS + '-menu-rotate')
	}

	const s = node.style
	if (!s) return false

	s.transition = 'none'
	s.transform = FLAT_TRANSFORM
	s.filter = FLAT_FILTER
	s.opacity = '1'
	s.pointerEvents = 'auto'
	s.willChange = 'auto'

	if (typeof node.getBoundingClientRect === 'function') node.getBoundingClientRect()

	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(function () {
			if (node.style) node.style.transition = ''
		})
	} else {
		s.transition = ''
	}
	return true
}

/**
 * Убирает инлайновый плоский сброс.
 *
 * Обязательна перед новым открытием визарда: инлайн сильнее классов, и без
 * очистки .efl-lw-menu-out больше не смог бы повернуть меню — визард
 * открывался бы поверх неподвижного экрана. Реальные значения снова придут
 * из CSS.
 */
function clearFlatMenuStyle(node) {
	if (!node || node.nodeType !== 1 || !node.style) return false
	const s = node.style
	s.transition = ''
	s.transform = ''
	s.filter = ''
	s.opacity = ''
	s.pointerEvents = ''
	s.willChange = ''
	return true
}

/**
 * ПЛОСКОЕ МЕНЮ ЗДЕСЬ И СЕЙЧАС.
 *
 * Зовётся при возврате в хаб: из UiSystem._returnToMenu(), из перехода в
 * STATE.MENU и из disposeLobbyWizardUi(). Чистит не только переданный узел:
 * MainMenuSystem пересобирает свой DOM при смене темы, поэтому прежний
 * корень может быть уже мёртв, а классы поворота — висеть на новом. Поэтому
 * обрабатываются три источника: переданный root, ВСЕ узлы с классами
 * поворота и все кандидаты из MENU_SELECTORS.
 *
 * @returns {number} сколько контейнеров реально сброшено
 */
export function resetMenuTransform(root) {
	if (typeof document === 'undefined') return 0

	const targets = []
	const push = function (node) {
		if (!node || node.nodeType !== 1) return
		if (targets.indexOf(node) >= 0) return
		targets.push(node)
	}

	push(root)

	const marked = document.querySelectorAll('.' + NS + '-menu-rotate, .' + NS + '-menu-out')
	for (let i = 0; i < marked.length; i++) push(marked[i])

	for (let i = 0; i < MENU_SELECTORS.length; i++) push(document.querySelector(MENU_SELECTORS[i]))

	let done = 0
	for (let i = 0; i < targets.length; i++) {
		if (applyFlatMenuStyle(targets[i])) done++
	}
	return done
}

/* Историческое имя того же действия — держим для внешних импортёров. */
export const resetLobbyWizardMenuTransform = resetMenuTransform

/* ====================================================================== */
/*                     жизненный цикл живого визарда                      */
/* ====================================================================== */

let activeWizard = null
let bridgeInstalled = false
let bridgeHandler = null

/** Живой визард или null. Разрушенный экземпляр наружу не отдаём. */
export function getActiveLobbyWizard() {
	if (activeWizard && activeWizard.destroyed) activeWizard = null
	return activeWizard
}

export function isLobbyWizardOpen() {
	return !!getActiveLobbyWizard()
}

/**
 * Открывает визард. Повторный вызов возвращает живой экземпляр.
 *
 * show() асинхронный (он ждёт поворот меню), поэтому промис здесь
 * обязательно перехватывается: незакрытый reject в обработчике клика — это
 * unhandledrejection и мёртвая кнопка без единой строки в консоли.
 *
 * @returns {LobbyWizard|null} экземпляр либо null, если открыть нельзя
 */
export function openLobbyWizard(engine, opts) {
	const live = getActiveLobbyWizard()
	if (live) return live
	if (typeof document === 'undefined') return null

	const o = opts || {}
	const resolved = resolveEngine(engine)
	if (!resolved) {
		logWarn('движок не найден — визард высадки не открыт')
		return null
	}
	if (!stateAllowsWizard(resolved)) return null

	const menuRoot = o.menuRoot || resolveMenuRoot(resolved.mainMenu || null, o.fromNode || null)

	/* Плоский сброс с прошлого выхода из рейда снимаем ДО создания визарда:
	 * иначе инлайн перебьёт .efl-lw-menu-out и меню не повернётся. */
	clearFlatMenuStyle(menuRoot)

	let wizard = null
	try {
		wizard = new LobbyWizard(resolved, {
			menuRoot: menuRoot,
			mount: o.mount || document.body,
			/* Единственный владелец ссылки — этот модуль. Класс сообщает о
			 * своей смерти сам, поэтому activeWizard не переживает dispose(). */
			onDispose: function (dead) {
				if (activeWizard === dead) activeWizard = null
			}
		})
	} catch (err) {
		logError('LobbyWizard не создан', err)
		return null
	}

	activeWizard = wizard

	Promise.resolve()
		.then(function () {
			return wizard.show()
		})
		.catch(function (err) {
			logError('визард высадки не отрисовался', err)
			try {
				wizard.dispose()
			} catch (inner) {
				/* теардаун не имеет права бросать поверх исходной ошибки */
			}
			if (activeWizard === wizard) activeWizard = null
			/* Меню уже могло уехать в поворот — возвращаем его плоским. */
			resetMenuTransform(menuRoot)
		})

	return wizard
}

/**
 * Закрывает визард.
 *
 * @param opts.restoreMenu вернуть меню поворотом обратно (по умолчанию да)
 */
export function closeLobbyWizard(opts) {
	const wizard = getActiveLobbyWizard()
	activeWizard = null
	if (!wizard) return false
	const o = opts || {}
	try {
		wizard.close({ restoreMenu: o.restoreMenu !== false })
	} catch (err) {
		logError('закрытие визарда упало', err)
		try {
			wizard.dispose()
		} catch (inner) {
			/* см. выше */
		}
		return false
	}
	return true
}

/* ====================================================================== */
/*                             мост в меню                                */
/* ====================================================================== */

/** Настоящий контрол, а не обёртка-контейнер. */
function isControlNode(node) {
	if (!node || node.nodeType !== 1) return false
	const tag = node.tagName ? String(node.tagName).toUpperCase() : ''
	if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SUMMARY') return true
	const role = attrOf(node, 'role')
	if (role && CONTROL_ROLES.test(role.trim())) return true
	if (attrOf(node, 'tabindex') != null) return true
	if (typeof node.onclick === 'function') return true
	const cls = node.className && typeof node.className === 'string' ? node.className : ''
	if (cls && CONTROL_CLASS_RE.test(cls)) return true
	return false
}

/**
 * Вторичный пункт меню: ПЕРСОНАЖ, БАРАХОЛКА, УБЕЖИЩЕ, ВЫХОД, ПОКИНУТЬ РЕЙД
 * и прочее, что визарда не касается.
 *
 * Пусковая подпись проверяется ПЕРВОЙ: у кнопки рейда в тексте нет ни одного
 * вторичного слова, но порядок делает правило неломающимся при любом
 * будущем ребрендинге.
 */
function looksLikeSecondary(node) {
	if (!node || node.nodeType !== 1) return false

	const text = textOf(node)
	if (text && text.length <= MAX_LABEL) {
		if (LAUNCH_RE.test(text)) return false
		if (SECONDARY_RE.test(text)) return true
	}

	for (let i = 0; i < LAUNCH_ATTRS.length; i++) {
		const raw = attrOf(node, LAUNCH_ATTRS[i])
		if (!raw) continue
		const trimmed = raw.trim()
		if (LAUNCH_ACTS.test(trimmed) || LAUNCH_RE.test(trimmed)) return false
		if (SECONDARY_RE.test(trimmed)) return true
	}
	return false
}

/** Похож ли узел на кнопку выхода в рейд. */
function looksLikeLaunch(node) {
	if (!node || node.nodeType !== 1) return false

	/*
	 * Подпись — только на самом контроле и только короткой строкой. Раньше
	 * условия на контрол не было, и по тексту матчился весь корень меню: его
	 * textContent содержит «ПОБЕГ ИЗ ЛАРПОВА» вместе со всеми остальными
	 * пунктами. Отсюда и брался перехват любой кнопки.
	 */
	const text = textOf(node)
	if (text && text.length <= MAX_LABEL && LAUNCH_RE.test(text) && isControlNode(node)) return true

	for (let i = 0; i < LAUNCH_ATTRS.length; i++) {
		const raw = attrOf(node, LAUNCH_ATTRS[i])
		if (!raw) continue
		const trimmed = raw.trim()
		if (LAUNCH_ACTS.test(trimmed)) return true
		if (LAUNCH_RE.test(trimmed)) return true
	}
	return false
}

/**
 * Ближайший вверх по дереву узел запуска рейда, либо null.
 *
 * @param target кликнутый узел
 * @param stopRoot корень меню: сам контейнер пусковым узлом быть не может
 */
function findLaunchNode(target, stopRoot) {
	let node = target
	for (let i = 0; i < MAX_WALK; i++) {
		if (!node || node.nodeType !== 1) return null
		if (typeof document !== 'undefined' && (node === document.body || node === document.documentElement)) return null
		/* Вторичный пункт — выходим СРАЗУ и вверх не идём. */
		if (looksLikeSecondary(node)) return null
		if (stopRoot && node === stopRoot) return null
		if (looksLikeLaunch(node)) return node
		node = node.parentElement
	}
	return null
}

function onDocumentClick(e) {
	/* Мост снят — слушателя быть не должно вовсе, но если браузер довёз
	 * событие из очереди, оно обязано пройти мимо нас. */
	if (!bridgeInstalled) return
	if (!e || e.defaultPrevented) return
	/* Только основная кнопка мыши: контекстное меню рейд не запускает. */
	if (typeof e.button === 'number' && e.button !== 0) return
	if (isLobbyWizardOpen()) return

	const target = e.target
	if (!target || target.nodeType !== 1) return
	if (typeof target.closest === 'function' && target.closest(SKIP_ROOTS)) return

	const engine = resolveEngine(null)
	if (!stateAllowsWizard(engine)) return

	/*
	 * Мост работает ТОЛЬКО внутри главного меню. Клик по чужому оверлею,
	 * инвентарю или холсту нас не касается — иначе интерфейсы начинают
	 * перетекать друг в друга. Ограничение включается лишь для живого,
	 * присоединённого к документу корня: если селектор поймал мёртвый узел,
	 * кнопка запуска не имеет права замолчать.
	 */
	const menuRoot = resolveMenuRoot(engine ? engine.mainMenu : null, null)
	const attached = !!(menuRoot && document.body && document.body.contains(menuRoot))
	if (attached && typeof menuRoot.contains === 'function' && !menuRoot.contains(target)) return

	const hit = findLaunchNode(target, attached ? menuRoot : null)
	if (!hit) return

	/*
	 * Порядок намеренный: сначала пробуем открыть, гасим событие только
	 * после успеха. Если визард почему-то не поднялся, клик уходит штатному
	 * обработчику меню и рейд всё равно стартует через engine.startRaid() —
	 * без преварма, но и без мёртвой кнопки.
	 */
	const wizard = openLobbyWizard(engine, {
		menuRoot: attached ? menuRoot : resolveMenuRoot(engine ? engine.mainMenu : null, hit),
		fromNode: hit
	})
	if (!wizard) return

	e.preventDefault()
	if (typeof e.stopPropagation === 'function') e.stopPropagation()
	/* Меню вешает свой хендлер на этот же узел — глушим и соседей. */
	if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation()
}

/*
 * ПРЕДВЫДЕЛЕННЫЙ ТОКЕН ПОДПИСКИ.
 *
 * removeEventListener() снимает слушателя только при совпадении всех трёх
 * составляющих: тип, ТА ЖЕ ССЫЛКА на функцию и та же фаза захвата. Держим их
 * одной замороженной тройкой, чтобы установка и снятие физически не могли
 * разойтись: ни анонимной обёртки, ни bind(), ни { capture: true } против
 * true — любая из этих мелочей оставляла бы перехватчик висеть на document
 * навсегда.
 */
const CLICK_TOKEN = Object.freeze({
	type: 'click',
	handler: onDocumentClick,
	capture: true
})

/**
 * Ставит делегированный обработчик клика по «ПОБЕГ ИЗ ЛАРПОВА».
 *
 * Обработчик висит на фазе ПЕРЕХВАТА, чтобы опередить штатный хендлер меню,
 * который ушёл бы в startRaid() без преварма. Делегирование — потому что
 * MainMenuSystem перерисовывает свой DOM целиком при смене темы, и прямая
 * подписка на узел кнопки умерла бы вместе с ним.
 *
 * main.js этот модуль не импортирует и правится лидом, поэтому мост
 * ставится сам при импорте (см. низ файла), а UiSystem передёргивает его на
 * переходах состояний.
 *
 * @returns {boolean} true, если слушатель поставлен именно этим вызовом
 */
export function applyLobbyWizardBridge() {
	if (bridgeInstalled || typeof document === 'undefined') return false
	/* Двойной страховки ради снимаем прежнюю подписку тем же токеном: если
	 * модуль перезагрузили, слушатель мог остаться от прошлой жизни. */
	document.removeEventListener(CLICK_TOKEN.type, CLICK_TOKEN.handler, CLICK_TOKEN.capture)
	bridgeInstalled = true
	bridgeHandler = CLICK_TOKEN.handler
	document.addEventListener(CLICK_TOKEN.type, CLICK_TOKEN.handler, CLICK_TOKEN.capture)
	return true
}

/**
 * Снимает мост НАСОВСЕМ.
 *
 * Зовётся при разрушении и скрытии визарда, на завершении рейда и из
 * UiSystem при уходе из меню. Идемпотентен и не смотрит на bridgeInstalled
 * перед снятием: раньше ранний return при сброшенном флаге оставлял живого
 * слушателя на document, и мёртвый экземпляр визарда продолжал воровать
 * клики по ПЕРСОНАЖ / БАРАХОЛКА / УБЕЖИЩЕ / ВЫХОД.
 *
 * @returns {boolean} был ли мост установлен до вызова
 */
export function removeLobbyWizardBridge() {
	if (typeof document === 'undefined') return false
	const was = bridgeInstalled

	/* Снятие ровно тем токеном, которым ставили: тип, та же функция, та же
	 * фаза захвата. */
	document.removeEventListener(CLICK_TOKEN.type, CLICK_TOKEN.handler, CLICK_TOKEN.capture)
	/* И буквальная форма из ТЗ — тот же слушатель, повторное снятие
	 * безвредно, зато перехват гарантированно мёртв. */
	document.removeEventListener('click', onDocumentClick, true)

	/* Ссылка из прошлой установки, если её успели подменить дев-харнессом. */
	if (bridgeHandler && bridgeHandler !== CLICK_TOKEN.handler) {
		document.removeEventListener(CLICK_TOKEN.type, bridgeHandler, CLICK_TOKEN.capture)
	}

	bridgeHandler = null
	bridgeInstalled = false
	return was
}

/** Висит ли перехватчик прямо сейчас. Нужно UiSystem и дев-харнессам. */
export function isLobbyWizardBridgeInstalled() {
	return bridgeInstalled
}

/**
 * Полный теардаун подсистемы визарда: живой экран, мост, поворот меню и тег
 * стилей.
 *
 * «Dispose what you create» из ARCHITECTURE.md: <style> впрыскивает
 * ensureStyles(), значит снять его обязан этот модуль, а не сборщик мусора.
 * Плоский сброс идёт ДО removeStyles(): после снятия тега классы поворота
 * уже ничего не значат, но инлайновые значения обязаны остаться корректными.
 */
export function disposeLobbyWizardUi() {
	closeLobbyWizard({ restoreMenu: false })
	removeLobbyWizardBridge()
	resetMenuTransform(null)
	removeStyles()
}

/* Имя из ТЗ и внешних вызовов — то же самое действие. */
export const destroyLobbyWizardUi = disposeLobbyWizardUi

/* ------------------------------------------------------- автоустановка */

applyLobbyWizardBridge()

/*
 * Дев-хендл рядом с window.__ENGINE__ из main.js: без него визард нельзя
 * поднять из консоли, не зная пути импорта. Ничего не переопределяем, если
 * хендл уже занят.
 */
if (typeof window !== 'undefined' && !window.__eflLobbyWizard) {
	window.__eflLobbyWizard = {
		open: openLobbyWizard,
		close: closeLobbyWizard,
		active: getActiveLobbyWizard,
		dispose: disposeLobbyWizardUi,
		reset: resetMenuTransform,
		bridge: {
			apply: applyLobbyWizardBridge,
			remove: removeLobbyWizardBridge,
			installed: isLobbyWizardBridgeInstalled
		}
	}
}

export default openLobbyWizard
