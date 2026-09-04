/* ==========================================================================
 * Escape-From-Larpov · src/ui/gpsMap.js
 *
 * The GPS tablet: a handheld tactical chart, rendered as an immersive overlay
 * device rather than a HUD widget.
 *
 * WHY THIS IS NOT THE MINIMAP. `minimap.js` is a 60 m always-on window that
 * bakes the scene from above and scrolls under a centred arrow. This is the
 * opposite instrument: a whole-map chart the player pulls out, oriented
 * north-up, drawn from LAYOUT VECTORS rather than from a depth bake, carrying
 * extraction and quest pins, and - the part that matters for the tactical
 * experience - gated on actually owning the hardware.
 *
 * THE DEVICE GATE. `item_gps_device` in one of the special slots is what turns
 * a paper chart into a positioning system. With it you get live coordinates, a
 * grid reference, a heading and the view frustum wedge. Without it the tablet
 * still opens, but it renders the raw top-down grid chart ONLY: no arrow, no
 * coordinates, no pins. That is deliberate - navigating a chart you cannot
 * locate yourself on is the whole point of carrying the module.
 *
 * PROCEDURAL LAYOUT. Boundary vectors, the road network and the block
 * footprints are generated from a deterministic per-map seed. The authored part
 * is only what has to be exact: the map extents, the extraction ids, and the
 * quest pins. Everything else is built by `buildLayout()` on first open and
 * cached, so the chart is identical every time a raid on that map is loaded and
 * nothing is hand-placed filler.
 *
 * 2D / 3D. The chart itself is canvas 2D - it is a chart, and a chart wants
 * crisp lines. The DEVICE is 3D: the canvas sits inside a real CSS perspective
 * transform with a tilt, a bezel, a specular sheen and scanlines, so the player
 * is looking at a screen held at an angle rather than at a browser overlay.
 * ========================================================================== */

import {
  FONT_DISPLAY,
  FONT_MONO,
  FONT_STACK,
  cardinal,
  clamp,
  clamp01,
  el,
  lerp,
  setStyle,
  setText,
} from './util.js'

/** The item that turns the chart into a positioning system. */
export const GPS_ITEM_ID = 'item_gps_device'

/**
 * Slots the module is accepted in.
 *
 * Tarkov calls these the special slots and this project has not grown them yet,
 * so the lookup walks the names it might use, then falls back to "anywhere on
 * the body". A device in a pocket works; a device in the stash does not.
 */
export const SPECIAL_SLOTS = Object.freeze([
  'special1',
  'special2',
  'special3',
  'special',
  'gps',
  'armband',
  'secure',
])

/** Marker palette. Green extracts, red current objectives, yellow future ones. */
export const MARKER = Object.freeze({
  extract: Object.freeze({ fill: '#3ddc7f', ink: '#04140b', ring: 'rgba(61,220,127,.30)' }),
  active: Object.freeze({ fill: '#ff4a3a', ink: '#1a0503', ring: 'rgba(255,74,58,.28)' }),
  future: Object.freeze({ fill: '#ffc531', ink: '#1d1403', ring: 'rgba(255,197,49,.26)' }),
})

/* ------------------------------------------------------------------ *
 * Reference tactical-chart contract.
 *
 * The production `GpsMap` below renders maps from its own authored schema;
 * these are the reference `MAP_SCHEMAS` layout vectors (metres, x east, z
 * north) for Factory / Customs / Woods / Interchange plus the reference
 * marker palette, exposed so any viewer that wants the canonical coordinate
 * tables can consume them directly.
 * ------------------------------------------------------------------ */

export const GPS_ITEM = GPS_ITEM_ID

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

const PANEL_BG = '#141a17'
const CHART_BG = '#1b241f'
const BLOCK_LO = [44, 56, 50]
const BLOCK_HI = [78, 96, 84]
const ROAD_INK = '#4d5e54'
const GRID_INK = 'rgba(126,214,160,.11)'
const GRID_INK_MAJOR = 'rgba(126,214,160,.20)'
const PHOSPHOR = '#8ff0b5'

/* ------------------------------------------------------------------ *
 * deterministic noise
 * ------------------------------------------------------------------ */

function hashString(s) {
  let h = 0x811c9dc5
  const str = String(s === undefined || s === null ? '' : s)
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** mulberry32. Small, fast, and the same sequence in every browser. */
function seeded(seed) {
  let a = seed >>> 0 || 0x9e3779b9
  const float = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    float,
    range: (lo, hi) => lo + float() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(float() * (hi - lo + 1)),
    pick: (list) => list[Math.min(list.length - 1, Math.floor(float() * list.length))],
    chance: (p) => float() < p,
  }
}

/* ------------------------------------------------------------------ *
 * map schema - the authored half
 * ------------------------------------------------------------------ */

/**
 * Everything that has to be exact, and nothing that does not.
 *
 * `extent` is the playable envelope in world metres. `spine` is the road
 * skeleton in NORMALISED coordinates (-1..1 on both axes) so the same authored
 * curve scales to a 90 m interior and a 480 m forest without being retyped.
 * `density` drives how much procedural mass the generator hangs off it.
 */
