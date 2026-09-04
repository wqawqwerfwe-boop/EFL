/**
 * UI - tactical GPS map tablet.
 *
 * A 2D canvas device that renders the current raid's layout vectors, the
 * extraction zones and quest objective pins, and - only if the player is
 * carrying `item_gps_device` in a special slot - their live position, heading
 * and view frustum. Without the device the tablet is a dead chart: grid, map
 * outline, pins, no fix.
 *
 * Reads:
 *   ctx.get('world')     -> { mapId }
 *   ctx.get('player')    -> { position: {x, y, z}, yaw }   (radians, 0 = +Z)
 *   ctx.get('inventory') -> { special: string[] }
 *   ctx.get('quests')    -> { markers(): Marker[] }        (optional)
 *
 * Marker: { id, kind: 'extract' | 'quest', status: 'active' | 'future' | 'done',
 *           label, x, z, radius }
 *
 * Time is fed through `update(dt)` from the engine clock, never from
 * performance.now(), so captures stay reproducible.
 */

export const GPS_ITEM = 'item_gps_device'

export const MARKER_COLORS = Object.freeze({
  extract: '#37e07a',
  active: '#f4d03f',
  future: '#ef4444',
  done: '#6b7280',
})

/* ================================================================== */
/* Map schemas - metres, x east, z north                              */
/* ================================================================== */

