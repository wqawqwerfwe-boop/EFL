/**
 * AI — soldier assembly. Turns the part library into a finished, skinned,
 * material-grouped character. One geometry per visual variant, shared by every
 * instance of that variant; only the skeleton is per-instance.
 *
 * FACTION COMPILER. This used to build one soldier three ways — three camo
 * patterns over one silhouette — which is why every actor in a raid read as the
 * same operator. It now compiles a silhouette per archetype:
 *
 *   scav    civilian layers: work jackets, mismatched tracksuits, dirty jeans,
 *           ushankas and beanies, bunched hoods, repair patches, a found
 *           bandolier. NO plate carrier, NO PALS, NO pauldrons, NO knee pads,
 *           and the only armour they can show is a PACA soft vest — gated on
 *           the actor's rolled `armorZones`, so an unarmoured scav carries no
 *           armour mesh at all.
 *   raider  matching issued kit: full-cut visored helmet with ear cups and a
 *           mandible bar, knee pads, heavy modular carrier with side plates and
 *           shoulder pauldrons.
 *   pmc     the reference soldier: high-cut helmet, goggles, standard carrier.
 *   boss    one signature each. Killa's full-face Maska with the three raised
 *           crown stripes; Shturman's open camo coat.
 *
 * WHAT IS DELIBERATELY UNTOUCHED. `vanguard`, `irregular` and `breacher`
 * compile exactly the geometry and materials they did before: every new part is
 * gated behind a flag no legacy record carries, and `resolveMaterials` keeps its
 * original switch for them. The repo has a pixel gate and an albedo audit
 * (`node src/ai/selftest.mjs`); silently adding a buckle to the reference
 * variants would fail both for no reason.
 *
 * MATERIAL_SLOTS ORDER IS HELD ON EVERY NEW PATH — see the note on that export,
 * it is load-bearing rather than cosmetic. Two additions exist purely to hold
 * it: the belt buckle is the `polymer` part that keeps polymer ahead of `skin`
 * for kits with no magazine pouches (and so no spare mag), and the weapon optic
 * is now added before the weapon steel so `glass` stays ahead of `steel` for
 * kits with no goggles, visor or shades. For the legacy variants glass has
 * already appeared on the head by then, so their order does not move.
 */

import * as THREE from 'three'
import { RIG, GRIP_R, GRIP_L, BORE_DIR } from './rig.js'
import { CharacterBuilder, Noise } from './geo.js'
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
 * The three reference silhouettes. FROZEN: they are what the pixel gate and the
 * albedo audit are calibrated against. Faction kits are merged in from
 * `factionKits.js` below and are distinguished by carrying `kit: true`.
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

/** Every variant `buildSoldier` can be asked for. */
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
 * Resolve a variant name. A host that knows only the faction gets that
 * faction's first kit rather than a tan PMC, and anything genuinely unknown
 * still falls back to `vanguard` — a wrong-looking soldier beats an exception
 * mid-raid.
 */
function resolveVariant(name, faction) {
  if (VARIANTS[name]) return { key: name, V: VARIANTS[name] }
  const pool = faction ? KITS_BY_FACTION[faction] : null
  if (pool && pool.length && VARIANTS[pool[0]]) return { key: pool[0], V: VARIANTS[pool[0]] }
  return { key: 'vanguard', V: VARIANTS.vanguard }
}

/**
 * Build one variant.
 *
 * @param name  variant key: a legacy silhouette or a faction kit
 * @param opts.rng         deterministic Rng
 * @param opts.materials   live SoldierMaterials
 * @param opts.faction     'scav' | 'raider' | 'pmc' | 'boss'. Only used to
 *                         resolve an unknown variant name; the kit record is
 *                         the authority once one is found.
 * @param opts.subtype     archetype subtype id. Recorded on the result but it
 *                         does NOT branch geometry or materials: both are cached
 *                         per variant name by the host and prewarmed before any
 *                         actor exists, so a per-instance branch here would hand
 *                         out a material whose program was never compiled.
 * @param opts.armorZones  the zones this actor actually rolled armour on. An
 *                         empty array on a civilian kit means NO armour mesh.
 * @returns { geometry, materials: THREE.Material[], weapon, stats }
 */
