/**
 * AI — faction kit tables and material resolution.
 *
 * `soldier.js` knows how to assemble a character. This file decides WHAT it
 * assembles for each archetype: which garments, which headgear, which armour,
 * which weapon, and what every material slot resolves to.
 *
 * It is split out for the same reason `resolveMaterials` was split out of
 * `buildSoldier`: `AiSystem.prewarmMaterials()` has to be able to ask for every
 * material a variant will ever use WITHOUT building a triangle, because geometry
 * construction draws from the shared RNG stream and doing it early moves every
 * downstream random draw.
 *
 * ------------------------------------------------------------------------
 * TWO PIPELINE CONSTRAINTS SHAPE EVERYTHING BELOW. Both were established by
 * reading the existing bakes, not assumed.
 *
 * 1. THE CAMO SETS MIGHT NOT EXIST.
 *    `SoldierMaterials` bakes `camo_<name>` only for `opts.camo ?? ['arid',
 *    'woodland']`, and `get()` throws `unknown material set` for anything it did
 *    not bake. A kit that hard-codes `camo_urban` therefore takes the whole raid
 *    down on a host that did not ask for urban. Every camo reference goes
 *    through `pickCamoSet()`, which probes `materials.sets` and degrades to a
 *    pattern that IS baked.
 *
 * 2. ONE MATERIAL PER SLOT, AND VERTEX COLOUR CAN ONLY DARKEN.
 *    Every part that declares `material: 'cloth'` shares ONE
 *    MeshStandardMaterial, so `tint` is per-variant, not per-part. Per-part
 *    colour comes from the vertex colour the builder bakes — and
 *    `CharacterBuilder._shade` clamps it to [0,1], so it can only ever darken
 *    the material tint.
 *
 *    Consequence: a kit that needs INTERNAL value contrast — white stripes on a
 *    dark tracksuit, pale crown stripes on a dark Maska — must put the BRIGHT
 *    extreme in `clothTint` / `plateTint` and darken the garment with vertex
 *    colour. That is why `scav_track` and `boss_killa` carry bright tints and
 *    dark part colours, which looks backwards until you know the rule.
 *
 * ------------------------------------------------------------------------
 * WHY CIVILIAN FABRIC IS THE NYLON BAKE.
 *    The only cloth bakes in the set are `camo_*`, and a camo blotch field
 *    tinted blue is blue camo, not denim. `nylon` is the one plain-weave bake
 *    available (basket weave + binding tape + bar-tacks), and at the cloth tile
 *    it stretches to a coarse twill, which is exactly what canvas, denim and
 *    tracksuit jersey look like at arm's length. The 1.5 mm thread is supplied
 *    by the `cloth` detail tile at 0.1 mm/texel regardless of which base bake is
 *    bound, so nothing is lost at close range.
 */

/**
 * Measured mean roughness of each bake's roughness channel, read off
 * `textures.js`:
 *   camo    `out.rough = 0.905 - 0.045 * ... + 0.035 * ...`  -> 0.905
 *   nylon   `out.rough = 0.79  - 0.13  * ... + 0.05  * ...`  -> 0.79
 *   plate   `out.rough = 0.590 + 0.060 * ... + 0.09 * ...`   -> 0.62
 *
 * Roughness targets are divided by these so the RELATIVE variation the bake
 * carries survives; this is the same reasoning as `ROUGH` in soldier.js, just
 * generalised so a target can be stated in absolute terms.
 */
export const MAP_ROUGH = Object.freeze({
  camo: 0.905,
  nylon: 0.79,
  plate: 0.62,
})

/** Absolute roughness the art direction wants, before the map divide. */
export const ROUGH_TARGET = Object.freeze({
  /** matte ripstop */
  ripstop: 0.85,
  /** heavy cotton canvas / duck — the dustiest thing on a scav */
  canvas: 0.88,
  /** worn denim: slightly polished at the wear points */
  denim: 0.86,
  /** polyester tracksuit jersey: the one civilian fabric with a sheen */
  track: 0.68,
  /** wool felt (ushanka crown, beanie) */
  wool: 0.92,
  /** laminate over foam */
  plate: 0.55,
  /** soft armour carrier: a fabric, not a laminate */
  soft: 0.72,
  /** waxed leather + rubber footwear */
  boot: 0.7,
})

