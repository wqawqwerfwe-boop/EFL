/* ==========================================================================
 * Escape-From-Larpov · src/core/raidPrewarm.js
 *
 * Прогрев рейда, который идёт ПОД экраном высадки (шаг 5 визарда) и
 * заканчивается ДО того, как движок выставит STATE.GAMEPLAY.
 *
 * ЗАЧЕМ. core/prewarm.js греет боты загрузки: он гоняется один раз на буте,
 * по статической сцене главного меню, и физически не может знать ни карту
 * рейда, ни снаряжение игрока. Поэтому первые секунды матча всё равно
 * съедали многосекундные стопы:
 *
 *   - меши оружия строятся в Viewmodel.addWeapon() один раз, но программа
 *     под них компилируется в тот кадр, когда группа впервые становится
 *     visible — то есть на первом кадре с этим стволом в руках;
 *   - пул трассеров в fx/particles.js растёт лениво, и первая же очередь
 *     заставляет его выделять буферы посреди боя;
 *   - шейдерные перестановки ландшафта конкретной локации до buildMap()
 *     вообще не существуют.
 *
 * Все три вещи детерминированно вызываются здесь, пока на экране висит
 * «ЗАГРУЗКА ДАННЫХ...».
 *
 * КАДРЫ. Сам прогрев не имеет права быть стопом. Три источника семисекундной
 * заморозки высадки убраны:
 *
 *   1. синхронный renderer.compile() на две сцены — теперь compileAsync();
 *   2. WebGLRenderTarget 1x1, который создавался и уничтожался N+2 раза за
 *      высадку, — теперь синглтон RenderSystem (render/scratchTarget.js),
 *      живущий до Engine.dispose();
 *   3. пакетная выпечка текстур материалов, шедшая одним куском внутри
 *      одного кадра, — теперь генератор MaterialSystem.bakeAll(), который
 *      отдаёт кадр браузеру и двигает ползунок загрузки.
 *
 * Выпечка идёт в стадии «ландшафт» ДО afterTerrain(), то есть до
 * world.buildMap(): карта строится уже по готовым текстурам и не заказывает
 * их по одной посреди сборки геометрии.
 *
 * КОНТРАКТ ЧИСТОТЫ. Прогрев обязан быть прозрачным для симуляции: он
 * шагает вьюмодель и трогает пулы частиц, а это двигает и часы, и поток
 * RNG. Снимок и восстановление — ровно как в core/prewarm.js, иначе
 * lockstep-съёмка в dev/shots.js разъедется.
 * ========================================================================== */

import { spawnTracer } from '../fx/tracers.js'
import { scratchTarget } from '../render/scratchTarget.js'

/** Сколько трассеров прогнать, чтобы пул частиц вырос до боевого размера. */
const TRACER_WARM_SHOTS = 24

/** Какую долю стадии «ландшафт» занимает выпечка материалов на ползунке. */
const BAKE_PROGRESS_SHARE = 0.7

/** Состояние, которым кормим Viewmodel.update() на прогреве. */
const WARM_VM_STATES = [
	{ ads: false, sprint: false, lowReady: false, speed: 0, crouch: false, airborne: false, trigger: false, empty: false },
	{ ads: true, sprint: false, lowReady: false, speed: 0, crouch: false, airborne: false, trigger: true, empty: false },
	{ ads: false, sprint: true, lowReady: false, speed: 5.4, crouch: false, airborne: false, trigger: false, empty: true }
]

const STAGES = [
	{ id: 'profile', label: 'ЗАГРУЗКА ДАННЫХ ПРОФИЛЯ' },
	{ id: 'terrain', label: 'ПОДГОТОВКА ЛАНДШАФТА' },
	{ id: 'shaders', label: 'КОМПИЛЯЦИЯ ШЕЙДЕРНЫХ КОНВЕЙЕРОВ' },
	{ id: 'weapons', label: 'ИНСТАНЦИРОВАНИЕ МОДЕЛЕЙ ОРУЖИЯ' },
	{ id: 'tracers', label: 'РЕЗЕРВИРОВАНИЕ ПУЛА ТРАССЕРОВ' },
	{ id: 'loadout', label: 'СИНХРОНИЗАЦИЯ СНАРЯЖЕНИЯ' },
	{ id: 'deploy', label: 'ВЫСАДКА НА МЕСТО ДИСЛОКАЦИИ' }
]

