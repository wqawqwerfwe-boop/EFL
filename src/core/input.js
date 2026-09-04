/**
 * Input aggregation: keyboard, mouse (pointer-locked), and gamepad, exposed as
 * a stable per-frame snapshot so gameplay never touches raw DOM events.
 *
 * Edge queries (`pressed`, `released`) are valid only during the frame in which
 * the transition happened — read them in update(), not fixedUpdate().
 *
 * ---------------------------------------------------------------------------
 * POINTER LOCK ARBITRATION
 *
 * `_onMouseDown()` used to re-acquire pointer lock on ANY left click anywhere in
 * the document as long as `enabled` was true. Full-screen DOM overlays (the
 * inventory, the ESC menu, the settings panel) release the cursor but leave
 * `enabled` untouched, so the first click on an inventory item re-locked the
 * mouse in the middle of a drag and handed the look vector back to the camera.
 * `frozen` did not help: it only zeroes `look` and gates `_onMouseMove()`.
 *
 * The same handler also published the button into `_pendingDown`, so `fire` went
 * true and the weapon system pulled the trigger — clicking an item to drag it
 * discharged the gun. `time.scale` is 0 while the inventory is open, so
 * `WeaponSystem.time` never advanced past `nextShotAt` and the shot always
 * passed its rate-of-fire gate.
 *
 * The fix is an explicit, owner-keyed suppression set. A UI surface calls
 * `suppressPointerLock('inventory')` while it owns the cursor and
 * `allowPointerLock('inventory')` when it hands it back. While ANY suppressor is
 * registered:
 *   - `requestPointerLock()` is a no-op, whoever calls it;
 *   - `_onMouseDown()` never auto-locks and never publishes the button;
 *   - `_onMouseMove()` accumulates no look delta, and `beginFrame()` publishes
 *     `look` as zero — the camera cannot be moved by an overlay drag;
 *   - `fire` / `firePressed` / `ads` report false.
 *
 * A second, independent guard keys off the DOM: pointer and keyboard events that
 * originate inside a registered UI overlay never auto-lock and never enter the
 * action snapshot, even if a surface forgets to register a suppressor. Belt and
 * braces, because a stuck pointer lock is unrecoverable without an alt-tab.
 */

/**
 * Roots that own the cursor whenever they are on screen. Kept deliberately in
 * sync with `SKIP_ROOTS` in ui/mainMenuBridge.js. `[data-efl-overlay]` lets any
 * future surface opt in without editing core.
 */
export const UI_OVERLAY_SELECTOR = '#eftInv, .efl-esc, .efl-set, [data-efl-overlay]';

export const ACTIONS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  use: ['KeyF'],
  melee: ['KeyV'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  swapWeapon: ['Digit1', 'Digit2', 'Tab'],
  grenade: ['KeyG'],
  flashlight: ['KeyT'],
  pause: ['Escape'],
};

/** True when the event originated inside a cursor-owning UI overlay. */
function inUiOverlay(target) {
  if (!target || target.nodeType !== 1 || typeof target.closest !== 'function') return false;
  try {
    return !!target.closest(UI_OVERLAY_SELECTOR);
  } catch (e) {
    /* Malformed selector support in exotic engines — fail open, not closed. */
    return false;
  }
}

/** Text entry must reach the DOM verbatim: no preventDefault, no action snapshot. */
function isEditableTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

export class Input {
  constructor(canvas, config) {
    this.canvas = canvas;
    this.config = config;

    this.down = new Set(); // codes currently held
    this._pressed = new Set(); // went down this frame
    this._released = new Set(); // went up this frame
    this._pendingDown = new Set();
    this._pendingUp = new Set();

    /** Accumulated pointer delta for this frame, in radians after sensitivity. */
    this.look = { x: 0, y: 0 };
    this._rawLook = { x: 0, y: 0 };
    this.wheel = 0;
    this._pendingWheel = 0;

    this.pointerLocked = false;
    this.enabled = true;
    /** Set true by capture mode so scripted shots aren't fought by real input. */
    this.frozen = false;

    /**
     * Owners that currently forbid pointer lock. A Set, not a boolean, so two
     * overlapping surfaces (inventory opened from the ESC menu) cannot have the
     * inner one hand the cursor back while the outer one still needs it.
     */
    this._lockSuppressors = new Set();

    this.gamepadIndex = null;
    this.stick = { moveX: 0, moveY: 0, lookX: 0, lookY: 0 };

    this._bound = {
      keydown: this._onKeyDown.bind(this),
      keyup: this._onKeyUp.bind(this),
      mousedown: this._onMouseDown.bind(this),
      mouseup: this._onMouseUp.bind(this),
      mousemove: this._onMouseMove.bind(this),
      wheel: this._onWheel.bind(this),
      lockchange: this._onLockChange.bind(this),
      blur: this._onBlur.bind(this),
      contextmenu: (e) => e.preventDefault(),
    };
  }