/**
 * Fabric recipes. `base` picks the bake; `clothTint` on the kit picks the
 * colour, so one recipe serves every colourway of that cloth.
 */
export const FABRIC = Object.freeze({
  ripstop: { base: 'camo', rough: ROUGH_TARGET.ripstop, normalScale: 1.15, detailNormal: 0.45, detailRough: 0.16 },
  canvas: { base: 'nylon', rough: ROUGH_TARGET.canvas, normalScale: 1.2, detailNormal: 0.55, detailRough: 0.2 },
  denim: { base: 'nylon', rough: ROUGH_TARGET.denim, normalScale: 1.25, detailNormal: 0.6, detailRough: 0.18 },
  track: { base: 'nylon', rough: ROUGH_TARGET.track, normalScale: 0.95, detailNormal: 0.35, detailRough: 0.12 },
  wool: { base: 'nylon', rough: ROUGH_TARGET.wool, normalScale: 1.3, detailNormal: 0.65, detailRough: 0.22 },
})

/**
 * Resolve a camo preference to a pattern that is ACTUALLY BAKED.
 *
 * `materials.sets` is a public field and cheap to probe, which is the only
 * reliable way to avoid the throw in `get()`. Preference order after the
 * requested one is deliberate: woodland is the most broadly plausible for this
 * setting, arid is always baked by default, urban only if the host asked.
 */
export function pickCamoSet(materials, preferred) {
  const sets = materials && materials.sets ? materials.sets : null
  if (!sets) return 'camo_arid'
  const order = []
  if (preferred) order.push(preferred)
  order.push('woodland', 'arid', 'urban')
  for (let i = 0; i < order.length; i++) {
    const key = 'camo_' + order[i]
    if (sets[key]) return key
  }
  const keys = Object.keys(sets)
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('camo_') === 0) return keys[i]
  }
  // no cloth bake at all: the plain weave is a better failure than a throw
  return 'nylon'
}

/* ================================================================== */
/* the kits                                                            */
/* ================================================================== */

/**
 * SCAVS.
 *
 * Three unarmoured silhouettes plus one with soft armour, because geometry is
 * cached per variant name: rolling the headgear inside one `scav` variant would
 * bake whichever hat came up first into every scav in the raid. Separate keys
 * is what actually eradicates the clones.
 *
 *   scav_civ    canvas work jacket, ushanka, dirty jeans, hood bunched at neck
 *   scav_track  dark tracksuit with white three-stripe ribbons, beanie
 *   scav_jeans  denim jacket and jeans, flat cap, shades, repair patches
 *   scav_paca   canvas layers under a PACA soft vest — the ONLY scav armour
 *
 * None of them get a plate carrier, PALS, pauldrons, a combat helmet or knee
 * pads. `noCarrier` is what enforces that at the assembly level.
 */