export const MAP_SCHEMA = Object.freeze({
  factory: {
    id: 'factory',
    label: 'ЗАВОД',
    latin: 'FACTORY',
    extent: { minX: -96, maxX: 96, minZ: -110, maxZ: 110 },
    grid: 20,
    wobble: 0.045,
    density: 0.62,
    blockKind: 'hangar',
    spine: [
      { pts: [[-0.92, -0.62], [-0.18, -0.58], [0.16, -0.06], [0.2, 0.58], [0.86, 0.66]], w: 7 },
      { pts: [[-0.74, 0.7], [-0.28, 0.24], [0.18, 0.0]], w: 5.5 },
      { pts: [[-0.1, -0.94], [-0.06, -0.2]], w: 5 },
    ],
    extracts: [
      { id: 'factory:gate3', label: 'ВОРОТА 3', x: 74, z: 88 },
      { id: 'factory:gate0', label: 'ВОРОТА 0', x: -82, z: -66 },
      { id: 'factory:cellars', label: 'ПОДВАЛЫ', x: 6, z: -4 },
    ],
    quests: [
      { id: 'factory:prapor_package', label: 'Посылка Прапора', x: -34, z: 26, state: 'active' },
      { id: 'factory:office_docs', label: 'Документы в Офисе', x: 28, z: -48, state: 'future' },
      { id: 'factory:pumping_valve', label: 'Вентиль Насосной', x: -12, z: 72, state: 'future' },
    ],
  },
  customs: {
    id: 'customs',
    label: 'ТАМОЖНЯ',
    latin: 'CUSTOMS',
    extent: { minX: -320, maxX: 320, minZ: -180, maxZ: 180 },
    grid: 50,
    wobble: 0.075,
    density: 0.42,
    blockKind: 'building',
    spine: [
      { pts: [[-0.96, 0.18], [-0.42, 0.1], [0.06, 0.16], [0.52, 0.06], [0.96, 0.12]], w: 12 },
      { pts: [[-0.5, -0.92], [-0.44, -0.2], [-0.4, 0.1]], w: 8 },
      { pts: [[0.34, -0.86], [0.3, -0.24], [0.24, 0.14]], w: 8 },
      { pts: [[-0.2, 0.22], [-0.16, 0.72], [0.28, 0.9]], w: 6.5 },
    ],
    extracts: [
      { id: 'customs:zb013', label: 'ЗБ-013', x: -286, z: -132 },
      { id: 'customs:crossroads', label: 'ПЕРЕКРЁСТОК', x: 294, z: 44 },
      { id: 'customs:trailer_park', label: 'ТРЕЙЛЕРНЫЙ ПАРК', x: 42, z: 158 },
      { id: 'customs:railway', label: 'ЖД ЭКСТРАКТ', x: -120, z: 164 },
    ],
    quests: [
      { id: 'customs:prapor_package', label: 'Посылка Прапора', x: -168, z: -34, state: 'active' },
      { id: 'customs:office_docs', label: 'Документы в Офисе', x: 116, z: -58, state: 'active' },
      { id: 'customs:dorm_stash', label: 'Тайник в Общаге', x: 24, z: -96, state: 'future' },
      { id: 'customs:gas_analyzer', label: 'Газовый Анализатор', x: 208, z: 92, state: 'future' },
    ],
  },
  woods: {
    id: 'woods',
    label: 'ЛЕС',
    latin: 'WOODS',
    extent: { minX: -300, maxX: 300, minZ: -300, maxZ: 300 },
    grid: 50,
    wobble: 0.13,
    density: 0.2,
    blockKind: 'forest',
    spine: [
      { pts: [[-0.94, -0.34], [-0.4, -0.1], [0.08, 0.06], [0.58, 0.3], [0.94, 0.42]], w: 9 },
      { pts: [[-0.16, -0.94], [-0.04, -0.36], [0.06, 0.08]], w: 6 },
      { pts: [[0.1, 0.1], [-0.24, 0.52], [-0.6, 0.88]], w: 5.5 },
    ],
    extracts: [
      { id: 'woods:rusted_bridge', label: 'РЖАВЫЙ МОСТ', x: 272, z: 214 },
      { id: 'woods:outskirts', label: 'ОКРАИНЫ', x: -268, z: -186 },
      { id: 'woods:factory_gate', label: 'ВОРОТА ЗАВОДА', x: 96, z: -276 },
    ],
    quests: [
      { id: 'woods:sawmill_camp', label: 'Лагерь у Пилорамы', x: 18, z: -22, state: 'active' },
      { id: 'woods:prapor_package', label: 'Посылка Прапора', x: -142, z: 84, state: 'future' },
      { id: 'woods:scout_marker', label: 'Метка Разведчика', x: 186, z: -108, state: 'future' },
    ],
  },
  interchange: {
    id: 'interchange',
    label: 'РАЗВЯЗКА',
    latin: 'INTERCHANGE',
    extent: { minX: -260, maxX: 260, minZ: -200, maxZ: 200 },
    grid: 50,
    wobble: 0.03,
    density: 0.5,
    blockKind: 'terminal',
    spine: [
      { pts: [[-0.98, -0.5], [-0.3, -0.56], [0.36, -0.5], [0.98, -0.42]], w: 14 },
      { pts: [[-0.98, 0.56], [-0.28, 0.62], [0.38, 0.56], [0.98, 0.48]], w: 14 },
      { pts: [[-0.66, -0.52], [-0.7, 0.58]], w: 9 },
      { pts: [[0.68, -0.48], [0.72, 0.54]], w: 9 },
    ],
    extracts: [
      { id: 'interchange:emercom', label: 'МЧС', x: -232, z: 168 },
      { id: 'interchange:railway', label: 'ЖД ЭКСТРАКТ', x: 226, z: -172 },
      { id: 'interchange:hole_in_fence', label: 'ДЫРА В ЗАБОРЕ', x: 12, z: 186 },
    ],
    quests: [
      { id: 'interchange:idea_safe', label: 'Сейф в IDEA', x: -68, z: 12, state: 'active' },
      { id: 'interchange:office_docs', label: 'Документы в Офисе', x: 92, z: -26, state: 'active' },
      { id: 'interchange:oli_cash', label: 'Касса OLI', x: 44, z: 58, state: 'future' },
    ],
  },
})

export const DEFAULT_MAP = 'customs'

/**
 * Whatever the world system calls the map, resolved to a schema key.
 *
 * The spec says `world.mapId` is one of Factory / Customs / Woods /
 * Interchange, but map builds also ship suffixes ('customs_night',
 * 'factory-day') and the odd display string, so this normalises rather than
 * matching exactly. An unknown id resolves to the default chart instead of a
 * blank screen.
 */
export function normalizeMapId(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).toLowerCase()
  if (!s) return DEFAULT_MAP
  if (MAP_SCHEMA[s]) return s
  const keys = Object.keys(MAP_SCHEMA)
  for (let i = 0; i < keys.length; i++) {
    if (s.indexOf(keys[i]) >= 0) return keys[i]
  }
  if (s.indexOf('завод') >= 0) return 'factory'
  if (s.indexOf('тамож') >= 0) return 'customs'
  if (s.indexOf('лес') >= 0) return 'woods'
  if (s.indexOf('развяз') >= 0) return 'interchange'
  return DEFAULT_MAP
}

/* ------------------------------------------------------------------ *
 * map schema - the procedural half
 * ------------------------------------------------------------------ */

function denorm(extent, nx, nz) {
  const cx = (extent.minX + extent.maxX) * 0.5
  const cz = (extent.minZ + extent.maxZ) * 0.5
  const hx = (extent.maxX - extent.minX) * 0.5
  const hz = (extent.maxZ - extent.minZ) * 0.5
  return [cx + nx * hx, cz + nz * hz]
}

/**
 * BOUNDARY VECTORS.
 *
 * The playable envelope is never a clean rectangle - it is a fence line, a tree
 * line or a perimeter wall. So the rectangle perimeter is walked at a fixed arc
 * step and each vertex is pushed in or out by a smooth, seeded wobble, with the
 * corners pulled in harder so the shape closes as a plausible perimeter rather
 * than a torn rectangle. `wobble` is per-map: 0.03 for a walled interchange,
 * 0.13 for a forest edge.
 */
function buildBoundary(rng, extent, wobble) {
  const segs = 68
  const out = []
  const cx = (extent.minX + extent.maxX) * 0.5
  const cz = (extent.minZ + extent.maxZ) * 0.5
  const hx = (extent.maxX - extent.minX) * 0.5
  const hz = (extent.maxZ - extent.minZ) * 0.5
  const phase = rng.range(0, Math.PI * 2)
  const a2 = rng.range(0, Math.PI * 2)
  const a3 = rng.range(0, Math.PI * 2)
  for (let i = 0; i < segs; i++) {
    const t = i / segs
    const ang = t * Math.PI * 2
    // squared-off unit circle: a rounded rectangle in polar form
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    const n = 4.2
    const k = 1 / Math.pow(Math.pow(Math.abs(c), n) + Math.pow(Math.abs(s), n), 1 / n)
    const noise =
      Math.sin(ang * 3 + phase) * 0.55 + Math.sin(ang * 7 + a2) * 0.3 + Math.sin(ang * 13 + a3) * 0.15
    const corner = Math.pow(Math.abs(c * s) * 2, 0.7)
    const r = k * (1 + noise * wobble - corner * wobble * 0.75)
    out.push([cx + c * hx * r, cz + s * hz * r])
  }
  return out
}