  attach() {
    addEventListener('keydown', this._bound.keydown);
    addEventListener('keyup', this._bound.keyup);
    addEventListener('mousedown', this._bound.mousedown);
    addEventListener('mouseup', this._bound.mouseup);
    addEventListener('mousemove', this._bound.mousemove);
    addEventListener('wheel', this._bound.wheel, { passive: true });
    addEventListener('blur', this._bound.blur);
    document.addEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
  }

  detach() {
    removeEventListener('keydown', this._bound.keydown);
    removeEventListener('keyup', this._bound.keyup);
    removeEventListener('mousedown', this._bound.mousedown);
    removeEventListener('mouseup', this._bound.mouseup);
    removeEventListener('mousemove', this._bound.mousemove);
    removeEventListener('wheel', this._bound.wheel);
    removeEventListener('blur', this._bound.blur);
    document.removeEventListener('pointerlockchange', this._bound.lockchange);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
  }

  /* ------------------------------------------------ pointer lock suppression */

  /**
   * Forbid pointer lock until `owner` gives it back. Idempotent, so a surface
   * may call it on every show() without bookkeeping.
   */
  suppressPointerLock(owner = 'anonymous') {
    this._lockSuppressors.add(owner);
    /* Any lock still held belongs to gameplay, not to the overlay that just
     * opened. Drop it here so callers don't each re-implement exitPointerLock. */
    if (this.pointerLocked && typeof document !== 'undefined' && typeof document.exitPointerLock === 'function') {
      try {
        document.exitPointerLock();
      } catch (e) {
        /* already unlocked */
      }
    }
    /* A suppressed frame must not carry mouse buttons into gameplay. */
    this._pendingDown.delete('Mouse0');
    this._pendingDown.delete('Mouse1');
    this._pendingDown.delete('Mouse2');
    for (const code of this.down) {
      if (code.startsWith('Mouse')) this._pendingUp.add(code);
    }
    /* ...nor a look delta. Moves that landed earlier in THIS frame, before the
     * overlay went up, are already sitting in _rawLook and would be applied by
     * the next beginFrame() as a kick of exactly the size of the mouse travel
     * that opened the panel. Drop both the raw accumulator and the published
     * vector: gameplay may read `look` again before the next beginFrame(). */
    this._rawLook.x = 0;
    this._rawLook.y = 0;
    this.look.x = 0;
    this.look.y = 0;
    return this._lockSuppressors.size;
  }

  allowPointerLock(owner = 'anonymous') {
    this._lockSuppressors.delete(owner);
    return this._lockSuppressors.size;
  }

  /** True while at least one UI surface owns the cursor. */
  get pointerLockSuppressed() {
    return this._lockSuppressors.size > 0;
  }

  /** Diagnostic for the ESC-menu cursor arbiter and dev overlays. */
  get pointerLockOwners() {
    return Array.from(this._lockSuppressors);
  }

