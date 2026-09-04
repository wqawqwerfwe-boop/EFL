/* ==========================================================================
 * Escape-From-Larpov · src/audio/mixer.js
 * Web Audio микшер: master / ui / music / hideout / sfx / ambience.
 * К этим GainNode напрямую крепятся ползунки вкладки «ЗВУК».
 * ========================================================================== */

export const MIXER_BUSES = ['ui', 'music', 'hideout', 'sfx', 'ambience']

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

export class AudioMixer {
  constructor(options = {}) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    this.context = options.context || new Ctor({ latencyHint: 'interactive' })

    /* Master Gain Node — «Общий уровень громкости» */
    this.master = this.context.createGain()
    this.master.gain.value = 0.72
    this.master.connect(this.context.destination)

    /* Шины под master */
    this.buses = {}
    MIXER_BUSES.forEach(name => {
      const gain = this.context.createGain()
      gain.gain.value = name === 'music' ? 0.45 : 0.6
      gain.connect(this.master)
      this.buses[name] = gain
    })

    this.volumes = { master: 0.72, ui: 0.6, music: 0.45, hideout: 0.55, sfx: 0.8, ambience: 0.7 }
    this.buses.hideout.gain.value = this.volumes.hideout

    this._buffers = new Map()
    this._loops = {}
    this._duckFactor = 1
    this._unlocked = this.context.state === 'running'