const SCAV_KITS = {
  scav_civ: {
    kit: true,
    id: 'scav_civ',
    faction: 'scav',
    civ: true,
    fabric: 'canvas',
    camo: 'woodland',
    // canvas over the nylon bake: warm, dusty, and under the uniform value
    clothTint: [0.78, 0.72, 0.6],
    gearTint: [0.86, 0.8, 0.64],
    plateTint: [0.8, 0.8, 0.8],
    skinTint: [0.9, 0.83, 0.76],
    noCarrier: true,
    headgear: 'ushanka',
    flapsUp: false,
    hood: true,
    placket: true,
    pockets: true,
    bandolier: 1,
    buckle: true,
    cuffs: 'jean',
    legRadii: [0.098, 0.092, 0.082, 0.074, 0.07, 0.07, 0.078],
    armRadii: [0.052, 0.066, 0.06, 0.053, 0.049, 0.045, 0.041],
    faceWrap: false,
    beard: true,
    kneePads: false,
    weapon: 'ak',
    bulk: 1.02,
    flare: 1.06,
    scale: 0.985,
  },
  scav_track: {
    kit: true,
    id: 'scav_track',
    faction: 'scav',
    civ: true,
    fabric: 'track',
    camo: 'woodland',
    // BRIGHT tint on purpose: the stripes take it at full vertex colour and the
    // tracksuit itself is darkened to ~0.06 by its own part colour. See the
    // header note on vertex-colour clamping.
    clothTint: [0.9, 0.92, 0.96],
    gearTint: [0.7, 0.7, 0.72],
    plateTint: [0.8, 0.8, 0.82],
    skinTint: [0.88, 0.82, 0.78],
    noCarrier: true,
    headgear: 'beanie',
    bobble: false,
    stripes: true,
    bandolier: -1,
    buckle: true,
    cuffs: 'track',
    legRadii: [0.092, 0.086, 0.078, 0.07, 0.064, 0.062, 0.068],
    armRadii: [0.05, 0.062, 0.056, 0.05, 0.046, 0.043, 0.039],
    faceWrap: true,
    beard: true,
    kneePads: false,
    weapon: 'ak',
    bulk: 0.96,
    flare: 0.98,
    scale: 0.98,
  },
  scav_jeans: {
    kit: true,
    id: 'scav_jeans',
    faction: 'scav',
    civ: true,
    fabric: 'denim',
    camo: 'woodland',
    clothTint: [0.66, 0.72, 0.86],
    gearTint: [0.8, 0.76, 0.66],
    plateTint: [0.8, 0.8, 0.8],
    skinTint: [0.93, 0.86, 0.8],
    noCarrier: true,
    headgear: 'cap',
    flatCap: true,
    placket: true,
    pockets: true,
    patches: true,
    shades: true,
    bandolier: 1,
    buckle: true,
    cuffs: 'jean',
    legRadii: [0.096, 0.09, 0.08, 0.072, 0.068, 0.068, 0.076],
    armRadii: [0.051, 0.064, 0.058, 0.052, 0.048, 0.044, 0.04],
    faceWrap: true,
    beard: true,
    kneePads: false,
    weapon: 'ak',
    bulk: 1.0,
    flare: 1.04,
    scale: 0.99,
  },
  scav_paca: {
    kit: true,
    id: 'scav_paca',
    faction: 'scav',
    civ: true,
    fabric: 'canvas',
    camo: 'woodland',
    clothTint: [0.76, 0.72, 0.62],
    gearTint: [0.84, 0.78, 0.62],
    // the PACA itself: a dark fabric carrier, so the plate slot goes dark and
    // soft rather than laminate-bright
    plateTint: [0.86, 0.86, 0.9],
    skinTint: [0.9, 0.83, 0.76],
    noCarrier: true,
    paca: true,
    softArmour: true,
    headgear: 'beanie',
    placket: true,
    bandolier: -1,
    buckle: true,
    cuffs: 'jean',
    legRadii: [0.096, 0.09, 0.08, 0.072, 0.068, 0.068, 0.076],
    armRadii: [0.051, 0.064, 0.058, 0.052, 0.048, 0.044, 0.04],
    faceWrap: true,
    beard: true,
    kneePads: false,
    weapon: 'ak',
    bulk: 1.04,
    flare: 1.02,
    scale: 0.99,
  },
}

/**
 * RAIDERS. Matching, issued, operational — the deliberate opposite of a scav.
 * Dark ripstop, full-cut visored helmet, knee pads, heavy modular carrier with
 * side plates and pauldrons.
 */
const RAIDER_KITS = {
  raider: {
    kit: true,
    id: 'raider',
    faction: 'raider',
    fabric: 'ripstop',
    // urban if the host baked it, otherwise the fallback pattern darkened hard
    camo: 'urban',
    clothTint: [0.82, 0.84, 0.88],
    gearTint: [0.7, 0.72, 0.76],
    plateTint: [0.78, 0.8, 0.84],
    skinTint: [0.98, 0.92, 0.87],
    visorHelmet: true,
    visorUp: false,
    heavyCarrier: true,
    fullCarrier: true,
    faceWrap: true,
    maskHard: true,
    beard: false,
    kneePads: true,
    weapon: 'carbine',
    bulk: 1.08,
    scale: 1.03,
  },
}

/**
 * PMCs. The existing good soldier, kept as the reference silhouette: high-cut
 * helmet, goggles down, standard plate carrier. Subtypes shift hue only — a
 * USEC and a BEAR are the same kit, and separating them by pattern rather than
 * by shape is correct.
 */
