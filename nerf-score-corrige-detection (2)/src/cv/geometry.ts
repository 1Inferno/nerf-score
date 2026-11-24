import {
  Point2D,
  ShotEvent,
  ShootingSession,
  TargetContourGeometry,
  TargetProfile,
  TargetZone,
} from '../types/nerf';

export type Matrix3x3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

function solveLinear8(A: number[][], b: number[]): number[] | null {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(M[r][col]);
      if (v > maxVal) {
        maxVal = v;
        maxRow = r;
      }
    }
    if (maxVal < 1e-10) return null;
    if (maxRow !== col) {
      const tmp = M[col];
      M[col] = M[maxRow];
      M[maxRow] = tmp;
    }
    const pivot = M[col][col];
    for (let c = col; c <= n; c++) {
      M[col][c] /= pivot;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let c = col; c <= n; c++) {
        M[r][c] -= factor * M[col][c];
      }
    }
  }
  return M.map((row) => row[n]);
}

export function computeHomography(
  src: [Point2D, Point2D, Point2D, Point2D],
  dst: [Point2D, Point2D, Point2D, Point2D],
): Matrix3x3 | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const sx = src[i].x;
    const sy = src[i].y;
    const dx = dst[i].x;
    const dy = dst[i].y;
    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  const h = solveLinear8(A, b);
  if (!h) return null;
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H: Matrix3x3, p: Point2D): Point2D {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  if (Math.abs(w) < 1e-8) return {x: p.x, y: p.y};
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

export const UNIT_SQUARE: [Point2D, Point2D, Point2D, Point2D] = [
  {x: 0, y: 0},
  {x: 1, y: 0},
  {x: 1, y: 1},
  {x: 0, y: 1},
];

export function mapFramePointToTargetSpace(
  framePoint: Point2D,
  corners: [Point2D, Point2D, Point2D, Point2D],
): Point2D {
  const H = computeHomography(corners, UNIT_SQUARE);
  if (!H) return framePoint;
  return applyHomography(H, framePoint);
}

export function mapTargetPointToFrameSpace(
  targetPoint: Point2D,
  corners: [Point2D, Point2D, Point2D, Point2D],
): Point2D {
  const H = computeHomography(UNIT_SQUARE, corners);
  if (!H) return targetPoint;
  return applyHomography(H, targetPoint);
}

export function pointInPolygon(pt: Point2D, polygon: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function computePolygonCentroid(polygon: Point2D[]): Point2D {
  if (polygon.length === 0) return {x: 0.5, y: 0.5};
  if (polygon.length < 3) {
    const sx = polygon.reduce((a, p) => a + p.x, 0);
    const sy = polygon.reduce((a, p) => a + p.y, 0);
    return {x: sx / polygon.length, y: sy / polygon.length};
  }
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p0 = polygon[i];
    const p1 = polygon[(i + 1) % polygon.length];
    const cross = p0.x * p1.y - p1.x * p0.y;
    area2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }
  if (Math.abs(area2) < 1e-8) {
    const sx = polygon.reduce((a, p) => a + p.x, 0);
    const sy = polygon.reduce((a, p) => a + p.y, 0);
    return {x: sx / polygon.length, y: sy / polygon.length};
  }
  return {
    x: Math.max(0.01, Math.min(0.99, cx / (3 * area2))),
    y: Math.max(0.01, Math.min(0.99, cy / (3 * area2))),
  };
}

export function computePolygonBoundingBox(polygon: Point2D[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  if (polygon.length === 0) return {x: 0.25, y: 0.25, w: 0.5, h: 0.5};
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);
  const minX = Math.max(0, Math.min(...xs));
  const maxX = Math.min(1, Math.max(...xs));
  const minY = Math.max(0, Math.min(...ys));
  const maxY = Math.min(1, Math.max(...ys));
  return {
    x: minX,
    y: minY,
    w: Math.max(0.02, maxX - minX),
    h: Math.max(0.02, maxY - minY),
  };
}

export function polygonToQuadCorners(
  polygon: Point2D[],
): [Point2D, Point2D, Point2D, Point2D] {
  if (polygon.length === 4) {
    return [
      {...polygon[0]},
      {...polygon[1]},
      {...polygon[2]},
      {...polygon[3]},
    ];
  }
  const bbox = computePolygonBoundingBox(polygon);
  return [
    {x: bbox.x, y: bbox.y},
    {x: bbox.x + bbox.w, y: bbox.y},
    {x: bbox.x + bbox.w, y: bbox.y + bbox.h},
    {x: bbox.x, y: bbox.y + bbox.h},
  ];
}

export function computePolygonGeometry(
  polygon: Point2D[],
  width: number,
  height: number,
): TargetContourGeometry {
  const n = polygon.length;
  if (n < 3) {
    return {
      vertexCount: n,
      sideLengthsNormalized: [],
      sideLengthsPx: [],
      interiorAnglesDeg: [],
      perimeterPx: 0,
      areaNormalized: 0,
      isIrregular: true,
      shapeLabel: 'Contour incomplet',
    };
  }

  const sideLengthsNormalized: number[] = [];
  const sideLengthsPx: number[] = [];
  const interiorAnglesDeg: number[] = [];
  let perimeterPx = 0;
  let area2 = 0;

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    const dxNorm = next.x - curr.x;
    const dyNorm = next.y - curr.y;
    const lenNorm = Math.hypot(dxNorm, dyNorm);
    const lenPx = Math.hypot(dxNorm * width, dyNorm * height);
    sideLengthsNormalized.push(Math.round(lenNorm * 10000) / 10000);
    sideLengthsPx.push(Math.round(lenPx * 10) / 10);
    perimeterPx += lenPx;

    area2 += curr.x * next.y - next.x * curr.y;

    const v1x = (prev.x - curr.x) * width;
    const v1y = (prev.y - curr.y) * height;
    const v2x = (next.x - curr.x) * width;
    const v2y = (next.y - curr.y) * height;
    const m1 = Math.hypot(v1x, v1y);
    const m2 = Math.hypot(v2x, v2y);
    if (m1 > 1e-4 && m2 > 1e-4) {
      const cosA = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
      interiorAnglesDeg.push(Math.round((Math.acos(cosA) * 180) / Math.PI));
    } else {
      interiorAnglesDeg.push(0);
    }
  }

  const minSide = Math.min(...sideLengthsPx);
  const maxSide = Math.max(...sideLengthsPx);
  const sideRatio = minSide > 1 ? maxSide / minSide : 99;
  const hasNonRightAngle = interiorAnglesDeg.some((a) => Math.abs(a - 90) > 6);
  const isIrregular = n !== 4 || sideRatio > 1.12 || hasNonRightAngle;

  let shapeLabel = `Polygone irrégulier (${n} points)`;
  if (n === 4) {
    shapeLabel = hasNonRightAngle
      ? sideRatio <= 1.18
        ? 'Losange / carré tourné (4 points)'
        : 'Quadrilatère irrégulier (4 points)'
      : 'Quadrilatère (4 points)';
  } else if (n === 3) {
    shapeLabel = 'Triangle (3 points)';
  }

  return {
    vertexCount: n,
    sideLengthsNormalized,
    sideLengthsPx,
    interiorAnglesDeg,
    perimeterPx: Math.round(perimeterPx * 10) / 10,
    areaNormalized: Math.round((Math.abs(area2) * 0.5) * 100000) / 100000,
    isIrregular,
    shapeLabel,
  };
}