export const MAP_SCHEMAS = Object.freeze({
  factory: {
    name: 'FACTORY',
    ru: 'ЗАВОД',
    bounds: [[-60, -60], [60, -60], [60, 60], [-60, 60]],
    structures: [
      { label: 'Main hall', poly: [[-40, -20], [20, -20], [20, 30], [-40, 30]] },
      { label: 'Offices', poly: [[22, -10], [50, -10], [50, 26], [22, 26]], floors: 3 },
      { label: 'Forklifts', poly: [[-52, -50], [-10, -50], [-10, -24], [-52, -24]] },
      { label: 'Breach', poly: [[-10, -50], [30, -50], [30, -30], [-10, -30]] },
      { label: 'Pumping', poly: [[-52, 34], [-18, 34], [-18, 52], [-52, 52]] },
      { label: 'Tunnels', poly: [[-14, 34], [40, 34], [40, 44], [-14, 44]], under: true },
    ],
    roads: [
      [[-60, -22], [60, -22]],
      [[-60, 32], [60, 32]],
      [[0, -60], [0, 60]],
    ],
    extractions: [
      { id: 'factory:gate3', label: 'Gate 3', x: 55, z: -40, radius: 5 },
      { id: 'factory:gate0', label: 'Gate 0', x: -55, z: 0, radius: 4 },
      { id: 'factory:cellars', label: 'Cellars', x: -30, z: 55, radius: 4 },
    ],
    quests: [
      { id: 'q:prapor_parcel', label: 'Посылка Прапора', x: -20, z: 5, status: 'active' },
      { id: 'q:office_docs', label: 'Документы в Офисе', x: 36, z: 8, status: 'future' },
      { id: 'q:tagilla', label: 'Тагилла (босс)', x: -5, z: -38, status: 'future' },
    ],
  },
  customs: {
    name: 'CUSTOMS',
    ru: 'ТАМОЖНЯ',
    bounds: [[-200, -110], [200, -110], [200, 110], [-200, 110]],
    structures: [
      { label: 'Dorms', poly: [[-170, 40], [-120, 40], [-120, 90], [-170, 90]], floors: 3 },
      { label: 'Gas station', poly: [[-60, 60], [-20, 60], [-20, 85], [-60, 85]] },
      { label: 'Customs bldg', poly: [[-10, -30], [40, -30], [40, 10], [-10, 10]], floors: 2 },
      { label: 'Big red', poly: [[-120, -80], [-60, -80], [-60, -40], [-120, -40]] },
      { label: 'Warehouse 4', poly: [[70, -20], [120, -20], [120, 20], [70, 20]] },
      { label: 'Construction', poly: [[-50, -100], [10, -100], [10, -60], [-50, -60]] },
      { label: 'New gas', poly: [[130, 40], [170, 40], [170, 70], [130, 70]] },
    ],
    roads: [
      [[-200, 30], [-130, 30], [-70, 20], [0, 25], [90, 30], [200, 30]],
      [[-200, -60], [-130, -60], [-40, -50], [60, -60], [200, -60]],
      [[-40, -110], [-40, 110]],
      [[90, -110], [90, 110]],
    ],
    water: [[[-200, 95], [-130, 100], [-60, 96], [0, 104], [80, 98], [200, 102], [200, 110], [-200, 110]]],
    extractions: [
      { id: 'customs:zb1011', label: 'ZB-1011', x: 175, z: -95, radius: 6 },
      { id: 'customs:crossroads', label: 'Crossroads', x: -190, z: -30, radius: 8 },
      { id: 'customs:rusroadblock', label: 'RUAF Roadblock', x: 190, z: 10, radius: 6 },
      { id: 'customs:trailerpark', label: 'Trailer Park', x: -190, z: 95, radius: 6 },
    ],
    quests: [
      { id: 'q:prapor_parcel', label: 'Посылка Прапора', x: -145, z: 65, status: 'active' },
      { id: 'q:office_docs', label: 'Документы в Офисе', x: 15, z: -10, status: 'future' },
      { id: 'q:reshala', label: 'Решала (босс)', x: -40, z: 72, status: 'future' },
    ],
  },
  woods: {
    name: 'WOODS',
    ru: 'ЛЕС',
    bounds: [[-250, -200], [250, -200], [250, 200], [-250, 200]],
    structures: [
      { label: 'Sawmill', poly: [[-40, -30], [40, -30], [40, 30], [-40, 30]] },
      { label: 'Lumber camp', poly: [[110, 80], [170, 80], [170, 130], [110, 130]] },
      { label: 'Scav house', poly: [[-180, 100], [-150, 100], [-150, 125], [-180, 125]] },
      { label: 'USEC camp', poly: [[-200, -120], [-150, -120], [-150, -80], [-200, -80]] },
      { label: 'Checkpoint', poly: [[190, -150], [230, -150], [230, -120], [190, -120]] },
      { label: 'Old station', poly: [[60, -160], [130, -160], [130, -120], [60, -120]] },
      { label: 'Plane crash', poly: [[-90, 40], [-40, 60], [-60, 80]] },
    ],
    roads: [
      [[-250, -60], [-160, -40], [-60, -20], [0, -34], [90, -60], [250, -100]],
      [[-40, 30], [-20, 90], [30, 140], [110, 160], [250, 150]],
    ],
    water: [[[100, 0], [160, -10], [200, 30], [170, 60], [110, 50]]],
    extractions: [
      { id: 'woods:outskirts', label: 'Outskirts', x: -235, z: 40, radius: 8 },
      { id: 'woods:unroadblock', label: 'UN Roadblock', x: 235, z: -160, radius: 8 },
      { id: 'woods:rukzb014', label: 'RUAF Gate', x: 40, z: 190, radius: 6 },
    ],
    quests: [
      { id: 'q:shturman_stash', label: 'Тайник Штурмана', x: 0, z: 48, status: 'active' },
      { id: 'q:prapor_parcel', label: 'Посылка Прапора', x: -160, z: -100, status: 'future' },
      { id: 'q:jaeger_cabin', label: 'Домик Егеря', x: -100, z: 150, status: 'future' },
    ],
  },
  interchange: {
    name: 'INTERCHANGE',
    ru: 'РАЗВЯЗКА',
    bounds: [[-160, -150], [160, -150], [160, 150], [-160, 150]],
    structures: [
      { label: 'ULTRA mall', poly: [[-100, -60], [100, -60], [100, 60], [-100, 60]], floors: 2 },
      { label: 'IDEA', poly: [[-95, -55], [-30, -55], [-30, 55], [-95, 55]], inner: true },
      { label: 'Goshan', poly: [[-25, -55], [25, -55], [25, 55], [-25, 55]], inner: true },
      { label: 'OLI', poly: [[30, -55], [95, -55], [95, 55], [30, 55]], inner: true },
      { label: 'Power station', poly: [[110, -140], [150, -140], [150, -100], [110, -100]] },
      { label: 'Kiba', poly: [[-15, 20], [15, 20], [15, 40], [-15, 40]], inner: true },
      { label: 'Parking', poly: [[-100, 70], [100, 70], [100, 110], [-100, 110]] },
    ],
    roads: [
      [[-160, -80], [-110, -80], [-110, 130], [110, 130], [110, -80], [160, -80]],
      [[-160, 120], [160, 120]],
    ],
    extractions: [
      { id: 'interchange:emercom', label: 'Emercom', x: 140, z: 100, radius: 8 },
      { id: 'interchange:railway', label: 'Railway', x: -145, z: -130, radius: 8 },
      { id: 'interchange:hole', label: 'Hole in fence', x: 150, z: -30, radius: 4 },
    ],
    quests: [
      { id: 'q:kiba_keys', label: 'Ключи от Кибы', x: 0, z: 30, status: 'active' },
      { id: 'q:office_docs', label: 'Документы в Офисе', x: 60, z: -40, status: 'future' },
      { id: 'q:killa', label: 'Килла (босс)', x: -60, z: 0, status: 'future' },
    ],
  },
})

export const MAP_IDS = Object.freeze(Object.keys(MAP_SCHEMAS))

/* ================================================================== */
/* Device                                                             */
/* ================================================================== */

export const QUEST_SERVICE_ID = 'quests'

/** Events that invalidate the pin layer. Quest events bind only in LIVE mode. */
export const MAP_SOURCE_EVENTS = Object.freeze(['raid:start', 'raid:end', 'map:changed'])
export const QUEST_SOURCE_EVENTS = Object.freeze([
  'quest:accepted',
  'quest:updated',
  'quest:completed',
  'quest:failed',
  'quests:changed',
  'objectives:changed',
])