const PMC_KITS = {
  pmc: {
    kit: true,
    id: 'pmc',
    faction: 'pmc',
    fabric: 'ripstop',
    camo: 'arid',
    clothTint: [1.03, 1.0, 0.94],
    gearTint: [1.08, 0.98, 0.8],
    plateTint: [1.02, 0.96, 0.84],
    skinTint: [1.0, 0.94, 0.88],
    helmet: true,
    helmetCover: true,
    helmetTint: [0.72, 0.72, 0.68],
    goggles: true,
    gogglesDown: true,
    fullCarrier: true,
    faceWrap: true,
    beard: false,
    kneePads: true,
    weapon: 'carbine',
    bulk: 1.0,
    scale: 1.0,
  },
}

/**
 * BOSSES. One signature silhouette each, because a boss that reads as a raider
 * is not a boss.
 *
 *   boss_killa      full-face Maska with three raised crown stripes, heavy
 *                   carrier, dark green tracksuit-armour styling. `plateTint`
 *                   is bright so the stripes can be pale while the shell is
 *                   darkened to a carrier value by vertex colour.
 *   boss_shturman   open camo coat over ripstop, flat cap, light carrier, long
 *                   rifle. The open coat is the whole read: it hangs to
 *                   mid-thigh and leaves a vertical gap down the torso, which
 *                   no other actor in the game has.
 */
const BOSS_KITS = {
  boss_killa: {
    kit: true,
    id: 'boss_killa',
    faction: 'boss',
    fabric: 'track',
    camo: 'woodland',
    clothTint: [0.8, 0.86, 0.78],
    gearTint: [0.74, 0.78, 0.7],
    // bright: the crown stripes ride this tint at ~0.95 vertex colour, the
    // shell is pulled down to ~0.42
    plateTint: [1.3, 1.3, 1.28],
    skinTint: [0.96, 0.9, 0.85],
    killa: true,
    heavyCarrier: true,
    fullCarrier: true,
    stripes: true,
    faceWrap: true,
    maskHard: true,
    beard: false,
    kneePads: true,
    weapon: 'carbine',
    bulk: 1.16,
    scale: 1.07,
  },
  boss_shturman: {
    kit: true,
    id: 'boss_shturman',
    faction: 'boss',
    fabric: 'ripstop',
    camo: 'woodland',
    clothTint: [0.99, 1.02, 0.95],
    gearTint: [0.9, 0.94, 0.74],
    plateTint: [0.92, 0.95, 0.82],
    skinTint: [0.92, 0.86, 0.8],
    coat: true,
    headgear: 'cap',
    flatCap: true,
    softArmour: true,
    paca: true,
    noCarrier: true,
    buckle: true,
    shades: false,
    faceWrap: false,
    beard: true,
    kneePads: false,
    weapon: 'ak',
    bulk: 1.06,
    flare: 1.04,
    scale: 1.02,
  },
}

/** Every faction kit, keyed by the mesh variant name `agent.js` asks for. */
export const FACTION_KITS = Object.freeze({
  ...SCAV_KITS,
  ...RAIDER_KITS,
  ...PMC_KITS,
  ...BOSS_KITS,
})

/** Mesh variant names available per faction, for hosts that want to enumerate. */
export const KITS_BY_FACTION = Object.freeze({
  scav: Object.freeze(['scav_civ', 'scav_track', 'scav_jeans', 'scav_paca']),
  raider: Object.freeze(['raider']),
  pmc: Object.freeze(['pmc']),
  boss: Object.freeze(['boss_killa', 'boss_shturman']),
})

/* ================================================================== */
/* material resolution                                                 */
/* ================================================================== */

/**
 * Descriptor for every material slot a kit uses.
 *
 * Returns intent, not materials: `detail.tile` names which entry of
 * `soldier.js`'s `MATERIALS` table supplies the base tile size, because that is
 * where the tile table lives and the detail scale has to be
 * `baseTile / DETAIL_TILE` for a thread to come out the same physical size on a
 * sleeve, a pouch and a boot. `rough` is already divided by the bake's map
 * average, so it can be handed to `get()` unchanged.
 *
 * @param kit        a FACTION_KITS record
 * @param materials  live SoldierMaterials, probed for which camo sets exist
 */