/**
 * Computes exact intersection distance from `center` along ray toward `pt` to any segment of `polygon`.
 */
export function rayPolygonBoundaryDistance(
  center: Point2D,
  pt: Point2D,
  polygon: Point2D[],
): number {
  const dx = pt.x - center.x;
  const dy = pt.y - center.y;
  const rayLen = Math.hypot(dx, dy);
  if (rayLen < 1e-9 || polygon.length < 3) return 1;
  const rx = dx / rayLen;
  const ry = dy / rayLen;

  let bestT = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const p1 = polygon[i];
    const p2 = polygon[(i + 1) % polygon.length];
    const sx = p2.x - p1.x;
    const sy = p2.y - p1.y;
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-10) continue;
    const qpx = p1.x - center.x;
    const qpy = p1.y - center.y;
    const t = (qpx * sy - qpy * sx) / denom;
    const u = (qpx * ry - qpy * rx) / denom;
    if (t > 1e-7 && u >= -1e-4 && u <= 1 + 1e-4) {
      if (t < bestT) bestT = t;
    }
  }
  return Number.isFinite(bestT) ? bestT : Math.max(rayLen, 1e-4);
}

/**
 * Scales the calibrated polygon boundary inward around `center` by `fraction` (0..1)
 * so scoring zones preserve slanted diamond and irregular edge geometry.
 */