export const PREWARM_STAGES = STAGES

function sys(engine, id) {
	const ctx = engine && engine.ctx
	if (!ctx || typeof ctx.peek !== 'function') return null
	try {
		return ctx.peek(id) || null
	} catch (err) {
		return null
	}
}

function nextFrame() {
	if (typeof requestAnimationFrame === 'function') {
		return new Promise((resolve) => requestAnimationFrame(() => resolve()))
	}
	return new Promise((resolve) => setTimeout(resolve, 16))
}

function clamp01(t) {
	const v = Number(t)
	if (!Number.isFinite(v)) return 0
	if (v < 0) return 0
	if (v > 1) return 1
	return v
}

/**
 * Снимок всего, что прогрев может сдвинуть. Возвращает функцию отката.
 *
 * Камера входит в снимок: компиляция кадра идёт из позы игрока, а вьюмодель
 * с trackCamera = true перепишет anchor из камеры на первом же update().
 */
function snapshot(engine) {
	const cam = engine.camera
	const t = engine.time
	const r = engine.rng
	const saved = {
		pos: cam ? cam.position.clone() : null,
		quat: cam ? cam.quaternion.clone() : null,
		fov: cam ? cam.fov : 0,
		elapsed: t ? t.elapsed : 0,
		raw: t ? t.raw : 0,
		dt: t ? t.dt : 0,
		alpha: t ? t.alpha : 0,
		frame: t ? t.frame : 0,
		s0: r ? r.s0 : 0,
		s1: r ? r.s1 : 0,
		s2: r ? r.s2 : 0,
		s3: r ? r.s3 : 0,
		spare: r ? r._spare : null,
		accum: engine._accum
	}
	return function restore() {
		if (cam && saved.pos) {
			cam.position.copy(saved.pos)
			cam.quaternion.copy(saved.quat)
			cam.fov = saved.fov
			cam.updateProjectionMatrix()
			cam.updateMatrixWorld(true)
		}
		if (t) {
			t.elapsed = saved.elapsed
			t.raw = saved.raw
			t.dt = saved.dt
			t.alpha = saved.alpha
			t.frame = saved.frame
		}
		if (r) {
			r.s0 = saved.s0
			r.s1 = saved.s1
			r.s2 = saved.s2
			r.s3 = saved.s3
			r._spare = saved.spare
		}
		engine._accum = saved.accum
		engine._last = performance.now()
	}
}

/**
 * Одна сцена, асинхронно.
 *
 * renderer.compile() линкует все программы сцены в текущем кадре: на карте
 * рейда это те самые 2443ms в одном rAF-обработчике. compileAsync() отдаёт
 * промис и опрашивает KHR_parallel_shader_compile, поэтому браузер успевает
 * нарисовать экран загрузки между программами. Синхронный compile() остаётся
 * запасным путём для three без compileAsync и для headless-харнесса.
 */
async function compileScene(renderer, scene, camera) {
	if (!scene || !camera) return false
	if (typeof renderer.compileAsync === 'function') {
		await renderer.compileAsync(scene, camera)
		return true
	}
	renderer.compile(scene, camera)
	return true
}

/**
 * Компиляция обеих сцен с ПРИВЯЗАННЫМ render target.
 *
 * three складывает outputColorSpace и toneMapping в ключ кэша программы и
 * читает оба с текущей цели. С привязанным канвасом компилируются srgb +
 * tonemapped варианты, а мир и вьюмодель рисуются в HDR-таргеты, которым
 * нужны srgb-linear + NoToneMapping. Мерено в core/prewarm.js: без этого
 * половина прогретых программ — мусор. Хватает цели 1x1.
 *
 * Цель больше НЕ создаётся здесь. Она принадлежит RenderSystem и переживает
 * всю сессию: раньше на одну высадку приходилось N+2 пары new/dispose, то
 * есть N+2 создания и удаления FBO в драйвере посреди кадра прогрева.
 *
 * Ошибка компиляции не бросается наружу: прогрев стоит между экраном высадки
 * и STATE.GAMEPLAY, и исключение отсюда навсегда вешало бы загрузку. Она
 * уезжает в сводку.
 */