/** Authored spine, scaled into world metres and given a little seeded drift. */
function buildRoads(rng, extent, spine) {
  const out = []
  for (let i = 0; i < spine.length; i++) {
    const road = spine[i]
    const pts = []
    for (let j = 0; j < road.pts.length; j++) {
      const p = denorm(extent, road.pts[j][0], road.pts[j][1])
      const drift = j === 0 || j === road.pts.length - 1 ? 0 : rng.range(-1, 1)
      pts.push([p[0] + drift * road.w * 0.5, p[1] + rng.range(-1, 1) * road.w * 0.35])
    }
    out.push({ pts, w: road.w })
  }
  return out
}

/** Shortest distance from a point to a polyline, in metres. */
function distToRoads(roads, x, z) {
  let best = Infinity
  for (let i = 0; i < roads.length; i++) {
    const pts = roads[i].pts
    for (let j = 0; j < pts.length - 1; j++) {
      const ax = pts[j][0]
      const az = pts[j][1]
      const bx = pts[j + 1][0]
      const bz = pts[j + 1][1]
      const dx = bx - ax
      const dz = bz - az
      const len = dx * dx + dz * dz
      let t = len > 1e-6 ? ((x - ax) * dx + (z - az) * dz) / len : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = ax + dx * t
      const pz = az + dz * t
      const d = Math.hypot(x - px, z - pz) - roads[i].w * 0.5
      if (d < best) best = d
    }
  }
  return best
}

/**
 * BLOCK FOOTPRINTS.
 *
 * A jittered lattice sized off the map's own grid, rolled against `density`,
 * with anything that would sit in a road corridor or outside the envelope
 * discarded, and a keep-out disc around every extraction and quest pin so a
 * procedural warehouse never lands on top of the marker the player is trying to
 * walk to. `floors` only drives the fill value - taller mass reads lighter, the
 * same convention the minimap uses, so the two instruments agree.
 */
function buildBlocks(rng, extent, roads, keepOut, density, kind, grid) {
  const out = []
  const cell = Math.max(18, grid * 0.85)
  const hx = (extent.maxX - extent.minX) * 0.5
  const hz = (extent.maxZ - extent.minZ) * 0.5
  const cx = (extent.minX + extent.maxX) * 0.5
  const cz = (extent.minZ + extent.maxZ) * 0.5
  for (let gz = -hz + cell * 0.5; gz < hz; gz += cell) {
    for (let gx = -hx + cell * 0.5; gx < hx; gx += cell) {
      if (!rng.chance(density)) continue
      const jx = gx + rng.range(-cell * 0.3, cell * 0.3)
      const jz = gz + rng.range(-cell * 0.3, cell * 0.3)
      const x = cx + jx
      const z = cz + jz
      // inside the envelope, with a margin so nothing straddles the perimeter
      const edge = Math.max(Math.abs(jx) / hx, Math.abs(jz) / hz)
      if (edge > 0.9) continue
      const w = kind === 'forest' ? rng.range(cell * 0.4, cell * 0.9) : rng.range(cell * 0.3, cell * 0.78)
      const d = kind === 'forest' ? rng.range(cell * 0.4, cell * 0.9) : rng.range(cell * 0.3, cell * 0.78)
      if (distToRoads(roads, x, z) < Math.max(w, d) * 0.55) continue
      let clash = false
      for (let i = 0; i < keepOut.length && !clash; i++) {
        if (Math.hypot(x - keepOut[i][0], z - keepOut[i][1]) < Math.max(w, d) * 0.8 + 8) clash = true
      }
      if (clash) continue
      out.push({
        x,
        z,
        w,
        d,
        kind,
        floors: kind === 'forest' ? 1 : rng.int(1, 4),
        rot: kind === 'forest' ? rng.range(-0.5, 0.5) : rng.chance(0.72) ? 0 : rng.range(-0.22, 0.22),
      })
    }
  }
  return out
}

const _layoutCache = new Map()

/**
 * Build (and cache) the full chart for a map id.
 *
 * Cached by id, not by instance: the layout is a pure function of the schema and
 * the seed, so reopening the tablet - or opening it on a second raid on the same
 * map - costs nothing and draws the identical chart.
 */
export function buildLayout(mapId) {
  const id = normalizeMapId(mapId)
  const hit = _layoutCache.get(id)
  if (hit) return hit

  const schema = MAP_SCHEMA[id]
  const rng = seeded(hashString('efl:gps:' + id))
  const boundary = buildBoundary(rng, schema.extent, schema.wobble)
  const roads = buildRoads(rng, schema.extent, schema.spine)

  const markers = []
  for (let i = 0; i < schema.extracts.length; i++) {
    const e = schema.extracts[i]
    markers.push({ id: e.id, label: e.label, x: e.x, z: e.z, kind: 'extract', state: 'extract' })
  }
  for (let i = 0; i < schema.quests.length; i++) {
    const q = schema.quests[i]
    markers.push({ id: q.id, label: q.label, x: q.x, z: q.z, kind: 'quest', state: q.state })
  }

  const keepOut = markers.map((m) => [m.x, m.z])
  const blocks = buildBlocks(
    rng,
    schema.extent,
    roads,
    keepOut,
    schema.density,
    schema.blockKind,
    schema.grid
  )

  const layout = {
    id,
    label: schema.label,
    latin: schema.latin,
    extent: schema.extent,
    grid: schema.grid,
    boundary,
    roads,
    blocks,
    markers,
  }
  _layoutCache.set(id, layout)
  return layout
}

/** Grid reference in the classic letter/number form, e.g. "E-07". */
export function gridRef(layout, x, z) {
  const g = layout.grid
  const col = Math.floor((x - layout.extent.minX) / g)
  const row = Math.floor((z - layout.extent.minZ) / g)
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  const c = letters[clamp(col, 0, letters.length - 1)]
  return c + '-' + (row < 9 ? '0' : '') + (row + 1)
}

/* ------------------------------------------------------------------ *
 * style
 * ------------------------------------------------------------------ */

const STYLE_ID = 'efl-gps-style'

