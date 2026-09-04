/**
 * Agent voice layer - spatial call-outs synthesised through the existing pipeline.
 *
 * This is a layer, not a synthesiser. `src/audio/vox.js` already builds barks
 * from a formant/tract model; what it needs and does not have is somewhere to
 * play them. `AudioSystem.play()` can only fire pre-rendered buffers out of its
 * bank, so a live bark cannot go through it. So this module owns the small
 * amount of plumbing in between: a white-noise source bank of the shape vox.js
 * expects, a pool of spatial channels wired into the mixer's public `dry` and
 * `reverbIn` nodes, one occlusion ray per bark, and the cooldowns that stop a
 * six-man squad screaming over each other.
 *
 * A line is text plus a rhythm. `text` is the literal phrase ('Кепка!',
 * 'Contact front!') and rides on the `ai:voice` event for subtitles and for the
 * debug overlay. `shape` is a compact syllable string that drives the formant
 * sequence, so what you hear has the cadence and stress of the phrase even
 * though vox.js is a barker rather than a TTS. Tokens are an optional onset
 * (p/f/n) plus a vowel key from vox.js's VOWELS table, '!' marks a stressed
 * syllable and '|' a word break.
 *
 * Nothing here is required for the game to run: every entry point degrades to
 * the pre-rendered bank, and then to silence, without throwing.
 */

import { bark, barkFor } from '../audio/vox.js'
import { clamp } from '../core/tarkovUtils.js'

/**
 * How far each kind of call-out carries, in metres. Squad.callOut() takes this
 * straight into hear(pos, loudness), so these numbers are the actual radius at
 * which a squadmate can learn something - not a mixer volume.
 */
export const CALL_RANGE = Object.freeze({
	spotEnemy: 36,
	takingFire: 26,
	reloading: 15,
	death: 30,
	grenade: 42,
	flank: 20,
	advance: 22,
	hurt: 18,
	copy: 14,
})

/** Minimum seconds between two lines of the same kind from one actor. */
const COOLDOWN = Object.freeze({
	spotEnemy: 6,
	takingFire: 4.5,
	reloading: 3,
	death: 0,
	grenade: 8,
	flank: 7,
	advance: 6,
	hurt: 3.5,
	copy: 5,
})

/** vox.js bark ids, so an unmapped event still produces the right texture. */
const BARK_KIND = Object.freeze({
	spotEnemy: 'spot',
	takingFire: 'suppress',
	reloading: 'reload',
	death: 'death',
	grenade: 'grenade',
	flank: 'flank',
	advance: 'advance',
	hurt: 'hurt',
	copy: 'copy',
})

/* ------------------------------------------------------------------ *
 * lines
 * ------------------------------------------------------------------ */

const SCAV = {
	spotEnemy: [
		{ text: 'Кепка!', shape: 'pe! | pa' },
		{ text: 'Вижу его!', shape: 'vi! | zhu | ye | vo' },
		{ text: 'Он здесь!', shape: 'ohh! | pzye!' },
		{ text: 'Стой, кто идёт!', shape: 'fo! | pto | i | pyo!' },
	],
	takingFire: [
		{ text: 'Стреляют!', shape: 'ftre! | lya | yut' },
		{ text: 'Ложись!', shape: 'la | zhi!' },
		{ text: 'Он бьёт по нам!', shape: 'ohh | pyo! | pa | na!' },
	],
	reloading: [
		{ text: 'Перезаряжаюсь!', shape: 'pe | re | za | rya! | zha | yus' },
		{ text: 'Пусто!', shape: 'pu! | fta' },
	],
	death: [
		{ text: 'А-а-а!', shape: 'ah! | ah | a', dying: true },
		{ text: 'Всё...', shape: 'fsyo', dying: true },
	],
	grenade: [{ text: 'Граната!', shape: 'pra | na! | ta' }],
	flank: [{ text: 'Обходи слева!', shape: 'ob | ha | pi! | fle | va' }],
	advance: [{ text: 'Вперёд!', shape: 'fpe | ryo!' }],
	hurt: [{ text: 'Больно!', shape: 'pol! | na' }],
	copy: [{ text: 'Понял!', shape: 'po! | nyal' }],
}