async function compileScenes(engine, render, renderer) {
	const out = { ok: true, world: false, view: false }
	const scratch = scratchTarget(render)
	const prevRt = renderer.getRenderTarget()
	const prevFace = typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0
	const prevMip = typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0
	try {
		if (scratch) renderer.setRenderTarget(scratch)
		try {
			out.world = await compileScene(renderer, engine.scene, engine.camera)
		} catch (err) {
			out.ok = false
			out.world = String((err && err.message) || err)
		}
		try {
			out.view = await compileScene(renderer, engine.viewScene, engine.viewCamera)
		} catch (err) {
			out.ok = false
			out.view = String((err && err.message) || err)
		}
	} finally {
		renderer.setRenderTarget(prevRt, prevFace, prevMip)
	}
	return out
}

/**
 * Выпечка текстур библиотеки материалов покадрово.
 *
 * Идёт ДО world.buildMap(): карта должна собираться по готовым наборам, а не
 * заказывать выпечку по одной поверхности посреди сборки геометрии. Прогресс
 * уходит прямо в ползунок визарда — это и есть замена «мёртвых» семи секунд.
 */
async function bakeMaterials(engine, onProgress) {
	const materials = sys(engine, 'materials')
	if (!materials || typeof materials.bakeAll !== 'function') {
		return { ok: false, reason: 'no materials system' }
	}
	const names = typeof materials.names === 'function' ? materials.names() : []
	const out = { ok: true, baked: 0, cached: 0, total: names.length, ms: 0, slowest: '' }
	if (!names.length) return out

	const t0 = performance.now()
	let worst = 0
	for await (const step of materials.bakeAll(names, { onProgress })) {
		out.baked++
		if (step.cached) out.cached++
		if (step.ms > worst) {
			worst = step.ms
			out.slowest = step.name
		}
	}
	out.ms = Math.round(performance.now() - t0)
	out.slowestMs = Math.round(worst)
	return out
}

/**
 * Прогон КАЖДОГО набора вьюмодели через setActive + update.
 *
 * Именно это ловит стоп при первой смене ствола: группа оружия создаётся
 * скрытой (group.visible = false в addWeapon), поэтому её материалы
 * компилируются только когда она впервые попадает в кадр. Активный ствол
 * восстанавливается в конце, чтобы игрок вошёл в рейд с тем, что выбрал.
 */
async function warmViewmodels(engine, render, renderer) {
	const weapons = sys(engine, 'weapons')
	const vm = weapons && weapons.viewmodel
	if (!vm || !vm.weapons || typeof vm.setActive !== 'function') return { ok: false, reason: 'no viewmodel' }

	const wasActive = vm.active ? vm.active.id : null
	const wasTrack = vm.trackCamera
	let warmed = 0

	/* trackCamera выключаем: прогрев не имеет права переставлять viewCamera. */
	vm.trackCamera = false
	try {
		const ids = Array.from(vm.weapons.keys())
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i]
			try {
				vm.setActive(id)
				for (let k = 0; k < WARM_VM_STATES.length; k++) {
					vm.update(1 / 60, WARM_VM_STATES[k])
				}
				const entry = vm.weapons.get(id)
				if (entry && entry.group) entry.group.updateMatrixWorld(true)
				await compileScenes(engine, render, renderer)
				warmed++
			} catch (err) {
				/* один набор мешей не должен валить остальные */
			}
			await nextFrame()
		}
	} finally {
		vm.trackCamera = wasTrack
		try {
			if (wasActive) vm.setActive(wasActive)
		} catch (err) {
			/* ствол вернёт loadoutSync на входе в рейд */
		}
	}
	return { ok: true, warmed }
}

/**
 * Пре-пул трассеров и снарядов.
 *
 * spawnTracer() кладёт в пул три спрайта на выстрел (ядро, послесвечение,
 * раскалённая голова), поэтому пул растёт втрое быстрее числа выстрелов и
 * первая очередь в матче гарантированно упиралась в реаллокацию. Трассеры
 * рождаются далеко за пределами карты и с нулевым временем жизни, поэтому
 * ни один из них не успевает попасть в кадр; следом пулы чистятся.
 */
