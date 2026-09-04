/**
 * AI — soldier assembly. Turns the part library into a finished, skinned,
 * material-grouped character. One geometry per visual variant, shared by every
 * instance of that variant; only the skeleton is per-instance.
 *
 * FACTION COMPILER. This used to build one soldier three ways — three camo
 * patterns over one silhouette — which is why every actor in a raid read as the
 * same operator. It now compiles a silhouette per archetype:
 *
 *   scav    civilian layers. Work jackets, mismatched tracksuits, dirty jeans,
 *           ushankas and beanies, bunched hoods, repair patches, a found
 *           bandolier. NO plate carrier, NO PALS, NO pauldrons, NO knee pads,
 *           and the only armour they can show is a PACA soft vest — gated on
 *           the actor's rolled `_armorZones`, so an unarmoured scav has no
 *           armour mesh at all.
 *   raider   matching issued kit. Full-cut visored helmet with ear cups and a
 *           mandible bar, knee pads, heavy modular carrier with side plates and
 *           shoulder pauldrons.
 *   pmc      the reference soldier, unchanged in spirit: high-cut helmet,
 *           goggles, standard carrier.
 *   boss     one signature each. Killa's full-face Maska with the three raised
 *           crown stripes; Shturman's open camo coat.
 *
 * WHAT IS DELIBERATELY UNTOUCHED. `vanguard`, `irregular` and `breacher` compile
 * exactly the geometry and materials they did before. Every new part is gated
 * behind a flag no legacy record carries, and `resolveMaterials` keeps its
 * original switch for them. The repo has a pixel gate and an albedo audit
 * (`node src/ai/selftest.mjs`); silently adding a buckle to the reference
 * variants would fail both for no reason.
 *
 * MATERIAL_SLOTS ORDER IS PRESERVED ON EVERY NEW PATH. See the note on that
 * export — it is load-bearing, not cosmetic, and two of the additions below
 * exist purely to hold it:
 *   - the belt buckle is the `polymer` part that keeps polymer ahead of `skin`
 *     for kits that have no magazine pouches (and therefore no spare mag);
 *   - the weapon optic is now added before the weapon steel, so `glass` stays
 *     ahead of `steel` for kits with no goggles, visor or shades. For the legacy
 *     variants glass has already appeared on the head by then, so their order is
 *     unchanged.
 */

import * as THREE from 'three'
import { RIG, GRIP_R, GRIP_L, BORE_DIR } from './rig.js'
import { CharacterBuilder, Noise, appendMesh, computeNormals, emptyMesh } from './geo.js'
import * as P from './parts.js'
import * as F from './factionParts.js'
import { buildWeapon } from './weapon.js'
import { CLOTH_TILE } from './textures.js'
import { FACTION_KITS, KIT_COLOUR, KITS_BY_FACTION, materialSpecs } from './factionKits.js'

/**
 * Metres of surface per texture tile. `cloth` is deliberately large: it is the
 * tile that has to carry the 0.2-0.4 m camo macro blotches, and the 1.5 mm weave
 * it can no longer resolve is supplied by the shader detail layer instead.
 */
const MATERIALS = {
  cloth: { tile: CLOTH_TILE },
  plate: { tile: 0.42 },
  gear: { tile: 0.26 },
  // Boots and gloves share the cordura bake with the pouches but NOT its
  // roughness: leather-and-rubber footwear is markedly smoother than webbing,
  // and having the whole kit sit at one gloss is half of why the figure reads as
  // one extruded blob. Own material name -> own geometry group -> own roughness.
  boot: { tile: 0.26 },
  skin: { tile: 0.20 },
  polymer: { tile: 0.15 },
  steel: { tile: 0.18 },
  rubber: { tile: 0.11 },
  glass: { tile: 1.0 },
}

/**
 * Roughness multiplier per material set, applied on top of the baked roughness
 * map so the *relative* variation the bake carries is preserved.
 *
 *   cloth 0.85   matte ripstop, map averages 0.905
 *   plate 0.55   laminate over foam, map averages 0.62
 *   boot  0.70   waxed leather / rubber, cordura map averages 0.79
 *
 * These three are the values the silhouette needs: at 25 m the only thing that
 * separates a plate carrier from the jacket under it is the width of its
 * specular lobe.
 */
const ROUGH = { cloth: 0.85 / 0.905, plate: 0.55 / 0.62, boot: 0.7 / 0.79 }

/** Detail tile size in metres — must match `bakeDetail` in textures.js. */
const DETAIL_TILE = 0.05