const RAIDER = {
	spotEnemy: [
		{ text: 'Contact front!', shape: 'pon! | takt | fru! | nt' },
		{ text: 'Tango spotted, engaging!', shape: 'pah! | ngo | fpo! | ted | en | pey! | jing' },
		{ text: 'Eyes on target!', shape: 'ah! | i | on | pah! | pet' },
	],
	takingFire: [
		{ text: 'Taking fire!', shape: 'pey! | king | fah! | er' },
		{ text: 'Pinned down, need suppression!', shape: 'pin! | d | pow! | n | ni | pre! | shun' },
	],
	reloading: [
		{ text: 'Reloading, cover me!', shape: 'ri | poh! | ding | pu! | ver | mi' },
		{ text: 'Dry, swapping mags!', shape: 'prah! | fwo! | ping | pa | ps' },
	],
	death: [
		{ text: 'Man down!', shape: 'pa! | n | pow!', dying: true },
		{ text: 'Aagh!', shape: 'ah! | ehr', dying: true },
	],
	grenade: [{ text: 'Frag out!', shape: 'fra! | g | pow!' }],
	flank: [{ text: 'Flanking right, moving!', shape: 'fla! | nking | rah! | t | pu! | ving' }],
	advance: [{ text: 'Push up, push up!', shape: 'pu! | sh | pup | pu! | sh | pup' }],
	hurt: [{ text: "I'm hit!", shape: 'ah! | m | pi!' }],
	copy: [{ text: 'Copy that.', shape: 'po | pi | pat' }],
}

/* USEC read the same book as the raiders but with less shouting in it. */
const USEC = {
	spotEnemy: [
		{ text: 'Contact, front!', shape: 'pon! | takt | fru! | nt' },
		{ text: 'Got eyes on him.', shape: 'pot | ah! | on | pim' },
		{ text: 'Hostile, twelve o’clock!', shape: 'po! | ftail | pwe! | lv | pluk' },
	],
	takingFire: [
		{ text: 'Contact, taking rounds!', shape: 'pon! | takt | pey! | king | rah! | nds' },
		{ text: 'Suppressed, need a break!', shape: 'su | pre! | st | ni | pey! | k' },
	],
	reloading: [
		{ text: 'Reloading, cover.', shape: 'ri | poh! | ding | pu! | ver' },
		{ text: 'Mag out.', shape: 'pa! | g | pow!' },
	],
	death: [
		{ text: 'Aagh — no...', shape: 'ah! | ehr | poh', dying: true },
		{ text: 'I’m down!', shape: 'ah! | m | pow!', dying: true },
	],
	grenade: [{ text: 'Grenade out!', shape: 'pre | pey! | d | pow!' }],
	flank: [{ text: 'Moving wide, hold him.', shape: 'pu! | ving | pwah! | d | pol! | d' }],
	advance: [{ text: 'Moving up.', shape: 'pu! | ving | pup' }],
	hurt: [{ text: 'I’m hit, still up.', shape: 'ah! | m | pi! | ftil | pup' }],
	copy: [{ text: 'Solid copy.', shape: 'po! | lid | po | pi' }],
}

/* BEAR speak Russian, but with a radio and none of the panic. */
const BEAR = {
	spotEnemy: [
		{ text: 'Контакт, впереди!', shape: 'pon! | takt | fpe | re | pi!' },
		{ text: 'Цель вижу.', shape: 'pel! | vi | zhu' },
	],
	takingFire: [
		{ text: 'Работают по мне!', shape: 'ra | po! | ta | yut | pa | mnye!' },
		{ text: 'Прижали!', shape: 'pri | zha! | li' },
	],
	reloading: [
		{ text: 'Меняю магазин, прикрой!', shape: 'me | nya! | yu | ma | ga | zi! | n | pri | proy!' },
		{ text: 'Пустой!', shape: 'pu | ftoy!' },
	],
	death: [
		{ text: '三... минус.', shape: 'ah! | mi | nus', dying: true },
		{ text: 'Ранен... тяжело...', shape: 'ra! | nyen | tya | zhe | poh', dying: true },
	],
	grenade: [{ text: 'Граната пошла!', shape: 'pra | na! | ta | pa | shla!' }],
	flank: [{ text: 'Захожу справа!', shape: 'za | ha | zhu! | fpra | va' }],
	advance: [{ text: 'Работаем, вперёд!', shape: 'ra | po! | ta | yem | fpe | ryo!' }],
	hurt: [{ text: 'Меня зацепило!', shape: 'me | nya! | za | tse | pi! | la' }],
	copy: [{ text: 'Принял.', shape: 'pri! | nyal' }],
}