async function warmTracers(engine) {
	const fx = sys(engine, 'fx')
	const weapons = sys(engine, 'weapons')
	let tracers = 0

	if (fx && typeof fx.emitAdd === 'function' && fx.rng) {
		const from = { x: 0, y: -4000, z: 0 }
		const to = { x: 0, y: -4000, z: -120 }
		const dir = { x: 0, y: 0, z: -1 }
		for (let i = 0; i < TRACER_WARM_SHOTS; i++) {
			try {
				spawnTracer(fx, from, to, 300 + i * 12, { dir, warm: 1 })
				tracers += 3
			} catch (err) {
				break
			}
		}
	}

	/* Снаряды: ProjectileSim держит свой пул, чистится штатным clear(). */
	if (weapons && weapons.projectiles && typeof weapons.projectiles.clear === 'function') {
		try {
			weapons.projectiles.clear()
		} catch (err) {
			/* пул мог быть ещё не собран */
		}
	}

	await nextFrame()

	/* Гасим всё, что налили: экран высадки не должен получить ни одной искры. */
	if (fx) {
		try {
			if (typeof fx.clear === 'function') fx.clear()
			else if (typeof fx.reset === 'function') fx.reset()
		} catch (err) {
			/* необязательный хук */
		}
	}
	return { ok: true, tracers }
}

/**
 * Хуки prewarmMaterials() подсистем.
 *
 * render идёт первым намеренно: он патчит все освещённые материалы
 * инъекцией CSM/AO/SSR, и программа, скомпилированная с непропатченного
 * материала, выбрасывается первым же кадром, который обходит сцену.
 * fx пропускаем — он греется сам на втором отрисованном кадре, и вызов
 * отсюда защёлкнул бы его флаг _warmed на неверной перестановке светов.
 */
async function runMaterialHooks(engine) {
	const out = {}
	const registry = engine.registry
	const renderSys = registry && typeof registry.peek === 'function' ? registry.peek('render') : null
	const hooks = []
	if (renderSys && typeof renderSys.prewarmMaterials === 'function') hooks.push(renderSys)
	const ordered = (registry && registry.ordered) || []
	for (let i = 0; i < ordered.length; i++) {
		const s = ordered[i]
		if (!s || s === renderSys) continue
		const id = s.constructor && s.constructor.id
		if (id === 'fx') continue
		if (typeof s.prewarmMaterials === 'function') hooks.push(s)
	}
	for (let i = 0; i < hooks.length; i++) {
		const s = hooks[i]
		const id = (s.constructor && s.constructor.id) || '?'
		try {
			const arg = s === renderSys ? { post: true, shadow: false } : engine.ctx
			out[id] = (await s.prewarmMaterials(arg)) || { ok: true }
		} catch (err) {
			out[id] = { ok: false, reason: String((err && err.message) || err) }
		}
		await nextFrame()
	}
	return out
}

/**
 * Полный прогон прогрева.
 *
 * @param engine                движок
 * @param opts.onStage(id,label,index,total)  для текстового лоадера визарда
 * @param opts.onProgress(t)    0..1 для ползунка
 * @param opts.afterTerrain     await-колбэк между «ландшафтом» и «шейдерами»:
 *                              сюда визард вставляет engine.startRaid(), чтобы
 *                              шейдеры компилировались по УЖЕ собранной карте
 * @returns сводка, никогда не бросает
 */
