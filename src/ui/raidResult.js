/* ==========================================================================
 * Escape-From-Larpov · src/ui/raidResult.js
 * Последовательные экраны итогов рейда:
 *   1. Список убийств   2. Статистика рейда   3. Опыт (с проверкой уровня)
 *
 * Формат payload — ровно то, что шлёт RaidSystem.end():
 *   { kind, kills, xp, value, time, exit, mapId, faction, night }
 * kind ∈ 'survived' | 'killed' | 'mia' | 'deserted'
 * Реестра убитых в payload НЕТ — есть только счётчик kills, поэтому экран 1
 * синтезирует имена из пула-заглушки.
 * ========================================================================== */

import {
  ensureTarkovFonts,
  formatRaidClock,
  call,
  playUiSound,
  installAudioCompat,
  STATE,
} from './escapeMenu.js'

export const RAID_STEP = {
  KILLS: 'kills',
  STATS: 'stats',
  EXPERIENCE: 'experience',
}

export const RAID_STEP_ORDER = [RAID_STEP.KILLS, RAID_STEP.STATS, RAID_STEP.EXPERIENCE]

const STEP_TITLES = {
  kills: 'СПИСОК УБИЙСТВ',
  stats: 'СТАТИСТИКА РЕЙДА',
  experience: 'ПОЛУЧЕННЫЙ ОПЫТ',
}

const STEP_LABELS = {
  kills: 'Убийства',
  stats: 'Статистика',
  experience: 'Опыт',
}

/* Статусы совпадают с kind из RaidSystem.end(). */
const KIND_META = {
  survived: { label: 'ВЫЖИЛ', tone: 'ok' },
  killed: { label: 'ПОГИБ', tone: 'bad' },
  mia: { label: 'ПРОПАЛ БЕЗ ВЕСТИ', tone: 'warn' },
  deserted: { label: 'ДЕЗЕРТИР', tone: 'bad' },
}

const MAP_TITLES = {
  factory: 'Завод',
  woods: 'Лес',
  customs: 'Таможня',
  cyberlarp: 'CyberLarp',
}

/* Пул имён для экрана 1: RaidSystem не ведёт реестр убитых, только счётчик. */
export const DEFAULT_KILL_LIST = [
  { name: 'Жора Вереск', faction: 'ДИКИЕ', level: 21, weapon: 'АКС-74У', bodyPart: 'Грудь', distance: 42, xp: 315 },
  { name: 'Толя Картечь', faction: 'ДИКИЕ', level: 14, weapon: 'МР-133', bodyPart: 'Голова', distance: 18, xp: 288 },
  { name: 'USEC_Grimm', faction: 'USEC', level: 37, weapon: 'M4A1', bodyPart: 'Живот', distance: 96, xp: 512 },
  { name: 'BEAR_Сентябрь', faction: 'BEAR', level: 29, weapon: 'АК-105', bodyPart: 'Грудь', distance: 61, xp: 447 },
  { name: 'Тагилла', faction: 'БОСС', level: 52, weapon: 'Кувалда', bodyPart: 'Голова', distance: 7, xp: 1840 },
]

/* Оставлены для обратной совместимости импортов. */
export const DEFAULT_RAID_STATS = []
export const DEFAULT_EXPERIENCE = { levelFrom: 1, levelTo: 1, gained: 0 }