export function materialSpecs(kit, materials) {
  const fabric = FABRIC[kit.fabric] || FABRIC.ripstop
  const clothSet = fabric.base === 'camo' ? pickCamoSet(materials, kit.camo) : fabric.base
  // a camo fallback that landed on plain nylon is no longer a camo bake, so the
  // roughness divide has to follow the bake that was actually chosen
  const clothMap = clothSet.indexOf('camo_') === 0 ? MAP_ROUGH.camo : MAP_ROUGH.nylon

  return {
    cloth: {
      set: clothSet,
      tint: kit.clothTint,
      rough: fabric.rough / clothMap,
      normalScale: fabric.normalScale,
      detail: { set: 'cloth', tile: 'cloth', normal: fabric.detailNormal, rough: fabric.detailRough },
    },
    gear: {
      set: 'nylon',
      tint: kit.gearTint,
      normalScale: 1.1,
      detail: { set: 'nylon', tile: 'gear', normal: 0.5, rough: 0.14 },
    },
    boot: {
      set: 'nylon',
      tint: kit.gearTint,
      rough: ROUGH_TARGET.boot / MAP_ROUGH.nylon,
      normalScale: 1.1,
      detail: { set: 'nylon', tile: 'boot', normal: 0.5, rough: 0.1 },
    },
    plate: {
      set: 'plate',
      tint: kit.plateTint,
      // soft armour is a fabric carrier, not a laminate: rougher, and it must
      // not pick up the tight specular lobe that makes a plate read as a plate
      rough: (kit.softArmour ? ROUGH_TARGET.soft : ROUGH_TARGET.plate) / MAP_ROUGH.plate,
      normalScale: kit.softArmour ? 1.15 : 1.0,
      detail: { set: 'nylon', tile: 'plate', normal: kit.softArmour ? 0.55 : 0.45, rough: 0.1 },
    },
    skin: { set: 'skin', tint: kit.skinTint, normalScale: 0.8, ao: 0.6 },
    polymer: { set: 'polymer', normalScale: 1.0 },
    steel: { set: 'steel', normalScale: 1.0 },
    rubber: { set: 'rubber', normalScale: 1.2 },
  }
}

/**
 * Per-part vertex colours for the faction-specific pieces.
 *
 * These are FRACTIONS OF THE MATERIAL TINT, not absolute albedos, and they are
 * the only lever available for per-piece value (see the header note). The
 * hierarchy they express is the thing that stops a figure reading as one
 * extruded blob at 25 m: garment brightest, webbing under it, armour under
 * that, boots darkest — with the deliberate exceptions where a signature
 * feature has to be the brightest thing on the actor.
 */
export const KIT_COLOUR = Object.freeze({
  /** canvas / denim / ripstop garment body */
  garment: [1, 1, 1],
  /** tracksuit body: pulled well down so the stripes can be pale */
  trackBody: [0.44, 0.46, 0.5],
  /** the three stripes: as bright as the material tint allows */
  trackStripe: [0.98, 0.98, 1.0],
  /** ushanka / beanie crown */
  hat: [0.86, 0.84, 0.8],
  /** fur brim: a different colour family from the crown it sits on */
  fur: [0.7, 0.6, 0.48],
  /** hood bunched at the neck, in shadow */
  hood: [0.82, 0.82, 0.8],
  /** jean legs, a shade off the jacket */
  jeans: [0.9, 0.92, 0.96],
  /** repair patch: mismatched on purpose */
  patch: [0.7, 0.66, 0.6],
  /** placket, lapels, hem — doubled fabric reads darker */
  seam: [0.84, 0.84, 0.82],
  /** PACA panels */
  paca: [0.58, 0.58, 0.6],
  /** raider heavy carrier */
  carrier: [0.62, 0.63, 0.66],
  /** pauldrons catch the light, so they sit slightly above the plates */
  pauldron: [0.7, 0.71, 0.74],
  /** raider full-cut shell */
  raiderShell: [0.58, 0.6, 0.63],
  /** Killa's Maska shell: dark, so the stripes read */
  killaShell: [0.42, 0.44, 0.42],
  /** Killa's three crown stripes: the brightest thing on the model */
  killaStripe: [0.95, 0.95, 0.93],
  /** Shturman's coat */
  coat: [0.92, 0.94, 0.9],
  /** coat lapels and storm collar */
  coatTrim: [0.8, 0.82, 0.78],
  /** scav bandolier: found webbing, not issued */
  civStrap: [0.66, 0.62, 0.54],
  /** mismatched civilian gloves */
  civGlove: [0.34, 0.33, 0.32],
})

export default FACTION_KITS