export async function runRaidPrewarm(engine, opts) {
	const o = opts || {}
	const onStage = typeof o.onStage === 'function' ? o.onStage : () => {}
	const rawProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {}
	const onProgress = (t) => rawProgress(clamp01(t))
	const t0 = performance.now()
	const summary = { ok: false, ms: 0, stages: {}, compiled: 0, tracers: 0, weapons: 0, baked: 0 }

	if (!engine) return summary

	const render = sys(engine, 'render')
	const renderer = render && render.renderer
	const restore = snapshot(engine)
	const programsBefore = renderer && renderer.info && renderer.info.programs ? renderer.info.programs.length : 0

	const total = STAGES.length
	let index = 0
	const enter = async (id) => {
		const stage = STAGES.find((s) => s.id === id) || { id, label: id }
		const at = index
		onStage(stage.id, stage.label, at, total)
		onProgress(at / total)
		index++
		await nextFrame()
		return { id: stage.id, label: stage.label, base: at / total, slice: 1 / total }
	}

	try {
		/* 1. Профиль и снаряжение — до постройки мира, дешёвая стадия. */
		await enter('profile')
		const inv = sys(engine, 'inventory')
		summary.stages.profile = { ok: !!inv, items: inv && inv.all ? inv.all.length : 0 }

		/* 2. Ландшафт: сначала покадровая выпечка материалов, потом колбэк
		 *    визарда, который строит карту рейда. Порядок принципиален —
		 *    buildMap() должен получить уже готовые наборы текстур. */
		const terrain = await enter('terrain')
		const bake = await bakeMaterials(engine, (t) => {
			onProgress(terrain.base + terrain.slice * BAKE_PROGRESS_SHARE * clamp01(t))
		})
		summary.stages.materials = bake
		summary.baked = bake.baked || 0
		onProgress(terrain.base + terrain.slice * BAKE_PROGRESS_SHARE)

		if (typeof o.afterTerrain === 'function') {
			try {
				summary.stages.terrain = (await o.afterTerrain()) || { ok: true }
			} catch (err) {
				summary.stages.terrain = { ok: false, reason: String((err && err.message) || err) }
				throw err
			}
		} else {
			summary.stages.terrain = { ok: true, skipped: true }
		}

		/* 3. Шейдеры: хуки подсистем + асинхронная компиляция обеих сцен. */
		await enter('shaders')
		if (renderer) {
			summary.stages.shaders = await runMaterialHooks(engine)
			summary.stages.shaders.compile = await compileScenes(engine, render, renderer)
		} else {
			summary.stages.shaders = { ok: false, reason: 'no renderer' }
		}

		/* 4. Меши оружия. */
		await enter('weapons')
		if (renderer) {
			const res = await warmViewmodels(engine, render, renderer)
			summary.stages.weapons = res
			summary.weapons = res.warmed || 0
		} else {
			summary.stages.weapons = { ok: false, reason: 'no renderer' }
		}

		/* 5. Пул трассеров. */
		await enter('tracers')
		const tr = await warmTracers(engine)
		summary.stages.tracers = tr
		summary.tracers = tr.tracers || 0

		/* 6. Снаряжение в руки: сюда встаёт weapons/loadoutSync. */
		await enter('loadout')
		const weapons = sys(engine, 'weapons')
		if (weapons && typeof weapons.syncLoadout === 'function') {
			try {
				summary.stages.loadout = weapons.syncLoadout({ reason: 'prewarm' }) || { ok: true }
			} catch (err) {
				summary.stages.loadout = { ok: false, reason: String((err && err.message) || err) }
			}
		} else if (weapons && typeof weapons._syncFromInventory === 'function') {
			try {
				weapons._syncFromInventory()
				summary.stages.loadout = { ok: true, legacy: true }
			} catch (err) {
				summary.stages.loadout = { ok: false, reason: String((err && err.message) || err) }
			}
		} else {
			summary.stages.loadout = { ok: false, reason: 'no weapons system' }
		}

		/* 7. Последняя компиляция уже с реальным стволом в руках. */
		await enter('deploy')
		if (renderer) summary.stages.deploy = await compileScenes(engine, render, renderer)
		else summary.stages.deploy = { ok: true, skipped: true }

		onProgress(1)
		summary.ok = true
	} catch (err) {
		summary.ok = false
		summary.reason = String((err && err.message) || err)
		if (typeof console !== 'undefined') console.error('[EFL/prewarm] прогрев рейда упал', err)
	} finally {
		restore()
		const programsAfter = renderer && renderer.info && renderer.info.programs ? renderer.info.programs.length : 0
		summary.compiled = programsAfter - programsBefore
		summary.ms = Math.round(performance.now() - t0)
		engine.__eflRaidPrewarm = summary
	}

	return summary
}

export default runRaidPrewarm