export function buildSoldier(name, { rng, materials, faction, subtype, armorZones } = {}) {
  const resolved = resolveVariant(name, faction)
  const V = resolved.V
  const nz = new Noise(rng.fork())
  const B = new CharacterBuilder(RIG, { noise: nz, materials: MATERIALS })

  /* ---------------- what this actor is wearing ------------------------ */

  const civ = V.civ === true
  // null = the caller did not say, so trust the kit. An array = the actor's real
  // roll, and an empty one is a hard "no armour".
  const rolled = Array.isArray(armorZones) ? armorZones.length > 0 : null
  /**
   * THE SCAV ARMOUR GATE. A civilian kit shows exactly one piece of armour — a
   * PACA soft vest — and only when the actor rolled a plate. `scav_paca` is the
   * variant `agent.js` asks for when `_armorZones` came back non-empty; the
   * `civ && rolled` arm covers a host that built a plain civilian kit for an
   * actor that did roll one, and `rolled === false` removes it outright.
   */
  const showPaca = rolled === false ? false : V.paca === true || (civ && rolled === true)
  const showCarrier = V.noCarrier !== true
  const heavy = V.heavyCarrier === true
  const armRadii = V.armRadii ?? ARM_RADII
  const legRadii = V.legRadii ?? LEG_RADII
  // tracksuit bodies are darkened so their stripes can ride the material tint
  const bodyColour = V.stripes && civ ? KIT_COLOUR.trackBody : [1, 1, 1]
  const legColour = civ && V.cuffs === 'jean' ? KIT_COLOUR.jeans : [0.98, 0.98, 0.97]

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
    // an open coat shades the torso it hangs off and the inside of its own flaps
    B.occlude([-0.09, 0.75, 0.09], [-0.09, 1.24, 0.11], 0.06, 0.9)
    B.occlude([0.09, 0.75, 0.09], [0.09, 1.24, 0.11], 0.06, 0.9)
  }

  /* ---------------- uniform ------------------------------------------ */
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
    colour: civ ? legColour : [0.97, 0.97, 0.97],
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

  /* ---------------- civilian / boss outer layers ---------------------- */
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
      B.add(F.chestPocket(nz, side * 0.086, 1.256, 0.114, side, 1), {
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
    const armBones = [`Clavicle${suffix}`, `UpperArm${suffix}`, `Forearm${suffix}`, `Hand${suffix}`, 'Spine2']
    const armBias = [0.5, 1, 1, 0.7, 0.25]
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
        bones: armBones,
        bias: armBias,
        colour: bodyColour,
        grime: 0.8,
        dirt: 0.15,
        dust: 0.3,
        wear: civ ? 0.2 : 0.12,
        name: `sleeve${suffix}`,
      }
    )
    // THREE-STRIPE TRACKSUIT RIBBONS down the outer face of the arm. The stripes
    // ride the material tint at full vertex colour while the sleeve under them is
    // darkened, which is the only way to get white-on-dark out of one material.
    if (V.stripes) {
      B.add(
        F.trackStripes(armChain, {
          out: [side, 0, 0],
          lateral: [0, 0, 1],
          radius: [armRadii[0], armRadii[3], armRadii[6]],
          count: 3,
          gap: 0.017,
          width: 0.011,
          thick: 0.0035,
          lift: 0.0015,
        }),
        {
          material: 'cloth',
          bones: armBones,
          bias: armBias,
          colour: KIT_COLOUR.trackStripe,
          grime: 0.5,
          dirt: 0.1,
          dust: 0.35,
          wear: 0.1,
          name: `armStripe${suffix}`,
        }
      )
    }
    // elbow reinforcement patch — issued kit only
    if (!civ) {
      B.add(
        P.limbTube(
          nz,
          [el[0] * 0.98 + sh[0] * 0.02, el[1] + 0.05, el[2] - 0.005],
          el,
          [el[0] * 0.98 + wr[0] * 0.02, el[1] - 0.05, el[2] + 0.004],
          [0.050, 0.054, 0.050],
          { rings: 5, seg: 14, fold: 0.001 }
        ),
        {
          material: 'gear',
          bones: [`UpperArm${suffix}`, `Forearm${suffix}`],
          bias: [1, 1],
          colour: GEAR.pad,
          grime: 1.0,
          dirt: 0.25,
          dust: 0.22,
          wear: 0.16,
          name: `elbowPad${suffix}`,
        }
      )
    } else if (V.patches) {
      // a mismatched repair instead: the fastest way to say "not issued"
      B.add(F.clothPatch(nz, [el[0] + side * 0.044, el[1] + 0.004, el[2] - 0.016], [side, 0.1, -0.3], 0.046), {
        material: 'cloth',
        bones: [`UpperArm${suffix}`, `Forearm${suffix}`],
        bias: [1, 1],
        colour: KIT_COLOUR.patch,
        grime: 1.0,
        dirt: 0.4,
        dust: 0.3,
        wear: 0.3,
        name: `elbowPatch${suffix}`,
      })
    }
  }

  /**
   * Scav bandolier. Also the part that keeps `gear` ahead of `boot` in the
   * material order for civilian kits, which have no elbow pads — see
   * MATERIAL_SLOTS.
   */
  if (V.bandolier) {
    B.add(F.bandolier(nz, V.bandolier), {
      material: 'gear',
      bones: ['Spine2', 'Spine1', 'Spine', 'ClavicleR', 'ClavicleL'],
      bias: [1, 0.9, 0.6, 0.5, 0.5],
      colour: KIT_COLOUR.civStrap,
      grime: 1.0,
      dirt: 0.5,
      dust: 0.45,
      wear: 0.34,
      name: 'bandolier',
    })
  }

  /* ---------------- trousers, boots ---------------------------------- */
  for (const [hip, kn, an, suffix] of [
    [hipR, knR, anR, 'R'],
    [hipL, knL, anL, 'L'],
  ]) {
    const side = suffix === 'R' ? -1 : 1
    const legChain = [hip, kn, [an[0], an[1] + 0.085, an[2] + 0.008]]
    const legBones = ['Hips', `UpLeg${suffix}`, `Leg${suffix}`, `Foot${suffix}`]
    const legBias = [0.6, 1, 1, 0.5]
    B.add(
      P.limbTube(nz, legChain[0], legChain[1], legChain[2], legRadii, {
        rings: 24,
        seg: 17,
        fold: 0.0018,
        // trousers crease harder than sleeves and stack on the boot cuff
        crease: civ ? 0.005 : 0.0042,
        bend: [0, 0, -1], // gathers behind the knee
      }),
      {
        material: 'cloth',
        bones: legBones,
        bias: legBias,
        colour: legColour,
        grime: 0.8,
        dirt: civ ? 0.85 : 0.72,
        dust: 0.22,
        wear: civ ? 0.22 : 0.10,
        name: `leg${suffix}`,
      }
    )
    if (V.stripes) {
      B.add(
        F.trackStripes(legChain, {
          out: [side, 0, 0],
          lateral: [0, 0, 1],
          radius: [legRadii[0], legRadii[3], legRadii[6]],
          count: 3,
          gap: 0.019,
          width: 0.013,
          thick: 0.004,
          lift: 0.0015,
        }),
        {
          material: 'cloth',
          bones: legBones,
          bias: legBias,
          colour: KIT_COLOUR.trackStripe,
          grime: 0.6,
          dirt: 0.2,
          dust: 0.35,
          wear: 0.12,
          name: `legStripe${suffix}`,
        }
      )
    }
    // cargo pocket on the outer thigh — issued trousers only
    if (!civ) {
      B.add(
        P.pouch(nz, {
          hx: 0.052, hy: 0.070, hz: 0.026,
          x: hip[0] + side * 0.062, y: hip[1] - 0.16, z: 0.026,
          rz: side * 0.06, ry: side * 0.55, bend: 0.11,
        }),
        {
          material: 'cloth',
          bones: [`UpLeg${suffix}`, 'Hips'],
          bias: [1, 0.4],
          colour: [0.95, 0.95, 0.94],
          grime: 0.9,
          dirt: 0.5,
          dust: 0.4,
          wear: 0.16,
          name: `cargo${suffix}`,
        }
      )
    }
    if (V.kneePads) {
      B.add(P.kneePad(nz, kn, side), {
        material: 'gear',
        bones: [`Leg${suffix}`, `UpLeg${suffix}`],
        bias: [1, 0.5],
        colour: GEAR.pad,
        grime: 1.0,
        dirt: 0.9,
        dust: 0.28,
        wear: 0.20,
        name: `knee${suffix}`,
      })
    }
    // boots
    B.add(P.boot(nz, an, side), {
      material: 'boot',
      bones: [`Leg${suffix}`, `Foot${suffix}`, `Toe${suffix}`],
      bias: [0.55, 1, 0.6],
      colour: GEAR.boot,
      grime: 0.9,
      dirt: 0.85,
      dust: 0.5,
      wear: 0.3,
      name: `boot${suffix}`,
    })
    B.add(P.bootSole(an), {
      material: 'rubber',
      bones: [`Foot${suffix}`, `Toe${suffix}`],
      bias: [1, 0.8],
      grime: 0.9,
      dirt: 1.0,
      name: `sole${suffix}`,
    })
    B.add(P.bootLaces(an), {
      material: 'boot',
      bone: `Foot${suffix}`,
      colour: GEAR.lace,
      grime: 0.9,
      dirt: 0.85,
      name: `laces${suffix}`,
    })
    // Civilian trousers do not blouse into the boot: jeans STACK on the laces,
    // tracksuit hems grip the ankle. Either one breaks the clean combat-trouser
    // line that reads as issued kit.
    if (V.cuffs === 'jean') {
      B.add(F.jeanCuffs(nz, an, side), {
        material: 'cloth',
        bones: [`Leg${suffix}`, `Foot${suffix}`],
        bias: [1, 0.55],
        colour: KIT_COLOUR.jeans,
        grime: 1.0,
        dirt: 0.95,
        dust: 0.4,
        wear: 0.34,
        name: `jeanCuff${suffix}`,
      })
    } else if (V.cuffs === 'track') {
      B.add(F.trackCuffs(nz, an), {
        material: 'cloth',
        bones: [`Leg${suffix}`, `Foot${suffix}`],
        bias: [1, 0.55],
        colour: bodyColour,
        grime: 1.0,
        dirt: 0.9,
        dust: 0.4,
        wear: 0.28,
        name: `trackCuff${suffix}`,
      })
    }
  }

  /* ---------------- armour ------------------------------------------- */
  const carrierBones = ['Spine', 'Spine1', 'Spine2', 'ClavicleR', 'ClavicleL']
  const carrierBias = [0.7, 1, 1, 0.45, 0.45]

  if (showPaca) {
    // SOFT ARMOUR ONLY: two thin panels and a shoulder yoke, no cummerbund and
    // no PALS. See factionParts.pacaVest — the moment it grows hardware it stops
    // reading as a scav who found a vest.
    B.add(F.pacaVest(nz, {}), {
      material: 'plate',
      bones: carrierBones,
      bias: carrierBias,
      colour: KIT_COLOUR.paca,
      grime: 1.0,
      dirt: 0.5,
      dust: 0.4,
      wear: 0.34,
      name: 'paca',
    })
  } else if (showCarrier && heavy) {
    const hc = F.heavyCarrier(nz, {})
    B.add(hc.plates, {
      material: 'plate',
      bones: carrierBones,
      bias: carrierBias,
      colour: KIT_COLOUR.carrier,
      grime: 0.85,
      dirt: 0.3,
      dust: 0.3,
      wear: 0.2,
      name: 'carrier',
    })
    // pauldrons square off the shoulder line — the raider's silhouette cue, and
    // the reason they read as armoured before the tint is even visible
    B.add(hc.pauldrons, {
      material: 'plate',
      bones: ['ClavicleR', 'ClavicleL', 'Spine2', 'UpperArmR', 'UpperArmL'],
      bias: [1, 1, 0.6, 0.35, 0.35],
      colour: KIT_COLOUR.pauldron,
      grime: 0.8,
      dirt: 0.25,
      dust: 0.45,
      wear: 0.3,
      name: 'pauldrons',
    })
    B.add(hc.webbing, {
      material: 'gear',
      bones: ['Spine1', 'Spine2'],
      bias: [1, 1],
      colour: GEAR.webbing,
      grime: 1.0,
      dust: 0.3,
      wear: 0.26,
      name: 'webbing',
    })
  } else if (showCarrier) {
    B.add(P.plateCarrier(nz, V), {
      material: 'plate',
      bones: carrierBones,
      bias: carrierBias,
      colour: [0.72, 0.72, 0.72],
      grime: 0.85,
      dirt: 0.3,
      dust: 0.30,
      wear: 0.18,
      name: 'carrier',
    })
    B.add(P.carrierWebbing(), {
      material: 'gear',
      bones: ['Spine1', 'Spine2'],
      bias: [1, 1],
      colour: GEAR.webbing,
      grime: 1.0,
      dust: 0.3,
      wear: 0.26,
      name: 'webbing',
    })
  }

  /* ---------------- load-bearing gear -------------------------------- */
  if (showCarrier) {
    // magazine pouches across the front, deliberately not evenly loaded
    const nPouch = V.fullCarrier ? 3 : 2
    for (let i = 0; i < nPouch; i++) {
      const t = nPouch === 1 ? 0.5 : i / (nPouch - 1)
      const x = (t - 0.5) * (nPouch > 2 ? 0.156 : 0.09)
      B.add(
        P.pouch(nz, {
          hx: 0.033, hy: 0.056, hz: 0.034,
          x, y: 1.236 + rng.range(-0.006, 0.006), z: heavy ? 0.156 : 0.148,
          rx: -0.10, rz: rng.range(-0.05, 0.05),
          lidTilt: i === 1 ? -0.5 : 0,
          bend: 0.26,
        }),
        {
          material: 'gear',
          bones: ['Spine1', 'Spine2', 'Spine'],
          bias: [1, 0.8, 0.4],
          colour: i === 1 ? GEAR.pouchAlt : GEAR.pouch,
          grime: 0.9,
          dirt: 0.25,
          dust: 0.5,
          wear: 0.30,
          name: `magPouch${i}`,
        }
      )
      // a magazine sticking out of the open pouch
      if (i === 1) {
        const mag = P.pouch(nz, {
          hx: 0.0145, hy: 0.042, hz: 0.023,
          x, y: 1.308, z: heavy ? 0.160 : 0.152, rx: -0.12,
        })
        B.add(mag, {
          material: 'polymer',
          bones: ['Spine1', 'Spine2'],
          bias: [1, 0.8],
          grime: 0.4,
          wear: 0.2,
          name: 'spareMag',
        })
      }
    }

    // radio on the left chest, admin pouch on the right
    B.add(
      P.pouch(nz, {
        hx: 0.032, hy: 0.058, hz: 0.028,
        x: 0.112, y: 1.336, z: 0.118, ry: 0.35, rz: 0.10, bend: 0.24,
      }),
      {
        material: 'gear',
        bones: ['Spine2', 'ClavicleL', 'Spine1'],
        bias: [1, 0.5, 0.5],
        colour: GEAR.pouchAlt,
        grime: 0.9,
        dust: 0.5,
        wear: 0.22,
        name: 'radio',
      }
    )
    const ant = P.pouch(nz, { hx: 0.005, hy: 0.075, hz: 0.005, x: 0.116, y: 1.424, z: 0.104, rx: -0.18 })
    B.add(ant, {
      material: 'polymer',
      bones: ['Spine2', 'ClavicleL'],
      bias: [1, 0.6],
      grime: 0.3,
      name: 'antenna',
    })
  }

  B.add(P.belt(nz), {
    material: 'gear',
    bones: ['Hips', 'Spine'],
    bias: [1, 0.5],
    colour: civ ? KIT_COLOUR.civStrap : GEAR.belt,
    grime: 1.0,
    dirt: 0.4,
    dust: 0.25,
    wear: 0.26,
    name: 'belt',
  })
  /**
   * Belt buckle. Also the `polymer` part that keeps polymer ahead of `skin` for
   * kits with no magazine pouches and therefore no spare magazine — see
   * MATERIAL_SLOTS. Gated so the reference variants are unchanged.
   */
  if (V.buckle) {
    B.add(P.pouch(nz, { hx: 0.030, hy: 0.021, hz: 0.010, x: 0, y: 0.902, z: 0.116, bend: 0.20 }), {
      material: 'polymer',
      bones: ['Hips', 'Spine'],
      bias: [1, 0.4],
      grime: 0.6,
      dust: 0.3,
      wear: 0.35,
      name: 'buckle',
    })
  }
  B.add(P.hipPouch(nz, -1), {
    material: 'gear',
    bones: ['Hips', 'Spine'],
    bias: [1, 0.4],
    colour: civ ? KIT_COLOUR.civStrap : GEAR.dump,
    grime: 0.95,
    dirt: 0.6,
    dust: 0.45,
    wear: 0.26,
    name: 'dumpPouch',
  })

  /* ---------------- head --------------------------------------------- */
  const wrapped = V.faceWrap
  B.add(P.headMesh(nz, head, {}), {
    material: 'skin',
    bone: 'Head',
    colour: [1, 1, 1],
    grime: civ ? 0.55 : 0.3,
    dirt: civ ? 0.2 : 0.06,
    name: 'head',
  })
  B.add(P.nose(nz, head), { material: 'skin', bone: 'Head', grime: 0.25, name: 'nose' })
  B.add(P.ear(nz, head, -1), { material: 'skin', bone: 'Head', grime: 0.45, name: 'earR' })
  B.add(P.ear(nz, head, 1), { material: 'skin', bone: 'Head', grime: 0.45, name: 'earL' })
  for (const side of [-1, 1]) {
    B.add(P.eyeball(head, side), {
      material: 'polymer',
      bone: 'Head',
      colour: [0.55, 0.5, 0.45],
      grime: 0.2,
      name: 'eye',
    })
  }
  // neck
  B.add(
    P.limbTube(nz, [head[0], head[1] - 0.10, head[2] - 0.012], [head[0], head[1] - 0.05, head[2] - 0.008], [head[0], head[1], head[2]],
      [0.058, 0.056, 0.054], { rings: 5, seg: 14, fold: 0.001 }),
    {
      material: 'skin',
      bones: ['Neck', 'Head', 'Spine2'],
      bias: [1, 0.7, 0.4],
      grime: 0.5,
      name: 'neck',
    }
  )

  if (wrapped) {
    // A hard ballistic mask is moulded polymer on the *same* geometry: the seam
    // and the bridge fold read as the mask's edge and nose vent instead of a
    // cloth hem, and it lands far darker than any cloth in the kit, which is
    // what gives that variant a legible face at range.
    B.add(P.faceWrap(nz, head, V), {
      material: V.maskHard ? 'polymer' : 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.5],
      colour: V.maskHard ? GEAR.mask : V.helmet ? GEAR.wrap : [0.78, 0.74, 0.66],
      grime: V.maskHard ? 0.5 : 0.85,
      dirt: V.maskHard ? 0.1 : 0.2,
      dust: V.maskHard ? 0.2 : 0.3,
      wear: V.maskHard ? 0.3 : 0.1,
      name: 'faceWrap',
    })
  }

  if (V.killa) {
    /**
     * KILLA. A blunt Maska shell with the three raised crown stripes, and a
     * faceplate that covers the whole face rather than the eye line. The
     * stripes ride the bright `plateTint` at near-full vertex colour while the
     * shell is pulled down to a carrier value, so one material yields a dark
     * helmet with pale stripes.
     */
    const k = F.killaHelmet(nz, head, {})
    B.add(k.shell, {
      material: 'plate',
      bone: 'Head',
      colour: KIT_COLOUR.killaShell,
      grime: 0.8,
      dirt: 0.3,
      dust: 0.4,
      wear: 0.45,
      name: 'killaShell',
    })
    B.add(k.stripes, {
      material: 'plate',
      bone: 'Head',
      colour: KIT_COLOUR.killaStripe,
      grime: 0.45,
      dirt: 0.1,
      dust: 0.3,
      wear: 0.25,
      name: 'killaStripes',
    })
    B.add(k.visor, { material: 'glass', bone: 'Head', colour: [1, 1, 1], grime: 0.2, name: 'killaVisor' })
    B.add(P.chinStrap(head), {
      material: 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.4],
      colour: GEAR.strap,
      grime: 0.95,
      dust: 0.25,
      wear: 0.18,
      name: 'chinStrap',
    })
  } else if (V.visorHelmet) {
    // RAIDER. Full-cut shell that comes down over the ears, ear cups, a mandible
    // bar and a flip-down visor — an assaulter, not a soldier in a high-cut.
    const h = F.visorHelmet(nz, head, { visorUp: V.visorUp })
    B.add(h.shell, {
      material: 'plate',
      bone: 'Head',
      colour: KIT_COLOUR.raiderShell,
      grime: 0.7,
      dirt: 0.2,
      dust: 0.5,
      wear: 0.4,
      name: 'helmet',
    })
    B.add(h.mandible, {
      material: 'plate',
      bones: ['Head', 'Neck'],
      bias: [1, 0.3],
      colour: KIT_COLOUR.raiderShell,
      grime: 0.75,
      dust: 0.35,
      wear: 0.35,
      name: 'mandible',
    })
    B.add(h.cups, { material: 'polymer', bone: 'Head', grime: 0.5, wear: 0.3, name: 'helmetHW' })
    B.add(h.visor, { material: 'glass', bone: 'Head', colour: [1, 1, 1], grime: 0.18, name: 'visor' })
    B.add(P.chinStrap(head), {
      material: 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.4],
      colour: GEAR.strap,
      grime: 0.95,
      dust: 0.25,
      wear: 0.18,
      name: 'chinStrap',
    })
  } else if (V.helmet) {
    // A covered helmet is CLOTH, not plastic: the camo cover is the single
    // biggest reason a helmet reads as a helmet rather than a bowling ball. Its
    // tint deliberately lands off the uniform value so the head separates from
    // the torso at range. A bare shell goes on the laminate set instead.
    B.add(P.helmet(nz, head, V), {
      material: V.helmetCover ? 'cloth' : 'plate',
      bone: 'Head',
      colour: V.helmetTint ?? [1, 1, 1],
      grime: 0.6,
      dirt: 0.2,
      dust: 0.55,
      wear: 0.4,
      name: 'helmet',
    })
    B.add(P.helmetHardware(nz, head), {
      material: 'polymer',
      bone: 'Head',
      grime: 0.5,
      wear: 0.3,
      name: 'helmetHW',
    })
    B.add(P.chinStrap(head), {
      material: 'gear',
      bones: ['Head', 'Neck'],
      bias: [1, 0.4],
      colour: GEAR.strap,
      grime: 0.95,
      dust: 0.25,
      wear: 0.18,
      name: 'chinStrap',
    })
    if (V.goggles) {
      const g = P.goggles(head, V.gogglesDown)
      B.add(g.frame, { material: 'polymer', bone: 'Head', grime: 0.4, wear: 0.35, name: 'goggleFrame' })
      B.add(g.strap, {
        material: 'gear',
        bone: 'Head',
        colour: GEAR.strap,
        grime: 0.85,
        dust: 0.3,
        name: 'goggleStrap',
      })
      B.add(P.goggleLens(head, V.gogglesDown), {
        material: 'glass',
        bone: 'Head',
        colour: [1, 1, 1],
        grime: 0.15,
        name: 'goggleLens',
      })
    }
  } else if (V.headgear === 'ushanka') {
    // The single most legible "not a soldier" cue available: fur, and a
    // silhouette wider than the skull.
    const h = F.ushanka(nz, head, { flapsUp: V.flapsUp })
    B.add(h.crown, {
      material: 'cloth',
      bone: 'Head',
      colour: KIT_COLOUR.hat,
      grime: 0.9,
      dirt: 0.3,
      dust: 0.5,
      wear: 0.2,
      name: 'ushanka',
    })
    B.add(h.fur, {
      material: 'cloth',
      bone: 'Head',
      colour: KIT_COLOUR.fur,
      grime: 1.0,
      dirt: 0.45,
      dust: 0.55,
      wear: 0.3,
      name: 'ushankaFur',
    })
    B.add(h.flaps, {
      material: 'cloth',
      bones: ['Head', 'Neck'],
      bias: [1, 0.3],
      colour: KIT_COLOUR.fur,
      grime: 1.0,
      dirt: 0.4,
      dust: 0.5,
      wear: 0.28,
      name: 'ushankaFlaps',
    })
  } else if (V.headgear === 'beanie') {
    B.add(F.beanie(nz, head, { bobble: V.bobble }), {
      material: 'cloth',
      bone: 'Head',
      colour: KIT_COLOUR.hat,
      grime: 1.0,
      dirt: 0.35,
      dust: 0.5,
      wear: 0.26,
      name: 'beanie',
    })
  } else if (V.headgear === 'cap') {
    const c = F.civCap(nz, head, { flat: V.flatCap })
    B.add(c.crown, {
      material: 'cloth',
      bone: 'Head',
      colour: KIT_COLOUR.hat,
      grime: 0.95,
      dirt: 0.3,
      dust: 0.5,
      wear: 0.24,
      name: 'cap',
    })
    // the peak is the whole point: a hard horizontal shadow across the brow
    B.add(c.peak, {
      material: 'cloth',
      bone: 'Head',
      colour: KIT_COLOUR.seam,
      grime: 0.9,
      dirt: 0.25,
      dust: 0.4,
      wear: 0.3,
      name: 'capPeak',
    })
  } else if (V.headWrap) {
    B.add(P.headScarf(nz, head), {
      // hue comes from the variant's cloth tint; the VALUE sits below the uniform
      // so the head is never the brightest thing on the figure
      material: 'cloth',
      bone: 'Head',
      colour: [0.82, 0.80, 0.76],
      grime: 0.8,
      dirt: 0.25,
      dust: 0.4,
      wear: 0.14,
      name: 'shemagh',
    })
  }

  if (V.shades) {
    const s = P.sunglasses(head)
    B.add(s.frame, { material: 'polymer', bone: 'Head', grime: 0.4, wear: 0.3, name: 'shadeFrame' })
    B.add(s.lens, {
      material: 'glass',
      bone: 'Head',
      colour: [1, 1, 1],
      grime: 0.2,
      name: 'shadeLens',
    })
  }

  /* ---------------- hands + weapon ----------------------------------- */
  const bore = new THREE.Vector3(...BORE_DIR).normalize()
  const palmR = new THREE.Vector3(-0.55, 0.35, -0.75).normalize()
  const palmL = new THREE.Vector3(0.75, 0.30, -0.60).normalize()
  const gripAxisR = new THREE.Vector3(0.18, 0.92, -0.34).normalize() // down the grip
  const gripAxisL = bore.clone()
  const gloveColour = civ ? KIT_COLOUR.civGlove : GEAR.glove

  B.add(P.glove(nz, wrR, [gripAxisR.x, gripAxisR.y, gripAxisR.z], [palmR.x, palmR.y, palmR.z], -1), {
    material: 'boot',
    bones: ['HandR', 'ForearmR'],
    bias: [1, 0.35],
    colour: gloveColour,
    grime: 0.9,
    dirt: 0.3,
    dust: 0.25,
    wear: 0.28,
    name: 'gloveR',
  })
  B.add(P.glove(nz, wrL, [gripAxisL.x, gripAxisL.y, gripAxisL.z], [palmL.x, palmL.y, palmL.z], 1), {
    material: 'boot',
    bones: ['HandL', 'ForearmL'],
    bias: [1, 0.35],
    colour: gloveColour,
    grime: 0.9,
    dirt: 0.3,
    dust: 0.25,
    wear: 0.28,
    name: 'gloveL',
  })
  // Hard knuckle guards are issued kit. A scav gets bare gloves, which is one
  // more silhouette difference at the hands.
  if (!civ) {
    B.add(P.knuckleGuard(wrR, [gripAxisR.x, gripAxisR.y, gripAxisR.z], [palmR.x, palmR.y, palmR.z]), {
      material: 'polymer',
      bone: 'HandR',
      grime: 0.5,
      wear: 0.35,
      name: 'knuckleR',
    })
    B.add(P.knuckleGuard(wrL, [gripAxisL.x, gripAxisL.y, gripAxisL.z], [palmL.x, palmL.y, palmL.z]), {
      material: 'polymer',
      bone: 'HandL',
      grime: 0.5,
      wear: 0.35,
      name: 'knuckleL',
    })
  }

  const W = buildWeapon(nz, V.weapon, rng)
  // Optic glass BEFORE the steel: for a kit with no goggles, visor or shades
  // this is where `glass` first appears, and it has to land ahead of `steel` to
  // hold MATERIAL_SLOTS. The legacy variants already registered glass on the
  // head, so their material order does not move.
  if (W.glass.p.length) {
    B.add(W.glass, { material: 'glass', bone: 'HandR', grime: 0.1, name: 'wpnGlass' })
  }
  B.add(W.steel, { material: 'steel', bone: 'HandR', grime: 0.55, wear: 0.25, name: 'wpnSteel' })
  B.add(W.polymer, { material: 'polymer', bone: 'HandR', grime: 0.5, wear: 0.3, name: 'wpnPoly' })
  B.add(W.rubber, { material: 'rubber', bone: 'HandR', grime: 0.6, name: 'wpnRubber' })

  // sling: body-bound so it stays on the chest as the arms move
  B.add(P.sling(W.foregrip, W.stockTop), {
    material: 'gear',
    bones: ['Spine2', 'Spine1', 'ClavicleR', 'ClavicleL', 'Hips'],
    bias: [1, 0.8, 0.5, 0.5, 0.3],
    colour: civ ? KIT_COLOUR.civStrap : GEAR.sling,
    grime: 1.0,
    dust: 0.2,
    wear: 0.22,
    name: 'sling',
  })

  const built = B.build()
  // Guard the prewarm contract: see MATERIAL_SLOTS.
  if (built.materialNames.join() !== MATERIAL_SLOTS.filter((s) => built.materialNames.includes(s)).join()) {
    console.warn(
      `[ai] material slot order changed for "${resolved.key}" (${built.materialNames.join()}); ` +
        'update MATERIAL_SLOTS or prewarmMaterials will reorder opaque draws'
    )
  }
  const mats = resolveMaterials(resolved.key, built.materialNames, materials)

  return {
    geometry: built.geometry,
    materials: mats,
    parts: built.parts,
    weapon: W,
    stats: { vertices: built.vertices, triangles: built.triangles },
    variant: V,
    variantName: resolved.key,
    faction: V.faction ?? faction ?? null,
    subtype: subtype ?? null,
    armoured: showPaca || (showCarrier && !civ),
  }
}