export function buildScaledPolygonRing(
  polygon: Point2D[],
  center: Point2D,
  fraction: number,
): Point2D[] {
  const s = Math.max(0.02, Math.min(1, fraction));
  return polygon.map((p) => ({
    x: center.x + (p.x - center.x) * s,
    y: center.y + (p.y - center.y) * s,
  }));
}

export function translatePolygon(
  polygon: Point2D[],
  center: Point2D,
  dx: number,
  dy: number,
): {polygon: Point2D[]; center: Point2D} {
  let clampedDx = dx;
  let clampedDy = dy;
  for (const p of polygon) {
    if (p.x + clampedDx < 0.01) clampedDx = 0.01 - p.x;
    if (p.x + clampedDx > 0.99) clampedDx = 0.99 - p.x;
    if (p.y + clampedDy < 0.01) clampedDy = 0.01 - p.y;
    if (p.y + clampedDy > 0.99) clampedDy = 0.99 - p.y;
  }
  return {
    polygon: polygon.map((p) => ({
      x: Math.max(0.01, Math.min(0.99, p.x + clampedDx)),
      y: Math.max(0.01, Math.min(0.99, p.y + clampedDy)),
    })),
    center: {
      x: Math.max(0.01, Math.min(0.99, center.x + clampedDx)),
      y: Math.max(0.01, Math.min(0.99, center.y + clampedDy)),
    },
  };
}

export function rotatePolygonAroundCenter(
  polygon: Point2D[],
  center: Point2D,
  angleDeg: number,
  aspectRatio = 1,
): Point2D[] {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ar = Math.max(0.3, Math.min(3, aspectRatio));
  return polygon.map((p) => {
    const rx = (p.x - center.x) * ar;
    const ry = p.y - center.y;
    const nx = center.x + (rx * cos - ry * sin) / ar;
    const ny = center.y + (rx * sin + ry * cos);
    return {
      x: Math.max(0.01, Math.min(0.99, nx)),
      y: Math.max(0.01, Math.min(0.99, ny)),
    };
  });
}

export function scalePolygonAroundCenter(
  polygon: Point2D[],
  center: Point2D,
  factor: number,
): Point2D[] {
  const f = Math.max(0.5, Math.min(1.8, factor));
  return polygon.map((p) => ({
    x: Math.max(0.01, Math.min(0.99, center.x + (p.x - center.x) * f)),
    y: Math.max(0.01, Math.min(0.99, center.y + (p.y - center.y) * f)),
  }));
}

/**
 * Inserts a new vertex along the closest edge of `polygon` so adding points never crosses segments.
 */
export function insertPointOnClosestEdge(polygon: Point2D[], newPt: Point2D): {
  polygon: Point2D[];
  insertedIndex: number;
} {
  if (polygon.length < 2) {
    const next = [...polygon, newPt];
    return {polygon: next, insertedIndex: next.length - 1};
  }
  let bestEdgeIdx = polygon.length - 1;
  let bestDistSq = Infinity;

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const lenSq = abx * abx + aby * aby;
    const t =
      lenSq > 1e-10
        ? Math.max(0, Math.min(1, ((newPt.x - a.x) * abx + (newPt.y - a.y) * aby) / lenSq))
        : 0;
    const px = a.x + t * abx;
    const py = a.y + t * aby;
    const dSq = (newPt.x - px) ** 2 + (newPt.y - py) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestEdgeIdx = i;
    }
  }

  const next = [...polygon];
  const insertAt = bestEdgeIdx + 1;
  next.splice(insertAt, 0, newPt);
  return {polygon: next, insertedIndex: insertAt};
}

export function isPointInZone(targetPt: Point2D, zone: TargetZone, aspectRatio = 1): boolean {
  const dx = targetPt.x - 0.5;
  const dy = targetPt.y - 0.5;

  if (zone.shape === 'polygon' && zone.polygonNormalized && zone.polygonNormalized.length >= 3) {
    return pointInPolygon(targetPt, zone.polygonNormalized);
  }

  if (zone.shape === 'ellipse') {
    const rx = zone.radiusRatio;
    const ry = zone.radiusRatio / Math.max(0.4, Math.min(2.5, aspectRatio));
    return (dx * dx) / (rx * rx + 1e-9) + (dy * dy) / (ry * ry + 1e-9) <= 1;
  }

  return Math.hypot(dx, dy) <= zone.radiusRatio;
}

