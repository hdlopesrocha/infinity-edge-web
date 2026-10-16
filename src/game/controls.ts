// Control 37_T verbatim: per-axis deadzone, playable-area stick, positions.

import { clamp } from '../engine/math';

export interface Touch {
  x: number;
  y: number;
}

export class AnalogStick {
  value = { x: 0, y: 0 };
  old = { x: 0, y: 0 };
  pressing = false;
  enabled = false;
  backX = 0;
  backY = 0;
  stickX = 0;
  stickY = 0;
  readonly backSize = 256;
  readonly stickSize = 96;
  readonly areaSize = 320; // 256 + 2*32 margin

  reset(_w: number, _h: number): void {
    this.old = { ...this.value };
    this.value = { x: 0, y: 0 };
  }

  receiveTouch(x: number, y: number, w: number): void {
    if (x > (2 * w) / 3) return;
    if (!this.enabled) {
      this.backX = x - this.backSize / 2;
      this.backY = y - this.backSize / 2;
    }
    this.pressing = true;
    const bottom = this.backY + this.backSize;
    const right = this.backX + this.backSize;
    let vy = -clamp((bottom - y) / (this.backSize / 2) - 1, -1, 1);
    let vx = -clamp((right - x) / (this.backSize / 2) - 1, -1, 1);
    // Per-axis deadzone + rescale (verbatim)
    if (Math.abs(vx) < 0.1) vx = 0;
    else if (vx < 0) vx = (vx + 0.1) * 1.1111;
    else vx = (vx - 0.1) * 1.1111;
    if (Math.abs(vy) < 0.1) vy = 0;
    else if (vy < 0) vy = (vy + 0.1) * 1.1111;
    else vy = (vy - 0.1) * 1.1111;
    this.value = { x: clamp(vx, -1, 1), y: clamp(vy, -1, 1) };
  }

  finish(): void {
    this.enabled = this.pressing;
    this.value = {
      x: clamp(this.value.x + (this.old.x - this.value.x) * 0.7, -1, 1),
      y: clamp(this.value.y + (this.old.y - this.value.y) * 0.7, -1, 1),
    };
    const l = Math.hypot(this.value.x, this.value.y);
    if (l > 1) {
      this.value.x /= l;
      this.value.y /= l;
    }
    this.stickX = this.backX + this.backSize / 2 + (this.backSize / 2) * this.value.x - this.stickSize / 2;
    this.stickY = this.backY + this.backSize / 2 + (this.backSize / 2) * this.value.y - this.stickSize / 2;
  }
}

export class AnalogAcel {
  value = 0;
  old = 0;
  /** Last value set by a touch drag: the throttle stays where it was left. */
  touchValue = 0;
  /** True while the throttle is being commanded by the keyboard. */
  keyThrust = false;
  // Area/Back rectangles: Area (W-96, H-400, 96x400); Back (Area.X+48, Area.Y+48, 16x304)
  areaX = 0;
  areaY = 0;
  backX = 0;
  backY = 0;
  readonly backW = 16;
  readonly backH = 400 - 96;
  readonly knobSize = 96;

  reset(w: number, h: number): void {
    this.old = this.value;
    this.areaX = w - 96;
    this.areaY = h - 400;
    this.backX = this.areaX + 48;
    this.backY = this.areaY + 48;
    // The original only zeroes the throttle in the `#if WINDOWS` branch; on the
    // phone the value survives the frame, so dragging the slider sets a cruise
    // speed and releasing the finger keeps it (steer/fire while moving).
  }

  receiveTouch(x: number, y: number): void {
    if (x >= this.areaX && x <= this.areaX + 96 && y >= this.areaY && y <= this.areaY + 400) {
      this.value = clamp((this.backY + this.backH - y) / this.backH, 0, 1);
      this.touchValue = this.value;
    }
  }

  finish(): void {
    this.value = clamp(this.value + (this.old - this.value) * 0.7, 0.0001, 1);
  }
}

export class TouchButton {
  value = false;
  // BackRectangle 96x96; AreaRectangle = Back (or offset 0 here)
  x = 0;
  y = 0;
  readonly size = 96;

  constructor(private row: number) {}

  reset(w: number, h: number): void {
    this.x = w - 96 - 128;
    this.y = h - (96 + 32) * this.row;
    this.value = false;
  }

  receiveTouch(tx: number, ty: number): void {
    if (tx >= this.x && tx <= this.x + this.size && ty >= this.y && ty <= this.y + this.size) {
      this.value = true;
    }
  }
}

export class Control {
  analogStick = new AnalogStick();
  analogAcel = new AnalogAcel();
  fireButton = new TouchButton(1);
  homingButton = new TouchButton(2);
  nitroButton = new TouchButton(3);
  homings = 0;
  nitroFrac = 0;
  keys = new Set<string>();
  touches = new Map<number, Touch>();
  private w = 1280;
  private h = 720;

  update(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.analogStick.reset(w, h);
    this.analogAcel.reset(w, h);
    this.fireButton.reset(w, h);
    this.homingButton.reset(w, h);
    this.nitroButton.reset(w, h);
    this.analogStick.pressing = false;
    for (const t of this.touches.values()) {
      this.analogStick.receiveTouch(t.x, t.y, w);
      this.analogAcel.receiveTouch(t.x, t.y);
      this.fireButton.receiveTouch(t.x, t.y);
      this.homingButton.receiveTouch(t.x, t.y);
      this.nitroButton.receiveTouch(t.x, t.y);
    }
    const k = this.keys;
    const has = (...codes: string[]) => codes.some((c) => k.has(c));
    if (has('Space')) this.fireButton.value = true;
    if (has('ArrowLeft', 'KeyA')) this.analogStick.value.x = -1;
    if (has('ArrowRight', 'KeyD')) this.analogStick.value.x = 1;
    if (has('ArrowUp', 'KeyW')) this.analogStick.value.y = -1;
    if (has('ArrowDown', 'KeyS')) this.analogStick.value.y = 1;
    // Keyboard throttle is hold-to-thrust: releasing it falls back to the
    // cruise value set with the touch slider (which persists).
    // Plain keys only: Ctrl/Alt as modifiers make the browser fire its own
    // shortcuts (Ctrl+W closes the tab, Alt focuses the menu bar).
    const keyThrust = has('KeyC');
    if (keyThrust) {
      this.analogAcel.value = 1;
      this.analogAcel.keyThrust = true;
    } else if (this.analogAcel.keyThrust) {
      this.analogAcel.keyThrust = false;
      this.analogAcel.value = this.analogAcel.touchValue;
    }
    if (has('KeyM')) this.homingButton.value = true;
    if (has('ShiftLeft', 'ShiftRight', 'KeyN', 'KeyB')) this.nitroButton.value = true;
    this.analogStick.finish();
    this.analogAcel.finish();
    void this.w;
    void this.h;
  }
}
