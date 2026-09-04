/* ==========================================================================
 * Escape-From-Larpov · src/ui/escapeMenuTheme.js
 * Визуал ESC-меню: scoped CSS + векторные иконки.
 * Только ассеты: никаких обращений к движку и никаких сайд-эффектов.
 * ========================================================================== */

export const ESCAPE_MENU_CSS = `
.efl-esc, .efl-esc * { box-sizing: border-box; margin: 0; padding: 0; }

.efl-esc {
  --efl-orange: #e27210;
  --efl-orange-dim: #a8540b;
  --efl-red: #c0392b;
  --efl-text: #c8c7c2;
  --efl-text-dim: #8b8a85;
  --efl-line: rgba(200, 199, 194, 0.12);
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  flex-direction: column;
  font-family: 'Oswald', 'Geometria', Arial, sans-serif;
  color: var(--efl-text);
  user-select: none;
  -webkit-font-smoothing: antialiased;
  opacity: 0;
  transition: opacity 140ms ease-out;
}
.efl-esc.is-visible { opacity: 1; }

.efl-esc__backdrop {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(120% 90% at 50% 45%, rgba(8, 9, 8, 0.55) 0%, rgba(4, 5, 4, 0.88) 78%),
    rgba(6, 7, 6, 0.55);
  backdrop-filter: blur(8px) saturate(0.75);
  -webkit-backdrop-filter: blur(8px) saturate(0.75);
}
.efl-esc__grain {
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: 0.05;
  background-image:
    repeating-linear-gradient(0deg, rgba(255,255,255,0.09) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgba(0,0,0,0.25) 0 1px, transparent 1px 4px);
  mix-blend-mode: overlay;
}
.efl-esc__vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  box-shadow: inset 0 0 260px 90px rgba(0, 0, 0, 0.85);
}

.efl-esc__screen {
  position: relative;
  flex: 1 1 auto;
  display: none;
  flex-direction: column;
  align-items: center;
  padding: 46px 64px 96px;
}
.efl-esc__screen.is-active { display: flex; animation: efl-esc-in 180ms ease-out both; }

@keyframes efl-esc-in {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.efl-esc__title {
  font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 44px;
  line-height: 1;
  letter-spacing: 0.14em;
  color: #e8e7e2;
  text-align: center;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.9);
}
.efl-esc__subtitle {
  margin-top: 6px;
  font-family: 'Oswald', Arial, sans-serif;
  font-weight: 300;
  font-size: 13px;
  letter-spacing: 0.28em;
  text-transform: uppercase;
  color: var(--efl-text-dim);
  text-align: center;
}

.efl-esc__stack {
  margin: auto 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 26px;
}
.efl-esc__big {
  position: relative;
  background: none;
  border: 0;
  cursor: pointer;
  font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 42px;
  line-height: 1;
  letter-spacing: 0.16em;
  color: #bdbcb7;
  padding: 6px 42px;
  transition: color 120ms linear, text-shadow 120ms linear, transform 120ms ease-out;
}
.efl-esc__big::before,
.efl-esc__big::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 0;
  height: 2px;
  background: var(--efl-orange);
  transform: translateY(-50%);
  transition: width 140ms ease-out;
}
.efl-esc__big::before { left: 0; }
.efl-esc__big::after { right: 0; }
.efl-esc__big:hover,
.efl-esc__big:focus-visible {
  color: #ffffff;
  outline: none;
  text-shadow: 0 0 22px rgba(226, 114, 16, 0.55);
}
.efl-esc__big:hover::before,
.efl-esc__big:hover::after,
.efl-esc__big:focus-visible::before,
.efl-esc__big:focus-visible::after { width: 26px; }
.efl-esc__big:active { transform: scale(0.985); }
.efl-esc__big--danger:hover { color: #ff6a4d; text-shadow: 0 0 22px rgba(192, 57, 43, 0.6); }

/* НИКАКОГО position:absolute.
 *
 * Здесь стояло \`position:absolute; left:0; right:0; bottom:74px\`, из-за чего
 * футер с кнопками полностью выпадал из потока .efl-esc__screen. Плашка
 * .efl-esc__alert течёт в обычном потоке сверху вниз, и на экране
 * дезертирства её нижняя кромка доходила до пришпиленных кнопок — текст
 * наезжал на текст. Футер снова в потоке и прижимается к низу через
 * margin-top:auto, поэтому перекрытие невозможно ни при какой высоте окна. */
.efl-esc__footer {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin-top: auto;
}

/* Нижняя группа экрана дезертирства: красная плашка предупреждения сверху,
 * кнопки выбора под ней. Оба элемента — дети ОДНОГО flex-контейнера, поэтому
 * поток раскладывает их строго друг под другом, а расстояние задаёт gap. */
.efl-desertion-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 24px;
  width: 100%;
  margin-top: auto;
}
/* Внутри группы зазором владеет gap. Собственные отступы детей гасим, иначе
 * margin-top:auto у футера растащил бы плашку и кнопки по краям экрана. */
.efl-desertion-footer > .efl-esc__alert,
.efl-desertion-footer > .efl-esc__footer {
  margin-top: 0;
}

.efl-esc__build {
  position: absolute;
  left: 18px;
  bottom: 42px;
  font-family: 'Oswald', Arial, sans-serif;
  font-weight: 300;
  font-size: 12px;
  letter-spacing: 0.12em;
  color: rgba(200, 199, 194, 0.45);
  text-transform: uppercase;
  pointer-events: none;
}

.efl-esc__gear {
  position: absolute;
  right: 16px;
  bottom: 34px;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  background: rgba(20, 20, 18, 0.6);
  border: 1px solid var(--efl-line);
  cursor: pointer;
  color: #b9b8b3;
  transition: color 120ms linear, border-color 120ms linear, transform 200ms ease-out, background 120ms linear;
}
.efl-esc__gear svg { width: 20px; height: 20px; display: block; }
.efl-esc__gear:hover {
  color: var(--efl-orange);
  border-color: rgba(226, 114, 16, 0.65);
  background: rgba(226, 114, 16, 0.1);
  transform: rotate(45deg);
}

.efl-esc__shell {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 26px;
  padding: 0 14px;
  background: linear-gradient(180deg, rgba(12,12,11,0.55) 0%, rgba(8,8,7,0.88) 100%);
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(190, 189, 184, 0.4);
  pointer-events: none;
}
.efl-esc__shell-group { display: flex; align-items: center; gap: 22px; }
.efl-esc__shell-group--right { margin-left: auto; }

.efl-esc__body {
  width: 100%;
  max-width: 1180px;
  margin-top: 56px;
  display: grid;
  grid-template-columns: 380px 1fr;
  gap: 34px;
  align-items: start;
}
.efl-esc__pmc { position: relative; display: flex; justify-content: center; }
.efl-esc__pmc svg { width: 250px; height: 470px; display: block; filter: drop-shadow(0 18px 40px rgba(0,0,0,0.85)); }

.efl-esc__level {
  position: absolute;
  top: 6px;
  left: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 8px;
  background: rgba(14, 14, 13, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.06);
}
.efl-esc__level svg { width: 38px; height: 38px; filter: none; }
.efl-esc__level-value {
  font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 40px;
  line-height: 0.9;
  letter-spacing: 0.04em;
  color: #e6e5e0;
}

.efl-esc__map {
  position: relative;
  border: 1px solid rgba(255, 255, 255, 0.07);
  background: #0d0d0c;
  overflow: hidden;
}
.efl-esc__map-tag {
  position: absolute;
  top: -30px;
  left: 2px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 0.05em;
  color: #d6d5d0;
}
.efl-esc__map-tag::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #d6d5d0;
}
.efl-esc__map-shot {
  width: 100%;
  height: 372px;
  object-fit: cover;
  display: block;
  filter: contrast(1.05) saturate(0.85) brightness(0.92);
}
.efl-esc__map-shot--fallback { background: var(--efl-map-accent, #22211d); }
.efl-esc__map-info {
  padding: 14px 18px 16px;
  background: linear-gradient(180deg, rgba(10,10,9,0.92) 0%, rgba(6,6,5,0.98) 100%);
  border-top: 1px solid rgba(255,255,255,0.05);
}
.efl-esc__map-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: #e6e5e0;
  margin-bottom: 6px;
}
.efl-esc__map-desc {
  font-weight: 300;
  font-size: 12.5px;
  line-height: 1.55;
  color: rgba(200, 199, 194, 0.72);
  max-width: 720px;
}
.efl-esc__dots { display: flex; gap: 7px; justify-content: flex-end; padding: 10px 18px 14px; background: rgba(6,6,5,0.98); }
.efl-esc__dot { width: 8px; height: 8px; background: rgba(255,255,255,0.16); }
.efl-esc__dot.is-active { background: #e8e7e2; }

.efl-esc__alert {
  width: 100%;
  max-width: 1180px;
  margin-top: 26px;
  display: grid;
  grid-template-columns: 56px 1fr;
  align-items: center;
  gap: 4px;
  background: linear-gradient(90deg, rgba(150, 25, 18, 0.92) 0%, rgba(178, 34, 24, 0.92) 45%, rgba(150, 25, 18, 0.92) 100%);
  border: 1px solid rgba(255, 120, 90, 0.28);
  box-shadow: 0 10px 40px rgba(120, 15, 10, 0.35);
  padding: 12px 18px 12px 0;
  animation: efl-alert-pulse 2.6s ease-in-out infinite;
}
@keyframes efl-alert-pulse {
  0%, 100% { box-shadow: 0 10px 40px rgba(120, 15, 10, 0.3); }
  50%      { box-shadow: 0 10px 52px rgba(200, 40, 25, 0.55); }
}
.efl-esc__alert-icon { display: grid; place-items: center; color: #2a0a06; }
.efl-esc__alert-icon svg { width: 30px; height: 30px; }
.efl-esc__alert-title {
  font-size: 15px;
  font-weight: 600;
  color: #ffe9e2;
  letter-spacing: 0.02em;
  margin-bottom: 3px;
}
.efl-esc__alert-text {
  font-weight: 300;
  font-size: 13px;
  line-height: 1.45;
  color: rgba(255, 235, 228, 0.88);
  max-width: 1020px;
}
.efl-esc__alert--center { grid-template-columns: 52px 1fr; max-width: 940px; text-align: left; }

/* Стили .efl-esc__grace / .efl-esc__grace-value / @keyframes efl-blink удалены
 * вместе с блоком автокика: мигающий счётчик обратного отсчёта больше не
 * существует, и мёртвым правилам в теме делать нечего. */

.efl-esc__result { display: flex; flex-direction: column; align-items: center; margin-top: 22px; }
.efl-esc__result-figure { position: relative; display: flex; align-items: flex-start; gap: 18px; }
.efl-esc__result-figure svg.efl-esc__pmc-art { width: 210px; height: 400px; filter: drop-shadow(0 18px 40px rgba(0,0,0,0.9)); }
.efl-esc__nickname {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 16px;
  letter-spacing: 0.12em;
  color: #dcdbd6;
  text-transform: uppercase;
}
.efl-esc__nickname svg { width: 15px; height: 15px; opacity: 0.75; }

.efl-esc__verdict { margin-top: 18px; display: flex; align-items: center; gap: 26px; }
.efl-esc__badge {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 232px;
  padding: 11px 22px;
  background: linear-gradient(180deg, #f0821a 0%, #d9660b 100%);
  border: 1px solid rgba(255, 190, 120, 0.5);
  box-shadow: 0 0 34px rgba(226, 114, 16, 0.45), inset 0 1px 0 rgba(255,255,255,0.25);
  color: #1a0c02;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.06em;
}
.efl-esc__badge svg { width: 21px; height: 21px; }
.efl-esc__clock { display: flex; align-items: center; gap: 12px; }
.efl-esc__clock-label {
  font-size: 11px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: rgba(200, 199, 194, 0.55);
}
.efl-esc__clock-row { display: flex; align-items: center; gap: 9px; }
.efl-esc__clock-row svg { width: 19px; height: 19px; color: rgba(220,219,214,0.8); }
.efl-esc__clock-value {
  font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 30px;
  letter-spacing: 0.1em;
  color: #e8e7e2;
  font-variant-numeric: tabular-nums;
}
.efl-esc__exp {
  margin-top: 20px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.efl-esc__exp-tag {
  padding: 3px 9px;
  background: #c8c7c2;
  color: #12120f;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
}
.efl-esc__exp-value {
  font-family: 'Bebas Neue', Impact, sans-serif;
  font-size: 28px;
  letter-spacing: 0.08em;
  color: #e8e7e2;
}

.efl-esc[hidden] { display: none !important; }
`