export function evaluateImpactZone(
  targetPt: Point2D,
  profile: TargetProfile,
): {zoneId: string | null; zoneName: string; points: number; insideTarget: boolean} {
  if (targetPt.x < -0.02 || targetPt.x > 1.02 || targetPt.y < -0.02 || targetPt.y > 1.02) {
    return {zoneId: null, zoneName: 'Extérieur', points: 0, insideTarget: false};
  }

  // Sort zones by highest score descending so inner concentric zones match first
  const sorted = [...profile.zones].sort((a, b) => b.points - a.points);
  for (const zone of sorted) {
    if (isPointInZone(targetPt, zone, profile.aspectRatio)) {
      return {
        zoneId: zone.id,
        zoneName: zone.name,
        points: zone.points,
        insideTarget: true,
      };
    }
  }
  return {zoneId: null, zoneName: 'Extérieur', points: 0, insideTarget: false};
}

/**
 * Evaluates a camera-frame impact point against an exact arbitrary polygon (diamond, irregular quad, N-gon)
 * and custom center without forcing 90-degree axes.
 */
export function evaluateImpactInPolygon(params: {
  framePoint: Point2D;
  polygon?: Point2D[];
  center: Point2D;
  corners: [Point2D, Point2D, Point2D, Point2D];
  profile: TargetProfile;
}): {
  targetSpacePt: Point2D;
  zoneId: string | null;
  zoneName: string;
  points: number;
  insideTarget: boolean;
} {
  const {framePoint, polygon, center, corners, profile} = params;
  const activePoly = polygon && polygon.length >= 3 ? polygon : corners;

  if (!pointInPolygon(framePoint, activePoly)) {
    return {
      targetSpacePt: mapFramePointToTargetSpace(framePoint, corners),
      zoneId: null,
      zoneName: 'Extérieur',
      points: 0,
      insideTarget: false,
    };
  }

  const dx = framePoint.x - center.x;
  const dy = framePoint.y - center.y;
  const r = Math.hypot(dx, dy);
  const edgeR = rayPolygonBoundaryDistance(center, framePoint, activePoly);
  const frac = Math.min(1, r / Math.max(1e-6, edgeR));
  const targetSpacePt: Point2D =
    r > 1e-8
      ? {
          x: 0.5 + (dx / r) * frac * 0.5,
          y: 0.5 + (dy / r) * frac * 0.5,
        }
      : {x: 0.5, y: 0.5};

  const sorted = [...profile.zones].sort((a, b) => b.points - a.points);
  for (const zone of sorted) {
    if (zone.shape === 'polygon' && zone.polygonNormalized && zone.polygonNormalized.length >= 3) {
      const quadMapped = mapFramePointToTargetSpace(framePoint, corners);
      if (pointInPolygon(quadMapped, zone.polygonNormalized)) {
        return {
          targetSpacePt: quadMapped,
          zoneId: zone.id,
          zoneName: zone.name,
          points: zone.points,
          insideTarget: true,
        };
      }
      continue;
    }
    if (frac * 0.5 <= zone.radiusRatio + 1e-6) {
      return {
        targetSpacePt,
        zoneId: zone.id,
        zoneName: zone.name,
        points: zone.points,
        insideTarget: true,
      };
    }
  }

  return {
    targetSpacePt,
    zoneId: null,
    zoneName: 'Extérieur',
    points: 0,
    insideTarget: false,
  };
}

export function computeSessionSummary(shots: ShotEvent[]): ShootingSession['summary'] {
  const activeShots = shots.filter((s) => s.validationState !== 'DISMISSED');
  const uncertainShots = activeShots.filter((s) => s.result === 'UNCERTAIN');
  const confirmedOrProbable = activeShots.filter((s) => s.result !== 'UNCERTAIN');

  const hits = confirmedOrProbable.filter((s) => s.result === 'HIT' || s.result === 'BOUNCE').length;
  const bounces = confirmedOrProbable.filter((s) => s.result === 'BOUNCE').length;
  const misses = confirmedOrProbable.filter((s) => s.result === 'MISS').length;

  const confirmedScore = confirmedOrProbable.reduce((acc, s) => acc + s.score, 0);
  const bestShotScore = confirmedOrProbable.reduce((max, s) => Math.max(max, s.score), 0);
  const confirmedCount = confirmedOrProbable.length;

  return {
    totalShots: activeShots.length,
    hits,
    misses,
    bounces,
    uncertain: uncertainShots.length,
    confirmedScore,
    averageConfirmedScore: confirmedCount > 0 ? Math.round((confirmedScore / confirmedCount) * 10) / 10 : 0,
    bestShotScore,
    confirmedAccuracyPct: confirmedCount > 0 ? Math.round((hits / confirmedCount) * 1000) / 10 : 0,
  };
}