/**
 * Every material slot a soldier's geometry is grouped by, IN THE ORDER
 * `CharacterBuilder.build()` emits them — which is the order the parts are added
 * above, deduplicated.
 *
 * THE ORDER IS LOAD-BEARING, and this is not a style preference. `THREE.Material`
 * hands out globally incrementing ids and three sorts the opaque render list by
 * `material.id` (`painterSortStable`), including the groups *within* one soldier.
 * Create them in a different order and the goggle lens draws before its frame
 * instead of after it; with a depth prepass in front, whichever coplanar surface
 * is drawn last wins the equal-depth test. MEASURED: prewarming these in a
 * hand-written order moved 2 pixels of the `combat` shot by 1/255 and failed the
 * pixel gate. `buildSoldier` asserts the order below still matches.
 *
 * A variant may use a SUBSET — an unarmoured scav has no `plate` group and a
 * bare-headed one may have no `glass` — and the guard compares against the
 * filtered list, so a subsequence is fine. What is never fine is a reordering,
 * which is why the belt buckle (polymer) and the optic glass are added where
 * they are.
 */
export const MATERIAL_SLOTS = Object.freeze([
  'cloth', 'gear', 'boot', 'rubber', 'plate', 'polymer', 'skin', 'glass', 'steel',
])

/**
 * Resolve a variant's material slot names to real materials.
 *
 * Split out of `buildSoldier` on purpose: `AiSystem.prewarmMaterials()` needs
 * every material a variant will ever ask for so their shader programs can be
 * compiled while a loading screen is up, and it must be able to get them WITHOUT
 * building a single triangle (geometry construction draws from the shared RNG
 * stream, so doing it early would move every downstream random draw and change
 * the picture). `SoldierMaterials.get()` is a pure function of its key and opts,
 * so calling it early is free of side effects.
 *
 * `detail` is the second half of the two-scale system: the base tile carries the
 * macro camo and the garment seams, this tile carries the weave and the webbing
 * ribbing. `scale` converts the base tile's UVs (metres / tile) into the detail
 * tile's, so the physical size of a thread is identical on a sleeve, a pouch and
 * a boot without any per-part tuning.
 */
