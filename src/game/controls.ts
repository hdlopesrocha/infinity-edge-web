// Control port: Core/Control/*.cs — touch buttons + keyboard + smoothing.
// The view feeds pointer/keyboard state; update(w,h) computes values per the
// original formulas. Draw state (counts, knob positions) is read by GameView.

import { clamp } from '../engine/math';

export interface StickValue {
  x: number;
  y: number;
}

export interface Touch {
  x: number;
  y: number;
}

export class AnalogStick {
  value: StickValue = { x: 0, y: 0 };
  old: StickValue = { x: 0, y: 0 };
  pressing = false;
  enabled = false;
  // geometry (set each update from canvas size)
  backX = 0;
  backY = 0;
  stickX = 0;
  stickY = 0;
  readonly backSize = 256;
  readonly stickSize = 96;
  readonly areaPad = 64; // 2*margin32

  reset(): void {
    this.old = { ...this.value };
    this.value = { x: 0, y: 0 };
  }

  receiveTouch(x: number, y: number, w: number, h: number): void {
    // playable area: left 2/3
    if (x > (2 * w) / 3) return;
    if (!this.enabled) {
      // recenter area/back on finger
      this.backX = x - this.backSize / 2;
      this.backY = y - this.backSize / 2;
    }
    this.pressing = true;
    const areaX = this.backX - 32;
    const areaY = this.backY - 32;
    const areaW = this.backSize + 64;
    const areaH = this.backSize + 64;
    void areaX; void areaY;
    const right = this.backX + this.backSize;
    const bottom = this.backY + this.backSize;
    void areaW; void areaH;
    let vx = -clamp((right - x) / (this.backSize / 2) - 1, -1, 1);
    let vy = -clamp((bottom - y) / (this.backSize / 2) - 1, -1, 1);
    void w; void h;
    if (Math.hypot(vx, vy) < 0.1) {
      vx = 0;
      vy = 0;
    } else {
      vx *= 1.1111;
      vy *= 1.1111;
    }
    this.value = { x: clamp(vx, -1, 1), y: clamp(vy, -1, 1) };
  }

  finish(): void {
    this.enabled = this.pressing;
    // smoothing: lerp toward old (verbatim)
    this.value = {
      x: clamp(this.value.x + (this.old.x - this.value.x) * 0.7, -1, 1),
      y: clamp(this.value.y + (this.old.y - this.value.y) * 0.7, -1, 1),
    };
    const l = Math.hypot(this.value.x, this.value.y);
    if (l > 1) {
      this.value.x /= l;
      this.value.y /= l;
    }
    // stick knob offset: Center + Size*Value/2 - Stick/2 (verbatim)
    this.stickX = this.backX + this.backSize / 2 + (this.backSize * this.value.x) / 2 - this.stickSize / 2;
    this.stickY = this.backY + this.backSize / 2 + (this.backSize * this.value.y) / 2 - this.stickSize / 2;
  }
}

export class AnalogAcel {
  value = 0;
  old = 0;

  reset(): void {
    this.old = this.value;
    this.value = 0; // Windows/no-touch default
  }

  receiveTouch(x: number, y: number, w: number, h: number): void {
    const areaX = w - 96;
    const areaY = h - 400;
    if (x >= areaX && x <= areaX + 96 && y >= areaY && y <= areaY + 400) {
      const bottom = areaY + 400;
      this.value = clamp((bottom - y) / 400, 0, 1);
    }
  }

  finish(): void {
    this.value = clamp(this.value + (this.old - this.value) * 0.7, 0.0001, 1);
  }
}

export class TouchButton {
  value = false;

  constructor(public rect: (w: number, h: number) => { x: number; y: number; w: number; h: number }) {}

  reset(): void {
    this.value = false;
  }

  receiveTouch(x: number, y: number, w: number, h: number): void {
    const r = this.rect(w, h);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) this.value = true;
  }
}

export class Control {
  analogStick = new AnalogStick();
  analogAcel = new AnalogAcel();
  fireButton = new TouchButton((w, h) => ({ x: w - 96 - 128, y: h - 128 * 1, w: 96, h: 96 }));
  homingButton = new TouchButton((w, h) => ({ x: w - 96 - 128, y: h - 128 * 2, w: 96, h: 96 }));
  nitroButton = new TouchButton((w, h) => ({ x: w - 96 - 128, y: h - 128 * 3, w: 96, h: 96 }));
  homings = 0;
  nitroFrac = 0;
  keys = new Set<string>();
  touches = new Map<number, Touch>();

  /** Per-frame update (Control.Update verbatim, touch+keyboard). */
  update(w: number, h: number): void {
    this.analogStick.reset();
    this.analogAcel.reset();
    this.fireButton.reset();
    this.homingButton.reset();
    this.nitroButton.reset();
    this.analogStick.pressing = false;
    for (const t of this.touches.values()) {
      this.analogStick.receiveTouch(t.x, t.y, w, h);
      this.analogAcel.receiveTouch(t.x, t.y, w, h);
      this.fireButton.receiveTouch(t.x, t.y, w, h);
      this.homingButton.receiveTouch(t.x, t.y, w, h);
      this.nitroButton.receiveTouch(t.x, t.y, w, h);
    }
    const k = this.keys;
    const has = (...codes: string[]) => codes.some((c) => k.has(c));
    if (has('Space')) this.fireButton.value = true;
    if (has('ArrowLeft', 'KeyA')) this.analogStick.value.x = -1;
    if (has('ArrowRight', 'KeyD')) this.analogStick.value.x = 1;
    if (has('ArrowUp', 'KeyW')) this.analogStick.value.y = -1;
    if (has('ArrowDown', 'KeyS')) this.analogStick.value.y = 1;
    if (has('ControlLeft', 'KeyC')) this.analogAcel.value = 1;
    if (has('AltLeft', 'KeyM')) this.homingButton.value = true;
    if (has('ShiftLeft', 'ShiftRight', 'KeyN')) this.nitroButton.value = true;
    if (has('Escape')) {
      /* handled by view (back navigation) */
    }
    this.analogStick.finish();
    this.analogAcel.finish();
  }
}