const BOSS = {
	spotEnemy: [
		{ text: 'Ага, гость!', shape: 'a | pa! | poh! | ft' },
		{ text: 'Ну иди сюда!', shape: 'nu | i | pi! | syu | pa!' },
	],
	takingFire: [{ text: 'Щекотно!', shape: 'she | po! | tna' }],
	reloading: [{ text: 'Ждать!', shape: 'zhda! | t' }],
	death: [{ text: 'Нет... не так...', shape: 'nye! | t | nye | pak', dying: true }],
	grenade: [{ text: 'Держи подарок!', shape: 'per | zhi! | pa | pa! | rak' }],
	flank: [{ text: 'Не уйдёшь!', shape: 'nye | uy | pyo! | sh' }],
	advance: [{ text: 'Вперёд, все!', shape: 'fpe | ryo! | fsye' }],
	hurt: [{ text: 'Мелочь!', shape: 'pye! | lach' }],
	copy: [{ text: 'Слышу.', shape: 'fli! | shu' }],
}

export const VOICE_BANKS = Object.freeze({
	scav: SCAV,
	raider: RAIDER,
	usec: USEC,
	bear: BEAR,
	boss: BOSS,
})

/**
 * Voice character per bank. Scavs are shouting with no radio and a lot of
 * breath; raiders and PMCs are compressed and clipped over comms; the boss is
 * an octave lower than anyone else.
 */
const CHARACTER = Object.freeze({
	scav: { f0: 118, drive: 0.62, breath: 0.34, tremolo: 0.16, radio: false, level: 1 },
	raider: { f0: 102, drive: 0.44, breath: 0.16, tremolo: 0.06, radio: true, level: 0.92 },
	usec: { f0: 108, drive: 0.4, breath: 0.14, tremolo: 0.05, radio: true, level: 0.9 },
	bear: { f0: 96, drive: 0.5, breath: 0.18, tremolo: 0.07, radio: true, level: 0.94 },
	boss: { f0: 82, drive: 0.7, breath: 0.22, tremolo: 0.1, radio: false, level: 1.1 },
})

/** Vowel keys vox.js knows. Anything else in a shape falls back to 'a'. */
const VOWEL_KEYS = ['a', 'e', 'i', 'o', 'u', 'ah', 'ehr', 'ohh']

const BASE_SYLLABLE = 0.13

/**
 * Turn a shape string into the syllable array vox.js consumes.
 * 'pe! | pa' -> a stressed 'e' with a plosive onset, a word gap, then 'a'.
 */
function parseShape(shape) {
	const out = []
	if (!shape) return out
	const words = String(shape).split('|')
	for (let w = 0; w < words.length; w++) {
		const tokens = words[w].trim().split(/\s+/)
		for (let t = 0; t < tokens.length; t++) {
			const raw = tokens[t]
			if (!raw) continue
			const stressed = raw.indexOf('!') >= 0
			let body = raw.replace(/!/g, '').toLowerCase()
			let onset = ''
			if (body.length > 1 && (body[0] === 'p' || body[0] === 'f' || body[0] === 'n')) {
				onset = body[0]
				body = body.slice(1)
			}
			let vowel = 'a'
			for (let i = 0; i < VOWEL_KEYS.length; i++) {
				const k = VOWEL_KEYS[i]
				if (body.indexOf(k) === 0 && k.length > vowel.length) vowel = k
				else if (body.indexOf(k) === 0 && vowel === 'a' && k !== 'a') vowel = k
			}
			if (body.length && VOWEL_KEYS.indexOf(body) >= 0) vowel = body
			out.push({
				v: vowel,
				d: BASE_SYLLABLE * (stressed ? 1.5 : 1),
				a: stressed ? 1 : 0.66,
				p: stressed ? 1.12 : 0.94,
				on: onset,
				g: t === tokens.length - 1 && w < words.length - 1 ? 0.075 : 0.012,
			})
		}
	}
	return out
}

/**
 * The noise bank vox.js expects: `source(kind, rng, rate)` returning a node
 * carrying `._offset`. AudioSystem has no such accessor, so build one small
 * looping buffer and hand out sources from it.
 */
function makeNoiseBank(actx) {
	const len = Math.max(1, Math.floor(actx.sampleRate * 2))
	const buf = actx.createBuffer(1, len, actx.sampleRate)
	const d = buf.getChannelData(0)
	let s = 0x2545f491
	for (let i = 0; i < len; i++) {
		s ^= s << 13
		s ^= s >>> 17
		s ^= s << 5
		d[i] = ((s >>> 0) / 2147483648 - 1) * 0.9
	}
	return {
		white: buf,
		noise: buf,
		source(kind, rng, rate) {
			const src = actx.createBufferSource()
			src.buffer = buf
			src.loop = true
			if (Number.isFinite(rate) && rate > 0) src.playbackRate.value = rate
			src._offset = (rng && typeof rng.float === 'function' ? rng.float() : Math.random()) * 1.8
			return src
		},
	}
}