const CSS =
  '.efl-gps{position:fixed;inset:0;z-index:9400;display:none;align-items:center;' +
  'justify-content:center;pointer-events:none;background:radial-gradient(120% 90% at 50% 55%,' +
  'rgba(3,7,5,.42) 0%,rgba(2,5,4,.78) 100%);font-family:' +
  FONT_STACK +
  '}' +
  '.efl-gps.on{display:flex;pointer-events:auto}' +
  '.efl-gps-stage{perspective:1500px;perspective-origin:50% 42%}' +
  '.efl-gps-device{position:relative;transform:rotateX(12deg) rotateZ(-1.1deg) translateY(1.5%);' +
  'transform-style:preserve-3d;border-radius:16px;padding:16px 16px 40px;' +
  'background:linear-gradient(168deg,#2c332e 0%,#1a201c 46%,#0f1411 100%);' +
  'box-shadow:0 42px 90px rgba(0,0,0,.72),0 4px 0 rgba(255,255,255,.05) inset,' +
  '0 -3px 0 rgba(0,0,0,.55) inset;transition:transform 180ms ease-out}' +
  '.efl-gps-device.flat{transform:rotateX(0deg) rotateZ(0deg)}' +
  '.efl-gps-screen{position:relative;border-radius:6px;overflow:hidden;' +
  'background:' +
  PANEL_BG +
  ';box-shadow:0 0 0 2px #0a0f0c,0 0 0 4px #333c36,0 0 34px rgba(120,240,170,.10) inset}' +
  '.efl-gps-screen canvas{display:block;width:100%;height:100%}' +
  '.efl-gps-scan{position:absolute;inset:0;pointer-events:none;' +
  'background:repeating-linear-gradient(180deg,rgba(0,0,0,.16) 0 1px,rgba(0,0,0,0) 1px 3px);' +
  'mix-blend-mode:multiply}' +
  '.efl-gps-sheen{position:absolute;inset:0;pointer-events:none;' +
  'background:linear-gradient(122deg,rgba(255,255,255,.09) 0%,rgba(255,255,255,0) 34%,' +
  'rgba(255,255,255,0) 68%,rgba(255,255,255,.05) 100%)}' +
  '.efl-gps-bar{display:flex;align-items:center;gap:10px;padding:0 4px 9px;' +
  'color:' +
  PHOSPHOR +
  ';font:700 12px/1 ' +
  FONT_DISPLAY +
  ';letter-spacing:.16em;text-transform:uppercase}' +
  '.efl-gps-bar .sp{flex:1}' +
  '.efl-gps-bar .dim{color:rgba(143,240,181,.45);letter-spacing:.1em}' +
  '.efl-gps-foot{position:absolute;left:18px;right:18px;bottom:12px;display:flex;' +
  'align-items:center;gap:14px;color:rgba(186,206,194,.62);' +
  'font:600 10px/1 ' +
  FONT_STACK +
  ';letter-spacing:.14em;text-transform:uppercase}' +
  '.efl-gps-foot .sp{flex:1}' +
  '.efl-gps-foot b{color:' +
  PHOSPHOR +
  ';font-weight:700}' +
  '.efl-gps-led{width:7px;height:7px;border-radius:50%;background:#ff4a3a;' +
  'box-shadow:0 0 8px rgba(255,74,58,.8)}' +
  '.efl-gps-led.live{background:#3ddc7f;box-shadow:0 0 9px rgba(61,220,127,.85)}' +
  '.efl-gps-coord{font:700 11px/1 ' +
  FONT_MONO +
  ';letter-spacing:.06em;color:' +
  PHOSPHOR +
  '}'

function ensureStyle() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/* ------------------------------------------------------------------ *
 * the device
 * ------------------------------------------------------------------ */

export class GpsMap {
  constructor(ctx, opts = {}) {
    this.ctx = ctx || null
    this.opts = opts

    this.visible = false
    this.hasSignal = false
    this.mapId = DEFAULT_MAP
    this.layout = null

    this.zoom = 1
    this.minZoom = 0.55
    this.maxZoom = 4.5
    this.pan = { x: 0, z: 0 }
    this.tilted = true

    this._raf = 0
    this._last = 0
    this._t = 0
    this._px = 0
    this._cssW = 0
    this._cssH = 0
    this._drag = null
    this._objectiveOverride = null
    this._player = { x: 0, y: 0, z: 0, heading: 0, fov: 78, ok: false }

    this.root = null
    this.canvas = null
    this.g = null

    this._onKey = null
    this._onWheel = null
    this._onDown = null
    this._onMove = null
    this._onUp = null
    this._onResize = null
    this._offRaidEnd = null
    this._offToggle = null

    if (typeof document !== 'undefined') this.mount(opts.parent || document.body)
  }

  /* ---------------------------------------------------------------- dom */

  mount(parent) {
    if (this.root || typeof document === 'undefined') return
    ensureStyle()

    this.root = el('div', 'efl-gps', parent)
    const stage = el('div', 'efl-gps-stage', this.root)
    this.device = el('div', 'efl-gps-device', stage)

    const bar = el('div', 'efl-gps-bar', this.device)
    this.ledEl = el('div', 'efl-gps-led', bar)
    this.titleEl = el('span', null, bar, 'ТАКТИЧЕСКАЯ КАРТА')
    el('span', 'sp', bar)
    this.mapEl = el('span', 'dim', bar, '—')

    this.screen = el('div', 'efl-gps-screen', this.device)
    this.canvas = el('canvas', null, this.screen)
    this.g = this.canvas.getContext('2d')
    el('div', 'efl-gps-scan', this.screen)
    el('div', 'efl-gps-sheen', this.screen)

    const foot = el('div', 'efl-gps-foot', this.device)
    this.coordEl = el('span', 'efl-gps-coord', foot, '--- / ---')
    el('span', 'sp', foot)
    this.hintEl = el('span', null, foot, 'M — ЗАКРЫТЬ · КОЛЕСО — МАСШТАБ · ЛКМ — СДВИГ · T — НАКЛОН')

    this._bind()
    this.resize()
  }

