import { EFL } from '../core/config.js'
import { SURFACE_BALLISTICS, SURFACE_NAMES } from '../core/surfaces.js'

/*
 * Surface ballistics live in src/core/surfaces.js.
 *
 * This module used to declare its own twelve-entry copy, and because the
 * Float32Array lanes in init() were keyed off Object.keys() of that literal,
 * items ended up with a third index space that agreed with neither physics nor
 * the penetration solver. Re-exported here so existing importers of
 * items/index.js keep resolving.
 */
export { SURFACE_BALLISTICS }

export const ITEMS = Object.create(null)
const def = (o) => (ITEMS[o.id] = o)

/*
 * ARMOUR MATERIALS — how a plate dies.
 *
 *   destruction       multiplier on durability lost when a round defeats the plate
 *   blocked           EXTRA durability eaten when the plate stops the round.
 *                     Ceramic cracks and steel deforms, so a blocked hit hurts
 *                     them far more than it hurts soft aramid.
 *   blunt             multiplier on the blunt throughput reaching the limb behind
 *   repairDegradation how badly durMax suffers per repair. Steel welds well,
 *                     ceramic never really comes back.
 *
 * penetration.js reads these on every armour hit, so they are frozen flats with
 * no accessors.
 */
export const ARMOR_MATERIALS = Object.freeze({
  aramid: Object.freeze({ destruction: 1.0, blocked: 1.2, blunt: 1.0, repairDegradation: 1.0 }),
  steel: Object.freeze({ destruction: 0.85, blocked: 1.65, blunt: 1.15, repairDegradation: 0.8 }),
  titanium: Object.freeze({ destruction: 0.95, blocked: 1.4, blunt: 1.05, repairDegradation: 0.9 }),
  ceramic: Object.freeze({ destruction: 1.3, blocked: 1.95, blunt: 0.85, repairDegradation: 1.35 })
})

export const DEFAULT_ARMOR_MATERIAL = 'aramid'

export function armorMaterial(name) {
  const m = ARMOR_MATERIALS[name]
  return m === undefined ? ARMOR_MATERIALS[DEFAULT_ARMOR_MATERIAL] : m
}

/** A real plate: something with a class and at least one covered zone. */
export function isArmorDef(d) {
  if (!d) return false
  if (typeof d.armorClass !== 'number' || d.armorClass <= 0) return false
  return Array.isArray(d.zones) && d.zones.length > 0
}

/*
 * Durability is per INSTANCE, never per definition: two PACAs in the same stash
 * wear out independently, and MetaSystem.repair() permanently lowers durMax on
 * the one it touched.
 *
 * InventorySystem.add() only seeds `dur`, and saves written before armour was
 * real have no durMax at all, so both fields are lazily backfilled here. The
 * ballistics and repair paths call this before reading either one.
 */
export function ensureArmorInstance(it, d) {
  if (!it) return null
  const adef = d || ITEMS[it.id]
  if (!isArmorDef(adef)) return null
  if (typeof it.durMax !== 'number' || !(it.durMax > 0)) it.durMax = adef.durMax ?? adef.dur ?? 0
  if (typeof it.dur !== 'number' || !(it.dur >= 0)) it.dur = it.durMax
  if (it.dur > it.durMax) it.dur = it.durMax
  return it
}

/** Remaining durability as 0..100. A dead plate reads 0 and stops nothing. */
export function durabilityPercent(it, d) {
  const inst = ensureArmorInstance(it, d)
  if (!inst || !(inst.durMax > 0)) return 0
  const pct = (inst.dur / inst.durMax) * 100
  if (pct < 0) return 0
  if (pct > 100) return 100
  return pct
}

