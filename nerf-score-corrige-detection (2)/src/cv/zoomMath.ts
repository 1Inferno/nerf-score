import {Point2D} from '../types/nerf';

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ZoomPanState {
  zoom: number;
  panX: number;
  panY: number;
}

export function clamp01(value: number): number {
  return Math.max(0.005, Math.min(0.995, value));
}

/**
 * Converts a screen/pointer coordinate `(clientX, clientY)` into normalized original-image
 * coordinates `(0..1, 0..1)` using the rendered stage bounding rect (already transformed by zoom & pan).
 */
export function screenPointToOriginalNormalized(
  clientX: number,
  clientY: number,
  stageRect: ViewportRect,
): Point2D {
  if (stageRect.width <= 0 || stageRect.height <= 0) {
    return {x: 0.5, y: 0.5};
  }
  return {
    x: clamp01((clientX - stageRect.left) / stageRect.width),
    y: clamp01((clientY - stageRect.top) / stageRect.height),
  };
}

/**
 * Inverse projection: given an original-image normalized point `(0..1, 0..1)` and the unzoomed base stage box,
 * computes where that point lands on screen under a given `ZoomPanState` (`translate3d(panX, panY, 0) scale(zoom)`).
 */
export function originalNormalizedToScreenPoint(
  originalPt: Point2D,
  baseRect: ViewportRect,
  state: ZoomPanState,
): {clientX: number; clientY: number} {
  return {
    clientX: baseRect.left + state.panX + originalPt.x * baseRect.width * state.zoom,
    clientY: baseRect.top + state.panY + originalPt.y * baseRect.height * state.zoom,
  };
}

/**
 * Computes the bounding rect of the zoomed/panned stage given an unzoomed base rect and `ZoomPanState`.
 */
export function computeTransformedStageRect(
  baseRect: ViewportRect,
  state: ZoomPanState,
): ViewportRect {
  return {
    left: baseRect.left + state.panX,
    top: baseRect.top + state.panY,
    width: baseRect.width * state.zoom,
    height: baseRect.height * state.zoom,
  };
}

/**
 * Clamps pan offsets so the zoomed image stays within the container viewport.
 */
export function clampPanOffset(
  panX: number,
  panY: number,
  zoom: number,
  baseWidth: number,
  baseHeight: number,
): {panX: number; panY: number} {
  if (zoom <= 1.001 || baseWidth <= 0 || baseHeight <= 0) {
    return {panX: 0, panY: 0};
  }
  const minX = -(baseWidth * (zoom - 1));
  const minY = -(baseHeight * (zoom - 1));
  return {
    panX: Math.max(minX, Math.min(0, panX)),
    panY: Math.max(minY, Math.min(0, panY)),
  };
}

/**
 * Updates zoom around an anchor pixel `(anchorLocalX, anchorLocalY)` relative to the unzoomed viewport top-left
 * so the image detail under the user's fingers/cursor stays anchored while zooming in or out.
 */
export function zoomAroundLocalAnchor(
  current: ZoomPanState,
  nextZoom: number,
  anchorLocalX: number,
  anchorLocalY: number,
  baseWidth: number,
  baseHeight: number,
): ZoomPanState {
  const clampedZoom = Math.max(1, Math.min(6, Math.round(nextZoom * 100) / 100));
  if (clampedZoom <= 1.001) {
    return {zoom: 1, panX: 0, panY: 0};
  }
  const imgX = (anchorLocalX - current.panX) / Math.max(1e-4, current.zoom);
  const imgY = (anchorLocalY - current.panY) / Math.max(1e-4, current.zoom);
  const rawPanX = anchorLocalX - imgX * clampedZoom;
  const rawPanY = anchorLocalY - imgY * clampedZoom;
  const clamped = clampPanOffset(rawPanX, rawPanY, clampedZoom, baseWidth, baseHeight);
  return {
    zoom: clampedZoom,
    panX: clamped.panX,
    panY: clamped.panY,
  };
}

export function createDiamondPresetPolygon(): Point2D[] {
  return [
    {x: 0.5, y: 0.16},
    {x: 0.79, y: 0.5},
    {x: 0.5, y: 0.84},
    {x: 0.21, y: 0.5},
  ];
}

export function createRectanglePresetPolygon(): Point2D[] {
  return [
    {x: 0.24, y: 0.2},
    {x: 0.76, y: 0.2},
    {x: 0.76, y: 0.8},
    {x: 0.24, y: 0.8},
  ];
}