export const ICON_GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.63.68 1.09 1.32 1.09H21a2 2 0 1 1 0 4h-.09c-.64 0-1.18.46-1.32 1.09z"/></svg>'

export const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.8 22.6 20.2H1.4L12 1.8Zm-1.2 6.4v6.2h2.4V8.2h-2.4Zm0 7.8v2.4h2.4V16h-2.4Z"/></svg>'

export const ICON_USER = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12a4.6 4.6 0 1 0 0-9.2A4.6 4.6 0 0 0 12 12Zm0 2.1c-4 0-8 2-8 4.6V21h16v-2.3c0-2.6-4-4.6-8-4.6Z"/></svg>'

export const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M12 6.6V12l3.6 2.2" stroke-linecap="round"/></svg>'

export const ICON_EXIT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.2 3H5.4A2.4 2.4 0 0 0 3 5.4v13.2A2.4 2.4 0 0 0 5.4 21h7.8v-2.2H5.4V5.2h7.8V3Zm4.1 4.2-1.6 1.6 2.1 2.1H9.2v2.2h8.6l-2.1 2.1 1.6 1.6L22.1 12l-4.8-4.8Z"/></svg>'

/* Силуэт ПМК — используется, если не передан options.portrait. */
export const PMC_SILHOUETTE = `
<svg class="efl-esc__pmc-art" viewBox="0 0 220 420" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="eflPmcBody" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5a5449"/>
      <stop offset="55%" stop-color="#3a362e"/>
      <stop offset="100%" stop-color="#23211c"/>
    </linearGradient>
    <linearGradient id="eflPmcRig" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#8c7f5f"/>
      <stop offset="100%" stop-color="#5d5439"/>
    </linearGradient>
  </defs>
  <ellipse cx="110" cy="408" rx="66" ry="9" fill="#000" opacity="0.55"/>
  <path d="M92 44c0-12 8-20 18-20s18 8 18 20v14c0 10-8 17-18 17s-18-7-18-17V44Z" fill="#2b2924"/>
  <path d="M94 48h32v10H94z" fill="#16150f"/>
  <circle cx="110" cy="63" r="3.2" fill="#0c0b08"/>
  <path d="M84 78h52l14 22 8 84-20 6-6-56v52H88v-52l-6 56-20-6 8-84 14-22Z" fill="url(#eflPmcBody)"/>
  <path d="M86 92h48v56H86z" fill="url(#eflPmcRig)" opacity="0.92"/>
  <path d="M90 100h16v14H90zm24 0h16v14h-16zM90 122h16v16H90zm24 0h16v16h-16z" fill="#3f3a26" opacity="0.9"/>
  <path d="M88 186h44l6 106h-18l-8-70-8 70H82l6-106Z" fill="#33323a"/>
  <path d="M84 292h24l4 92H86l-2-92Zm28 0h24l-2 92h-26l4-92Z" fill="#2a2932"/>
  <path d="M80 384h32v14H80zm28 0h32v14h-32z" fill="#191813"/>
  <path d="M136 118l52-16 6 12-52 18-6-14Z" fill="#4a4536"/>
  <path d="M150 112h44v12h-44z" fill="#2f2b21"/>
  <path d="M62 176l16-6 4 12-16 6-4-12Z" fill="#242219"/>
</svg>`

export const LEVEL_CLAW = `
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M6 40 20 6M16 42 30 8M26 42 40 8" stroke="#c8c7c2" stroke-width="3.4" stroke-linecap="round" opacity="0.85"/>
  <path d="M13 26c6-3 13-3 19 0" stroke="#8b8a85" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
</svg>`