/* weapons */
def({ id: 'ak74n', n: 'AK-74N', t: 'weapon', cls: 'rifle', w: 5, h: 2, kg: 3.3, px: 24000, cal: '545', rpm: 650, modes: ['single', 'auto'], ergo: 44, vr: 139, hr: 412, cap: 30, spread: 0.0034, magId: 'mag_ak30' })
def({ id: 'aks74u', n: 'AKS-74U', t: 'weapon', cls: 'rifle', w: 4, h: 2, kg: 2.7, px: 19500, cal: '545', rpm: 700, modes: ['single', 'auto'], ergo: 52, vr: 141, hr: 517, cap: 30, spread: 0.0042, magId: 'mag_ak30' })
def({ id: 'rpk16', n: 'RPK-16', t: 'weapon', cls: 'lmg', w: 6, h: 2, kg: 4.7, px: 56000, cal: '545', rpm: 600, modes: ['single', 'auto'], ergo: 38, vr: 120, hr: 390, cap: 45, spread: 0.0036, magId: 'mag_ak45' })
def({ id: 'm4a1', n: 'Colt M4A1', t: 'weapon', cls: 'rifle', w: 5, h: 2, kg: 3.1, px: 44000, cal: '556', rpm: 800, modes: ['single', 'auto'], ergo: 47, vr: 126, hr: 342, cap: 30, spread: 0.003, magId: 'mag_stanag' })
def({ id: 'mp5', n: 'HK MP5', t: 'weapon', cls: 'smg', w: 4, h: 2, kg: 2.6, px: 27000, cal: '9x19', rpm: 800, modes: ['single', 'auto'], ergo: 60, vr: 78, hr: 230, cap: 30, spread: 0.0038, magId: 'mag_mp5' })
def({ id: 'mp7a2', n: 'HK MP7A2', t: 'weapon', cls: 'smg', w: 4, h: 2, kg: 2.2, px: 61000, cal: '9x19', rpm: 950, modes: ['single', 'auto'], ergo: 66, vr: 62, hr: 196, cap: 40, spread: 0.0035, magId: 'mag_mp7' })
def({ id: 'sv98', n: 'SV-98', t: 'weapon', cls: 'sniper', w: 6, h: 2, kg: 5.6, px: 48000, cal: '762x54', rpm: 60, modes: ['single'], ergo: 30, vr: 180, hr: 520, cap: 10, zoom: 4, spread: 0.0012 })
def({ id: 'mosin', n: 'Mosin', t: 'weapon', cls: 'sniper', w: 6, h: 2, kg: 4.2, px: 21000, cal: '762x54', rpm: 50, modes: ['single'], ergo: 34, vr: 196, hr: 560, cap: 5, zoom: 2.6, spread: 0.0016 })
def({ id: 'm870', n: 'M870', t: 'weapon', cls: 'shotgun', w: 5, h: 2, kg: 3.6, px: 23000, cal: '12x70', rpm: 75, modes: ['single'], ergo: 40, vr: 220, hr: 600, cap: 7, pellets: 8, spread: 0.03 })
def({ id: 'pm', n: 'PM', t: 'weapon', cls: 'pistol', w: 2, h: 1, kg: 0.73, px: 3500, cal: '9x18', rpm: 600, modes: ['single'], ergo: 75, vr: 220, hr: 480, cap: 8, pistol: 1, spread: 0.005, magId: 'mag_pm' })
def({ id: 'glock', n: 'Glock 17', t: 'weapon', cls: 'pistol', w: 2, h: 1, kg: 0.9, px: 13000, cal: '9x19', rpm: 700, modes: ['single'], ergo: 78, vr: 200, hr: 430, cap: 17, pistol: 1, spread: 0.0048, magId: 'mag_glock' })

/* ammo */
const A = (id, n, cal, dmg, pen, px, frag, ad) =>
  def({ id, n, t: 'ammo', w: 1, h: 1, kg: 0.012, px, cal, dmg, pen, frag, ad, stack: 60 })