  requestPointerLock() {
    if (!this.enabled) return;
    /* THE fix for the drag-and-drop bug: while an overlay owns the cursor this
     * is a no-op no matter who calls it — inventory, ESC menu, or a stray
     * mousedown that leaked up to window. */
    if (this.pointerLockSuppressed) return;
    // Chrome returns a promise that rejects if the document is not eligible
    // (headless capture, an iframe, a lock request too soon after an exit).
    // An unhandled rejection there shows up as a page error in the harness, so
    // swallow it: failing to lock is not a game error.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not eligible — keep running unlocked */
    }
  }

  /* ---------------------------------------------------------- DOM listeners */

  _onKeyDown(e) {
    if (!this.enabled) return;
    if (e.repeat) return;
    /* Text fields and overlay chrome own their own keystrokes. Without this the
     * stash search box was unusable: every character was swallowed by
     * preventDefault and simultaneously published as a movement action, so
     * typing "wasd" walked the player around inside the menu. */
    if (isEditableTarget(e.target) || inUiOverlay(e.target)) return;
    // Let devtools/refresh through; swallow everything else the game binds.
    if (!e.metaKey && !e.ctrlKey) e.preventDefault();
    this._pendingDown.add(e.code);
  }

  _onKeyUp(e) {
    if (!this.enabled) return;
    /* Always publish the release, even from an overlay: a key pressed in
     * gameplay and released over an overlay must not stay latched. */
    this._pendingUp.add(e.code);
  }

  _onMouseDown(e) {
    if (!this.enabled) return;

    /* Two independent reasons to keep our hands off this click. */
    if (this.pointerLockSuppressed || inUiOverlay(e.target)) return;

    if (!this.pointerLocked && e.button === 0) this.requestPointerLock();
    this._pendingDown.add(`Mouse${e.button}`);
  }

  _onMouseUp(e) {
    if (!this.enabled) return;
    /* Unconditional, symmetric with _onKeyUp: never leave a button latched. */
    this._pendingUp.add(`Mouse${e.button}`);
  }

  _onMouseMove(e) {
    if (!this.enabled || !this.pointerLocked || this.frozen) return;
    /* The camera reads the suppression set, NOT the DOM's lock state.
     *
     * document.exitPointerLock() is asynchronous: `pointerlockchange` lands a
     * frame or more after an overlay opens, so `pointerLocked` is still true for
     * the first several moves over an open panel. Each one accumulated into
     * _rawLook and was applied by the next beginFrame() — i.e. the view snapped
     * to wherever the player had dragged an item to. The `frozen` check above
     * masked it only because InventorySystem._open() happens to set that flag as
     * well; the ESC menu and the settings panel file a suppressor without it and
     * still moved the camera.
     *
     * inUiOverlay() is the second, independent guard: an unlocked cursor moving
     * over .efl-esc / .efl-set / #eftInv contributes nothing even if the surface
     * forgot to register itself at all. */
    if (this.pointerLockSuppressed || inUiOverlay(e.target)) return;
    // movementX/Y is already relative and unaffected by cursor clamping.
    this._rawLook.x += e.movementX ?? 0;
    this._rawLook.y += e.movementY ?? 0;
  }

  _onWheel(e) {
    if (!this.enabled) return;
    /* Scrolling the stash must not cycle the player's weapon. */
    if (this.pointerLockSuppressed || inUiOverlay(e.target)) return;
    this._pendingWheel += Math.sign(e.deltaY);
  }

  _onLockChange() {
    this.pointerLocked = document.pointerLockElement === this.canvas;
    if (!this.pointerLocked) this._onBlur();
  }

  /** Losing focus must release every held key, or the player runs forever. */
  _onBlur() {
    for (const code of this.down) this._pendingUp.add(code);
    this._rawLook.x = 0;
    this._rawLook.y = 0;
  }

  beginFrame() {
    this._pressed.clear();
    this._released.clear();

    for (const code of this._pendingDown) {
      if (!this.down.has(code)) {
        this.down.add(code);
        this._pressed.add(code);
      }
    }
    for (const code of this._pendingUp) {
      if (this.down.delete(code)) this._released.add(code);
    }
    this._pendingDown.clear();
    this._pendingUp.clear();

    const s = this.config.sensitivity;
    /* Suppressed is as dead as frozen for the camera: while a UI surface owns the
     * cursor the view does not move, whatever managed to reach _rawLook. */
    const mute = this.frozen || this.pointerLockSuppressed;
    this.look.x = mute ? 0 : this._rawLook.x * s;
    this.look.y = mute ? 0 : this._rawLook.y * s * (this.config.invertY ? -1 : 1);
    this._rawLook.x = 0;
    this._rawLook.y = 0;

    this.wheel = this._pendingWheel;
    this._pendingWheel = 0;

    this._pollGamepad();
  }

  endFrame() {}

  _pollGamepad() {
    const pads = navigator.getGamepads?.() ?? [];
    const pad = pads[this.gamepadIndex ?? 0] ?? pads.find(Boolean);
    if (!pad) {
      this.stick.moveX = this.stick.moveY = this.stick.lookX = this.stick.lookY = 0;
      return;
    }
    const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
    this.stick.moveX = dz(pad.axes[0] ?? 0);
    this.stick.moveY = dz(pad.axes[1] ?? 0);
    // Cubic response curve on the look stick — fine aim near centre, fast flicks at the edge.
    const curve = (v) => Math.sign(v) * Math.abs(v) ** 2.4;
    this.stick.lookX = curve(dz(pad.axes[2] ?? 0));
    this.stick.lookY = curve(dz(pad.axes[3] ?? 0));
  }

  /** True while any key bound to `action` is held. */
  action(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  actionPressed(name) {
    const codes = ACTIONS[name];
    if (!codes) return false;
    for (const c of codes) if (this._pressed.has(c)) return true;
    return false;
  }

  held(code) {
    return this.down.has(code);
  }

  pressed(code) {
    return this._pressed.has(code);
  }

  released(code) {
    return this._released.has(code);
  }

  /*
   * Gameplay trigger queries are gated on the suppression set. This is the single
   * chokepoint that stops a UI click from being read as a shot, so no subsystem
   * has to learn what an overlay is.
   */
  get fire() {
    return !this.pointerLockSuppressed && this.down.has('Mouse0');
  }

  get firePressed() {
    return !this.pointerLockSuppressed && this._pressed.has('Mouse0');
  }

  get ads() {
    return !this.pointerLockSuppressed && this.down.has('Mouse2');
  }

  /** Normalised WASD + left-stick movement, clamped to the unit disc so
   *  diagonals aren't faster than cardinals. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = (this.action('right') ? 1 : 0) - (this.action('left') ? 1 : 0);
    let y = (this.action('forward') ? 1 : 0) - (this.action('back') ? 1 : 0);
    x += this.stick.moveX;
    y -= this.stick.moveY;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    out.x = x;
    out.y = y;
    return out;
  }
}
