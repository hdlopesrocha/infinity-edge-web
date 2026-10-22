// Generic world-space UI scene.
//
// The in-game HUD and every menu/lobby/room screen are the same 16:9 UI plane
// in this scene. The plane has one size and one texture at a time; only its
// rotation and content painter change:
//   - HUD mode paints `store.hud` (no action column) and the XR host rotates
//     the plane with the head so it stays in front of the user,
//   - menu mode paints a ScreenUi into the left seven eighths, turns the
//     right action column on, and keeps the reset orientation so the gaze ray
//     can sweep a still plane.
// The XR renderer feeds this scene the same midpoint distance, 80% fullscreen
// size and focus feather for both modes, so the game scene and the menus cannot
// drift into different-looking planes.
//
// The painters still own their own canvases (the HUD cache and MenuUi have
// different repaint rules), but they upload into the SAME quad drawn here. The
// action-column toggle is deliberately on the scene, not on each screen: the
// host calls setActions(false) for a live match and setActions(true) for menus
// and the pause screen.

import { store } from '../game/store';
import { HudOverlay } from './hud3d';
import { PANEL_H, PANEL_W, VrPanel, WorldQuad } from './vrpanel';
import type { PanelBasis } from './vrpanel';
import type { ScreenUi } from './overlay';

type Hud = typeof store.hud;
type UiMode = 'none' | 'menu' | 'hud';

export class UiScene {
  /** Painted plane size (the one 16:9 content rectangle). */
  readonly width = PANEL_W;
  readonly height = PANEL_H;

  private readonly panel: VrPanel;
  private readonly hud: HudOverlay;
  private readonly quad: WorldQuad;
  private screen: ScreenUi | null = null;
  private texture: WebGLTexture | null = null;
  private mode: UiMode = 'none';
  private actions = true;

  constructor(gl: WebGL2RenderingContext) {
    this.panel = new VrPanel(gl);
    this.hud = new HudOverlay(gl);
    this.quad = new WorldQuad(gl);
  }

  /** Current content kind (diagnostics/tests). */
  get content(): UiMode {
    return this.mode;
  }

  /** Whether the right action column is reserved (menus on, game off). */
  get actionColumn(): boolean {
    return this.actions;
  }

  /** True when a painted texture is ready to draw. */
  get ready(): boolean {
    return this.texture !== null;
  }

  /**
   * Toggle the shared action column. MenuUi repaints at the new content width;
   * the HUD painter simply has no action column.
   */
  setActions(on: boolean): void {
    if (this.actions === on) return;
    this.actions = on;
    this.screen?.setActions?.(on);
  }

  /** Paint and select a menu/lobby/room screen on the plane. */
  setMenu(ui: ScreenUi): void {
    this.screen = ui;
    this.mode = 'menu';
    // Apply the scene-level switch even when this screen was mounted after the
    // last setActions() call.
    ui.setActions?.(this.actions);
    this.panel.update(ui);
    this.texture = this.panel.texture;
  }

  /**
   * Paint and select the in-game HUD. The snapshot must already be prepared
   * for this plane's 1600x900 aspect (the XR loop sets the instance's canvas
   * size and the fitted FOV before calling syncHud).
   */
  setHud(h: Hud | null): void {
    this.screen = null;
    if (!h) {
      this.mode = 'none';
      this.texture = null;
      return;
    }
    this.mode = 'hud';
    this.hud.update(h);
    this.texture = this.hud.texture;
  }

  /** Draw the one plane in the current eye (viewport/scissor are the caller's). */
  draw(
    fbo: WebGLFramebuffer | null, view: Float32Array, proj: Float32Array,
    basis: PanelBasis, width: number, height: number,
  ): void {
    if (!this.texture) return;
    this.quad.draw(
      fbo, view, proj,
      basis.center, basis.right, basis.up, width * 0.5, height * 0.5,
      this.texture,
    );
  }

  /** Release the painters, texture uploaders and the shared quad. */
  dispose(): void {
    this.panel.dispose();
    this.hud.dispose();
    this.quad.dispose();
    this.texture = null;
    this.screen = null;
    this.mode = 'none';
  }
}
