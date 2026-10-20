// Geometry for the player-colour frame painted just inside the focus
// rectangle. Kept separate from the renderer so the pixel math is unit-tested.

export interface FocusViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Four strips forming a `thicknessPx` stroke wholly inside `rect`. `rect` is
 * normalized to `view` (bottom-left origin, the composite convention); the
 * returned strips are in physical pixels. Edges that fall outside the view are
 * left at their real coordinates: the renderer scissor-intersects each strip,
 * so a clipped plane edge never becomes a line along the viewport border.
 */
export function focusBorderStrips(
  rect: FocusViewRect,
  view: FocusViewRect,
  thicknessPx: number,
): FocusViewRect[] {
  if (view.w <= 0 || view.h <= 0) return [];
  const x0 = Math.ceil(view.x + rect.x * view.w);
  const y0 = Math.ceil(view.y + rect.y * view.h);
  const x1 = Math.floor(view.x + (rect.x + rect.w) * view.w);
  const y1 = Math.floor(view.y + (rect.y + rect.h) * view.h);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw < 2 || rh < 2) return [];
  const t = Math.min(
    Math.max(1, Math.round(thicknessPx)),
    Math.floor(Math.min(rw, rh) / 2),
  );
  return [
    { x: x0, y: y1 - t, w: rw, h: t },          // top
    { x: x0, y: y0, w: rw, h: t },              // bottom
    { x: x0, y: y0 + t, w: t, h: rh - t * 2 },  // left
    { x: x1 - t, y: y0 + t, w: t, h: rh - t * 2 }, // right
  ];
}