function pickLine(bankName, event, rng) {
	const bank = VOICE_BANKS[bankName] || SCAV
	const list = bank[event] || SCAV[event]
	if (!list || list.length === 0) return null
	const r = rng && typeof rng.float === 'function' ? rng.float() : Math.random()
	return list[Math.min(list.length - 1, Math.floor(r * list.length))]
}

/** Concurrency cap. Three voices is a firefight; six is a crowd scene. */
const MAX_CONCURRENT = 3
const MIN_SPACING = 0.12
const CHANNELS = 6

const MUFFLE_HZ = 700
const OPEN_HZ = 15000
const MUFFLE_GAIN = 0.45

export class VoiceLayer {
	constructor(ctx) {
		this.ctx = ctx || null
		this.audio = null
		this.phys = null
		this.bus = null
		this.actx = null
		this.bank = null
		this.channels = []
		this.cursor = 0
		this.active = 0
		this.lastAt = -99
		this.cooldowns = new WeakMap()
		this.enabled = true
		this.time = 0
		this._failed = false
	}

	init() {
		if (this.actx || this._failed) return this.actx !== null
		const ctx = this.ctx
		if (!ctx) return false
		const audio =
			ctx.audio || (typeof ctx.get === 'function' ? ctx.get('audio') : null) || (ctx.systems ? ctx.systems.audio : null)
		if (!audio || !audio.actx) return false
		this.audio = audio
		this.actx = audio.actx
		this.bus = ctx.bus || null
		this.phys = ctx.physics || (typeof ctx.get === 'function' ? ctx.get('physics') : null)
		try {
			this.bank = makeNoiseBank(this.actx)
			const dest = audio.dry || audio.master || this.actx.destination
			for (let i = 0; i < CHANNELS; i++) {
				const input = this.actx.createGain()
				const lp = this.actx.createBiquadFilter()
				lp.type = 'lowpass'
				lp.frequency.value = OPEN_HZ
				const panner = this.actx.createPanner()
				panner.panningModel = 'HRTF'
				panner.distanceModel = 'inverse'
				panner.refDistance = 4
				panner.rolloffFactor = 1.1
				panner.maxDistance = 140
				const gain = this.actx.createGain()
				gain.gain.value = 1
				input.connect(lp)
				lp.connect(panner)
				panner.connect(gain)
				gain.connect(dest)
				let send = null
				if (audio.reverbIn) {
					send = this.actx.createGain()
					send.gain.value = 0
					gain.connect(send)
					send.connect(audio.reverbIn)
				}
				this.channels.push({ input, lp, panner, gain, send, busyUntil: -1 })
			}
		} catch (err) {
			this._failed = true
			this.actx = null
			return false
		}
		return true
	}

	_channel(now) {
		for (let i = 0; i < this.channels.length; i++) {
			const c = this.channels[(this.cursor + i) % this.channels.length]
			if (c.busyUntil <= now) {
				this.cursor = (this.cursor + i + 1) % this.channels.length
				return c
			}
		}
		return null
	}

	/** One ray from the listener to the mouth. Blocked means muffled, not silent. */
	_occluded(pos) {
		const phys = this.phys
		if (!phys || typeof phys.lineOfSight !== 'function') return false
		const field = this.audio && this.audio.field ? this.audio.field : null
		const from = field && field.listenerPos ? field.listenerPos : null
		if (!from) return false
		try {
			const mask = phys.MASK && phys.MASK.SIGHT !== undefined ? phys.MASK.SIGHT : 1
			return !phys.lineOfSight(from, pos, mask)
		} catch (err) {
			return false
		}
	}