export function formatNumber(value) {
  const n = Math.round(Number(value) || 0)
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function levelRequirement(meta, lvl) {
  const safe = Math.max(1, Math.round(Number(lvl) || 1))
  if (meta && typeof meta._need === 'function') {
    const v = Number(meta._need(safe))
    if (Number.isFinite(v) && v > 0) return v
  }
  /* Та же кривая, что в MetaSystem._need(). */
  return Math.round(1000 * Math.pow(safe, 1.35))
}

const RAID_RESULT_CSS = `
.efl-res, .efl-res * { box-sizing: border-box; margin: 0; padding: 0; }
.efl-res {
  --efl-accent: #e27210;
  --efl-lime: #9bd12a;
  --efl-text: #c8c7c2;
  --efl-dim: #86857f;
  --efl-line: rgba(200, 199, 194, 0.12);
  position: fixed; inset: 0; z-index: 9400;
  display: flex; flex-direction: column;
  font-family: 'Oswald', 'Geometria', Arial, sans-serif;
  color: var(--efl-text); user-select: none;
  opacity: 0; transition: opacity 150ms ease-out;
}
.efl-res.is-visible { opacity: 1; }
.efl-res__bg {
  position: absolute; inset: 0;
  background: radial-gradient(120% 100% at 50% 0%, rgba(26,26,22,0.72) 0%, rgba(5,6,5,0.97) 78%), rgba(6,7,6,0.92);
  backdrop-filter: blur(14px) saturate(0.7); -webkit-backdrop-filter: blur(14px) saturate(0.7);
}
.efl-res__head { position: relative; padding: 30px 52px 0; }
.efl-res__title {
  font-family: 'Bebas Neue', Impact, sans-serif; font-size: 42px; line-height: 1;
  letter-spacing: 0.16em; color: #eceae5;
}
.efl-res__subtitle {
  margin-top: 7px; font-size: 13px; font-weight: 300; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--efl-dim);
}
.efl-res__status { font-weight: 600; letter-spacing: 0.14em; }
.efl-res__status--ok { color: var(--efl-lime); }
.efl-res__status--bad { color: #e2544a; }
.efl-res__status--warn { color: var(--efl-accent); }
.efl-res__steps { display: flex; gap: 26px; margin-top: 20px; border-bottom: 1px solid var(--efl-line); }
.efl-res__step {
  position: relative; padding: 6px 2px 12px; font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 21px; letter-spacing: 0.14em; color: #6f6e69;
}
.efl-res__step.is-active { color: var(--efl-accent); }
.efl-res__step.is-done { color: #b0afaa; }
.efl-res__step.is-active::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--efl-accent); box-shadow: 0 0 16px rgba(226,114,16,0.75);
}
.efl-res__body { position: relative; flex: 1 1 auto; overflow: hidden; padding: 22px 52px 10px; }
.efl-res__pane { display: none; height: 100%; }
.efl-res__pane.is-active { display: block; animation: efl-res-in 190ms ease-out both; }
@keyframes efl-res-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
.efl-res__scroll { max-height: 100%; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(226,114,16,0.5) transparent; }
.efl-res__scroll::-webkit-scrollbar { width: 6px; }
.efl-res__scroll::-webkit-scrollbar-thumb { background: rgba(226,114,16,0.45); }
.efl-res__table { width: 100%; border-collapse: collapse; font-size: 13.5px; font-weight: 300; }
.efl-res__table th {
  text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 500;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--efl-dim);
  border-bottom: 1px solid rgba(226,114,16,0.35); white-space: nowrap;
}
.efl-res__table td { padding: 9px 12px; border-bottom: 1px solid var(--efl-line); }
.efl-res__table tr:hover td { background: rgba(255,255,255,0.02); }
.efl-res__name { font-weight: 500; color: #eceae5; letter-spacing: 0.03em; }
.efl-res__tag {
  display: inline-block; padding: 2px 8px; font-size: 10.5px; letter-spacing: 0.14em;
  background: rgba(226,114,16,0.16); border: 1px solid rgba(226,114,16,0.4); color: #f0a45c;
}
.efl-res__num { font-variant-numeric: tabular-nums; text-align: right; }
.efl-res__xpcell { color: var(--efl-lime); font-variant-numeric: tabular-nums; text-align: right; }
.efl-res__empty { padding: 34px 12px; text-align: center; color: var(--efl-dim); font-weight: 300; font-size: 14px; }
.efl-res__group { margin-bottom: 22px; max-width: 860px; }
.efl-res__group-title {
  font-family: 'Bebas Neue', Impact, sans-serif; font-size: 19px; letter-spacing: 0.14em;
  color: #dcdbd6; padding-bottom: 6px; margin-bottom: 4px;
  border-bottom: 1px solid rgba(226,114,16,0.35);
}
.efl-res__row { display: flex; align-items: baseline; gap: 14px; padding: 7px 4px; border-bottom: 1px solid var(--efl-line); }
.efl-res__row-label { flex: 1 1 auto; font-size: 13.5px; font-weight: 300; color: #b7b6b1; }
.efl-res__row-value { font-size: 14px; color: #eceae5; font-variant-numeric: tabular-nums; letter-spacing: 0.03em; }
.efl-res__xp { max-width: 900px; }
.efl-res__xp-levels { display: flex; align-items: center; gap: 18px; margin-bottom: 14px; }
.efl-res__xp-badge {
  min-width: 78px; padding: 8px 4px; text-align: center;
  background: rgba(18,18,16,0.9); border: 1px solid var(--efl-line);
}
.efl-res__xp-badge-cap { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--efl-dim); }
.efl-res__xp-badge-val { font-family: 'Bebas Neue', Impact, sans-serif; font-size: 34px; line-height: 1; color: #eceae5; }
.efl-res__xp-badge--next { border-color: rgba(226,114,16,0.55); }
.efl-res__xp-badge--next .efl-res__xp-badge-val { color: var(--efl-accent); }
.efl-res__xp-arrow { color: var(--efl-dim); font-size: 22px; }
.efl-res__levelup {
  display: none; margin-left: auto; padding: 8px 18px;
  background: linear-gradient(180deg, #f0821a 0%, #d9660b 100%);
  color: #1a0c02; font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 22px; letter-spacing: 0.16em;
  box-shadow: 0 0 30px rgba(226,114,16,0.5);
  animation: efl-res-pulse 1.5s ease-in-out infinite;
}
.efl-res__levelup.is-visible { display: block; }
@keyframes efl-res-pulse { 50% { box-shadow: 0 0 46px rgba(226,114,16,0.85); } }
.efl-res__bar {
  position: relative; height: 20px; background: rgba(255,255,255,0.07);
  border: 1px solid var(--efl-line); overflow: hidden;
}
.efl-res__bar-fill {
  position: absolute; left: 0; top: 0; bottom: 0; width: 0%;
  background: linear-gradient(90deg, #b4581f 0%, var(--efl-accent) 60%, #ffa14a 100%);
  box-shadow: 0 0 18px rgba(226,114,16,0.6);
}
.efl-res__bar-meta { display: flex; justify-content: space-between; margin-top: 7px; font-size: 12.5px; color: var(--efl-dim); }
.efl-res__bar-meta b { color: var(--efl-lime); font-weight: 500; }
.efl-res__note { margin-top: 16px; font-size: 13px; font-weight: 300; color: var(--efl-dim); }
.efl-res__foot {
  position: relative; display: flex; align-items: center; gap: 26px;
  padding: 14px 52px 30px; border-top: 1px solid var(--efl-line);
}
.efl-res__hint { font-size: 11.5px; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(200,199,194,0.35); }
.efl-res__actions { margin-left: auto; display: flex; align-items: center; gap: 26px; }
.efl-res__btn {
  background: none; border: 0; cursor: pointer;
  font-family: 'Bebas Neue', Impact, sans-serif; font-size: 27px; letter-spacing: 0.16em;
  color: #bdbcb7; padding: 4px 18px;
  transition: color 120ms linear, text-shadow 120ms linear;
}
.efl-res__btn:hover, .efl-res__btn:focus-visible { color: #fff; outline: none; text-shadow: 0 0 18px rgba(226,114,16,0.6); }
.efl-res__btn[disabled] { opacity: 0.3; cursor: default; }
.efl-res__btn[disabled]:hover { color: #bdbcb7; text-shadow: none; }
.efl-res__btn--accent { color: var(--efl-accent); }
.efl-res__btn--accent:hover { color: #ffa14a; }
`

/* ==========================================================================
 * RaidResultSystem
 * ========================================================================== */
export class RaidResultSystem {
  constructor(ctx, options = {}) {
    this.ctx = ctx
    this.options = options || {}

    this.root = null
    this.isOpen = false
    this.destroyed = false
    this.stepIndex = 0
    this.model = null
    this._xpCommitted = false      // одна фиксация опыта на один показ итогов

    this._raf = 0
    this._onClick = this._onClick.bind(this)

    ensureTarkovFonts()
    this._injectStyles()
  }

  /* ---------------------------------------------------------------- utils */
  _svc(name) {
    const ctx = this.ctx
    if (!ctx) return null
    if (typeof ctx.peek === 'function') {
      try { return ctx.peek(name) } catch (e) { return null }
    }
    if (typeof ctx.get === 'function') {
      try { return ctx.get(name) } catch (e) { return null }
    }
    return null
  }

  _engine() {
    if (this.ctx && this.ctx.engine) return this.ctx.engine
    if (this.options.engine) return this.options.engine
    return null
  }

  _audio() {
    return installAudioCompat(this._svc('audio'))
  }

  _injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById('efl-raid-result-css')) return
    const style = document.createElement('style')
    style.id = 'efl-raid-result-css'
    style.textContent = RAID_RESULT_CSS
    document.head.appendChild(style)
  }

  get step() {
    return RAID_STEP_ORDER[this.stepIndex] || RAID_STEP_ORDER[0]
  }

  /** Накопленный за рейд опыт — ровно то, что визард показал на третьем
   *  экране. Поля такого раньше не было вообще. */
  get totalXpEarned() {
    const xp = this.model && this.model.experience ? Number(this.model.experience.gained) : 0
    return Number.isFinite(xp) && xp > 0 ? Math.round(xp) : 0
  }

  /* ----------------------------------------------------------- модель */
  _buildModel(payload) {
    const p = payload && typeof payload === 'object' ? payload : {}
    const kind = KIND_META[p.kind] ? p.kind : 'survived'
    const meta = KIND_META[kind]

    const hasKillCount = Number.isFinite(Number(p.kills))
    const kills = hasKillCount ? Math.max(0, Math.round(Number(p.kills))) : 0
    const xp = Math.max(0, Math.round(Number(p.xp) || 0))
    const value = Math.max(0, Math.round(Number(p.value) || 0))
    const seconds = Math.max(0, Number(p.time) || 0)
    const mapId = typeof p.mapId === 'string' ? p.mapId : 'factory'

    return {
      kind: kind,
      status: meta.label,
      tone: meta.tone,
      kills: kills,
      xp: xp,
      value: value,
      seconds: seconds,
      mapId: mapId,
      mapTitle: MAP_TITLES[mapId] || mapId,
      exit: typeof p.exit === 'string' && p.exit ? p.exit : '',
      faction: typeof p.faction === 'string' && p.faction ? p.faction : 'pmc',
      night: !!p.night,
      killList: this._buildKillList(p, kills, hasKillCount),
      experience: this._buildExperience(p, xp, kind),
    }
  }

  /* Реальный payload несёт только число убитых, имена придётся выдумать. */
  _buildKillList(p, kills, hasKillCount) {
    if (Array.isArray(p.killList) && p.killList.length) {
      return p.killList.map((raw, i) => {
        const src = raw && typeof raw === 'object' ? raw : {}
        const mock = DEFAULT_KILL_LIST[i % DEFAULT_KILL_LIST.length]
        return {
          name: src.name || src.nickname || mock.name,
          faction: src.faction || mock.faction,
          level: Number.isFinite(Number(src.level)) ? Number(src.level) : mock.level,
          weapon: src.weapon || mock.weapon,
          bodyPart: src.bodyPart || src.zone || mock.bodyPart,
          distance: Number.isFinite(Number(src.distance)) ? Number(src.distance) : mock.distance,
          xp: Number.isFinite(Number(src.xp)) ? Number(src.xp) : mock.xp,
        }
      })
    }

    /* payload пуст совсем — показываем полный мок-ростер. */
    if (!hasKillCount) return DEFAULT_KILL_LIST.slice()
    if (kills <= 0) return []

    const out = []
    for (let i = 0; i < kills; i++) {
      out.push(Object.assign({}, DEFAULT_KILL_LIST[i % DEFAULT_KILL_LIST.length]))
    }
    return out
  }

  /* Снимок уровня/опыта ДО того, как MetaSystem._afterRaid() зачислит рейд.
   * UiSystem передаёт его в progressBefore; если его нет — читаем живые данные. */
  _buildExperience(p, gained, kind) {
    const meta = this._svc('meta')
    const before = p.progressBefore && typeof p.progressBefore === 'object' ? p.progressBefore : null

    let lvl = 1
    let xpInLevel = 0
    if (before) {
      lvl = Math.max(1, Math.round(Number(before.lvl) || 1))
      xpInLevel = Math.max(0, Math.round(Number(before.xp) || 0))
    } else if (meta && meta.P) {
      lvl = Math.max(1, Math.round(Number(meta.P.lvl) || 1))
      xpInLevel = Math.max(0, Math.round(Number(meta.P.xp) || 0))
    }

    const levelFrom = lvl
    const segments = []
    let left = gained
    let cursor = xpInLevel
    let current = lvl
    let guard = 0

    while (guard++ < 500) {
      const need = levelRequirement(meta, current)
      const room = Math.max(0, need - cursor)
      if (left < room || need <= 0) {
        segments.push({ lvl: current, need: need, from: cursor, to: cursor + left })
        cursor += left
        left = 0
        break
      }
      segments.push({ lvl: current, need: need, from: cursor, to: need })
      left -= room
      current += 1
      cursor = 0
    }

    const need = levelRequirement(meta, current)
    return {
      levelFrom: levelFrom,
      /* Дорейдовый снимок сохраняем целиком: по нему _commitExperience()
       * понимает, был ли опыт уже зачислен обработчиком raid:end. */
      xpBefore: xpInLevel,
      hadSnapshot: !!before,
      levelTo: current,
      leveledUp: current > levelFrom,
      gained: gained,
      segments: segments,
      current: cursor,
      need: need,
      remaining: Math.max(0, need - cursor),
      breakdown: this._buildBreakdown(p, gained, kind),
    }
  }

  _buildBreakdown(p, gained, kind) {
    if (gained <= 0) return []
    const kills = Math.max(0, Math.round(Number(p.kills) || 0))
    const value = Math.max(0, Math.round(Number(p.value) || 0))

    const killXp = kills > 0 ? Math.round(gained * 0.6) : 0
    const lootXp = value > 0 ? Math.round(gained * 0.25) : 0
    const restXp = gained - killXp - lootXp

    const rows = []
    if (killXp > 0) rows.push({ label: 'Устранение целей ×' + kills, value: killXp })
    if (lootXp > 0) rows.push({ label: 'Найденная добыча', value: lootXp })
    rows.push({
      label: kind === 'survived' ? 'Успешная эвакуация' : 'Исследование локации',
      value: restXp,
    })
    return rows
  }

  /* ------------------------------------------------------------ показ */
  show(payload) {
    if (this.destroyed || typeof document === 'undefined') return
    this.model = this._buildModel(payload)
    this.stepIndex = 0
    this._xpCommitted = false

    if (this.root) this._teardownDom()
    this.isOpen = true
    this._render()
    this._paintStep()
    playUiSound(this._audio(), 'open')
  }

  close() {
    if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = 0
    }
    this._teardownDom()
    this.isOpen = false
  }

  hide() {
    this.close()
  }

  /* ----------------------------------------------------------- рендер */
  _render() {
    const m = this.model
    if (!m) return

    const root = document.createElement('div')
    root.className = 'efl-res'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    if (this.options.zIndex) root.style.zIndex = String(this.options.zIndex)

    root.innerHTML =
      '<div class="efl-res__bg"></div>' +
      '<div class="efl-res__head">' +
        '<div class="efl-res__title" data-role="title">' + STEP_TITLES.kills + '</div>' +
        '<div class="efl-res__subtitle">' +
          '<span class="efl-res__status efl-res__status--' + m.tone + '">' + escapeHtml(m.status) + '</span>' +
          ' · ' + escapeHtml(m.mapTitle) +
          ' · ' + formatRaidClock(m.seconds * 1000) +
        '</div>' +
        '<div class="efl-res__steps" data-role="steps">' +
          RAID_STEP_ORDER.map((id, i) =>
            '<div class="efl-res__step" data-step="' + id + '">' + (i + 1) + '. ' + STEP_LABELS[id] + '</div>'
          ).join('') +
        '</div>' +
      '</div>' +
      '<div class="efl-res__body">' +
        '<div class="efl-res__pane" data-pane="' + RAID_STEP.KILLS + '"><div class="efl-res__scroll">' + this._renderKills() + '</div></div>' +
        '<div class="efl-res__pane" data-pane="' + RAID_STEP.STATS + '"><div class="efl-res__scroll">' + this._renderStats() + '</div></div>' +
        '<div class="efl-res__pane" data-pane="' + RAID_STEP.EXPERIENCE + '"><div class="efl-res__scroll">' + this._renderExperience() + '</div></div>' +
      '</div>' +
      '<div class="efl-res__foot">' +
        '<span class="efl-res__hint">шаг <span data-role="step-num">1</span> из ' + RAID_STEP_ORDER.length + '</span>' +
        '<div class="efl-res__actions">' +
          '<button type="button" class="efl-res__btn" data-act="prev">НАЗАД</button>' +
          '<button type="button" class="efl-res__btn efl-res__btn--accent" data-act="next">ДАЛЕЕ</button>' +
          '<button type="button" class="efl-res__btn efl-res__btn--accent" data-act="finish" hidden>В УБЕЖИЩЕ</button>' +
        '</div>' +
      '</div>'

    root.addEventListener('click', this._onClick)
    document.body.appendChild(root)
    this.root = root

    requestAnimationFrame(() => {
      if (this.root) this.root.classList.add('is-visible')
    })
  }

  _renderKills() {
    const list = this.model.killList
    if (!list.length) {
      return '<div class="efl-res__empty">За этот рейд нет подтверждённых убийств.</div>'
    }
    return (
      '<table class="efl-res__table">' +
        '<thead><tr>' +
          '<th>#</th><th>Никнейм</th><th>Фракция</th><th>Ур.</th>' +
          '<th>Оружие</th><th>Поражение</th><th>Дистанция</th><th>Опыт</th>' +
        '</tr></thead><tbody>' +
        list.map((k, i) =>
          '<tr>' +
            '<td class="efl-res__num">' + (i + 1) + '</td>' +
            '<td class="efl-res__name">' + escapeHtml(k.name) + '</td>' +
            '<td><span class="efl-res__tag">' + escapeHtml(k.faction) + '</span></td>' +
            '<td class="efl-res__num">' + escapeHtml(k.level) + '</td>' +
            '<td>' + escapeHtml(k.weapon) + '</td>' +
            '<td>' + escapeHtml(k.bodyPart) + '</td>' +
            '<td class="efl-res__num">' + escapeHtml(k.distance) + ' м</td>' +
            '<td class="efl-res__xpcell">+' + formatNumber(k.xp) + '</td>' +
          '</tr>'
        ).join('') +
        '</tbody></table>'
    )
  }

  _renderStats() {
    const m = this.model
    const groups = [
      {
        title: 'Итог рейда',
        rows: [
          { label: 'Статус', value: m.status },
          { label: 'Локация', value: m.mapTitle },
          { label: 'Время в рейде', value: formatRaidClock(m.seconds * 1000) },
          { label: 'Точка выхода', value: m.exit || '—' },
          { label: 'Время суток', value: m.night ? 'Ночь' : 'День' },
          { label: 'Фракция', value: String(m.faction).toUpperCase() },
        ],
      },
      {
        title: 'Бой',
        rows: [
          { label: 'Устранено целей', value: formatNumber(m.kills) },
          { label: 'Записей в списке убийств', value: formatNumber(m.killList.length) },
        ],
      },
      {
        title: 'Добыча и опыт',
        rows: [
          { label: 'Стоимость вынесенного', value: formatNumber(m.value) + ' ₽' },
          { label: 'Опыт за рейд', value: '+' + formatNumber(m.xp) },
        ],
      },
    ]

    return groups.map(g =>
      '<div class="efl-res__group">' +
        '<div class="efl-res__group-title">' + g.title + '</div>' +
        g.rows.map(r =>
          '<div class="efl-res__row">' +
            '<span class="efl-res__row-label">' + escapeHtml(r.label) + '</span>' +
            '<span class="efl-res__row-value">' + escapeHtml(r.value) + '</span>' +
          '</div>'
        ).join('') +
      '</div>'
    ).join('')
  }

  _renderExperience() {
    const xp = this.model.experience
    const breakdown = Array.isArray(xp.breakdown) ? xp.breakdown : []

    const rows = breakdown.length
      ? breakdown.map(r =>
          '<div class="efl-res__row">' +
            '<span class="efl-res__row-label">' + escapeHtml(r.label) + '</span>' +
            '<span class="efl-res__row-value">+' + formatNumber(r.value) + '</span>' +
          '</div>'
        ).join('')
      : '<div class="efl-res__note">Опыт за этот рейд не начислен.</div>'

    return (
      '<div class="efl-res__xp">' +
        '<div class="efl-res__xp-levels">' +
          '<div class="efl-res__xp-badge">' +
            '<div class="efl-res__xp-badge-cap">было</div>' +
            '<div class="efl-res__xp-badge-val">' + xp.levelFrom + '</div>' +
          '</div>' +
          '<div class="efl-res__xp-arrow">&rarr;</div>' +
          '<div class="efl-res__xp-badge efl-res__xp-badge--next">' +
            '<div class="efl-res__xp-badge-cap">стало</div>' +
            '<div class="efl-res__xp-badge-val" data-role="xp-level">' + xp.levelFrom + '</div>' +
          '</div>' +
          '<div class="efl-res__levelup" data-role="levelup">ПОВЫШЕНИЕ УРОВНЯ</div>' +
        '</div>' +
        '<div class="efl-res__bar"><div class="efl-res__bar-fill" data-role="xp-fill"></div></div>' +
        '<div class="efl-res__bar-meta">' +
          '<span data-role="xp-current">0 / 0</span>' +
          '<span>за рейд <b>+' + formatNumber(xp.gained) + '</b></span>' +
        '</div>' +
        '<div class="efl-res__group" style="margin-top:22px">' +
          '<div class="efl-res__group-title">Из чего сложился опыт</div>' +
          rows +
        '</div>' +
        '<div class="efl-res__note" data-role="xp-remaining"></div>' +
      '</div>'
    )
  }

  /* -------------------------------------------------------- навигация */
  _paintStep() {
    if (!this.root) return
    const current = this.step

    const title = this.root.querySelector('[data-role="title"]')
    if (title) title.textContent = STEP_TITLES[current] || ''

    const steps = this.root.querySelectorAll('.efl-res__step')
    for (let i = 0; i < steps.length; i++) {
      steps[i].classList.toggle('is-active', i === this.stepIndex)
      steps[i].classList.toggle('is-done', i < this.stepIndex)
    }

    const panes = this.root.querySelectorAll('.efl-res__pane')
    for (let i = 0; i < panes.length; i++) {
      panes[i].classList.toggle('is-active', panes[i].getAttribute('data-pane') === current)
    }

    const num = this.root.querySelector('[data-role="step-num"]')
    if (num) num.textContent = String(this.stepIndex + 1)

    const prev = this.root.querySelector('[data-act="prev"]')
    if (prev) prev.disabled = this.stepIndex === 0

    const isLast = this.stepIndex === RAID_STEP_ORDER.length - 1
    const next = this.root.querySelector('[data-act="next"]')
    const finish = this.root.querySelector('[data-act="finish"]')
    if (next) next.hidden = isLast
    if (finish) finish.hidden = !isLast

    if (current === RAID_STEP.EXPERIENCE) this._animateExperience()
  }

  next() {
    if (this.stepIndex >= RAID_STEP_ORDER.length - 1) {
      this.finish()
      return
    }
    this.stepIndex += 1
    playUiSound(this._audio(), 'click')
    this._paintStep()
  }

  prev() {
    if (this.stepIndex <= 0) return
    this.stepIndex -= 1
    playUiSound(this._audio(), 'back')
    this._paintStep()
  }

  /* ------------------------------------------------- фиксация опыта в профиль */

  /* 'meta' — штатный владелец профиля, 'profile' поддержан как псевдоним.
   * Идём только через peek: registry.get() бросает для незарегистрированного
   * id, а не возвращает ложь, так что get('meta') || get('profile') упал бы на
   * первом же отсутствующем сервисе и сломал кнопку выхода. */
  _profile() {
    return this._svc('meta') || this._svc('profile')
  }

  /** MetaSystem._afterRaid() уже зачисляет опыт по событию raid:end до того,
   *  как игрок увидит этот экран. Если профиль уже отличается ото дорейдового
   *  снимка — начисление было, и второй раз писать нельзя: опыт и уровни
   *  удвоились бы на каждом рейде. */
  _experienceAlreadyCredited(meta) {
    const xp = this.model && this.model.experience ? this.model.experience : null
    if (!xp || !xp.hadSnapshot) return true      // без снимка не рискуем дублем
    const P = meta && meta.P ? meta.P : null
    if (!P) return true
    const lvl = Math.max(1, Math.round(Number(P.lvl) || 1))
    const inLevel = Math.max(0, Math.round(Number(P.xp) || 0))
    return lvl !== xp.levelFrom || inLevel !== xp.xpBefore
  }

  /** Запись опыта в профиль и коммит сейва. Идемпотентно. */
  _commitExperience() {
    if (this._xpCommitted) return false
    const meta = this._profile()
    if (!meta) return false

    const gained = this.totalXpEarned
    let written = false

    if (gained > 0 && !this._experienceAlreadyCredited(meta)) {
      if (typeof meta.addExperience === 'function') {
        try {
          meta.addExperience(gained)
          written = true
        } catch (err) {
          console.error('[EFL/res] addExperience упал', err)
        }
      } else {
        console.warn('[EFL/res] у профиля нет addExperience(), опыт не начислен')
      }
    }

    /* Коммит нужен и тогда, когда опыт начислила MetaSystem: игрок уходит
     * из рейда, и следующего кадра с отложенным сейвом может и не быть. */
    if (typeof meta.save === 'function') {
      try { meta.save() } catch (err) { console.error('[EFL/res] save профиля упал', err) }
    }

    this._xpCommitted = true
    return written
  }

  /* Кнопка «В УБЕЖИЩЕ». Раньше звала _svc('mainMenu').show() — такого
   * сервиса в реестре нет, поэтому визард был тупиком. */
  finish() {
    playUiSound(this._audio(), 'click')

    /* Опыт фиксируем ДО ухода в убежище и ДО close(): это последняя точка,
     * где известны и начисление, и дорейдовый снимок прогресса. */
    this._commitExperience()

    const engine = this._engine()
    this.close()

    if (typeof this.options.onFinish === 'function') {
      try {
        this.options.onFinish()
        return
      } catch (err) {
        console.error('[EFL/res] onFinish упал', err)
      }
    }

    if (!engine) return
    if (typeof engine.returnToMenu === 'function') call(engine, 'returnToMenu')
    if (typeof engine.setState === 'function' && engine.state !== STATE.MENU) {
      engine.setState(STATE.MENU)
    }
    call(engine.mainMenu, 'show')
  }

  /* ------------------------------------------------------- анимация опыта */
  _animateExperience() {
    if (!this.root || !this.model) return
    if (this._raf) {
      cancelAnimationFrame(this._raf)
      this._raf = 0
    }

    const xp = this.model.experience
    const segments = Array.isArray(xp.segments) && xp.segments.length
      ? xp.segments
      : [{ lvl: xp.levelFrom, need: Math.max(1, xp.need), from: 0, to: 0 }]

    const fill = this.root.querySelector('[data-role="xp-fill"]')
    const levelEl = this.root.querySelector('[data-role="xp-level"]')
    const currentEl = this.root.querySelector('[data-role="xp-current"]')
    const levelUpEl = this.root.querySelector('[data-role="levelup"]')
    const remainingEl = this.root.querySelector('[data-role="xp-remaining"]')

    if (remainingEl) {
      remainingEl.textContent = 'До ' + (xp.levelTo + 1) + '-го уровня осталось ' + formatNumber(xp.remaining) + ' опыта.'
    }

    const stepDuration = Math.max(260, Math.round(1000 / segments.length))
    let index = 0

    const paint = (seg, current) => {
      const need = seg.need > 0 ? seg.need : 1
      const pct = Math.max(0, Math.min(100, (current / need) * 100))
      if (fill) fill.style.width = pct.toFixed(2) + '%'
      if (levelEl) levelEl.textContent = String(seg.lvl)
      if (currentEl) currentEl.textContent = formatNumber(current) + ' / ' + formatNumber(need)
    }

    const runSegment = () => {
      if (this.destroyed || !this.isOpen || !this.root) return
      if (index >= segments.length) {
        if (xp.leveledUp && levelUpEl) levelUpEl.classList.add('is-visible')
        if (levelEl) levelEl.textContent = String(xp.levelTo)
        if (xp.leveledUp) playUiSound(this._audio(), 'levelup')
        this._raf = 0
        return
      }

      const seg = segments[index]
      const started = performance.now()

      const tick = (now) => {
        if (this.destroyed || !this.isOpen || !this.root) return
        const k = Math.min(1, (now - started) / stepDuration)
        const eased = 1 - Math.pow(1 - k, 3)
        paint(seg, seg.from + (seg.to - seg.from) * eased)
        if (k < 1) {
          this._raf = requestAnimationFrame(tick)
          return
        }
        index += 1
        this._raf = requestAnimationFrame(runSegment)
      }

      this._raf = requestAnimationFrame(tick)
    }

    paint(segments[0], segments[0].from)
    if (levelUpEl) levelUpEl.classList.remove('is-visible')
    runSegment()
  }

  /* ---------------------------------------------------------------- события */
  _onClick(event) {
    const node = event && event.target && event.target.closest ? event.target.closest('[data-act]') : null
    if (!node || node.disabled) return
    event.preventDefault()

    const act = node.getAttribute('data-act')
    if (act === 'next') this.next()
    else if (act === 'prev') this.prev()
    else if (act === 'finish') this.finish()
  }

  _teardownDom() {
    if (!this.root) return
    this.root.removeEventListener('click', this._onClick)
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root)
    this.root = null
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.close()
    this.model = null
  }
}

/* Удобная обёртка для разового показа вне UiSystem. */
export function showRaidResult(ctx, payload, options = {}) {
  const system = new RaidResultSystem(ctx, options)
  system.show(payload)
  return system
}

export default RaidResultSystem