A('545ps', '5.45 PS', '545', 40, 31, 90, 0.17, 38)
A('545bt', '5.45 BT', '545', 44, 37, 140, 0.12, 42)
A('545bp', '5.45 BP', '545', 44, 45, 210, 0.08, 46)
A('545bs', '5.45 BS', '545', 43, 51, 480, 0.05, 52)
A('556m855', '5.56 M855', '556', 41, 37, 120, 0.14, 40)
A('556m856', '5.56 M856', '556', 43, 26, 80, 0.22, 34)
A('556m995', '5.56 M995', '556', 42, 53, 520, 0.05, 54)
A('9x19pst', '9x19 PST', '9x19', 54, 24, 60, 0.2, 30)
A('9x19ap', '9x19 AP 6.3', '9x19', 52, 35, 190, 0.1, 40)
A('9x18pmm', '9x18 PMM', '9x18', 50, 17, 40, 0.24, 24)
A('762x54lps', '7.62x54 LPS', '762x54', 81, 41, 180, 0.16, 50)
A('762x54snb', '7.62x54 SNB', '762x54', 80, 56, 420, 0.08, 58)
A('12x70buck', '12/70 Buckshot', '12x70', 50, 2, 110, 0.02, 12)
A('12x70slug', '12/70 Slug', '12x70', 167, 20, 330, 0.05, 40)

/* magazines */
const MG = (id, n, cal, cap, px, ergo, w = 1, h = 2, kg = 0.2) =>
  def({ id, n, t: 'mag', cal, cap, px, ergo: ergo || 0, w, h, kg })
MG('mag_ak30', 'AK 5.45 30-round', '545', 30, 2600, 0)
MG('mag_ak45', 'RPK 5.45 45-round', '545', 45, 9000, -3, 1, 3, 0.5)
MG('mag_stanag', 'STANAG 5.56 30-round', '556', 30, 5200, 0)
MG('mag_mp5', 'MP5 30-round', '9x19', 30, 4200, 0)
MG('mag_mp7', 'MP7 40-round', '9x19', 40, 7400, 0, 1, 2, 0.24)
MG('mag_pm', 'PM 8-round', '9x18', 8, 900, 2, 1, 1, 0.1)
MG('mag_glock', 'Glock 17-round', '9x19', 17, 2400, 1, 1, 1, 0.14)

/* mods */
const MOD = (o) => def(Object.assign({ t: 'mod', w: 1, h: 1, kg: 0.2 }, o))
MOD({ id: 'dtk74', n: 'DTK-1 5.45', slot: 'muzzle', cal: '545', ergo: -2, vr: -24, hr: -15, px: 16000 })
MOD({ id: 'sup545', n: 'PBS-1', slot: 'muzzle', cal: '545', ergo: -6, vr: -18, hr: -10, sup: 1, heat: 1.35, px: 78000, w: 2 })
MOD({ id: 'pso1', n: 'PSO-1 4x', slot: 'sight', cal: 'any', ergo: -7, zoom: 4, acc: 12, px: 34000, w: 2 })
MOD({ id: 'eotech', n: 'EOTech HHS 1.35x', slot: 'sight', cal: 'any', ergo: -2, zoom: 1.35, acc: 5, px: 41000 })
MOD({ id: 'grip_fore', n: 'Foregrip', slot: 'foregrip', cal: 'any', ergo: 2, vr: -8, hr: -12, px: 18000 })
MOD({ id: 'stock_zh', n: 'Zhukov-S', slot: 'stock', cal: 'any', ergo: 6, vr: -10, hr: -8, px: 29000, w: 2 })

/*
 * Equipment / containers.
 *
 * ARMOUR SCHEMA — every plate, helmet, mask, lens and plate carrier declares:
 *   armorClass       1..6, the class the plate is rated at when fresh
 *   durMax           starting maximum durability for a new instance
 *   material         aramid | steel | titanium | ceramic (see ARMOR_MATERIALS)
 *   bluntThroughput  0.05..0.25, share of base damage that reaches the limb
 *                    when the plate STOPS the round
 *   zones            named armour zones covered (src/core/anatomy.js)
 *   headZones        helmets only: which head sub-zones are actually shelled
 *
 * `armor` and `dur` are kept alongside them: the legacy AI armour lookup and
 * InventorySystem.add() still read those two keys.
 */