/**
 * ALBEDO BUDGET (linear, after the vertex tint multiplies the map)
 *
 * MEASURED, not asserted — `node src/ai/selftest.mjs` prints this table from the
 * geometry and the real bakes, and `SoldierMaterials` prints the cloth map's mean
 * and range at boot. Current values:
 *
 *   uniform cloth      0.092-0.094   map mean 0.104, every texel in 0.040-0.152
 *   helmet cover       0.064         deliberately off the uniform value
 *   mag/admin pouches  0.058-0.076
 *   knee + elbow pads  0.057-0.063
 *   carrier            0.047         laminate, and smoother than the cloth
 *   webbing / sling    0.051-0.054
 *   boots              0.032
 *   gloves             0.032-0.048
 *   skin               0.152-0.190
 *
 * Real desert multicam is 0.18-0.32 and that is what this used to target, but the
 * environment it stands in currently behaves like 0.05-0.09 albedo on screen
 * (see the measurement table in textures.js), so a physically-honest uniform
 * rendered brighter than sunlit plaster and read as a white mannequin. The whole
 * kit is therefore scaled by one documented constant, `KIT_CAL`, which keeps the
 * *hierarchy* — cloth brightest, pouches under it, carrier under that, boots and
 * gloves darkest — because that internal value structure is what breaks the "one
 * extruded blob" read at 25 m. Raise `CLOTH_BUDGET.mean` and `KIT_CAL` together
 * if the world's albedo is ever brought up to physical values.
 */
const GEAR = {
  webbing: [0.70, 0.70, 0.70],
  sling: [0.70, 0.70, 0.70],
  pouch: [0.84, 0.84, 0.84],
  pouchAlt: [0.76, 0.76, 0.76],
  dump: [0.72, 0.72, 0.72],
  belt: [0.62, 0.61, 0.57],
  pad: [0.55, 0.55, 0.55],
  strap: [0.56, 0.56, 0.56],
  wrap: [0.56, 0.54, 0.50],
  glove: [0.38, 0.372, 0.363],
  boot: [0.22, 0.209, 0.198],
  lace: [0.21, 0.204, 0.198],
  // A hard ballistic mask is moulded polymer, not webbing: near-black with a
  // clean sheen, which is what makes the lower face read as a mask at 35 m
  // instead of another patch of tan cloth.
  mask: [0.62, 0.63, 0.66],
}

/**
 * Visual variants. Each is a different silhouette, not a recolour: helmet vs
 * wrapped head, full plate vs chest rig, carbine vs long rifle.
 *
 * The three tints are hue shifts at roughly unit luminance — value is set per
 * part by the table above, so a variant can change colour family without
 * dragging every piece of its kit out of the albedo budget.
 *
 * THESE THREE ARE FROZEN. They are what the pixel gate and the albedo audit are
 * calibrated against. Faction kits are added alongside them from
 * `factionKits.js` and are distinguished by carrying `kit: true`.
 */
export const LEGACY_VARIANTS = {
  vanguard: {
    camo: 'arid',
    clothTint: [1.03, 1.0, 0.94],
    gearTint: [1.08, 0.98, 0.80], // coyote brown
    plateTint: [1.02, 0.96, 0.84],
    skinTint: [1.0, 0.94, 0.88],
    helmet: true,
    helmetCover: true,
    helmetTint: [0.72, 0.72, 0.68],
    goggles: true,
    gogglesDown: true,
    faceWrap: true,
    beard: false,
    kneePads: true,
    fullCarrier: true,
    weapon: 'carbine',
    bulk: 1.0,
    scale: 1.0,
  },
  irregular: {
    camo: 'woodland',
    clothTint: [0.98, 1.02, 0.94],
    gearTint: [0.92, 0.96, 0.74], // olive drab
    plateTint: [0.90, 0.94, 0.80],
    skinTint: [0.86, 0.80, 0.74],
    helmet: false,
    headWrap: true,
    goggles: false,
    // dark wrap-around shooting glasses: the bare head needs a hard horizontal
    // dark band at the eye line or it is a featureless egg at 35 m
    shades: true,
    faceWrap: true,
    beard: true,
    kneePads: false,
    fullCarrier: false,
    weapon: 'ak',
    bulk: 0.94,
    scale: 0.985,
  },
  breacher: {
    camo: 'urban',
    clothTint: [0.98, 0.99, 1.02],
    gearTint: [0.84, 0.86, 0.90], // wolf grey
    plateTint: [0.86, 0.88, 0.92],
    skinTint: [1.06, 0.98, 0.92],
    helmet: true,
    helmetCover: false, // bare painted shell instead of a cloth cover
    helmetTint: [0.82, 0.83, 0.86],
    // goggles parked on the shell (not over the eyes like vanguard) plus a hard
    // ballistic half-mask: same helmet family, completely different head read
    goggles: true,
    gogglesDown: false,
    faceWrap: true,
    maskHard: true,
    beard: true,
    kneePads: true,
    fullCarrier: true,
    weapon: 'carbine',
    bulk: 1.06,
    scale: 1.025,
  },
}