    this._unlock = this._unlock.bind(this)
    window.addEventListener('pointerdown', this._unlock, { once: false })
    window.addEventListener('keydown', this._unlock, { once: false })
  }

  _unlock() {
    if (this.context.state === 'suspended') this.context.resume()
    this._unlocked = true
  }

  resume() {
    if (this.context.state === 'suspended') return this.context.resume()
    return Promise.resolve()
  }

  /* ------------------------------------------------------------- громкости */
  _ramp(param, target, ms = 90) {
    const now = this.context.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    param.linearRampToValueAtTime(target, now + Math.max(0.01, ms / 1000))
  }

  setMasterVolume(value01, ms) {
    this.volumes.master = clamp01(value01)
    this._ramp(this.master.gain, this.volumes.master * this._duckFactor, ms)
    return this
  }

  setBusVolume(bus, value01, ms) {
    if (!this.buses[bus]) return this
    this.volumes[bus] = clamp01(value01)
    this._ramp(this.buses[bus].gain, this.volumes[bus], ms)
    return this
  }

  setUiVolume(v, ms) { return this.setBusVolume('ui', v, ms) }
  setMusicVolume(v, ms) { return this.setBusVolume('music', v, ms) }
  setHideoutVolume(v, ms) { return this.setBusVolume('hideout', v, ms) }
  setSfxVolume(v, ms) { return this.setBusVolume('sfx', v, ms) }

  applySettings(audioSettings = {}) {
    if (audioSettings.master != null) this.setMasterVolume(audioSettings.master / 100)
    if (audioSettings.ui != null) this.setUiVolume(audioSettings.ui / 100)
    if (audioSettings.music != null) this.setMusicVolume(audioSettings.music / 100)
    if (audioSettings.hideout != null) this.setHideoutVolume(audioSettings.hideout / 100)
    return this
  }

  /* Приглушение под оверлеи (ESC-меню, настройки). */
  duck(factor = 0.35, ms = 180) {
    this._duckFactor = clamp01(factor)
    this._ramp(this.master.gain, this.volumes.master * this._duckFactor, ms)
    return this
  }

  unduck(ms = 220) {
    this._duckFactor = 1
    this._ramp(this.master.gain, this.volumes.master, ms)
    return this
  }

  /* ------------------------------------------------------------- семплы */
  async load(url) {
    if (this._buffers.has(url)) return this._buffers.get(url)
    const response = await fetch(url)
    const raw = await response.arrayBuffer()
    const buffer = await this.context.decodeAudioData(raw)
    this._buffers.set(url, buffer)
    return buffer
  }

  async play(bus, url, opts = {}) {
    if (!this.buses[bus]) return null
    await this.resume()
    let buffer
    try {
      buffer = await this.load(url)
    } catch (e) {
      return null
    }
    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    source.buffer = buffer
    source.loop = !!opts.loop
    gain.gain.value = opts.volume != null ? clamp01(opts.volume) : 1
    source.connect(gain)
    gain.connect(this.buses[bus])
    if (opts.fadeIn) {
      gain.gain.value = 0
      this._ramp(gain.gain, opts.volume != null ? clamp01(opts.volume) : 1, opts.fadeIn)
    }
    source.start(0)
    return { source: source, gain: gain }
  }

  _stopLoop(key, ms = 240) {
    const entry = this._loops[key]
    if (!entry) return
    this._ramp(entry.gain.gain, 0, ms)
    const source = entry.source
    setTimeout(() => { try { source.stop() } catch (e) {} }, ms + 40)
    this._loops[key] = null
  }

  async _startLoop(key, bus, url, volume) {
    this._stopLoop(key, 120)
    const played = await this.play(bus, url, { loop: true, volume: volume, fadeIn: 400 })
    if (played) this._loops[key] = played
    return played
  }

  /* ------------------------------------------------------- игровые каналы */
  playMenuMusic(url = 'audio/music/geneburn_ost.ogg') {
    return this._startLoop('menuMusic', 'music', url, 1)
  }

  stopMenuMusic(ms) { this._stopLoop('menuMusic', ms); return this }

  playMenuAmbience(url) {
    if (!url) return null
    return this._startLoop('menuAmbience', 'ambience', url, 0.8)
  }

  playRaidAmbience(url = 'audio/ambience/factory_hum.ogg') {
    this.stopMenuMusic(300)
    return this._startLoop('raidAmbience', 'ambience', url, 1)
  }

  stopRaidAmbience(ms) { this._stopLoop('raidAmbience', ms); return this }

  startHideoutLoop(url = 'audio/ambience/hideout_loop.ogg') {
    return this._startLoop('hideout', 'hideout', url, 1)
  }

  stopHideoutLoop(ms) { this._stopLoop('hideout', ms); return this }

  /* Звуки интерфейса: семпл, а если его нет — синтез на лету. */
  playUi(name = 'click') {
    const map = {
      click: { url: 'audio/ui/click.ogg', freq: 780, dur: 0.05, type: 'square', gain: 0.35 },
      hover: { url: 'audio/ui/hover.ogg', freq: 1180, dur: 0.03, type: 'sine', gain: 0.18 },
      back: { url: 'audio/ui/back.ogg', freq: 420, dur: 0.07, type: 'square', gain: 0.3 },
      alert: { url: 'audio/ui/alert.ogg', freq: 220, dur: 0.34, type: 'sawtooth', gain: 0.4 },
    }
    const preset = map[name] || map.click

    if (this._buffers.has(preset.url)) {
      this.play('ui', preset.url, { volume: 1 })
      return this
    }

    this.load(preset.url)
      .then(() => this.play('ui', preset.url, { volume: 1 }))
      .catch(() => this._beep(preset))
    return this
  }

  _beep(preset) {
    if (this.context.state === 'suspended') return
    const osc = this.context.createOscillator()
    const gain = this.context.createGain()
    const now = this.context.currentTime
    osc.type = preset.type
    osc.frequency.setValueAtTime(preset.freq, now)
    osc.frequency.exponentialRampToValueAtTime(Math.max(60, preset.freq * 0.55), now + preset.dur)
    gain.gain.setValueAtTime(preset.gain, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.dur)
    osc.connect(gain)
    gain.connect(this.buses.ui)
    osc.start(now)
    osc.stop(now + preset.dur + 0.02)
  }

  dispose() {
    window.removeEventListener('pointerdown', this._unlock)
    window.removeEventListener('keydown', this._unlock)
    Object.keys(this._loops).forEach(key => this._stopLoop(key, 40))
    if (this.context && typeof this.context.close === 'function') this.context.close()
  }
}

export default AudioMixer