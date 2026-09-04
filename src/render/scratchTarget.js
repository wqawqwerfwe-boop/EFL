/* ==========================================================================
 * Escape-From-Larpov · src/render/scratchTarget.js
 *
 * The 1x1 compile target, owned by RenderSystem for the life of the engine.
 *
 * ЗАЧЕМ. three складывает outputColorSpace и toneMapping в ключ кэша
 * программы и читает оба с ТЕКУЩЕЙ цели рендера. С привязанным канвасом
 * прогреваются srgb + tonemapped варианты, а мир и вьюмодель рисуются в
 * HDR-таргеты, которым нужны srgb-linear + NoToneMapping, — половина
 * прогретых программ уходила в мусор. Хватает цели 1x1.
 *
 * Раньше эта цель создавалась и уничтожалась ВНУТРИ compileScenes(), то есть
 * N+2 раза за одну высадку (по разу на каждый набор вьюмодели плюс стадии
 * shaders и deploy). Каждая пара allocate/dispose — это создание и удаление
 * FBO с текстурой в драйвере посреди кадра прогрева, и именно эти вызовы
 * стояли в 4506ms/2443ms нарушениях rAF рядом с самой компиляцией.
 *
 * Теперь цель одна на весь сеанс: создаётся лениво при первой компиляции,
 * висит на экземпляре RenderSystem и освобождается ТОЛЬКО на разборке
 * движка (Engine.dispose()). 1x1 без depth и stencil — это несколько байт
 * VRAM, держать её дешевле любой пересборки.
 * ========================================================================== */

import * as THREE from 'three'

/** Единственное место, где живёт ссылка. Не перечисляемое имя, не свойство API. */
const KEY = '__eflScratchTarget'

/**
 * Ленивая 1x1 цель компиляции, принадлежащая RenderSystem.
 *
 * @param {object} owner экземпляр RenderSystem (ctx.peek('render'))
 * @returns {THREE.WebGLRenderTarget|null} null — владельца нет
 */
export function scratchTarget(owner) {
	if (!owner || typeof owner !== 'object') return null
	const existing = owner[KEY]
	if (existing) return existing
	const rt = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false })
	rt.texture.name = 'efl.scratch.compile.1x1'
	Object.defineProperty(owner, KEY, { value: rt, writable: true, configurable: true, enumerable: false })
	return rt
}

/** Есть ли уже выделенная цель. Нужно тестам и оверлею статистики. */
export function hasScratchTarget(owner) {
	return !!(owner && owner[KEY])
}

/**
 * Освобождение. Зовётся РОВНО из Engine.dispose(), не из прогрева и не между
 * рейдами: смысл этого модуля в том, что цель переживает высадку.
 *
 * @returns {boolean} true — цель была и освобождена
 */
export function disposeScratchTarget(owner) {
	if (!owner || typeof owner !== 'object') return false
	const rt = owner[KEY]
	if (!rt) return false
	owner[KEY] = null
	if (typeof rt.dispose === 'function') rt.dispose()
	return true
}

export default scratchTarget