	/**
	 * Speak.
	 *
	 * Returns the range in metres the call carries, or 0 if nothing was said -
	 * cooldown, no channel, no audio. The caller uses the return value to drive
	 * propagation, so a line that was never spoken alerts nobody.
	 */
	say(agent, event, opts = {}) {
		if (!this.enabled) return 0
		const range = CALL_RANGE[event] === undefined ? 20 : CALL_RANGE[event]
		if (!agent) return 0

		const now = this.time
		let slots = this.cooldowns.get(agent)
		if (!slots) {
			slots = {}
			this.cooldowns.set(agent, slots)
		}
		const gate = COOLDOWN[event] === undefined ? 4 : COOLDOWN[event]
		if (opts.force !== true && slots[event] !== undefined && now - slots[event] < gate) return 0
		slots[event] = now

		const voice = agent.voice || null
		const bankName = (opts.bank || (voice && voice.bank) || 'scav').toLowerCase()
		const rng = agent.rng || opts.rng || null
		const line = pickLine(bankName, event, rng)
		const pos =
			opts.position || (agent.eye ? agent.eye : agent.root ? agent.root.position : agent.position) || null
		const character = CHARACTER[bankName] || CHARACTER.scav
		const radio = voice && voice.radio !== undefined ? !!voice.radio : character.radio

		// Announce before making any sound: subtitles, the debug overlay and the
		// squad's propagation all key off this and must fire even if the actx is
		// suspended because the player has not clicked yet.
		if (this.bus && typeof this.bus.emit === 'function') {
			this.bus.emit('ai:voice', {
				actor: agent,
				event,
				text: line ? line.text : '',
				bank: bankName,
				position: pos,
				range,
				radio,
			})
		}

		if (!this.init()) return range
		if (this.audio && typeof this.audio.resume === 'function') this.audio.resume()
		if (this.actx.state === 'suspended') return range

		const t = this.actx.currentTime
		if (this.active >= MAX_CONCURRENT || t - this.lastAt < MIN_SPACING) return range
		const chan = this._channel(t)
		if (!chan) return range

		const f0Min = voice && Number.isFinite(voice.f0Min) ? voice.f0Min : character.f0 * 0.9
		const f0Max = voice && Number.isFinite(voice.f0Max) ? voice.f0Max : character.f0 * 1.1
		const pick = rng && typeof rng.float === 'function' ? rng.float() : Math.random()
		const f0 = f0Min + pick * (f0Max - f0Min)
		const syllables = line ? parseShape(line.shape) : null

		let res = null
		try {
			res = bark(this.actx, this.bank, rng, {
				when: t + 0.01,
				bark: syllables && syllables.length ? { syllables } : barkFor(BARK_KIND[event] || 'spot', rng),
				f0,
				tract: {
					drive: character.drive,
					breath: character.breath,
					tremolo: character.tremolo,
					dying: line ? !!line.dying : event === 'death',
				},
				level: character.level * (opts.level === undefined ? 1 : opts.level),
				radio,
				distance: opts.distance === undefined ? 0 : opts.distance,
			})
		} catch (err) {
			// vox.js refused - fall back to the pre-rendered bank so the moment still
			// has a sound attached to it
			if (this.audio && typeof this.audio.play === 'function') {
				this.audio.play(event === 'death' ? 'death' : event === 'reloading' ? 'reload' : 'click', pos, { gain: 0.7 })
			}
			return range
		}
		if (!res || !res.node) return range

		if (pos && chan.panner.positionX) {
			chan.panner.positionX.setValueAtTime(pos.x, t)
			chan.panner.positionY.setValueAtTime(pos.y, t)
			chan.panner.positionZ.setValueAtTime(pos.z, t)
		} else if (pos && typeof chan.panner.setPosition === 'function') {
			chan.panner.setPosition(pos.x, pos.y, pos.z)
		}

		const blocked = pos ? this._occluded(pos) : false
		chan.lp.frequency.setTargetAtTime(blocked ? MUFFLE_HZ : OPEN_HZ, t, 0.01)
		chan.gain.gain.setTargetAtTime(blocked ? MUFFLE_GAIN : 1, t, 0.01)
		if (chan.send) chan.send.gain.setTargetAtTime(res.send === undefined ? 0.3 : res.send, t, 0.02)

		try {
			res.node.connect(chan.input)
		} catch (err) {
			return range
		}

		const end = res.end === undefined ? t + 1 : res.end
		chan.busyUntil = end + 0.05
		this.lastAt = t
		this.active++
		const self = this
		const release = () => {
			self.active = Math.max(0, self.active - 1)
			try {
				res.node.disconnect()
			} catch (err) {
				/* already torn down by the graph */
			}
		}
		if (typeof setTimeout === 'function') setTimeout(release, Math.max(80, (end - t) * 1000 + 90))
		else release()

		return range
	}

	update(dt) {
		this.time += Number.isFinite(dt) && dt > 0 ? dt : 0
	}

	dispose() {
		for (let i = 0; i < this.channels.length; i++) {
			const c = this.channels[i]
			try {
				c.gain.disconnect()
				c.panner.disconnect()
				c.lp.disconnect()
				c.input.disconnect()
				if (c.send) c.send.disconnect()
			} catch (err) {
				/* context already closed */
			}
		}
		this.channels.length = 0
		this.actx = null
		this.bank = null
		this.cooldowns = new WeakMap()
	}
}

/** One layer per context, created on first use. */
export function voiceLayer(ctx) {
	if (!ctx) return null
	if (!ctx.__eflVoice) ctx.__eflVoice = new VoiceLayer(ctx)
	return ctx.__eflVoice
}

export default VoiceLayer