def({ id: 'armor_paca', n: 'PACA Soft Armor', t: 'armor', cls: 'light', w: 3, h: 3, kg: 6.5, px: 22000, armor: 2, dur: 50, armorClass: 2, durMax: 50, material: 'aramid', bluntThroughput: 0.22, zones: ['thorax', 'stomach'] })
def({ id: 'helmet_ssh', n: 'SSH-68', t: 'helmet', w: 2, h: 2, kg: 1.5, px: 18000, armor: 3, dur: 35, armorClass: 3, durMax: 35, material: 'steel', bluntThroughput: 0.18, zones: ['head'], headZones: ['top', 'nape'] })
def({ id: 'rig_bankrobber', n: 'Bank Robber', t: 'rig', w: 3, h: 3, kg: 1.1, px: 17000, grid: { w: 4, h: 4 } })
def({ id: 'backpack_smb', n: 'Scav Backpack', t: 'backpack', w: 4, h: 4, kg: 1.8, px: 21000, grid: { w: 5, h: 6 } })
def({ id: 'secure_alpha', n: 'Alpha Container', t: 'secure', w: 2, h: 2, kg: 0.4, px: 0, grid: { w: 2, h: 2 } })

/*
 * PMC equipment for the doll slots.
 *
 * SLOTS below has always declared melee / headset / glasses / face, but no item
 * in the database carried those types, so four of the sockets could never be
 * filled by anything and rendered as permanently empty decoration. `armband`
 * and `dogtag` were missing entirely. These defs give every socket on the
 * character doll something real to hold.
 */
def({ id: 'headset_proflex', n: 'ProFlex Ear-Plugs', t: 'headset', w: 2, h: 2, kg: 0.2, px: 12000 })
def({ id: 'headset_comtac', n: 'ComTac IV', t: 'headset', w: 2, h: 2, kg: 0.6, px: 38000 })
def({ id: 'helmet_ronin', n: 'Ronin Respirator', t: 'helmet', w: 2, h: 2, kg: 3.4, px: 62000, armor: 4, dur: 180, armorClass: 4, durMax: 180, material: 'titanium', bluntThroughput: 0.12, zones: ['head'], headZones: ['top', 'nape', 'ears', 'jaws'] })
def({ id: 'face_shroud', n: 'Shroud Half-Mask', t: 'face', w: 1, h: 1, kg: 0.1, px: 5400, dur: 30, armorClass: 1, durMax: 30, material: 'aramid', bluntThroughput: 0.25, zones: ['head'], headZones: ['jaws'] })
def({ id: 'glasses_crossbow', n: 'Crossbow Glasses', t: 'glasses', w: 2, h: 1, kg: 0.15, px: 7300, dur: 20, armorClass: 1, durMax: 20, material: 'aramid', bluntThroughput: 0.25, zones: ['head'], headZones: ['eyes'] })
def({ id: 'armband_obereg', n: 'Obereg Armband', t: 'armband', w: 1, h: 1, kg: 0.05, px: 4100 })
def({ id: 'dogtag_usec', n: 'USEC Dogtag', t: 'dogtag', w: 1, h: 1, kg: 0.01, px: 0 })
def({ id: 'melee_m2', n: 'M-2 Bayonet', t: 'melee', w: 2, h: 1, kg: 0.6, px: 9500 })
def({ id: 'rig_fcpc', n: 'FCPC V5', t: 'rig', w: 3, h: 3, kg: 4.2, px: 96000, armor: 4, dur: 197, armorClass: 4, durMax: 197, material: 'ceramic', bluntThroughput: 0.1, zones: ['thorax', 'stomach'], grid: { w: 4, h: 3 } })
def({ id: 'backpack_beta2', n: 'Beta 2 Backpack', t: 'backpack', w: 4, h: 5, kg: 1.4, px: 72000, grid: { w: 5, h: 6 } })
def({ id: 'secure_epsilon', n: 'Epsilon Container', t: 'secure', w: 2, h: 3, kg: 0.9, px: 0, grid: { w: 3, h: 3 } })