/**
 * Every variant `buildSoldier` can be asked for: the three reference
 * silhouettes plus the faction kits. An unknown name still falls back to
 * `vanguard`, so a host that asks for something this build has never heard of
 * gets a soldier rather than an exception.
 */
export const VARIANTS = { ...LEGACY_VARIANTS, ...FACTION_KITS }

export { KITS_BY_FACTION }

/** Default limb radii — the reference soldier's fitted uniform. */
const ARM_RADII = [0.050, 0.062, 0.056, 0.050, 0.046, 0.042, 0.038]
const LEG_RADII = [0.090, 0.085, 0.076, 0.068, 0.062, 0.060, 0.064]

const bp = (name) => {
  const v = RIG.bindPos[RIG.index(name)]
  return [v.x, v.y, v.z]
}

/**
 * Build one variant.
 *
 * @param name  variant key: a legacy silhouette or a faction kit
 * @param opts.rng         deterministic Rng
 * @param opts.materials   live SoldierMaterials
 * @param opts.faction     'scav' | 'raider' | 'pmc' | 'boss', advisory only —
 *                         the kit record is the authority
 * @param opts.subtype     archetype subtype id, for hue selection
 * @param opts.armorZones  the zones this actor actually rolled armour on. An
 *                         empty array on a civilian kit means NO armour mesh.
 * @returns { geometry, materials: THREE.Material[], weapon, stats }
 */
