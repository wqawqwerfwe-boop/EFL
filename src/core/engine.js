import * as THREE from 'three';
import { Registry, EventBus } from './registry.js';
import { FIXED_DT, MAX_SUBSTEPS } from './config.js';
import { Input } from './input.js';
import { Rng } from './rng.js';
import { disposeScratchTarget } from '../render/scratchTarget.js';

export const STATE = Object.freeze({
  BOOT: 'boot',
  MENU: 'menu',
  LOADING: 'loading',
  GAMEPLAY: 'gameplay',
  PAUSED: 'paused',
  RESULTS: 'results',
});

const ALL_STATES = new Set(Object.values(STATE));

/**
 * The Engine owns the frame loop and the shared context handed to every
 * subsystem. It does NOT know what any subsystem does — it only sequences them.
 *
 * Frame order:
 *   1. input.beginFrame()
 *   2. fixedUpdate(FIXED_DT) xN   — physics, deterministic gameplay
 *   3. update(dt)                 — animation, cameras, AI decisions
 *   4. lateUpdate(dt)             — anything that must observe final transforms
 *   5. render subsystem draws
 *   6. input.endFrame()
 */
export class Engine {
  constructor({ canvas, config }) {
    this.canvas = canvas;
    this.config = config;
    this.registry = new Registry();
    this.events = new EventBus();
    this.input = new Input(canvas, config);
    this.rng = new Rng(config.deterministic ? 0x5eed1234 : (Math.random() * 2 ** 32) >>> 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(config.fov, 1, 0.05, 1200);
    this.camera.rotation.order = 'YXZ';

    /** Separate scene+camera for the first-person viewmodel, drawn with its own
     *  near plane so hands/weapon never clip into world geometry. */
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(60, 1, 0.005, 12);

    this.time = {
      /** Seconds since start, scaled. */ elapsed: 0,
      /** Unscaled wall-clock seconds since start. */ raw: 0,
      /** Last frame delta, scaled and clamped. */ dt: 0,
      /** Fixed step. */ fixed: FIXED_DT,
      /** Interpolation alpha between the last two physics steps, 0..1. */ alpha: 0,
      scale: 1,
      frame: 0,
    };

    this.ctx = {
      engine: this,
      scene: this.scene,
      camera: this.camera,
      viewScene: this.viewScene,
      viewCamera: this.viewCamera,
      canvas,
      config,
      events: this.events,
      input: this.input,
      time: this.time,
      rng: this.rng,
      get: (id) => this.registry.get(id),
      peek: (id) => this.registry.peek(id),
      has: (id) => this.registry.has(id),
    };

    this._accum = 0;
    this._last = 0;
    this._running = false;
    this.state = STATE.BOOT;
    this.prevState = null;
    this.mainMenu = null;
    this._systemStates = new Map();
    this._transitioning = false;
    this._onResize = () => this.resize();
    this.events.on('raid:end', (payload) => this.showResults(payload));
  }

  add(SystemClass, opts = {}) {
    const sys = new SystemClass(opts);
    this.registry.add(sys);
    if (Array.isArray(opts.states) && opts.states.length) {
      this._systemStates.set(sys.constructor.id, new Set(opts.states));
    }
    return this;
  }

  async init() {
    const order = this.registry.resolve();
    for (const sys of order) {
      const t0 = performance.now();
      await sys.init?.(this.ctx);
      const ms = performance.now() - t0;
      if (ms > 50) console.info(`[engine] ${sys.constructor.id} init ${ms.toFixed(0)}ms`);
    }
    this.input.attach();
    addEventListener('resize', this._onResize);
    this.resize();
    return this;
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    for (const sys of this.registry.with('resize')) sys.resize(w, h, this.ctx);
    this.events.emit('resize', { width: w, height: h });
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  stop() {
    this._running = false;
  }

  _loop(now) {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    this.step(now);
  }

  /** Advance one frame. Exposed so the capture harness can pump frames by hand. */
  step(now = performance.now()) {
    const t = this.time;
    // Clamp so a tab-switch or a breakpoint doesn't teleport the simulation.
    const rawDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    t.raw += rawDt;
    t.dt = rawDt * t.scale;
    t.elapsed += t.dt;
    t.frame++;

    this.input.beginFrame();

    this._accum += t.dt;
    let steps = 0;
    const fixedSystems = this.registry.with('fixedUpdate');
    while (this._accum >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const sys of fixedSystems) {
        if (!this._canRun(sys)) continue;
        sys.fixedUpdate(FIXED_DT, this.ctx);
      }
      this._accum -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0; // shed backlog rather than spiral
    t.alpha = this._accum / FIXED_DT;

    for (const sys of this.registry.with('update')) {
      if (!this._canRun(sys)) continue;
      sys.update(t.dt, this.ctx);
    }
    for (const sys of this.registry.with('lateUpdate')) {
      if (!this._canRun(sys)) continue;
      sys.lateUpdate(t.dt, this.ctx);
    }

    const renderSystem = this.registry.peek('render');
    if (typeof renderSystem?.render === 'function') renderSystem.render(this.ctx);

    this.input.endFrame();
  }

  _canRun(sys) {
    if (!sys || sys.enabled === false) return false;
    const allowed = this._systemStates.get(sys.constructor.id);
    if (!allowed || allowed === ALL_STATES) return true;
    return allowed.has(this.state);
  }

  _setInputActive(active) {
    this.input.enabled = !!active;
    this.input.frozen = !active;
    if (!active) {
      try { document.exitPointerLock?.(); } catch {}
      this.input.pointerLocked = false;
    }
  }

  requestPointerLock() {
    if (!this.input.enabled) return;
    this.input.requestPointerLock();
  }

  setState(next) {
    if (this.state === next) return this.state;
    this.prevState = this.state;
    this.state = next;
    document.documentElement.setAttribute('data-game-state', next);
    this.events.emit('state', { from: this.prevState, to: next });
    return this.state;
  }

  enterMenu() {
    this.setState(STATE.MENU);
    this._setInputActive(false);
    const ui = this.ctx.peek('ui');
    ui?.menu?.close?.();
    ui?.setHudVisible?.(false);
    ui?.hideRaidResults?.();
    if (this.mainMenu) this.mainMenu.show();
    return this;
  }

  enterLoading() {
    this.setState(STATE.LOADING);
    this._setInputActive(false);
    const ui = this.ctx.peek('ui');
    ui?.menu?.close?.();
    ui?.setHudVisible?.(false);
    ui?.hideRaidResults?.();
    return this;
  }

  enterGameplay() {
    this.setState(STATE.GAMEPLAY);
    this._setInputActive(true);
    const ui = this.ctx.peek('ui');
    ui?.hideRaidResults?.();
    ui?.setHudVisible?.(true);
    ui?.menu?.close?.();
    return this;
  }

  async startRaid(opts = {}) {
    if (this._transitioning) return;
    this._transitioning = true;
    const raid = this.ctx.peek('raid');
    const startOpts = {
      mapId: opts.mapId ?? 'factory',
      faction: opts.faction ?? 'pmc',
      night: !!opts.night,
    };
    try {
      if (this.mainMenu?.isOpen?.()) {
        await this.mainMenu.close({ fade: 700, destroy: false });
      }
      this.enterLoading();
      if (!raid || typeof raid.start !== 'function') {
        throw new Error('[engine] raid subsystem missing');
      }
      await raid.start(startOpts.mapId, startOpts.faction, startOpts.night);
      this.enterGameplay();
      this.requestPointerLock();
    } catch (err) {
      console.error('[engine] startRaid failed', err);
      this.enterMenu();
      throw err;
    } finally {
      this._transitioning = false;
    }
  }

  showResults(payload = {}) {
    const ui = this.ctx.peek('ui');
    const summary = payload?.summary ? payload.summary : payload;
    this.setState(STATE.RESULTS);
    this._setInputActive(false);
    ui?.menu?.close?.();
    ui?.setHudVisible?.(false);
    ui?.showRaidResults?.(summary);
    return this;
  }

  returnToMenu() {
    const ui = this.ctx.peek('ui');
    ui?.hideRaidResults?.();
    ui?.setHudVisible?.(false);
    ui?.menu?.close?.();
    this.enterMenu();
    return this;
  }

  dispose() {
    this.stop();
    removeEventListener('resize', this._onResize);
    this.input.detach();
    /* The 1x1 shader-compile target is a session-long singleton owned by the
     * render system (see render/scratchTarget.js) precisely so the raid prewarm
     * stops allocating and destroying one per deploy. Engine shutdown is the
     * only place allowed to free it, and it has to happen before the render
     * system tears down the WebGL context underneath it. */
    disposeScratchTarget(this.registry.peek('render'));
    for (const sys of [...this.registry.ordered].reverse()) sys.dispose?.();
    this.events.clear();
  }
}