/* medicine / food */
def({ id: 'bandage', n: 'Bandage', t: 'med', w: 1, h: 1, kg: 0.08, px: 1500, uses: 1, stopsBleed: 1, time: 1.5 })
def({ id: 'salewa', n: 'Salewa', t: 'med', w: 1, h: 2, kg: 0.5, px: 14000, uses: 3, hp: 45, stopsBleed: 2, time: 2.8 })
def({ id: 'splint', n: 'Splint', t: 'med', w: 1, h: 1, kg: 0.15, px: 3200, uses: 1, splint: 1, time: 2.2 })
def({ id: 'analgin', n: 'Analgin', t: 'med', w: 1, h: 1, kg: 0.05, px: 2600, uses: 4, hp: 8, time: 1.6 })
def({ id: 'ifak', n: 'IFAK', t: 'med', w: 1, h: 1, kg: 0.5, px: 23000, uses: 3, hp: 60, stopsBleed: 2, time: 2.4 })
def({ id: 'afak', n: 'AFAK', t: 'med', w: 1, h: 1, kg: 0.6, px: 31000, uses: 4, hp: 70, stopsBleed: 2, time: 2.6 })
def({ id: 'calokb', n: 'CALOK-B', t: 'med', w: 1, h: 1, kg: 0.06, px: 12000, uses: 1, stopsBleed: 2, time: 1.4 })
def({ id: 'water', n: 'Water 0.6L', t: 'food', w: 1, h: 2, kg: 0.65, px: 2200, uses: 2, hydra: 35, time: 1.8 })
def({ id: 'crackers', n: 'Crackers', t: 'food', w: 1, h: 1, kg: 0.12, px: 900, uses: 1, energy: 22, hydra: -6, time: 1.6 })

/* barter / currency used by loot tables */
def({ id: 'rub', n: 'Roubles', t: 'barter', w: 1, h: 1, kg: 0.001, px: 1, stack: 500000 })
def({ id: 'usd', n: 'Dollars', t: 'barter', w: 1, h: 1, kg: 0.001, px: 145, stack: 10000 })
def({ id: 'eur', n: 'Euros', t: 'barter', w: 1, h: 1, kg: 0.001, px: 160, stack: 10000 })
def({ id: 'bolts', n: 'Bolts', t: 'barter', w: 1, h: 1, kg: 0.2, px: 12000, stack: 4 })
def({ id: 'wires', n: 'Wires', t: 'barter', w: 1, h: 1, kg: 0.15, px: 9000, stack: 4 })
def({ id: 'gunpowder', n: 'Gunpowder', t: 'barter', w: 1, h: 1, kg: 0.3, px: 18000, stack: 2 })
def({ id: 'milmodule', n: 'Military Circuit Board', t: 'barter', w: 2, h: 1, kg: 0.22, px: 42000 })
def({ id: 'gpu', n: 'Graphics Card', t: 'barter', w: 2, h: 1, kg: 0.9, px: 95000 })
def({ id: 'ledx', n: 'LEDX', t: 'barter', w: 1, h: 1, kg: 0.2, px: 350000 })
def({ id: 'btc', n: 'Physical Bitcoin', t: 'barter', w: 1, h: 1, kg: 0.1, px: 280000 })
def({ id: 'tgdocs', n: 'Docs Case', t: 'barter', w: 2, h: 1, kg: 0.6, px: 64000 })
def({ id: 'tgcard', n: 'Lab Keycard', t: 'barter', w: 1, h: 1, kg: 0.02, px: 180000 })
def({ id: 'key_cellar', n: 'Cellar Key', t: 'barter', w: 1, h: 1, kg: 0.02, px: 32000 })

