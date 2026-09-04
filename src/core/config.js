/**
 * Central tuning + quality configuration.
 * Subsystems read from here rather than hardcoding magic numbers, so the
 * quality scaler and the capture harness can drive everything from one place.
 */

export const PHYSICS_HZ = 120;
export const FIXED_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this many physics steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;

/** Real-world units are metres, seconds, kilograms. */
export const UNITS = {
  gravity: -9.81 * 2.1, // Games use exaggerated gravity; CoD-like feel.
  playerHeight: 1.78,
  playerCrouchHeight: 1.12,
  playerRadius: 0.32,
  eyeOffset: 0.12, // below top of capsule
};

export const QUALITY_PRESETS = {
  low: {
    renderScale: 0.72,
    shadowMapSize: 1024,
    cascades: 3,
    shadowDistance: 60,
    taa: false,
    gtao: false,
    ssr: false,
    volumetrics: false,
    motionBlur: false,
    bloom: true,
    anisotropy: 4,
    particleBudget: 2000,
    decalBudget: 64,
  },
  medium: {
    renderScale: 0.85,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 90,
    taa: true,
    gtao: true,
    ssr: false,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 8,
    particleBudget: 6000,
    decalBudget: 128,
  },
  high: {
    renderScale: 1.0,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 140,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 12000,
    decalBudget: 256,
  },
  ultra: {
    renderScale: 1.0,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 200,
    taa: true,
    gtao: true,
    ssr: true,
    volumetrics: true,
    motionBlur: true,
    bloom: true,
    anisotropy: 16,
    particleBudget: 24000,
    decalBudget: 512,
  },
};

export const DEFAULTS = {
  quality: 'ultra',
  fov: 80, // horizontal-ish vertical FOV, CoD default feel
  adsFovScale: 0.72,
  sensitivity: 0.0022,
  adsSensScale: 0.65,
  invertY: false,
  exposure: 1.0,
  /** Capture mode disables anything nondeterministic so screenshots are stable. */
  deterministic: false,
};

export function createConfig(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  cfg.q = { ...QUALITY_PRESETS[cfg.quality] };
  cfg.setQuality = (name) => {
    if (!QUALITY_PRESETS[name]) throw new Error(`unknown quality preset "${name}"`);
    cfg.quality = name;
    Object.assign(cfg.q, QUALITY_PRESETS[name]);
  };
  return cfg;
}

/* ==================== EFL ==================== */

/** Тарковский фов уже, чем CoD-шный: 75 по вертикали. */
DEFAULTS.fov = 75;
DEFAULTS.adsFovScale = 0.62;

export const EFL = {
  raid: {
    extractHold: 7,          // сек в зоне выхода
    transferHold: 9,         // переход на другую локацию
    lootSearchTime: 1.4,     // обыск контейнера
    corpseSearchTime: 2.2,
  },
  survival: {
    energyDrain: 0.055,      // ед/сек
    hydraDrain: 0.07,
    bleedLight: 0.42,        // хп/сек
    bleedHeavy: 1.35,
    starveDamage: 0.35,
  },
  weight: {
    free: 28,                // кг без штрафа
    maxPenalty: 0.5,         // максимум -50% к скорости
    perKg: 0.012,
  },
  stash: { width: 10, rows: 30, maxRows: 60 },
  /** Бюджеты. Ни одна подсистема не имеет права их превысить. */
  budgets: {
    bots: 24,                // живых ботов на карте
    botsUpdatedPerFrame: 6,  // time-slicing ИИ
    pathRequestsPerFrame: 2,
    lootPoints: 140,
    corpses: 16,             // старые трупы схлопываются в «мешок» без меша
    decalsPerSurface: 3,
  },
  /** Фиксированное число видимых point-light. См. раздел про permutation key. */
  lightSlots: { factory: 20, customs: 16, woods: 8, interchange: 22, lab: 18 },
};

/** Интерьерным картам не нужны 200 м теней — режем каскады под EFL. */
QUALITY_PRESETS.high.shadowDistance = 90;
QUALITY_PRESETS.ultra.shadowDistance = 120;
QUALITY_PRESETS.medium.shadowDistance = 60;