export function resolveMaterials(name, slots, materials) {
  const V = VARIANTS[name] ?? VARIANTS.vanguard
  const detail = (set, matName, normal, rough) => ({
    set,
    scale: MATERIALS[matName].tile / DETAIL_TILE,
    normal,
    rough,
  })
  if (V.kit) return resolveKitMaterials(V, slots, materials, detail)
  return slots.map((n) => {
    switch (n) {
      case 'cloth':
        return materials.get(`camo_${V.camo}`, {
          key: name,
          tint: V.clothTint,
          rough: ROUGH.cloth,
          metal: 1,
          // 1.15, not 1.0: the base tile now carries a 1-2 cm crease field and
          // the folds have to actually catch the key light at 25 m.
          normalScale: 1.15,
          detail: detail('cloth', 'cloth', 0.45, 0.16),
        })
      case 'plate':
        return materials.get('plate', {
          key: name,
          tint: V.plateTint,
          rough: ROUGH.plate,
          normalScale: 1.0,
          detail: detail('nylon', 'plate', 0.45, 0.10),
        })
      case 'gear':
        return materials.get('nylon', {
          key: name,
          tint: V.gearTint,
          normalScale: 1.1,
          detail: detail('nylon', 'gear', 0.5, 0.14),
        })
      case 'boot':
        return materials.get('nylon', {
          key: `${name}_boot`,
          tint: V.gearTint,
          rough: ROUGH.boot,
          normalScale: 1.1,
          detail: detail('nylon', 'boot', 0.5, 0.10),
        })
      case 'skin':
        return materials.get('skin', { key: name, tint: V.skinTint, normalScale: 0.8, ao: 0.6 })
      case 'polymer':
        return materials.get('polymer', { key: name, normalScale: 1.0 })
      case 'steel':
        return materials.get('steel', { key: name, normalScale: 1.0 })
      case 'rubber':
        return materials.get('rubber', { key: name, normalScale: 1.2 })
      case 'glass':
        return materials.glass()
      default:
        return materials.get('polymer', { key: name })
    }
  })
}

/**
 * Faction kits go through `materialSpecs`, which states each slot as intent —
 * bake, tint, absolute roughness already divided by that bake's map average, and
 * which detail tile to blend. The tile scale is applied here because the tile
 * table lives in this file.
 *
 * The camo set in the spec has ALREADY been checked against `materials.sets`;
 * `SoldierMaterials.get()` throws on a pattern the host never baked, and
 * `camo_urban` in particular is absent unless the host asked for it.
 */
function resolveKitMaterials(V, slots, materials, detail) {
  const spec = materialSpecs(V, materials)
  return slots.map((n) => {
    if (n === 'glass') return materials.glass()
    const s = spec[n] ?? spec.polymer
    const opts = { key: `${V.id}_${n}` }
    if (s.tint) opts.tint = s.tint
    if (s.rough !== undefined && s.rough !== null) opts.rough = s.rough
    if (s.metal !== undefined) opts.metal = s.metal
    if (s.normalScale !== undefined) opts.normalScale = s.normalScale
    if (s.ao !== undefined) opts.ao = s.ao
    if (s.detail) opts.detail = detail(s.detail.set, s.detail.tile, s.detail.normal, s.detail.rough)
    return materials.get(s.set, opts)
  })
}