export const MOD_SLOTS = [
  ['sight', 'Sight'],
  ['muzzle', 'Muzzle'],
  ['grip', 'Grip'],
  ['foregrip', 'Foregrip'],
  ['stock', 'Stock'],
]

/*
 * Canonical slot set for the character doll: id, English data-layer label, and
 * the item types the socket accepts. Russian captions and on-screen geometry are
 * the presentation layer's business and live in inventory/index.js, which
 * mirrors these ids.
 */
export const SLOTS = [
  ['headset', 'Headset', ['headset']],
  ['helmet', 'Helmet', ['helmet']],
  ['face', 'Face', ['face']],
  ['armband', 'Armband', ['armband']],
  ['armor', 'Armor', ['armor']],
  ['glasses', 'Glasses', ['glasses']],
  ['dogtag', 'Dogtag', ['dogtag']],
  ['holster', 'Holster', ['weapon']],
  ['primary', 'Primary', ['weapon']],
  ['secondary', 'Secondary', ['weapon']],
  ['melee', 'Melee', ['melee']],
  ['rig', 'Rig', ['rig']],
  ['backpack', 'Backpack', ['backpack']],
  ['secure', 'Secure', ['secure']],
]

/*
 * Body slots that can hold something that stops a round, in resolution order.
 * The ballistics solver walks this list to find the plate covering a zone.
 */
export const ARMOR_SLOTS = Object.freeze(['helmet', 'face', 'glasses', 'armor', 'rig'])

export const LOOT = {
  crate: [['bolts', 22], ['wires', 14], ['gunpowder', 6], ['bandage', 14], ['crackers', 12], ['water', 10], ['545ps', 12], ['milmodule', 4], ['gpu', 1], ['rub', 16]],
  safe: [['rub', 26], ['usd', 14], ['key_cellar', 6], ['ledx', 2], ['gpu', 4], ['tgdocs', 8], ['btc', 2], ['tgcard', 2]],
  jacket: [['rub', 22], ['crackers', 14], ['bandage', 12], ['analgin', 6], ['usd', 6], ['wires', 8]],
  med: [['bandage', 24], ['splint', 12], ['analgin', 8], ['salewa', 6], ['ifak', 5], ['calokb', 4], ['ledx', 1]],
  gun: [['pm', 16], ['aks74u', 10], ['m870', 8], ['ak74n', 7], ['mosin', 6], ['545ps', 16], ['12x70buck', 12], ['mag_ak30', 10], ['dtk74', 4]],
  tool: [['bolts', 24], ['wires', 18], ['gunpowder', 8], ['milmodule', 6], ['gpu', 2], ['mag_stanag', 5]],
}

export class ItemsSystem {
  static id = 'items'
  static deps = []

  async init(ctx) {
    this.ctx = ctx
    this.db = ITEMS
    this.rate = { rub: 1, usd: 145, eur: 160 }

    const ammoIds = Object.keys(ITEMS).filter((k) => ITEMS[k].t === 'ammo')
    const n = ammoIds.length
    this.ammoIndex = new Map()
    this.ammoId = ammoIds
    this.aDmg = new Float32Array(n)
    this.aPen = new Float32Array(n)
    this.aFrag = new Float32Array(n)
    this.aArmor = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const d = ITEMS[ammoIds[i]]
      this.ammoIndex.set(ammoIds[i], i)
      this.aDmg[i] = d.dmg
      this.aPen[i] = d.pen
      this.aFrag[i] = d.frag
      this.aArmor[i] = d.ad
    }

    this.byCaliber = Object.create(null)
    for (const id of ammoIds) (this.byCaliber[ITEMS[id].cal] ??= []).push(id)
    for (const c in this.byCaliber) this.byCaliber[c].sort((a, b) => ITEMS[a].pen - ITEMS[b].pen)