export function buildSoldier(name, { rng, materials, faction, subtype, armorZones } = {}) {
  const V = VARIANTS[name] ?? VARIANTS.vanguard
  const nz = new Noise(rng.fork())
  const B = new CharacterBuilder(RIG, { noise: nz, materials: MATERIALS })

  /* ---------------- what this actor is wearing ------------------------ */

  const civ = V.civ === true
  // null = the caller did not say, so trust the kit; an array = the actor's
  // real roll, and an empty one is a hard "no armour"
  const rolled = Array.isArray(armorZones) ? armorZones.length > 0 : null
  /**
   * THE SCAV ARMOUR GATE. A civilian kit shows exactly one piece of armour, a
   * PACA soft vest, and only when the actor rolled a plate. `scav_paca` is the
   * variant `agent.js` asks for when `_armorZones` came back non-empty, and the
   * `rolled === true` arm catches the case where some other host built a
   * civilian kit for an actor that did roll one.
   */
  const showPaca = (civ || V.paca === true) && (rolled === null ? V.paca === true : rolled || V.paca === true)
  const showCarrier = V.noCarrier !== true
  const heavy = V.heavyCarrier === true
  const armRadii = V.armRadii ?? ARM_RADII
  const legRadii = V.legRadii ?? LEG_RADII

  const shR = bp('UpperArmR'), elR = bp('ForearmR'), wrR = bp('HandR')
  const shL = bp('UpperArmL'), elL = bp('ForearmL'), wrL = bp('HandL')
  const hipR = bp('UpLegR'), knR = bp('LegR'), anR = bp('FootR')
  const hipL = bp('UpLegL'), knL = bp('LegL'), anL = bp('FootL')
  const head = bp('Head')

  /* ---------------- occlusion proxies (drives baked vertex AO) -------- */
  B.occlude([0, 0.95, -0.01], [0, 1.42, 0.0], 0.155, 1.0) // torso core
  if (showCarrier || showPaca) {
    B.occlude([0, 1.17, 0.130], [0, 1.40, 0.138], 0.11, 1.0) // front plate
    B.occlude([0, 1.20, -0.105], [0, 1.40, -0.112], 0.105, 0.8) // back plate
    B.occlude([-0.02, 1.02, 0.10], [-0.02, 1.02, -0.10], 0.10, 0.6) // carrier hem
  }
  B.occlude([-0.17, 1.16, 0.02], [-0.17, 1.30, 0.02], 0.055, 0.7) // right side
  B.occlude([0.17, 1.16, 0.02], [0.17, 1.30, 0.02], 0.055, 0.7)
  B.occlude([0, 1.60, 0.0], [0, 1.80, -0.01], 0.122, 1.0) // helmet interior
  B.occlude([-0.09, 1.655, 0.05], [0.09, 1.655, 0.05], 0.055, 1.0) // brim shadow
  B.occlude(shR, elR, 0.058, 0.7)
  B.occlude(shL, elL, 0.058, 0.7)
  B.occlude(hipR, knR, 0.085, 0.8)
  B.occlude(hipL, knL, 0.085, 0.8)
  B.occlude([0, 0.90, -0.01], [0, 1.05, -0.01], 0.15, 0.8) // belt line
  // strap crossings — shoulder yokes and the diagonal sling run. These are the
  // places a real uniform is darkest: sweat, webbing dye and ground-in dust all
  // collect where nylon rubs cloth.
  B.occlude([-0.085, 1.42, 0.06], [-0.085, 1.42, -0.06], 0.048, 1.0)
  B.occlude([0.085, 1.42, 0.06], [0.085, 1.42, -0.06], 0.048, 1.0)
  B.occlude([-0.13, 1.40, 0.055], [0.10, 1.10, 0.115], 0.032, 0.9) // sling diagonal
  // cuffs, elbows and knees: the three places a uniform is always ground in
  B.occlude(wrR, [wrR[0], wrR[1] + 0.05, wrR[2]], 0.044, 0.9)
  B.occlude(wrL, [wrL[0], wrL[1] + 0.05, wrL[2]], 0.044, 0.9)
  B.occlude(elR, [elR[0], elR[1] - 0.02, elR[2] - 0.01], 0.052, 0.8)
  B.occlude(elL, [elL[0], elL[1] - 0.02, elL[2] - 0.01], 0.052, 0.8)
  B.occlude(knR, [knR[0], knR[1] - 0.03, knR[2] + 0.01], 0.072, 0.8)
  B.occlude(knL, [knL[0], knL[1] - 0.03, knL[2] + 0.01], 0.072, 0.8)
  B.occlude([anR[0], anR[1] + 0.09, anR[2]], [anR[0], anR[1] + 0.15, anR[2]], 0.062, 0.8)
  B.occlude([anL[0], anL[1] + 0.09, anL[2]], [anL[0], anL[1] + 0.15, anL[2]], 0.062, 0.8)
  B.occlude(GRIP_R, [GRIP_R[0] + BORE_DIR[0] * 0.4, GRIP_R[1] + BORE_DIR[1] * 0.4 + 0.09, GRIP_R[2] + BORE_DIR[2] * 0.4], 0.045, 0.6)
  if (showCarrier) {
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 0.078
      B.occlude([x, 1.20, 0.160], [x, 1.28, 0.164], 0.040, 0.8) // mag pouches
    }
  }
  if (V.coat) {
    // an open coat shades the torso it hangs off, and the inside of its own
    // front flaps
    B.occlude([-0.09, 0.75, 0.09], [-0.09, 1.24, 0.11], 0.06, 0.9)
    B.occlude([0.09, 0.75, 0.09], [0.09, 1.24, 0.11], 0.06, 0.9)
  }

  /* ---------------- uniform ------------------------------------------ */
  const bodyColour = V.stripes && civ ? KIT_COLOUR.trackBody : [1, 1, 1]
  B.add(P.jacketTorso(nz, { bulk: V.bulk, flare: V.flare ?? 1 }), {
    material: 'cloth',
    bones: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'ClavicleR', 'ClavicleL', 'UpperArmR', 'UpperArmL'],
    bias: [1, 1, 1, 1, 0.8, 0.55, 0.55, 0.30, 0.30],
    colour: bodyColour,
    grime: civ ? 0.95 : 0.85,
    dirt: civ ? 0.34 : 0.20,
    dust: 0.34,
    wear: civ ? 0.16 : 0.08,
    name: 'jacket',
  })
  B.add(P.pelvis(nz), {
    material: 'cloth',
    bones: ['Hips', 'Spine', 'UpLegR', 'UpLegL'],
    bias: [1, 0.7, 0.5, 0.5],
    colour: civ && V.cuffs === 'jean' ? KIT_COLOUR.jeans : [0.97, 0.97, 0.97],
    grime: 0.9,
    dirt: 0.35,
    dust: 0.2,
    name: 'pelvis',
  })
  B.add(P.collar(nz), {
    material: 'cloth',
    bones: ['Neck', 'Spine2', 'Head'],
    bias: [1, 0.8, 0.3],
    colour: civ ? KIT_COLOUR.seam : [0.92, 0.92, 0.91],
    grime: 1.0,
    dust: 0.3,
    name: 'collar',
  })

  /* ---------------- civilian layers ---------------------------------- */
  if (V.placket) {
    const j = F.jacketPlacket(nz, {})
    B.add(j.placket, {
      material: 'cloth',
      bones: ['Spine1', 'Spine2', 'Spine', 'Hips'],
      bias: [1, 0.9, 0.7, 0.35],
      colour: KIT_COLOUR.seam,
      grime: 1.0,
      dirt: 0.3,
      dust: 0.28,
      wear: 0.22,
      name: 'placket',
    })
    B.add(j.lapels, {
      material: 'cloth',
      bones: ['Spine2', 'Spine1', 'ClavicleR', 'ClavicleL'],
      bias: [1, 0.7, 0.5, 0.5],
      colour: KIT_COLOUR.seam,
      grime: 0.9,
      dust: 0.4,
      wear: 0.2,
      name: 'lapels',
    })
    B.add(j.hem, {
      material: 'cloth',
      bones: ['Hips', 'Spine'],
      bias: [1, 0.6],
      colour: KIT_COLOUR.seam,
      grime: 1.0,
      dirt: 0.6,
      dust: 0.2,
      wear: 0.24,
      name: 'jacketHem',
    })
  }
  if (V.hood) {
    B.add(F.hoodDown(nz, {}), {
      material: 'cloth',
      bones: ['Neck', 'Spine2', 'Head'],
      bias: [1, 0.8, 0.25],
      colour: KIT_COLOUR.hood,
      grime: 1.0,
      dirt: 0.3,
      dust: 0.45,
      wear: 0.12,
      name: 'hood',
    })
  }
  if (V.pockets) {
    for (const side of [-1, 1]) {
      B.add(F.chestPocket(nz, side * 0.086, 1.256, 0.116, side, 1), {
        material: 'cloth',
        bones: ['Spine1', 'Spine2'],
        bias: [1, 0.8],
        colour: KIT_COLOUR.seam,
        grime: 0.95,
        dust: 0.45,
        wear: 0.2,
        name: side < 0 ? 'pocketR' : 'pocketL',
      })
    }
  }
  if (V.coat) {
    const c = F.openCoat(nz, {})
    B.add(c.skirt, {
      material: 'cloth',
      bones: ['Hips', 'Spine', 'Spine1', 'UpLegR', 'UpLegL'],
      bias: [1, 0.8, 0.5, 0.28, 0.28],
      colour: KIT_COLOUR.coat,
      grime: 0.9,
      dirt: 0.55,
      dust: 0.4,
      wear: 0.18,
      name: 'coatSkirt',
    })
    B.add(c.lapels, {
      material: 'cloth',
      bones: ['Spine2', 'Spine1', 'Neck', 'ClavicleR', 'ClavicleL'],
      bias: [1, 0.7, 0.5, 0.5, 0.5],
      colour: KIT_COLOUR.coatTrim,
      grime: 0.95,
      dust: 0.45,
      wear: 0.22,
      name: 'coatLapels',
    })
  }

  /* ---------------- sleeves ------------------------------------------ */
  for (const [sh, el, wr, side, suffix] of [
    [shR, elR, wrR, -1, 'R'],
    [shL, elL, wrL, 1, 'L'],
  ]) {
    // deltoid cap. The sleeve tube alone meets the torso in a socket, which is
    // half of the "tube arms" read; this gives the shoulder an actual shape and
    // a highlight to catch the key light on.
    B.add(P.shoulderCap(nz, sh, side), {
      material: 'cloth',
      bones: [`Clavicle${suffix}`, `UpperArm${suffix}`, 'Spine2'],
      bias: [0.8, 1, 0.4],
      colour: bodyColour,
      grime: 0.7,
      dust: 0.5,
      wear: 0.06,
      name: `shoulder${suffix}`,
    })
    const armChain = [[sh[0] + side * 0.012, sh[1] + 0.055, sh[2]], el, wr]
    B.add(
      P.limbTube(nz, armChain[0], armChain[1], armChain[2], armRadii, {
        rings: 22,
        seg: 16,
        fold: 0.0016,
        // 3 mm creases: at 35 m that is sub-pixel as displacement but the normals
        // it generates are what put light and shade *inside* the sleeve outline.
        crease: civ ? 0.0038 : 0.0030,
        bend: [0, 0, -1], // sleeve bunches inside the elbow
      }),
      {
        material: 'cloth',
        bones: [`Clavicle${suffix}`, `UpperArm${suffix}`, `Forearm${suffix}`, `Hand${suffix}`, 'Spine2'],
        bias: [0.5, 1, 1, 0.7, 0.25],
        colour: bodyColour,
        grime: 0.8,
        dirt: 0.15,
        dust: 0.3,
        wear: civ ? 0.2 : 0.12,
        name: `sleeve${suffix}`,
      }
    )
    // THREE-STRIPE TRACKSUI