/** Method names a quest service may expose for per-map pins, in preference order. */
const QUEST_PIN_READERS = Object.freeze(['markersFor', 'pinsFor', 'objectivesFor', 'forMap'])

/** Marker status vocabulary. Anything else collapses to 'future'. */
const MARKER_STATUS = Object.freeze({ active: 'active', future: 'future', done: 'done' })

/** Default pin radius in metres when a source omits it. */
const DEFAULT_PIN_RADIUS = 3

function finite(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

/**
 * Coerce an arbitrary source record into the canonical `Marker` shape
 * ({ id, kind, status, label, x, z, radius }) or return null when the record
 * cannot be placed on the chart. Accepts `{x,z}`, `{position:{x,z}}` and
 * `{pos:{x,z}}` so the world, the raid controller and a future quest system
 * can all feed it without an adapter.
 */
function coerceMarker(src, kind, fallbackStatus) {
  if (!src || typeof src !== 'object') return null
  const p = src.position || src.pos || src
  const x = finite(p.x) ? p.x : null
  const z = finite(p.z) ? p.z : null
  if (x === null || z === null) return null
  const rawStatus = typeof src.status === 'string' ? src.status : fallbackStatus
  const status = MARKER_STATUS[rawStatus] || 'future'
  const id = typeof src.id === 'string' && src.id ? src.id : kind + ':' + x.toFixed(1) + ':' + z.toFixed(1)
  const label = typeof src.label === 'string' ? src.label : typeof src.name === 'string' ? src.name : id
  const radius = finite(src.radius) && src.radius > 0 ? src.radius : DEFAULT_PIN_RADIUS
  return { id, kind, status, label, x, z, radius }
}

export class GpsMap {
  constructor(ctx, canvas, opts = {}) {
    this.ctx = ctx
    this.canvas = canvas
    this.g = canvas.getContext('2d')
    this.time = 0
    this.zoom = opts.zoom || 1
    this.followPlayer = opts.followPlayer !== false
    this.markers = []
    this.mapId = null
    this.schema = null
    this.pan = { x: 0, z: 0 }
    this._objectives = null
    this._markersDirty = true
    this._questsLive = false
    this._bindMapSources()
    this.setMap(this._worldMapId() || 'factory')
  }

  /* ---------------------------- state ----------------------------- */

  _worldMapId() {
    const w = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('world') : null
    return w && w.mapId ? w.mapId : null
  }

  setMap(mapId) {
    if (!MAP_SCHEMAS[mapId]) mapId = 'factory'
    this.mapId = mapId
    this.schema = MAP_SCHEMAS[mapId]
    this.pan.x = 0
    this.pan.z = 0
    this._rebuildMarkers()
  }

  _questService() {
    const ctx = this.ctx
    if (!ctx) return null
    if (typeof ctx.has === 'function' && !ctx.has(QUEST_SERVICE_ID)) return null
    if (typeof ctx.peek === 'function') return ctx.peek(QUEST_SERVICE_ID) || null
    if (typeof ctx.get !== 'function') return null
    try {
      return ctx.get(QUEST_SERVICE_ID) || null
    } catch (_err) {
      return null
    }
  }

  /** True when the chart is currently allowed to compute live quest pins. */
  get questsLive() {
    return this._questsLive === true
  }

  /**
   * The authored schema for the map the raid is on. `this.schema` wins when the
   * device was opened with an explicit chart; otherwise resolve from the raid's
   * map id, then fall back to the first known schema so the tablet never opens
   * on an empty canvas.
   */
  _activeSchema() {
    if (this.schema && Array.isArray(this.schema.extractions)) return this.schema
    const raid = this.ctx && typeof this.ctx.peek === 'function' ? this.ctx.peek('raid') : null
    const mapId = this.mapId || (raid && raid.mapId) || null
    if (mapId && MAP_SCHEMAS[mapId]) return MAP_SCHEMAS[mapId]
    const ids = Object.keys(MAP_SCHEMAS)
    return ids.length ? MAP_SCHEMAS[ids[0]] : null
  }

  /**
   * Static world extraction zones. This is the ONLY data the chart carries in
   * STATIC mode. Source of truth is the authored schema; if the live raid
   * controller has resolved exits for this map they are merged by id so a
   * closed/conditional exit can still be reflected without a quest service.
   */
  _pushExtractions(out, schema) {
    const seen = this._extractSeen || (this._extractSeen = new Set())
    seen.clear()
    const list = Array.isArray(schema.extractions) ? schema.extractions : []
    for (let i = 0; i < list.length; i++) {
      const m = coerceMarker(list[i], 'extract', 'active')
      if (!m) continue
      seen.add(m.id)
      out.push(m)
    }
    const raid = this.ctx && typeof this.ctx.peek === 'function' ? this.ctx.peek('raid') : null
    const exits = raid && Array.isArray(raid.exits) ? raid.exits : null
    if (!exits) return
    for (let i = 0; i < exits.length; i++) {
      const m = coerceMarker(exits[i], 'extract', 'active')
      if (!m || seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  }

  /**
   * Objectives pushed explicitly through the public `setObjectives()` API.
   * These are caller-authored static pins, not live quest calculations, so
   * they are legal in both modes.
   */
  _pushStaticObjectives(out) {
    const list = Array.isArray(this._objectives) ? this._objectives : null
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      const m = coerceMarker(list[i], 'quest', 'future')
      if (m) out.push(m)
    }
  }

  /**
   * Read live pins from a PRESENT quest service. Tries the known reader names,
   * then a plain `objectives` array. Returns null when the service exposes
   * nothing usable so the caller can fall back to STATIC mode explicitly.
   */
  _readQuestPins(quests, schema) {
    const mapId = this.mapId || (schema && schema.id) || null
    for (let i = 0; i < QUEST_PIN_READERS.length; i++) {
      const name = QUEST_PIN_READERS[i]
      if (typeof quests[name] !== 'function') continue
      const res = quests[name](mapId)
      if (Array.isArray(res)) return res
    }
    if (Array.isArray(quests.objectives)) return quests.objectives
    if (Array.isArray(quests.pins)) return quests.pins
    return null
  }

  _pushQuestPins(out, pins) {
    for (let i = 0; i < pins.length; i++) {
      const m = coerceMarker(pins[i], 'quest', 'future')
      if (m) out.push(m)
    }
  }

  /** One-shot diagnostics so a missing optional service never spams the console. */
  _noteOnce(key, msg) {
    const seen = this._noted || (this._noted = Object.create(null))
    if (seen[key]) return
    seen[key] = true
    if (typeof console !== 'undefined') console.info('[EFL/gps] ' + msg)
  }

  /**
   * Rebuild the pin layer.
   *
   * Never throws. Never touches the quest subsystem through a throwing path.
   * Always leaves `this.markers` in a drawable state (possibly extraction-only)
   * and clears `_markersDirty` so `draw()` will not retry every frame.
   *
   * Returns the reused marker array for callers that want it inline.
   */
  _rebuildMarkers() {
    const out = this.markers || (this.markers = [])
    out.length = 0
    this._markersDirty = false

    const schema = this._activeSchema()
    if (!schema) {
      this._questsLive = false
      this._noteOnce('schema', 'no chart schema for map "' + String(this.mapId) + '" — pin layer empty')
      return out
    }

    /* Layer 1 — static world extraction zones. Present in BOTH modes. */
    this._pushExtractions(out, schema)

    /* Layer 2 — caller-authored objectives. Static, so present in BOTH modes. */
    this._pushStaticObjectives(out)

    /* Layer 3 — live quest pins. Requires the optional service. */
    const quests = this._questService()
    if (!quests) {
      if (this._questsLive) this._unbindQuestSources()
      this._questsLive = false
      this._noteOnce('quests:absent', 'quest service not registered — chart running in STATIC extraction mode')
      return out
    }

    let pins = null
    try {
      pins = this._readQuestPins(quests, schema)
    } catch (err) {
      pins = null
      if (typeof console !== 'undefined') console.warn('[EFL/gps] quest pin read failed — falling back to STATIC mode for this rebuild', err)
    }

    if (!pins) {
      this._questsLive = false
      this._noteOnce('quests:empty', 'quest service present but exposes no pin reader — STATIC mode')
      return out
    }

    this._pushQuestPins(out, pins)
    if (!this._questsLive) {
      this._questsLive = true
      this._bindQuestSources()
    }
    return out
  }

  /**
   * Public API (declared in gpsMap.d.ts). Accepts caller-authored objective
   * pins, marks the layer dirty and rebuilds immediately so the next `draw()`
   * has the new set. Passing a non-array clears the static objective layer.
   */
  setObjectives(list) {
    this._objectives = Array.isArray(list) ? list.slice() : null
    this._markersDirty = true
    this._rebuildMarkers()
    if (typeof this.requestDraw === 'function') this.requestDraw()
  }

  /** Mark the pin layer stale; the rebuild happens lazily on the next draw. */
  _invalidateMarkers() {
    this._markersDirty = true
    if (typeof this.requestDraw === 'function') this.requestDraw()
  }

  /** Called from `draw()` before the pin pass. Cheap when nothing changed. */
  _ensureMarkers() {
    if (this._markersDirty || !this.markers) this._rebuildMarkers()
    return this.markers
  }

  /**
   * Bind the chart to the world. Map-level events always bind; quest events
   * bind only once a quest service has actually been observed (see
   * `_bindQuestSources`). Idempotent — calling twice does not double-subscribe.
   */
  _bindMapSources() {
    if (this._mapUnsubs) return
    const ev = this.ctx && this.ctx.events
    if (!ev || typeof ev.on !== 'function') {
      this._mapUnsubs = []
      return
    }
    const unsubs = []
    this._onMapSource = (e) => {
      if (e && typeof e.mapId === 'string') this.mapId = e.mapId
      this.schema = this.mapId && MAP_SCHEMAS[this.mapId] ? MAP_SCHEMAS[this.mapId] : this.schema
      this._invalidateMarkers()
    }
    for (let i = 0; i < MAP_SOURCE_EVENTS.length; i++) {
      unsubs.push(ev.on(MAP_SOURCE_EVENTS[i], this._onMapSource))
    }
    this._mapUnsubs = unsubs
    this._markersDirty = true
  }

  /** Quest listeners — attached ONLY in LIVE mode. Idempotent. */
  _bindQuestSources() {
    if (this._questUnsubs) return
    const ev = this.ctx && this.ctx.events
    if (!ev || typeof ev.on !== 'function') {
      this._questUnsubs = []
      return
    }
    const unsubs = []
    this._onQuestSource = () => this._invalidateMarkers()
    for (let i = 0; i < QUEST_SOURCE_EVENTS.length; i++) {
      unsubs.push(ev.on(QUEST_SOURCE_EVENTS[i], this._onQuestSource))
    }
    this._questUnsubs = unsubs
  }

  _unbindQuestSources() {
    const unsubs = this._questUnsubs
    this._questUnsubs = null
    this._onQuestSource = null
    if (!unsubs) return
    for (let i = 0; i < unsubs.length; i++) {
      if (typeof unsubs[i] === 'function') unsubs[i]()
    }
  }

  /** Symmetric teardown. Safe to call from `dispose()` any number of times. */
  _unbindMapSources() {
    this._unbindQuestSources()
    const unsubs = this._mapUnsubs
    this._mapUnsubs = null
    this._onMapSource = null
    if (!unsubs) return
    for (let i = 0; i < unsubs.length; i++) {
      if (typeof unsubs[i] === 'function') unsubs[i]()
    }
  }

  addMarker(m) {
    this.removeMarker(m.id)
    this.markers.push({ kind: 'quest', status: 'active', radius: 3, ...m })
  }

  removeMarker(id) {
    this.markers = this.markers.filter((m) => m.id !== id)
  }

  setMarkerStatus(id, status) {
    const m = this.markers.find((x) => x.id === id)
    if (m) m.status = status
  }

  hasDevice() {
    const inv = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('inventory') : null
    if (!inv) return false
    const slots = inv.special || []
    return slots.includes(GPS_ITEM)
  }

  player() {
    const p = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('player') : null
    if (!p || !p.position) return null
    return { x: p.position.x, z: p.position.z, y: p.position.y || 0, yaw: p.yaw || 0, fov: p.fov || 75 }
  }

  update(dt) {
    this.time += dt
    const wid = this._worldMapId()
    if (wid && wid !== this.mapId) this.setMap(wid)
  }

  /* --------------------------- transform -------------------------- */

  _fit() {
    const b = this.schema.bounds
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const [x, z] of b) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
    const W = this.canvas.width
    const H = this.canvas.height
    const pad = 48
    const scale = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxZ - minZ)) * this.zoom
    let cx = (minX + maxX) / 2 + this.pan.x
    let cz = (minZ + maxZ) / 2 + this.pan.z
    const pl = this.player()
    if (this.followPlayer && this.zoom > 1.01 && pl && this.hasDevice()) {
      cx = pl.x
      cz = pl.z
    }
    this._t = { scale, cx, cz, W, H, minX, maxX, minZ, maxZ }
  }

  toScreen(x, z) {
    const t = this._t
    return [t.W / 2 + (x - t.cx) * t.scale, t.H / 2 - (z - t.cz) * t.scale]
  }

  toWorld(sx, sy) {
    const t = this._t
    return [(sx - t.W / 2) / t.scale + t.cx, -(sy - t.H / 2) / t.scale + t.cz]
  }

  /* ---------------------------- render ---------------------------- */

  render() {
    this._ensureMarkers()
    const g = this.g
    const W = this.canvas.width
    const H = this.canvas.height
    this._fit()
    const device = this.hasDevice()

    // tablet backing
    g.fillStyle = '#0b120e'
    g.fillRect(0, 0, W, H)
    this._grid()
    this._water()
    this._roads()
    this._structures()
    this._boundary()
    this._markers()
    if (device) this._player()
    this._compass()
    this._scaleBar()
    this._header(device)
    this._scanlines()
  }

  _grid() {
    const g = this.g
    const t = this._t
    const step = t.scale < 1 ? 50 : t.scale < 3 ? 20 : 10
    g.strokeStyle = 'rgba(80,140,100,0.16)'
    g.lineWidth = 1
    g.font = '9px ui-monospace, monospace'
    g.fillStyle = 'rgba(120,180,140,0.35)'
    const [wx0, wz0] = this.toWorld(0, t.H)
    const [wx1, wz1] = this.toWorld(t.W, 0)
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) {
      const [sx] = this.toScreen(x, 0)
      g.beginPath()
      g.moveTo(sx, 0)
      g.lineTo(sx, t.H)
      g.stroke()
      if (x % (step * 2) === 0) g.fillText(String(x), sx + 2, t.H - 4)
    }
    for (let z = Math.floor(wz0 / step) * step; z <= wz1; z += step) {
      const [, sz] = this.toScreen(0, z)
      g.beginPath()
      g.moveTo(0, sz)
      g.lineTo(t.W, sz)
      g.stroke()
      if (z % (step * 2) === 0) g.fillText(String(z), 4, sz - 2)
    }
  }

  _poly(poly, close = true) {
    const g = this.g
    g.beginPath()
    poly.forEach(([x, z], i) => {
      const [sx, sy] = this.toScreen(x, z)
      if (i === 0) g.moveTo(sx, sy)
      else g.lineTo(sx, sy)
    })
    if (close) g.closePath()
  }

  _water() {
    const g = this.g
    for (const w of this.schema.water || []) {
      this._poly(w)
      g.fillStyle = 'rgba(40,90,140,0.35)'
      g.fill()
      g.strokeStyle = 'rgba(90,160,220,0.5)'
      g.lineWidth = 1
      g.stroke()
    }
  }

  _roads() {
    const g = this.g
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (const r of this.schema.roads) {
      this._poly(r, false)
      g.strokeStyle = 'rgba(20,30,24,0.9)'
      g.lineWidth = Math.max(4, this._t.scale * 6)
      g.stroke()
      this._poly(r, false)
      g.strokeStyle = 'rgba(150,170,150,0.35)'
      g.lineWidth = 1
      g.setLineDash([6, 6])
      g.stroke()
      g.setLineDash([])
    }
  }

  _structures() {
    const g = this.g
    for (const s of this.schema.structures) {
      this._poly(s.poly)
      if (s.under) {
        g.fillStyle = 'rgba(60,80,120,0.25)'
        g.setLineDash([4, 3])
      } else if (s.inner) {
        g.fillStyle = 'rgba(70,110,85,0.22)'
      } else {
        g.fillStyle = s.floors ? 'rgba(90,120,95,0.55)' : 'rgba(70,95,78,0.45)'
      }
      g.fill()
      g.strokeStyle = s.inner ? 'rgba(150,220,170,0.4)' : 'rgba(160,230,180,0.75)'
      g.lineWidth = s.floors ? 1.6 : 1
      g.stroke()
      g.setLineDash([])
      // label at centroid
      let cx = 0
      let cz = 0
      for (const [x, z] of s.poly) {
        cx += x
        cz += z
      }
      cx /= s.poly.length
      cz /= s.poly.length
      const [sx, sy] = this.toScreen(cx, cz)
      g.font = '10px ui-monospace, monospace'
      g.fillStyle = 'rgba(200,240,210,0.8)'
      g.textAlign = 'center'
      g.fillText(s.label.toUpperCase(), sx, sy + 3)
      if (s.floors) {
        g.fillStyle = 'rgba(200,240,210,0.45)'
        g.fillText(`${s.floors}F`, sx, sy + 14)
      }
      g.textAlign = 'left'
    }
  }

  _boundary() {
    const g = this.g
    this._poly(this.schema.bounds)
    g.strokeStyle = 'rgba(80,220,140,0.9)'
    g.lineWidth = 2
    g.setLineDash([10, 5])
    g.stroke()
    g.setLineDash([])
    // out-of-bounds hatch
    g.save()
    this._poly(this.schema.bounds)
    g.rect(0, 0, this._t.W, this._t.H)
    g.clip('evenodd')
    g.strokeStyle = 'rgba(220,60,60,0.12)'
    g.lineWidth = 1
    for (let i = -this._t.H; i < this._t.W; i += 14) {
      g.beginPath()
      g.moveTo(i, 0)
      g.lineTo(i + this._t.H, this._t.H)
      g.stroke()
    }
    g.restore()
  }

  _markers() {
    const g = this.g
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4)
    for (const m of this.markers) {
      const [sx, sy] = this.toScreen(m.x, m.z)
      const color = m.kind === 'extract' ? MARKER_COLORS.extract : MARKER_COLORS[m.status] || MARKER_COLORS.future
      const r = Math.max(6, (m.radius || 3) * this._t.scale)

      if (m.kind === 'extract') {
        // zone disc
        g.beginPath()
        g.arc(sx, sy, r, 0, Math.PI * 2)
        g.fillStyle = 'rgba(55,224,122,0.18)'
        g.fill()
        g.strokeStyle = color
        g.lineWidth = 1.5
        g.stroke()
        // pulse ring
        g.beginPath()
        g.arc(sx, sy, r + 4 + pulse * 6, 0, Math.PI * 2)
        g.strokeStyle = `rgba(55,224,122,${0.5 - pulse * 0.4})`
        g.stroke()
        // EXIT glyph
        g.fillStyle = color
        g.font = 'bold 9px ui-monospace, monospace'
        g.textAlign = 'center'
        g.fillText('EXF', sx, sy + 3)
      } else {
        // pin
        const bob = m.status === 'active' ? pulse * 3 : 0
        const py = sy - bob
        g.beginPath()
        g.moveTo(sx, py)
        g.lineTo(sx - 7, py - 14)
        g.arc(sx, py - 16, 7, Math.PI * 0.85, Math.PI * 0.15, false)
        g.lineTo(sx, py)
        g.closePath()
        g.fillStyle = color
        g.fill()
        g.strokeStyle = 'rgba(0,0,0,0.6)'
        g.lineWidth = 1
        g.stroke()
        g.beginPath()
        g.arc(sx, py - 16, 3, 0, Math.PI * 2)
        g.fillStyle = '#0b120e'
        g.fill()
        // ground ring for active objectives
        if (m.status === 'active') {
          g.beginPath()
          g.arc(sx, sy, 5 + pulse * 5, 0, Math.PI * 2)
          g.strokeStyle = `rgba(244,208,63,${0.7 - pulse * 0.5})`
          g.stroke()
        }
        if (m.status === 'done') {
          g.strokeStyle = '#0b120e'
          g.lineWidth = 2
          g.beginPath()
          g.moveTo(sx - 4, py - 16)
          g.lineTo(sx - 1, py - 13)
          g.lineTo(sx + 4, py - 20)
          g.stroke()
        }
      }
      // label plate
      g.font = '10px ui-monospace, monospace'
      const label = m.label
      const tw = g.measureText(label).width + 8
      const lx = sx + r + 6
      const ly = sy - 8
      g.fillStyle = 'rgba(5,10,8,0.8)'
      g.fillRect(lx, ly, tw, 14)
      g.strokeStyle = color
      g.lineWidth = 1
      g.strokeRect(lx + 0.5, ly + 0.5, tw, 14)
      g.fillStyle = color
      g.textAlign = 'left'
      g.fillText(label, lx + 4, ly + 10)
    }
  }

  _player() {
    const pl = this.player()
    if (!pl) return
    const g = this.g
    const [sx, sy] = this.toScreen(pl.x, pl.z)
    // yaw: 0 faces +Z (north on the chart, i.e. screen up)
    const a = -pl.yaw
    const half = ((pl.fov || 75) * Math.PI) / 360
    const reach = Math.max(40, 30 * this._t.scale)

    // view frustum wedge
    g.save()
    g.translate(sx, sy)
    g.rotate(a)
    const grad = g.createRadialGradient(0, 0, 4, 0, 0, reach)
    grad.addColorStop(0, 'rgba(120,220,255,0.5)')
    grad.addColorStop(1, 'rgba(120,220,255,0)')
    g.beginPath()
    g.moveTo(0, 0)
    g.arc(0, 0, reach, -Math.PI / 2 - half, -Math.PI / 2 + half)
    g.closePath()
    g.fillStyle = grad
    g.fill()
    g.strokeStyle = 'rgba(120,220,255,0.35)'
    g.lineWidth = 1
    g.stroke()

    // heading arrow
    g.beginPath()
    g.moveTo(0, -12)
    g.lineTo(8, 8)
    g.lineTo(0, 3)
    g.lineTo(-8, 8)
    g.closePath()
    g.fillStyle = '#9fe8ff'
    g.fill()
    g.strokeStyle = '#04202b'
    g.lineWidth = 1.5
    g.stroke()
    g.restore()

    // position ring
    g.beginPath()
    g.arc(sx, sy, 16 + Math.sin(this.time * 3) * 2, 0, Math.PI * 2)
    g.strokeStyle = 'rgba(159,232,255,0.45)'
    g.lineWidth = 1
    g.stroke()

    // readout
    const deg = (((pl.yaw * 180) / Math.PI) % 360 + 360) % 360
    const txt = `X ${pl.x.toFixed(1)}  Z ${pl.z.toFixed(1)}  ALT ${pl.y.toFixed(1)}  HDG ${deg.toFixed(0).padStart(3, '0')}°`
    g.font = '11px ui-monospace, monospace'
    const tw = g.measureText(txt).width + 12
    g.fillStyle = 'rgba(4,20,28,0.85)'
    g.fillRect(this._t.W - tw - 12, this._t.H - 30, tw, 20)
    g.strokeStyle = 'rgba(159,232,255,0.6)'
    g.strokeRect(this._t.W - tw - 11.5, this._t.H - 29.5, tw, 20)
    g.fillStyle = '#9fe8ff'
    g.fillText(txt, this._t.W - tw - 6, this._t.H - 16)
  }

  _compass() {
    const g = this.g
    const x = this._t.W - 34
    const y = 60
    g.beginPath()
    g.arc(x, y, 20, 0, Math.PI * 2)
    g.fillStyle = 'rgba(5,10,8,0.7)'
    g.fill()
    g.strokeStyle = 'rgba(80,220,140,0.6)'
    g.lineWidth = 1
    g.stroke()
    g.beginPath()
    g.moveTo(x, y - 16)
    g.lineTo(x + 5, y)
    g.lineTo(x - 5, y)
    g.closePath()
    g.fillStyle = '#ef4444'
    g.fill()
    g.beginPath()
    g.moveTo(x, y + 16)
    g.lineTo(x + 5, y)
    g.lineTo(x - 5, y)
    g.closePath()
    g.fillStyle = 'rgba(200,240,210,0.8)'
    g.fill()
    g.font = 'bold 10px ui-monospace, monospace'
    g.fillStyle = '#c8f0d2'
    g.textAlign = 'center'
    g.fillText('N', x, y - 24)
    g.textAlign = 'left'
  }

  _scaleBar() {
    const g = this.g
    const metres = this._t.scale > 4 ? 10 : this._t.scale > 1.5 ? 25 : this._t.scale > 0.7 ? 50 : 100
    const px = metres * this._t.scale
    const x = 14
    const y = this._t.H - 44
    g.strokeStyle = '#c8f0d2'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + px, y)
    g.moveTo(x, y - 4)
    g.lineTo(x, y + 4)
    g.moveTo(x + px, y - 4)
    g.lineTo(x + px, y + 4)
    g.stroke()
    g.font = '10px ui-monospace, monospace'
    g.fillStyle = '#c8f0d2'
    g.fillText(`${metres} m`, x + px + 6, y + 4)
  }

  _header(device) {
    const g = this.g
    const W = this._t.W
    g.fillStyle = 'rgba(5,10,8,0.85)'
    g.fillRect(0, 0, W, 30)
    g.strokeStyle = 'rgba(80,220,140,0.5)'
    g.beginPath()
    g.moveTo(0, 30.5)
    g.lineTo(W, 30.5)
    g.stroke()
    g.font = 'bold 13px ui-monospace, monospace'
    g.fillStyle = '#c8f0d2'
    g.fillText(`${this.schema.name} / ${this.schema.ru}`, 12, 20)

    const active = this.markers.filter((m) => m.kind === 'quest' && m.status === 'active').length
    const ext = this.markers.filter((m) => m.kind === 'extract').length
    g.font = '10px ui-monospace, monospace'
    g.textAlign = 'right'
    g.fillStyle = MARKER_COLORS.extract
    g.fillText(`EXF ${ext}`, W - 90, 20)
    g.fillStyle = MARKER_COLORS.active
    g.fillText(`OBJ ${active}`, W - 50, 20)
    g.textAlign = 'left'

    // fix status
    const blink = Math.sin(this.time * 6) > 0
    if (device) {
      g.fillStyle = blink ? '#9fe8ff' : 'rgba(159,232,255,0.5)'
      g.fillText('● GPS FIX', W - 40 - 160, 20)
    } else {
      g.fillStyle = blink ? '#ef4444' : 'rgba(239,68,68,0.5)'
      g.fillText('○ NO GPS DEVICE', W - 40 - 200, 20)
      // stamp
      g.save()
      g.translate(W / 2, this._t.H / 2)
      g.rotate(-0.25)
      g.font = 'bold 22px ui-monospace, monospace'
      g.textAlign = 'center'
      g.fillStyle = 'rgba(239,68,68,0.18)'
      g.fillRect(-170, -20, 340, 40)
      g.strokeStyle = 'rgba(239,68,68,0.6)'
      g.lineWidth = 2
      g.strokeRect(-170, -20, 340, 40)
      g.fillStyle = 'rgba(239,68,68,0.85)'
      g.fillText('НЕТ СИГНАЛА — СЛЕПАЯ НАВИГАЦИЯ', 0, 7)
      g.restore()
    }
  }

  _scanlines() {
    const g = this.g
    g.fillStyle = 'rgba(0,0,0,0.08)'
    for (let y = 0; y < this._t.H; y += 3) g.fillRect(0, y, this._t.W, 1)
    const vg = g.createRadialGradient(this._t.W / 2, this._t.H / 2, this._t.H * 0.3, this._t.W / 2, this._t.H / 2, this._t.H * 0.9)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,0.45)')
    g.fillStyle = vg
    g.fillRect(0, 0, this._t.W, this._t.H)
  }

  /* ------------------------- interaction -------------------------- */

  /** Hit-test a canvas pixel against marker pins. */
  pick(sx, sy) {
    this._fit()
    let best = null
    let bestD = 18
    for (const m of this.markers) {
      const [mx, my] = this.toScreen(m.x, m.z)
      const cy = m.kind === 'quest' ? my - 12 : my
      const d = Math.hypot(mx - sx, cy - sy)
      if (d < bestD) {
        bestD = d
        best = m
      }
    }
    return best
  }

  setZoom(z) {
    this.zoom = Math.max(0.6, Math.min(6, z))
  }

  panBy(dx, dz) {
    this.pan.x += dx
    this.pan.z += dz
  }

  dispose() {
    this._unbindMapSources()
    this.ctx = null
    this.canvas = null
    this.g = null
  }
}