    this.loot = Object.create(null)
    for (const kind in LOOT) {
      const rows = LOOT[kind]
      const ids = new Array(rows.length)
      const cum = new Float32Array(rows.length)
      let acc = 0
      for (let i = 0; i < rows.length; i++) {
        ids[i] = rows[i][0]
        acc += rows[i][1]
        cum[i] = acc
      }
      this.loot[kind] = { ids, cum, total: acc }
    }

    /*
     * Lane order IS the canonical surface order. Keying this off
     * Object.keys() of a local literal is what gave items its own index
     * space; SURFACE_NAMES makes surfaceSlot() agree with physics and the
     * penetration solver by construction.
     */
    this.surfaceKeys = SURFACE_NAMES.slice()
    this.sCost = new Float32Array(this.surfaceKeys.length)
    this.sRic = new Float32Array(this.surfaceKeys.length)
    this.sAng = new Float32Array(this.surfaceKeys.length)
    this.sPass = new Float32Array(this.surfaceKeys.length)
    this.surfaceIndex = new Map()
    this.surfaceKeys.forEach((k, i) => {
      const s = SURFACE_BALLISTICS[k]
      this.surfaceIndex.set(k, i)
      this.sCost[i] = s.cost
      this.sRic[i] = s.ric
      this.sAng[i] = s.ang
      this.sPass[i] = s.pass
    })

    this._rng = ctx.rng.fork('items')
  }

  get(id) {
    return ITEMS[id]
  }

  ammoSlot(id) {
    const i = this.ammoIndex.get(id)
    return i === undefined ? -1 : i
  }

  surfaceSlot(name) {
    const i = this.surfaceIndex.get(name)
    return i === undefined ? 0 : i
  }

  price(id) {
    return ITEMS[id]?.px ?? 0
  }

  size(id, rot) {
    const d = ITEMS[id]
    return rot ? { w: d.h, h: d.w } : { w: d.w, h: d.h }
  }

  ammoForCaliber(cal) {
    return this.byCaliber[cal] ?? null
  }

  /* ---------- armour ---------- */

  /** Definition-level armour test, for UI filters and trader assortments. */
  isArmor(id) {
    return isArmorDef(ITEMS[id])
  }

  /** Material record for an item id, always a real record. */
  material(id) {
    return armorMaterial(ITEMS[id]?.material)
  }

  /** Backfill dur/durMax on an instance and hand it back. */
  armorInstance(it) {
    return ensureArmorInstance(it, it ? ITEMS[it.id] : null)
  }

  /** Remaining durability of an instance as 0..100. */
  durability(it) {
    return durabilityPercent(it, it ? ITEMS[it.id] : null)
  }

  rollTable(kind, rng) {
    const t = this.loot[kind] ?? this.loot.crate
    const r = rng.float() * t.total
    let lo = 0
    let hi = t.cum.length - 1
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (t.cum[m] < r) lo = m + 1
      else hi = m
    }
    return t.ids[lo]
  }

  fillBag(out, kind, rng, mult = 1) {
    out.length = 0
    let n = 1 + (rng.float() < 0.55 ? 1 : 0) + (rng.float() < 0.3 ? 1 : 0)
    n = Math.max(1, Math.round(n * mult))
    for (let i = 0; i < n; i++) {
      const id = this.rollTable(kind, rng)
      out.push(id, this.amountFor(id, rng))
    }
    return out
  }

  amountFor(id, rng) {
    if (id === 'rub') return rng.int(8000, 60000)
    if (id === 'usd') return rng.int(60, 400)
    const d = ITEMS[id]
    if (!d) return 1
    if (d.t === 'ammo') return rng.int(10, 45)
    if (d.stack > 1) return rng.int(1, d.stack)
    return 1
  }

  dispose() {
    this.ammoIndex?.clear()
    this.surfaceIndex?.clear()
  }
}