  _bind() {
    this._onKey = (e) => {
      if (e.repeat) return
      const k = (e.key || '').toLowerCase()
      if (k === 'm' || k === 'ь') {
        // never steal the key while a text field or the inventory owns it
        const tag = document.activeElement ? document.activeElement.tagName : ''
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        this.toggle()
        return
      }
      if (!this.visible) return
      if (k === 'escape') {
        e.preventDefault()
        this.setVisible(false)
        return
      }
      if (k === 't' || k === 'е') {
        this.tilted = !this.tilted
        if (this.device) this.device.classList.toggle('flat', !this.tilted)
        return
      }
      if (k === '+' || k === '=') this.setZoom(this.zoom * 1.25)
      else if (k === '-' || k === '_') this.setZoom(this.zoom / 1.25)
      else if (k === '0') {
        this.setZoom(1)
        this.pan.x = 0
        this.pan.z = 0
      }
    }
    window.addEventListener('keydown', this._onKey)

    this._onWheel = (e) => {
      if (!this.visible) return
      e.preventDefault()
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.16 : 1 / 1.16))
    }
    this.root.addEventListener('wheel', this._onWheel, { passive: false })

    this._onDown = (e) => {
      if (!this.visible) return
      this._drag = { x: e.clientX, y: e.clientY, px: this.pan.x, pz: this.pan.z }
    }
    this._onMove = (e) => {
      if (!this._drag) return
      const mpp = this._metresPerPixel()
      this.pan.x = this._drag.px - (e.clientX - this._drag.x) * mpp
      this.pan.z = this._drag.pz - (e.clientY - this._drag.y) * mpp
    }
    this._onUp = () => {
      this._drag = null
    }
    this.root.addEventListener('pointerdown', this._onDown)
    window.addEventListener('pointermove', this._onMove)
    window.addEventListener('pointerup', this._onUp)

    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)

    const events = this.ctx && this.ctx.events ? this.ctx.events : null
    if (events && typeof events.on === 'function') {
      this._offRaidEnd = events.on('raid:end', () => this.setVisible(false))
      this._offToggle = events.on('gps:toggle', (e) => {
        if (e && typeof e.open === 'boolean') this.setVisible(e.open)
        else this.toggle()
      })
    }
  }

  /* ------------------------------------------------------------ geometry */

  resize() {
    if (!this.canvas) return
    const vw = Math.max(320, window.innerWidth || 1280)
    const vh = Math.max(240, window.innerHeight || 720)
    const cssW = Math.round(Math.min(vw * 0.74, vh * 1.16))
    const cssH = Math.round(cssW * 0.72)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    this._cssW = cssW
    this._cssH = cssH
    setStyle(this.screen, 'width', cssW + 'px')
    setStyle(this.screen, 'height', cssH + 'px')
    const w = Math.round(cssW * dpr)
    const h = Math.round(cssH * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this._px = dpr
  }

  setZoom(z) {
    this.zoom = clamp(z, this.minZoom, this.maxZoom)
  }

  /**
   * Metres of world per canvas pixel.
   *
   * The chart is fitted so the whole envelope is on screen at zoom 1, on
   * whichever axis is tighter, with a 6 % margin for the boundary wobble and the
   * marker labels.
   */
  _metresPerPixel() {
    const layout = this.layout
    if (!layout || !this.canvas) return 1
    const ex = layout.extent
    const spanX = (ex.maxX - ex.minX) * 1.06
    const spanZ = (ex.maxZ - ex.minZ) * 1.06
    const fit = Math.max(spanX / this.canvas.width, spanZ / this.canvas.height)
    return fit / this.zoom
  }

  _centre() {
    const layout = this.layout
    const ex = layout.extent
    let cx = (ex.minX + ex.maxX) * 0.5
    let cz = (ex.minZ + ex.maxZ) * 0.5
    // with a live fix the chart follows the player once it is zoomed in enough
    // to lose the whole map, which is what an actual handheld unit does
    if (this.hasSignal && this._player.ok && this.zoom > 1.35) {
      cx = this._player.x
      cz = this._player.z
    }
    return [cx + this.pan.x, cz + this.pan.z]
  }

  /* -------------------------------------------------------------- state */

  _sys(id) {
    const ctx = this.ctx
    if (!ctx) return null
    if (typeof ctx.peek === 'function') {
      try {
        const s = ctx.peek(id)
        if (s) return s
      } catch (err) {
        /* peek never throws by contract, but never trust that */
      }
    }
    if (typeof ctx.get === 'function') {
      try {
        return ctx.get(id)
      } catch (err) {
        return null
      }
    }
    return null
  }

  /** `world.mapId`, normalised, with the layout rebuilt when it changes. */
  _syncMap() {
    const world = this._sys('world')
    const raid = this._sys('raid')
    const raw =
      (world && world.mapId) ||
      (raid && (raid.mapId || (raid.config && raid.config.mapId))) ||
      this.mapId
    const id = normalizeMapId(raw)
    if (id !== this.mapId || !this.layout) {
      this.mapId = id
      this.layout = buildLayout(id)
      this.pan.x = 0
      this.pan.z = 0
    }
    return this.layout
  }

  /**
   * Is the module actually on this player?
   *
   * Special slots first, then any equipped slot, then anywhere on the body. The
   * stash explicitly does not count - `inventory.onBody()` already encodes that
   * rule and it is the same rule the weight calculation uses, so there is one
   * definition of "carried" in the project rather than two.
   */
  hasDevice() {
    if (this.opts.forceDevice === true) return true
    if (this.opts.forceDevice === false) return false
    const inv = this._sys('inventory')
    if (!inv) return false

    if (typeof inv.slotItem === 'function') {
      for (let i = 0; i < SPECIAL_SLOTS.length; i++) {
        const it = inv.slotItem(SPECIAL_SLOTS[i])
        if (it && it.id === GPS_ITEM_ID) return true
      }
    }
    // Reference convention: an inventory that exposes a `special` array of
    // item ids directly (rather than a slots map) still gates the device.
    if (Array.isArray(inv.special) && inv.special.indexOf(GPS_ITEM) !== -1) return true
    if (inv.slots && typeof inv.slots.forEach === 'function' && typeof inv.get === 'function') {
      let found = false
      inv.slots.forEach((uid) => {
        if (found) return
        const it = inv.get(uid)
        if (it && it.id === GPS_ITEM_ID) found = true
      })
      if (found) return true
    }
    if (Array.isArray(inv.all)) {
      for (let i = 0; i < inv.all.length; i++) {
        const it = inv.all[i]
        if (!it || it.id !== GPS_ITEM_ID) continue
        if (typeof inv.onBody !== 'function' || inv.onBody(it)) return true
      }
    }
    return false
  }

  /**
   * Where the player is and which way they are looking.
   *
   * Heading is a compass bearing in degrees with north on -Z, matching the
   * minimap and the compass strip, so all three instruments agree. The forward
   * vector is taken from whichever source the build actually exposes.
   */
  _readPlayer() {
    const p = this._player
    p.ok = false
    const player = this._sys('player')
    const pos = player && player.position ? player.position : null
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return p

    p.x = pos.x
    p.y = Number.isFinite(pos.y) ? pos.y : 0
    p.z = pos.z
    p.ok = true

    let fx = 0
    let fz = -1
    let got = false
    const cam = (player && player.camera) || (this._sys('render') && this._sys('render').camera) || null
    if (cam && typeof cam.getWorldDirection === 'function') {
      try {
        const d = cam.getWorldDirection({ x: 0, y: 0, z: 0, set: null } && cam.__eflGpsDir ? cam.__eflGpsDir : undefined)
        if (d && Number.isFinite(d.x)) {
          fx = d.x
          fz = d.z
          got = true
        }
      } catch (err) {
        got = false
      }
    }
    if (!got && Number.isFinite(player.yaw)) {
      fx = Math.sin(player.yaw)
      fz = Math.cos(player.yaw)
      got = true
    }
    if (!got && cam && cam.rotation && Number.isFinite(cam.rotation.y)) {
      fx = -Math.sin(cam.rotation.y)
      fz = -Math.cos(cam.rotation.y)
      got = true
    }

    const len = Math.hypot(fx, fz)
    if (len > 1e-5) {
      fx /= len
      fz /= len
      p.heading = (Math.atan2(fx, -fz) * 180) / Math.PI
    }
    if (cam && Number.isFinite(cam.fov)) p.fov = cam.fov
    return p
  }

  /**
   * Marker list for this frame.
   *
   * The schema states what a map has; the quest system states which of those are
   * live right now. Anything the quest source reports as accepted or in progress
   * is promoted to a red current pin, anything it does not is a yellow future
   * pin, and extracts are always green. With no quest source at all the schema's
   * own state is used, so the chart is never empty.
   */
  _markers() {
    const layout = this.layout
    if (!layout) return []
    if (Array.isArray(this._objectiveOverride)) return this._objectiveOverride

    const live = this._activeQuestIds()
    const out = []
    for (let i = 0; i < layout.markers.length; i++) {
      const m = layout.markers[i]
      if (m.kind === 'extract') {
        out.push(m)
        continue
      }
      let state = m.state
      if (live) state = live.has(m.id) ? 'active' : 'future'
      out.push({ id: m.id, label: m.label, x: m.x, z: m.z, kind: 'quest', state })
    }
    return out
  }

  _activeQuestIds() {
    const sources = [this._sys('raid'), this._sys('meta')]
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      if (!s) continue
      const list =
        (Array.isArray(s.objectives) && s.objectives) ||
        (Array.isArray(s.activeQuests) && s.activeQuests) ||
        (s.P && Array.isArray(s.P.quests) && s.P.quests) ||
        null
      if (!list || list.length === 0) continue
      const set = new Set()
      for (let j = 0; j < list.length; j++) {
        const q = list[j]
        if (typeof q === 'string') {
          set.add(q)
          continue
        }
        if (!q) continue
        const id = q.id || q.questId || q.key
        if (!id) continue
        const st = String(q.state || q.status || 'active').toLowerCase()
        if (st === 'done' || st === 'complete' || st === 'completed' || st === 'failed') continue
        set.add(id)
      }
      if (set.size) return set
    }
    return null
  }

  /** Replace the marker list outright. Used by scripted raids and the previews. */
  setObjectives(list) {
    this._objectiveOverride = Array.isArray(list) ? list.slice() : null
  }

  /* ------------------------------------------------------------ lifecycle */

  toggle() {
    this.setVisible(!this.visible)
  }

  setVisible(on) {
    const want = !!on
    if (want === this.visible || !this.root) return this.visible
    this.visible = want
    this.root.classList.toggle('on', want)
    if (want) {
      this._syncMap()
      this.resize()
      this._last = 0
      this._loop()
    } else if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = 0
      this._drag = null
    }
    const events = this.ctx && this.ctx.events ? this.ctx.events : null
    if (events && typeof events.emit === 'function') events.emit('gps:visible', { open: want })
    return this.visible
  }

  /**
   * Own rAF loop.
   *
   * `UiSystem.update()` deliberately does no per-frame work for overlays, and
   * the tablet is frozen-clock friendly - it has to keep animating while the
   * inventory has pinned `time.scale` to zero - so it drives itself off wall
   * time and releases the frame the moment it is hidden.
   */
  _loop() {
    const tick = (now) => {
      if (!this.visible) {
        this._raf = 0
        return
      }
      const dt = this._last ? Math.min(0.1, (now - this._last) / 1000) : 0.016
      this._last = now
      this.update(dt)
      this._raf = requestAnimationFrame(tick)
    }
    this._raf = requestAnimationFrame(tick)
  }

  update(dt) {
    if (!this.visible || !this.g) return
    this._t += dt
    this._syncMap()
    this.hasSignal = this.hasDevice()
    this._readPlayer()
    this._syncChrome()
    this.draw()
  }

  _syncChrome() {
    const layout = this.layout
    setText(this.mapEl, layout.label + ' · ' + layout.latin)
    this.ledEl.classList.toggle('live', this.hasSignal && this._player.ok)
    if (this.hasSignal && this._player.ok) {
      const p = this._player
      setText(
        this.coordEl,
        'X ' +
          (p.x < 0 ? '-' : '+') +
          Math.abs(Math.round(p.x)) +
          '  Z ' +
          (p.z < 0 ? '-' : '+') +
          Math.abs(Math.round(p.z)) +
          '  ' +
          gridRef(layout, p.x, p.z) +
          '  ' +
          Math.round(((p.heading % 360) + 360) % 360) +
          '° ' +
          cardinal(p.heading)
      )
    } else {
      setText(this.coordEl, 'X --- / Z --- / НЕТ ФИКСАЦИИ')
    }
  }

  /* --------------------------------------------------------------- draw */

  draw() {
    const g = this.g
    const W = this.canvas.width
    const H = this.canvas.height
    const layout = this.layout
    if (!W || !H || !layout) return

    const mpp = this._metresPerPixel()
    const ppm = 1 / mpp
    const c = this._centre()
    const u = this._px

    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, W, H)

    // base plate: always opaque, so nothing in the scene can read through it
    g.fillStyle = PANEL_BG
    g.fillRect(0, 0, W, H)

    const toX = (x) => (x - c[0]) * ppm + W * 0.5
    const toY = (z) => (z - c[1]) * ppm + H * 0.5

    g.save()
    g.beginPath()
    g.rect(0, 0, W, H)
    g.clip()

    this._drawEnvelope(g, layout, toX, toY)
    this._drawGrid(g, layout, W, H, ppm, c, u)

    if (this.hasSignal) {
      this._drawRoads(g, layout, toX, toY, ppm, u)
      this._drawBlocks(g, layout, toX, toY, ppm)
      this._drawBoundary(g, layout, toX, toY, u, true)
      this._drawMarkers(g, toX, toY, u)
      this._drawPlayer(g, toX, toY, u, ppm)
    } else {
      // RAW TOP-DOWN GRID CHART ONLY. No layout mass, no pins, no arrow: without
      // the module the player has a gridded sheet of paper and has to navigate
      // off what they can see out of the window.
      this._drawBoundary(g, layout, toX, toY, u, false)
      this._drawNoSignal(g, W, H, u)
    }

    this._drawScale(g, W, H, ppm, u)
    this._drawCompassRose(g, W, H, u)

    // vignette, so the chart sinks into the bezel instead of ending abruptly
    const vg = g.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.3, W * 0.5, H * 0.5, Math.max(W, H) * 0.72)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,0,0,.34)')
    g.fillStyle = vg
    g.fillRect(0, 0, W, H)

    g.restore()
  }

  _drawEnvelope(g, layout, toX, toY) {
    const b = layout.boundary
    g.beginPath()
    g.moveTo(toX(b[0][0]), toY(b[0][1]))
    for (let i = 1; i < b.length; i++) g.lineTo(toX(b[i][0]), toY(b[i][1]))
    g.closePath()
    g.fillStyle = CHART_BG
    g.fill()
  }

  _drawBoundary(g, layout, toX, toY, u, bright) {
    const b = layout.boundary
    g.beginPath()
    g.moveTo(toX(b[0][0]), toY(b[0][1]))
    for (let i = 1; i < b.length; i++) g.lineTo(toX(b[i][0]), toY(b[i][1]))
    g.closePath()
    g.lineJoin = 'round'
    g.lineWidth = 2 * u
    g.strokeStyle = bright ? 'rgba(143,240,181,.62)' : 'rgba(143,240,181,.34)'
    g.stroke()
    // hatched dead zone just outside the fence line
    g.lineWidth = 1 * u
    g.setLineDash([5 * u, 5 * u])
    g.strokeStyle = 'rgba(143,240,181,.16)'
    g.stroke()
    g.setLineDash([])
  }

  _drawGrid(g, layout, W, H, ppm, c, u) {
    const step = layout.grid
    const half = 0.5
    g.lineWidth = 1 * u
    for (let pass = 0; pass < 2; pass++) {
      const major = pass === 1
      const s = major ? step * 5 : step
      g.strokeStyle = major ? GRID_INK_MAJOR : GRID_INK
      g.beginPath()
      const x0 = Math.floor((c[0] - (W * half) / ppm) / s)
      const x1 = Math.ceil((c[0] + (W * half) / ppm) / s)
      for (let n = x0; n <= x1; n++) {
        const X = Math.round((n * s - c[0]) * ppm + W * half) + 0.5
        g.moveTo(X, 0)
        g.lineTo(X, H)
      }
      const z0 = Math.floor((c[1] - (H * half) / ppm) / s)
      const z1 = Math.ceil((c[1] + (H * half) / ppm) / s)
      for (let n = z0; n <= z1; n++) {
        const Y = Math.round((n * s - c[1]) * ppm + H * half) + 0.5
        g.moveTo(0, Y)
        g.lineTo(W, Y)
      }
      g.stroke()
    }

    // grid reference letters and numbers along the top and left edges
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
    g.font = '700 ' + (9 * u).toFixed(1) + 'px ' + FONT_MONO
    g.fillStyle = 'rgba(143,240,181,.34)'
    g.textAlign = 'center'
    g.textBaseline = 'top'
    const cols = Math.ceil((layout.extent.maxX - layout.extent.minX) / step)
    for (let i = 0; i < cols && i < letters.length; i++) {
      const x = layout.extent.minX + (i + 0.5) * step
      const X = (x - c[0]) * ppm + W * half
      if (X < 8 * u || X > W - 8 * u) continue
      g.fillText(letters[i], X, 4 * u)
    }
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    const rows = Math.ceil((layout.extent.maxZ - layout.extent.minZ) / step)
    for (let i = 0; i < rows; i++) {
      const z = layout.extent.minZ + (i + 0.5) * step
      const Y = (z - c[1]) * ppm + H * half
      if (Y < 10 * u || Y > H - 10 * u) continue
      g.fillText((i < 9 ? '0' : '') + (i + 1), 4 * u, Y)
    }
  }

  _drawRoads(g, layout, toX, toY, ppm, u) {
    const roads = layout.roads
    g.lineJoin = 'round'
    g.lineCap = 'round'
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < roads.length; i++) {
        const r = roads[i]
        g.beginPath()
        g.moveTo(toX(r.pts[0][0]), toY(r.pts[0][1]))
        for (let j = 1; j < r.pts.length; j++) g.lineTo(toX(r.pts[j][0]), toY(r.pts[j][1]))
        if (pass === 0) {
          g.lineWidth = Math.max(2 * u, r.w * ppm)
          g.strokeStyle = ROAD_INK
        } else {
          g.lineWidth = Math.max(1 * u, r.w * ppm * 0.1)
          g.setLineDash([7 * u, 9 * u])
          g.strokeStyle = 'rgba(214,236,222,.26)'
        }
        g.stroke()
      }
      g.setLineDash([])
    }
  }

  _drawBlocks(g, layout, toX, toY, ppm) {
    const blocks = layout.blocks
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      const t = clamp01((b.floors - 1) / 3)
      const X = toX(b.x)
      const Y = toY(b.z)
      const w = b.w * ppm
      const d = b.d * ppm
      g.save()
      g.translate(X, Y)
      if (b.rot) g.rotate(b.rot)
      if (b.kind === 'forest') {
        g.fillStyle = 'rgba(58,92,68,.62)'
        g.beginPath()
        g.ellipse(0, 0, w * 0.5, d * 0.5, 0, 0, Math.PI * 2)
        g.fill()
      } else {
        g.fillStyle =
          'rgb(' +
          Math.round(lerp(BLOCK_LO[0], BLOCK_HI[0], t)) +
          ',' +
          Math.round(lerp(BLOCK_LO[1], BLOCK_HI[1], t)) +
          ',' +
          Math.round(lerp(BLOCK_LO[2], BLOCK_HI[2], t)) +
          ')'
        g.fillRect(-w * 0.5, -d * 0.5, w, d)
        // key light from the north-west, exactly the convention the minimap uses,
        // so two footprints sharing a wall still separate
        g.fillStyle = 'rgba(206,244,220,.20)'
        g.fillRect(-w * 0.5, -d * 0.5, w, Math.max(1, d * 0.06))
        g.fillRect(-w * 0.5, -d * 0.5, Math.max(1, w * 0.06), d)
        g.fillStyle = 'rgba(3,8,6,.36)'
        g.fillRect(-w * 0.5, d * 0.5 - Math.max(1, d * 0.06), w, Math.max(1, d * 0.06))
        g.fillRect(w * 0.5 - Math.max(1, w * 0.06), -d * 0.5, Math.max(1, w * 0.06), d)
      }
      g.restore()
    }
  }

  /**
   * QUEST AND EXTRACTION PINS.
   *
   * Extracts are green chevrons - a direction out, not a place. Objectives are
   * diamonds: red for a current task, yellow for one that is not live yet.
   * Current objectives get a breathing ring so the eye finds them first, and
   * with a live fix every pin carries its range in metres, which is the number
   * the player actually plans on.
   */
  _drawMarkers(g, toX, toY, u) {
    const list = this._markers()
    const p = this._player
    const pulse = 0.5 + 0.5 * Math.sin(this._t * 3.1)

    g.textAlign = 'left'
    g.textBaseline = 'middle'

    for (let i = 0; i < list.length; i++) {
      const m = list[i]
      const pal = m.kind === 'extract' ? MARKER.extract : m.state === 'active' ? MARKER.active : MARKER.future
      const X = toX(m.x)
      const Y = toY(m.z)
      const r = 5.4 * u

      if (m.state === 'active' || m.kind === 'extract') {
        g.beginPath()
        g.arc(X, Y, r * (2.1 + pulse * 0.7), 0, Math.PI * 2)
        g.fillStyle = pal.ring
        g.fill()
      }

      g.save()
      g.translate(X, Y)
      g.beginPath()
      if (m.kind === 'extract') {
        // chevron pointing off the map
        g.moveTo(0, -r * 1.35)
        g.lineTo(r * 1.2, r * 0.5)
        g.lineTo(0, r * 0.05)
        g.lineTo(-r * 1.2, r * 0.5)
      } else {
        g.moveTo(0, -r * 1.25)
        g.lineTo(r * 1.25, 0)
        g.lineTo(0, r * 1.25)
        g.lineTo(-r * 1.25, 0)
      }
      g.closePath()
      g.fillStyle = pal.fill
      g.strokeStyle = 'rgba(4,10,7,.85)'
      g.lineWidth = 1.4 * u
      g.fill()
      g.stroke()
      g.restore()

      // label plate
      const label = m.label
      const dist = this.hasSignal && p.ok ? Math.round(Math.hypot(m.x - p.x, m.z - p.z)) + ' м' : ''
      g.font = '700 ' + (10 * u).toFixed(1) + 'px ' + FONT_STACK
      const tw = g.measureText(label).width
      const dw = dist ? g.measureText(dist).width + 8 * u : 0
      const bx = X + r * 1.8
      const by = Y - 7 * u
      g.fillStyle = 'rgba(6,14,10,.72)'
      g.fillRect(bx, by, tw + dw + 10 * u, 14 * u)
      g.fillStyle = pal.fill
      g.fillRect(bx, by, 2 * u, 14 * u)
      g.fillStyle = '#dff6e8'
      g.fillText(label, bx + 6 * u, by + 7.4 * u)
      if (dist) {
        g.fillStyle = 'rgba(143,240,181,.72)'
        g.fillText(dist, bx + 6 * u + tw + 6 * u, by + 7.4 * u)
      }
    }
  }

  /**
   * LIVE POSITION AND VIEW FRUSTUM.
   *
   * Only reachable with the module carried. The wedge is the camera's real
   * horizontal field of view, rotated by the real bearing, so the player can
   * match what is on the chart to what is on the screen - which is the entire
   * value of owning the device.
   */
  _drawPlayer(g, toX, toY, u, ppm) {
    const p = this._player
    if (!p.ok) return
    const X = toX(p.x)
    const Y = toY(p.z)
    const head = (p.heading * Math.PI) / 180
    const half = ((p.fov * 0.5) * Math.PI) / 180
    const reach = clamp(48 * ppm, 26 * u, 150 * u)

    // frustum wedge
    const grad = g.createRadialGradient(X, Y, 2 * u, X, Y, reach)
    grad.addColorStop(0, 'rgba(150,246,190,.34)')
    grad.addColorStop(0.72, 'rgba(150,246,190,.09)')
    grad.addColorStop(1, 'rgba(150,246,190,0)')
    g.beginPath()
    g.moveTo(X, Y)
    g.arc(X, Y, reach, -Math.PI / 2 + head - half, -Math.PI / 2 + head + half)
    g.closePath()
    g.fillStyle = grad
    g.fill()
    g.strokeStyle = 'rgba(170,250,205,.26)'
    g.lineWidth = 1 * u
    g.stroke()

    // accuracy halo, breathing
    const halo = (6 + Math.sin(this._t * 2.2) * 1.4) * u
    g.beginPath()
    g.arc(X, Y, halo * 2.4, 0, Math.PI * 2)
    g.fillStyle = 'rgba(143,240,181,.12)'
    g.fill()

    // the arrow itself
    g.save()
    g.translate(X, Y)
    g.rotate(head)
    const s = 6.6 * u
    g.beginPath()
    g.moveTo(0, -s * 1.6)
    g.lineTo(s * 1.1, s * 1.25)
    g.lineTo(0, s * 0.55)
    g.lineTo(-s * 1.1, s * 1.25)
    g.closePath()
    g.fillStyle = '#f4fff8'
    g.strokeStyle = 'rgba(3,9,6,.9)'
    g.lineWidth = 1.7 * u
    g.lineJoin = 'round'
    g.stroke()
    g.fill()
    g.restore()
  }

  _drawNoSignal(g, W, H, u) {
    const blink = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(this._t * 2.4))
    const bw = 300 * u
    const bh = 62 * u
    const x = (W - bw) * 0.5
    const y = H * 0.5 - bh * 0.5
    g.fillStyle = 'rgba(8,14,11,.82)'
    g.fillRect(x, y, bw, bh)
    g.strokeStyle = 'rgba(255,74,58,' + (0.35 + blink * 0.4).toFixed(3) + ')'
    g.lineWidth = 1.5 * u
    g.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1)

    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(255,110,96,' + (0.65 + blink * 0.35).toFixed(3) + ')'
    g.font = '700 ' + (17 * u).toFixed(1) + 'px ' + FONT_DISPLAY
    g.fillText('НЕТ СИГНАЛА', W * 0.5, y + bh * 0.34)
    g.fillStyle = 'rgba(186,206,194,.7)'
    g.font = '600 ' + (10.5 * u).toFixed(1) + 'px ' + FONT_STACK
    g.fillText('GPS-МОДУЛЬ НЕ УСТАНОВЛЕН · ' + GPS_ITEM_ID, W * 0.5, y + bh * 0.68)

    g.fillStyle = 'rgba(143,240,181,.30)'
    g.font = '600 ' + (10 * u).toFixed(1) + 'px ' + FONT_STACK
    g.fillText('СЕТКА КООРДИНАТ · ОРИЕНТИРОВАНИЕ ПО МЕСТНОСТИ', W * 0.5, y + bh + 22 * u)
  }

  _drawScale(g, W, H, ppm, u) {
    // pick a round number of metres that lands near 110 css px
    const want = 110 * u
    const steps = [10, 20, 25, 50, 100, 200, 250, 500]
    let metresBar = steps[steps.length - 1]
    for (let i = 0; i < steps.length; i++) {
      if (steps[i] * ppm >= want * 0.7) {
        metresBar = steps[i]
        break
      }
    }
    const len = metresBar * ppm
    const x = 14 * u
    const y = H - 18 * u
    g.strokeStyle = 'rgba(143,240,181,.6)'
    g.lineWidth = 2 * u
    g.beginPath()
    g.moveTo(x, y)
    g.lineTo(x + len, y)
    g.moveTo(x, y - 4 * u)
    g.lineTo(x, y + 4 * u)
    g.moveTo(x + len, y - 4 * u)
    g.lineTo(x + len, y + 4 * u)
    g.stroke()
    g.textAlign = 'left'
    g.textBaseline = 'bottom'
    g.fillStyle = 'rgba(143,240,181,.72)'
    g.font = '700 ' + (9.5 * u).toFixed(1) + 'px ' + FONT_MONO
    g.fillText(metresBar + ' М', x, y - 6 * u)
  }

  _drawCompassRose(g, W, H, u) {
    const r = 20 * u
    const x = W - r - 18 * u
    const y = r + 18 * u
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fillStyle = 'rgba(8,14,11,.6)'
    g.fill()
    g.strokeStyle = 'rgba(143,240,181,.34)'
    g.lineWidth = 1 * u
    g.stroke()
    g.beginPath()
    g.moveTo(x, y - r * 0.78)
    g.lineTo(x + r * 0.24, y + r * 0.2)
    g.lineTo(x, y + r * 0.04)
    g.lineTo(x - r * 0.24, y + r * 0.2)
    g.closePath()
    g.fillStyle = 'rgba(255,110,96,.86)'
    g.fill()
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(223,246,232,.8)'
    g.font = '700 ' + (9 * u).toFixed(1) + 'px ' + FONT_DISPLAY
    g.fillText('N', x, y - r * 0.98 - 5 * u)
  }

  /* ------------------------------------------------------------- teardown */

  dispose() {
    if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = 0
    }
    if (this._onKey) window.removeEventListener('keydown', this._onKey)
    if (this._onMove) window.removeEventListener('pointermove', this._onMove)
    if (this._onUp) window.removeEventListener('pointerup', this._onUp)
    if (this._onResize) window.removeEventListener('resize', this._onResize)
    if (this.root && this._onWheel) this.root.removeEventListener('wheel', this._onWheel)
    if (this.root && this._onDown) this.root.removeEventListener('pointerdown', this._onDown)
    if (typeof this._offRaidEnd === 'function') this._offRaidEnd()
    if (typeof this._offToggle === 'function') this._offToggle()
    this._offRaidEnd = null
    this._offToggle = null
    if (this.root && this.root.remove) this.root.remove()
    this.root = null
    this.canvas = null
    this.g = null
    this.layout = null
    this.ctx = null
  }
}

/**
 * Registry wrapper, so the tablet can be registered next to the other systems
 * in `main.js` and get its lifecycle for free. It owns nothing the class does
 * not: `update()` is empty on purpose because the overlay drives its own rAF.
 */
export class GpsMapSystem {
  static id = 'gpsMap'
  static deps = []

  constructor(options = {}) {
    this.options = options || {}
    this.map = null
    this.ctx = null
  }

  init(ctx) {
    this.ctx = ctx
    if (typeof document === 'undefined') return
    this.map = new GpsMap(ctx, this.options)
  }

  toggle() {
    if (this.map) this.map.toggle()
  }

  setVisible(on) {
    if (this.map) this.map.setVisible(on)
  }

  get visible() {
    return !!(this.map && this.map.visible)
  }

  hasDevice() {
    return !!(this.map && this.map.hasDevice())
  }

  resize(w, h) {
    if (this.map) this.map.resize(w, h)
  }

  update() {
    /* the overlay animates off its own rAF so it keeps running on a frozen clock */
  }

  dispose() {
    if (this.map) this.map.dispose()
    this.map = null
    this.ctx = null
  }
}

export default GpsMap
