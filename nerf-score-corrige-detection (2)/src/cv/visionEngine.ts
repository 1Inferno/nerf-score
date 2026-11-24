import {
  DetectedCircle,
  DetectionConfidenceLevel,
  LearnedTargetModel,
  Point2D,
  ShotEvent,
  ShotResult,
  TargetCalibration,
  TargetProfile,
} from '../types/nerf';
import {
  applyHomography,
  computeHomography,
  evaluateImpactInPolygon,
  pointInPolygon,
  UNIT_SQUARE,
} from './geometry';

export interface AnalyzedFrame {
  width: number;
  height: number;
  gray: Uint8Array;
  timestampMs: number;
}

export interface MotionBlob {
  cx: number; // normalized 0..1
  cy: number; // normalized 0..1
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  areaRatio: number;
  energy: number;
  aspectRatio: number;
}

export interface MotionStepOutput {
  hasSignificantMotion: boolean;
  globalShakeDetected: boolean;
  frameDeltaEnergy: number;
  bgDeltaEnergy: number;
  blobs: MotionBlob[];
  roiDeltaEnergy: number;
  maxPixelDelta: number;
  processingMs: number;
}


/**
 * Rejects generic scene motion and keeps only compact candidates overlapping
 * the manually calibrated target polygon. This is deliberately a candidate
 * filter, not a claim that computer vision has identified a dart with certainty.
 */
export function filterTargetMotionBlobs(
  rawBlobs: MotionBlob[],
  calibration: TargetCalibration,
): MotionBlob[] {
  const targetPolygon =
    calibration.polygon && calibration.polygon.length >= 3
      ? calibration.polygon
      : calibration.corners;
  const targetW = Math.max(0.01, calibration.boundingBox.w);
  const targetH = Math.max(0.01, calibration.boundingBox.h);

  return rawBlobs.filter((blob) => {
    const blobW = blob.maxX - blob.minX;
    const blobH = blob.maxY - blob.minY;
    if (blob.areaRatio > 0.035) return false;
    if (blobW > Math.max(0.04, targetW * 0.45) || blobH > Math.max(0.04, targetH * 0.45)) {
      return false;
    }
    if (blob.aspectRatio < 0.12 || blob.aspectRatio > 8) return false;

    const samples: Point2D[] = [
      {x: blob.cx, y: blob.cy},
      {x: (blob.minX + blob.maxX) / 2, y: (blob.minY + blob.maxY) / 2},
      {x: blob.minX, y: blob.minY},
      {x: blob.maxX, y: blob.minY},
      {x: blob.minX, y: blob.maxY},
      {x: blob.maxX, y: blob.maxY},
      ...targetPolygon.filter(
        (point) =>
          point.x >= blob.minX &&
          point.x <= blob.maxX &&
          point.y >= blob.minY &&
          point.y <= blob.maxY,
      ),
    ];
    return samples.some((point) => pointInPolygon(point, targetPolygon));
  });
}

export interface AlignmentCheckResult {
  aligned: boolean;
  driftScore: number; // 0 = identical, 1 = completely different
  reason: string | null;
}

export interface DistanceLocateResult {
  found: boolean;
  confidence: number;
  corners: [Point2D, Point2D, Point2D, Point2D];
  center: Point2D;
  boundingBox: {x: number; y: number; w: number; h: number};
  targetPixelSize: {w: number; h: number};
  sharpnessScore: number;
  tiltAngleDeg: number;
  tooBlurry: boolean;
  tooSmall: boolean;
  rejectedAsDifferentObject?: boolean;
  componentScores?: {
    dotGray: number;
    dotEdge: number;
    dotRgb: number;
    dotChroma: number;
  };
  message: string;
  processingMs: number;
}

/**
 * Converts RGBA ImageData to luminance grayscale buffer at target analysis resolution.
 */
export function extractGrayscale(imageData: ImageData, out?: Uint8Array): Uint8Array {
  const {data, width, height} = imageData;
  const len = width * height;
  const gray = out && out.length === len ? out : new Uint8Array(len);
  for (let i = 0, p = 0; i < len; i++, p += 4) {
    gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  }
  return gray;
}

/**
 * Extracts compact 3-byte RGB buffer for color-aware dart & target detection.
 */
export function extractRgb(imageData: ImageData, out?: Uint8Array): Uint8Array {
  const {data, width, height} = imageData;
  const len = width * height;
  const rgb = out && out.length === len * 3 ? out : new Uint8Array(len * 3);
  for (let i = 0, p = 0, q = 0; i < len; i++, p += 4, q += 3) {
    rgb[q] = data[p];
    rgb[q + 1] = data[p + 1];
    rgb[q + 2] = data[p + 2];
  }
  return rgb;
}

/**
 * Single-pass RGBA -> Grayscale + 3-byte RGB extraction for minimal memory bandwidth.
 */
export function extractGrayAndRgb(imageData: ImageData): {gray: Uint8Array; rgb: Uint8Array} {
  const {data, width, height} = imageData;
  const len = width * height;
  const gray = new Uint8Array(len);
  const rgb = new Uint8Array(len * 3);
  for (let i = 0, p = 0, q = 0; i < len; i++, p += 4, q += 3) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    rgb[q] = r;
    rgb[q + 1] = g;
    rgb[q + 2] = b;
  }
  return {gray, rgb};
}

/**
 * Fast 3x3 Gaussian blur to suppress mobile sensor noise before edge/Laplacian extraction.
 */
function smoothGray3x3(gray: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    const r0 = Math.max(0, y - 1) * width;
    const r1 = y * width;
    const r2 = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(width - 1, x + 1);
      const sum =
        gray[r0 + xm] +
        2 * gray[r0 + x] +
        gray[r0 + xp] +
        2 * gray[r1 + xm] +
        4 * gray[r1 + x] +
        2 * gray[r1 + xp] +
        gray[r2 + xm] +
        2 * gray[r2 + x] +
        gray[r2 + xp];
      out[r1 + x] = sum >> 4;
    }
  }
  return out;
}

/**
 * Measures optical focus sharpness inside a normalized ROI via variance of the discrete Laplacian.
 */
export function measureRoiSharpness(
  gray: Uint8Array,
  width: number,
  height: number,
  bbox: {x: number; y: number; w: number; h: number},
): number {
  const x0 = Math.max(1, Math.floor(bbox.x * width));
  const y0 = Math.max(1, Math.floor(bbox.y * height));
  const x1 = Math.min(width - 2, Math.floor((bbox.x + bbox.w) * width));
  const y1 = Math.min(height - 2, Math.floor((bbox.y + bbox.h) * height));
  if (x1 <= x0 + 2 || y1 <= y0 + 2) return 0;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    const row = y * width;
    for (let x = x0; x <= x1; x++) {
      const idx = row + x;
      const lap =
        gray[idx - width] +
        gray[idx + width] +
        gray[idx - 1] +
        gray[idx + 1] -
        4 * gray[idx];
      sum += lap;
      sumSq += lap * lap;
      count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

/**
 * Computes a 16x16 normalized luminance signature inside the target bounding box.
 */
export function computeRoiSignature(
  gray: Uint8Array,
  width: number,
  height: number,
  bbox: {x: number; y: number; w: number; h: number},
): number[] {
  const sig = new Array<number>(256).fill(0);
  const bx = Math.max(0, Math.floor(bbox.x * width));
  const by = Math.max(0, Math.floor(bbox.y * height));
  const bw = Math.max(8, Math.floor(bbox.w * width));
  const bh = Math.max(8, Math.floor(bbox.h * height));

  let mean = 0;
  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const startX = Math.min(width - 1, bx + Math.floor((gx * bw) / 16));
      const endX = Math.min(width, Math.max(startX + 1, bx + Math.floor(((gx + 1) * bw) / 16)));
      const startY = Math.min(height - 1, by + Math.floor((gy * bh) / 16));
      const endY = Math.min(height, Math.max(startY + 1, by + Math.floor(((gy + 1) * bh) / 16)));
      let sum = 0;
      let count = 0;
      for (let y = startY; y < endY; y++) {
        const row = y * width;
        for (let x = startX; x < endX; x++) {
          sum += gray[row + x];
          count++;
        }
      }
      const val = count > 0 ? sum / count : 0;
      sig[gy * 16 + gx] = val;
      mean += val;
    }
  }
  mean /= 256;
  let norm = 0;
  for (let i = 0; i < 256; i++) {
    sig[i] -= mean;
    norm += sig[i] * sig[i];
  }
  const denom = Math.sqrt(norm) || 1;
  for (let i = 0; i < 256; i++) {
    sig[i] /= denom;
  }
  return sig;
}

export function verifyTargetAlignment(
  gray: Uint8Array,
  width: number,
  height: number,
  calibration: TargetCalibration,
  tolerance: number,
): AlignmentCheckResult {
  const currentSig = computeRoiSignature(gray, width, height, calibration.boundingBox);
  const ref = calibration.referenceSignature;
  if (!ref || ref.length !== 256) {
    return {aligned: true, driftScore: 0, reason: null};
  }
  let dot = 0;
  for (let i = 0; i < 256; i++) {
    dot += currentSig[i] * ref[i];
  }
  const driftScore = Math.max(0, Math.min(1, 1 - dot));
  if (driftScore > tolerance) {
    return {
      aligned: false,
      driftScore,
      reason:
        driftScore > 0.65
          ? 'Cible temporairement perdue ou sortie du champ'
          : 'Décalage détecté par rapport à la position verrouillée',
    };
  }
  return {aligned: true, driftScore, reason: null};
}

/**
 * Sobel edge magnitude + gradient orientation for target contour & concentric ring detection.
 */
function computeSobelEdges(gray: Uint8Array, width: number, height: number) {
  const mag = new Float32Array(width * height);
  const gxArr = new Int16Array(width * height);
  const gyArr = new Int16Array(width * height);
  let maxMag = 1;

  for (let y = 1; y < height - 1; y++) {
    const r0 = (y - 1) * width;
    const r1 = y * width;
    const r2 = (y + 1) * width;
    for (let x = 1; x < width - 1; x++) {
      const idx = r1 + x;
      const gx =
        -gray[r0 + x - 1] +
        gray[r0 + x + 1] -
        2 * gray[r1 + x - 1] +
        2 * gray[r1 + x + 1] -
        gray[r2 + x - 1] +
        gray[r2 + x + 1];
      const gy =
        -gray[r0 + x - 1] -
        2 * gray[r0 + x] -
        gray[r0 + x + 1] +
        gray[r2 + x - 1] +
        2 * gray[r2 + x] +
        gray[r2 + x + 1];
      gxArr[idx] = gx;
      gyArr[idx] = gy;
      const m = Math.hypot(gx, gy);
      mag[idx] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  return {mag, gxArr, gyArr, maxMag};
}

function sampleBilinearGray(gray: Uint8Array, width: number, height: number, px: number, py: number): number {
  const x = Math.max(0, Math.min(width - 1.001, px));
  const y = Math.max(0, Math.min(height - 1.001, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = y0 * width + x0;
  const i10 = i00 + 1;
  const i01 = i00 + width;
  const i11 = i01 + 1;
  return (
    gray[i00] * (1 - fx) * (1 - fy) +
    gray[i10] * fx * (1 - fy) +
    gray[i01] * (1 - fx) * fy +
    gray[i11] * fx * fy
  );
}

function sampleBilinearRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  px: number,
  py: number,
): [number, number, number] {
  const x = Math.max(0, Math.min(width - 1.001, px));
  const y = Math.max(0, Math.min(height - 1.001, py));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w00 = (1 - fx) * (1 - fy);
  const w10 = fx * (1 - fy);
  const w01 = (1 - fx) * fy;
  const w11 = fx * fy;
  const i00 = (y0 * width + x0) * 3;
  const i10 = i00 + 3;
  const i01 = i00 + width * 3;
  const i11 = i01 + 3;
  return [
    rgb[i00] * w00 + rgb[i10] * w10 + rgb[i01] * w01 + rgb[i11] * w11,
    rgb[i00 + 1] * w00 + rgb[i10 + 1] * w10 + rgb[i01 + 1] * w01 + rgb[i11 + 1] * w11,
    rgb[i00 + 2] * w00 + rgb[i10 + 2] * w10 + rgb[i01 + 2] * w01 + rgb[i11 + 2] * w11,
  ];
}

function normalizeZeroMeanUnit(arr: number[]): number[] {
  const n = arr.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += arr[i];
  mean /= Math.max(1, n);
  let normSq = 0;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = arr[i] - mean;
    out[i] = v;
    normSq += v * v;
  }
  const denom = Math.sqrt(normSq) || 1;
  for (let i = 0; i < n; i++) out[i] /= denom;
  return out;
}

function computePatchEdges(patchGrayRaw: number[], size: number): number[] {
  const edges = new Array<number>(size * size).fill(0);
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const gx = patchGrayRaw[y * size + x + 1] - patchGrayRaw[y * size + x - 1];
      const gy = patchGrayRaw[(y + 1) * size + x] - patchGrayRaw[(y - 1) * size + x];
      edges[y * size + x] = Math.hypot(gx, gy);
    }
  }
  return normalizeZeroMeanUnit(edges);
}

/**
 * Computes brightness-invariant chromatic layout descriptor [R-L, G-L, B-L]
 * plus RMS chroma energy so gray/B&W targets automatically skip chroma gating.
 */
function computeChromaDescriptor(rawRgb: number[]): {
  patchChromaNorm: number[];
  chromaEnergy: number;
} {
  const nPix = Math.floor(rawRgb.length / 3);
  const chroma = new Array<number>(nPix * 3);
  let sumSq = 0;
  for (let i = 0; i < nPix; i++) {
    const q = i * 3;
    const r = rawRgb[q];
    const g = rawRgb[q + 1];
    const b = rawRgb[q + 2];
    const l = (r + g + b) / 3;
    const cr = r - l;
    const cg = g - l;
    const cb = b - l;
    chroma[q] = cr;
    chroma[q + 1] = cg;
    chroma[q + 2] = cb;
    sumSq += cr * cr + cg * cg + cb * cb;
  }
  const chromaEnergy = Math.sqrt(sumSq / Math.max(1, nPix));
  return {
    patchChromaNorm: normalizeZeroMeanUnit(chroma),
    chromaEnergy: Math.round(chromaEnergy * 100) / 100,
  };
}

function pool24To12(src: number[], channels: number): number[] {
  const out = new Array<number>(12 * 12 * channels);
  for (let py = 0; py < 12; py++) {
    for (let px = 0; px < 12; px++) {
      const y0 = py * 2;
      const x0 = px * 2;
      const i00 = (y0 * 24 + x0) * channels;
      const i10 = (y0 * 24 + x0 + 1) * channels;
      const i01 = ((y0 + 1) * 24 + x0) * channels;
      const i11 = ((y0 + 1) * 24 + x0 + 1) * channels;
      const dst = (py * 12 + px) * channels;
      for (let c = 0; c < channels; c++) {
        out[dst + c] = (src[i00 + c] + src[i10 + c] + src[i01 + c] + src[i11 + c]) * 0.25;
      }
    }
  }
  return normalizeZeroMeanUnit(out);
}

/**
 * Step A: Learns canonical projective appearance & geometry of the target from the initial reference photo.
 * Works identically whether the target was detected automatically or manually adjusted by the user.
 */
export function buildLearnedTargetModel(params: {
  imageData: ImageData;
  referenceImageDataUrl: string;
  corners: [Point2D, Point2D, Point2D, Point2D];
  center: Point2D;
  detectedCircles: DetectedCircle[];
  manualCorrected: boolean;
}): LearnedTargetModel {
  const {
    imageData,
    referenceImageDataUrl,
    corners,
    center,
    detectedCircles,
    manualCorrected,
  } = params;
  const {width, height} = imageData;
  const gray = extractGrayscale(imageData);
  const rgb = extractRgb(imageData);

  const patchSize = 24;
  const H = computeHomography(UNIT_SQUARE, corners);

  const rawGray = new Array<number>(patchSize * patchSize);
  const rawRgb = new Array<number>(patchSize * patchSize * 3);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let py = 0; py < patchSize; py++) {
    for (let px = 0; px < patchSize; px++) {
      // 3x3 supersampling inside each canonical 1/24 cell prevents aliasing when matching 3m/5m/10m targets
      let gAcc = 0;
      let rAcc = 0;
      let gColAcc = 0;
      let bAcc = 0;
      for (let sy = 0; sy < 3; sy++) {
        const v = (py + (sy + 0.5) / 3) / patchSize;
        for (let sx = 0; sx < 3; sx++) {
          const u = (px + (sx + 0.5) / 3) / patchSize;
          const framePt = H ? applyHomography(H, {x: u, y: v}) : {x: u, y: v};
          const fx = framePt.x * width;
          const fy = framePt.y * height;
          gAcc += sampleBilinearGray(gray, width, height, fx, fy);
          const [r, g, b] = sampleBilinearRgb(rgb, width, height, fx, fy);
          rAcc += r;
          gColAcc += g;
          bAcc += b;
        }
      }

      const idx = py * patchSize + px;
      const rMean = rAcc / 9;
      const gMean = gColAcc / 9;
      const bMean = bAcc / 9;
      rawGray[idx] = gAcc / 9;
      rawRgb[idx * 3] = rMean;
      rawRgb[idx * 3 + 1] = gMean;
      rawRgb[idx * 3 + 2] = bMean;
      sumR += rMean;
      sumG += gMean;
      sumB += bMean;
    }
  }

  const topW = Math.hypot((corners[1].x - corners[0].x) * width, (corners[1].y - corners[0].y) * height);
  const botW = Math.hypot((corners[2].x - corners[3].x) * width, (corners[2].y - corners[3].y) * height);
  const leftH = Math.hypot((corners[3].x - corners[0].x) * width, (corners[3].y - corners[0].y) * height);
  const rightH = Math.hypot((corners[2].x - corners[1].x) * width, (corners[2].y - corners[1].y) * height);
  const avgW = (topW + botW) / 2;
  const avgH = (leftH + rightH) / 2;
  const aspectRatio = Math.max(0.45, Math.min(2.2, avgW / Math.max(1, avgH)));

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bbox = {
    x: Math.max(0, Math.min(...xs)),
    y: Math.max(0, Math.min(...ys)),
    w: Math.max(0.03, Math.min(1, Math.max(...xs)) - Math.max(0, Math.min(...xs))),
    h: Math.max(0.03, Math.min(1, Math.max(...ys)) - Math.max(0, Math.min(...ys))),
  };
  const sharpnessScore = measureRoiSharpness(gray, width, height, bbox);
  const nPix = patchSize * patchSize;
  const chromaDesc = computeChromaDescriptor(rawRgb);

  return {
    id: `model-${Date.now()}`,
    referenceImageDataUrl,
    referenceWidth: width,
    referenceHeight: height,
    learnedCorners: corners,
    learnedCenter: center,
    aspectRatio,
    patchSize,
    patchGrayNorm: normalizeZeroMeanUnit(rawGray),
    patchEdgeNorm: computePatchEdges(rawGray, patchSize),
    patchColorMeanRgb: [
      Math.round(sumR / nPix),
      Math.round(sumG / nPix),
      Math.round(sumB / nPix),
    ],
    patchRgbNorm: normalizeZeroMeanUnit(rawRgb),
    patchGray12Norm: pool24To12(rawGray, 1),
    patchRgb12Norm: pool24To12(rawRgb, 3),
    patchChromaNorm: chromaDesc.patchChromaNorm,
    chromaEnergy: chromaDesc.chromaEnergy,
    detectedCircles,
    sharpnessScore,
    manualCorrected,
    learnedAt: Date.now(),
  };
}

/**
 * Ultra-fast 12x12 coarse pyramid evaluator using nearest-neighbor luminance + RGB correlation.
 */
function scoreCoarseQuad12(
  gray: Uint8Array,
  rgb: Uint8Array | null,
  width: number,
  height: number,
  model: LearnedTargetModel,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tiltRad: number,
): number {
  const cosA = Math.cos(tiltRad);
  const sinA = Math.sin(tiltRad);
  const halfWPx = halfW * width;
  const halfHPx = halfH * height;
  const cxPx = cx * width;
  const cyPx = cy * height;
  const rawGray = new Float32Array(144);
  const rawRgb = rgb ? new Float32Array(432) : null;
  let sumG = 0;
  let sumR = 0;

  for (let py = 0; py < 12; py++) {
    const ny = ((py + 0.5) / 12) * 2 - 1;
    const ryPx = ny * halfHPx;
    for (let px = 0; px < 12; px++) {
      const nx = ((px + 0.5) / 12) * 2 - 1;
      const rxPx = nx * halfWPx;
      const ix = Math.max(0, Math.min(width - 1, Math.round(cxPx + rxPx * cosA - ryPx * sinA)));
      const iy = Math.max(0, Math.min(height - 1, Math.round(cyPx + rxPx * sinA + ryPx * cosA)));
      const pIdx = iy * width + ix;
      const idx = py * 12 + px;
      const gVal = gray[pIdx];
      rawGray[idx] = gVal;
      sumG += gVal;

      if (rgb && rawRgb) {
        const q = pIdx * 3;
        const r = rgb[q];
        const g = rgb[q + 1];
        const b = rgb[q + 2];
        const d = idx * 3;
        rawRgb[d] = r;
        rawRgb[d + 1] = g;
        rawRgb[d + 2] = b;
        sumR += r + g + b;
      }
    }
  }

  const meanG = sumG / 144;
  let normG = 0;
  for (let i = 0; i < 144; i++) {
    const d = rawGray[i] - meanG;
    rawGray[i] = d;
    normG += d * d;
  }
  if (Math.sqrt(normG / 144) < 6) return -1;
  const invG = 1 / (Math.sqrt(normG) || 1);

  const modelG12 = model.patchGray12Norm;
  let dotGray = 0;
  if (modelG12 && modelG12.length === 144) {
    for (let i = 0; i < 144; i++) dotGray += rawGray[i] * invG * modelG12[i];
  } else {
    let normM = 0;
    for (let py = 0; py < 12; py++) {
      const my = Math.min(model.patchSize - 1, py * 2);
      for (let px = 0; px < 12; px++) {
        const mx = Math.min(model.patchSize - 1, px * 2);
        const mv = model.patchGrayNorm[my * model.patchSize + mx];
        dotGray += rawGray[py * 12 + px] * invG * mv;
        normM += mv * mv;
      }
    }
    dotGray /= Math.sqrt(normM) || 1;
  }

  if (!rawRgb || !model.patchRgb12Norm || model.patchRgb12Norm.length !== 432) {
    return dotGray;
  }

  const meanRgb = sumR / 432;
  let normRgb = 0;
  for (let i = 0; i < 432; i++) {
    const d = rawRgb[i] - meanRgb;
    rawRgb[i] = d;
    normRgb += d * d;
  }
  const invRgb = 1 / (Math.sqrt(normRgb) || 1);
  let dotRgb = 0;
  const mRgb12 = model.patchRgb12Norm;
  for (let i = 0; i < 432; i++) dotRgb += rawRgb[i] * invRgb * mRgb12[i];

  return 0.6 * dotGray + 0.4 * dotRgb;
}

interface CandidateScoreDetail {
  score: number;
  dotGray: number;
  dotEdge: number;
  dotRgb: number;
  dotChroma: number;
  candChromaEnergy: number;
}

/**
 * Fine 24x24 occlusion-tolerant visual similarity evaluator:
 * combines full-patch ZNCC luminance, edge gradient correlation, RGB structure,
 * brightness-invariant chroma layout, and top-6-of-9 cell ZNCC.
 */
function scoreCandidateQuadDetailed(
  gray: Uint8Array,
  rgb: Uint8Array | null,
  width: number,
  height: number,
  model: LearnedTargetModel,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tiltRad: number,
): CandidateScoreDetail {
  const sampleSize = model.patchSize;
  const cosA = Math.cos(tiltRad);
  const sinA = Math.sin(tiltRad);
  const halfWPx = halfW * width;
  const halfHPx = halfH * height;
  const cxPx = cx * width;
  const cyPx = cy * height;

  const count = sampleSize * sampleSize;
  const rawGray = new Array<number>(count);
  const rawRgb = rgb ? new Array<number>(count * 3) : null;

  for (let py = 0; py < sampleSize; py++) {
    const ny = ((py + 0.5) / sampleSize) * 2 - 1;
    const ryPx = ny * halfHPx;
    for (let px = 0; px < sampleSize; px++) {
      const nx = ((px + 0.5) / sampleSize) * 2 - 1;
      const rxPx = nx * halfWPx;
      const fx = cxPx + rxPx * cosA - ryPx * sinA;
      const fy = cyPx + rxPx * sinA + ryPx * cosA;
      const idx = py * sampleSize + px;
      rawGray[idx] = sampleBilinearGray(gray, width, height, fx, fy);
      if (rgb && rawRgb) {
        const [r, g, b] = sampleBilinearRgb(rgb, width, height, fx, fy);
        rawRgb[idx * 3] = r;
        rawRgb[idx * 3 + 1] = g;
        rawRgb[idx * 3 + 2] = b;
      }
    }
  }

  let meanG = 0;
  for (let i = 0; i < count; i++) meanG += rawGray[i];
  meanG /= count;
  let varG = 0;
  for (let i = 0; i < count; i++) {
    const d = rawGray[i] - meanG;
    varG += d * d;
  }
  if (Math.sqrt(varG / count) < 5) {
    return {score: -1, dotGray: -1, dotEdge: -1, dotRgb: -1, dotChroma: 0, candChromaEnergy: 0};
  }

  const candGrayNorm = normalizeZeroMeanUnit(rawGray);
  let dotGray = 0;
  for (let i = 0; i < count; i++) dotGray += candGrayNorm[i] * model.patchGrayNorm[i];

  const candEdgeNorm = computePatchEdges(rawGray, sampleSize);
  let dotEdge = 0;
  for (let i = 0; i < count; i++) dotEdge += candEdgeNorm[i] * model.patchEdgeNorm[i];

  let dotRgb = dotGray;
  let dotChroma = dotGray;
  let candChromaEnergy = 0;
  if (rawRgb && model.patchRgbNorm.length === count * 3) {
    const candRgbNorm = normalizeZeroMeanUnit(rawRgb);
    dotRgb = 0;
    for (let i = 0; i < count * 3; i++) dotRgb += candRgbNorm[i] * model.patchRgbNorm[i];

    const candChroma = computeChromaDescriptor(rawRgb);
    candChromaEnergy = candChroma.chromaEnergy;
    if (model.patchChromaNorm && model.patchChromaNorm.length === count * 3) {
      dotChroma = 0;
      for (let i = 0; i < count * 3; i++) {
        dotChroma += candChroma.patchChromaNorm[i] * model.patchChromaNorm[i];
      }
    }
  }

  // Top-6-of-9 (8x8 cell) ZNCC for robust partial occlusion tolerance on any edge or corner (up to ~33%)
  const cellSize = Math.max(4, Math.floor(sampleSize / 3));
  const cellLen = cellSize * cellSize;
  const cellScores: number[] = [];
  for (let cyCell = 0; cyCell < 3; cyCell++) {
    for (let cxCell = 0; cxCell < 3; cxCell++) {
      let cMean = 0;
      let mMean = 0;
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const idx = (cyCell * cellSize + y) * sampleSize + (cxCell * cellSize + x);
          cMean += rawGray[idx];
          mMean += model.patchGrayNorm[idx];
        }
      }
      cMean /= cellLen;
      mMean /= cellLen;
      let cNorm = 0;
      let mNorm = 0;
      let cDot = 0;
      for (let y = 0; y < cellSize; y++) {
        for (let x = 0; x < cellSize; x++) {
          const idx = (cyCell * cellSize + y) * sampleSize + (cxCell * cellSize + x);
          const cv = rawGray[idx] - cMean;
          const mv = model.patchGrayNorm[idx] - mMean;
          cNorm += cv * cv;
          mNorm += mv * mv;
          cDot += cv * mv;
        }
      }
      const denom = Math.sqrt(cNorm * mNorm);
      cellScores.push(denom > 1e-4 ? cDot / denom : 0);
    }
  }
  cellScores.sort((a, b) => b - a);
  let cellTop6 = 0;
  for (let i = 0; i < 6; i++) cellTop6 += cellScores[i];
  cellTop6 /= 6;

  const hasChromaModel = (model.chromaEnergy ?? 0) >= 6 && Boolean(rgb && model.patchChromaNorm);
  const score = hasChromaModel
    ? 0.21 * dotGray + 0.21 * dotEdge + 0.16 * dotRgb + 0.12 * dotChroma + 0.30 * cellTop6
    : 0.24 * dotGray + 0.22 * dotEdge + 0.20 * dotRgb + 0.34 * cellTop6;

  return {score, dotGray, dotEdge, dotRgb, dotChroma, candChromaEnergy};
}

function scoreCandidateQuad(
  gray: Uint8Array,
  rgb: Uint8Array | null,
  width: number,
  height: number,
  model: LearnedTargetModel,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tiltRad: number,
): number {
  return scoreCandidateQuadDetailed(gray, rgb, width, height, model, cx, cy, halfW, halfH, tiltRad)
    .score;
}

function buildRotatedCorners(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tiltRad: number,
  width: number,
  height: number,
): [Point2D, Point2D, Point2D, Point2D] {
  const cosA = Math.cos(tiltRad);
  const sinA = Math.sin(tiltRad);
  const halfWPx = halfW * width;
  const halfHPx = halfH * height;
  const pts: [number, number][] = [
    [-halfWPx, -halfHPx],
    [halfWPx, -halfHPx],
    [halfWPx, halfHPx],
    [-halfWPx, halfHPx],
  ];
  return pts.map(([rxPx, ryPx]) => ({
    x: Math.max(0.01, Math.min(0.99, cx + (rxPx * cosA - ryPx * sinA) / width)),
    y: Math.max(0.01, Math.min(0.99, cy + (rxPx * sinA + ryPx * cosA) / height)),
  })) as [Point2D, Point2D, Point2D, Point2D];
}

/**
 * Step B: Locates the learned target model at any distance (near -> 3m -> 5m -> 10m),
 * under scale changes, translation, mild tilt, lighting variations, and perspective skew.
 * Strictly guards against replacing the validated target with another shape or colored object.
 */
export function locateTargetInFrame(params: {
  gray: Uint8Array;
  rgb?: Uint8Array | null;
  width: number;
  height: number;
  model: LearnedTargetModel;
  previousCalibration?: TargetCalibration | null;
  forceGlobalSearch?: boolean;
  strictMatch?: boolean;
  expectedScaleHw?: {minHw: number; maxHw: number} | null;
}): DistanceLocateResult {
  const t0 = performance.now();
  const {
    gray,
    rgb = null,
    width,
    height,
    model,
    previousCalibration,
    forceGlobalSearch,
    strictMatch = true,
    expectedScaleHw = null,
  } = params;

  const frameAspect = width / Math.max(1, height);
  // In normalized frame coords, a target of pixel ratio R = model.aspectRatio has halfH = halfW * frameAspect / model.aspectRatio
  const normRatio = frameAspect / Math.max(0.4, model.aspectRatio);

  const clampHw = (hw: number) => {
    const lo = expectedScaleHw ? Math.max(0.012, expectedScaleHw.minHw) : 0.012;
    const hi = expectedScaleHw ? Math.min(0.48, expectedScaleHw.maxHw) : 0.48;
    return Math.max(lo, Math.min(hi, hw));
  };

  let bestScore = -1;
  let bestCand = {
    cx: previousCalibration?.center.x ?? 0.5,
    cy: previousCalibration?.center.y ?? 0.5,
    halfW: clampHw(previousCalibration ? previousCalibration.boundingBox.w * 0.5 : 0.2),
    halfH: clampHw(previousCalibration ? previousCalibration.boundingBox.w * 0.5 : 0.2) * normRatio,
    tiltDeg: 0,
  };

  // Phase 1: Fast local tracking around previous position when not forcing global search
  if (previousCalibration && !forceGlobalSearch) {
    const prevW = previousCalibration.boundingBox.w * 0.5;
    const prevCx = previousCalibration.center.x;
    const prevCy = previousCalibration.center.y;
    const prevTilt = previousCalibration.tiltAngleDeg ?? 0;

    for (const sMult of [0.9, 1.0, 1.1]) {
      const hw = clampHw(prevW * sMult);
      for (const aMult of [0.92, 1.0, 1.08]) {
        const hh = Math.max(0.015, Math.min(0.48, hw * normRatio * aMult));
        for (const tiltDeg of [prevTilt - 4, prevTilt, prevTilt + 4]) {
          const tiltRad = (tiltDeg * Math.PI) / 180;
          for (const dy of [-0.035, 0, 0.035]) {
            for (const dx of [-0.035, 0, 0.035]) {
              const cx = prevCx + dx;
              const cy = prevCy + dy;
              if (cx - hw < 0 || cx + hw > 1 || cy - hh < 0 || cy + hh > 1) continue;
              const sc = scoreCandidateQuad(
                gray,
                rgb,
                width,
                height,
                model,
                cx,
                cy,
                hw,
                hh,
                tiltRad,
              );
              if (sc > bestScore) {
                bestScore = sc;
                bestCand = {cx, cy, halfW: hw, halfH: hh, tiltDeg};
              }
            }
          }
        }
      }
    }
  }

  // Phase 2: Full Multi-Scale Pyramid Search (close-up -> 3m -> 5m -> 10m)
  if (bestScore < 0.48 || forceGlobalSearch || !previousCalibration) {
    const baseHalfWidths = [0.36, 0.28, 0.22, 0.17, 0.13, 0.10, 0.075, 0.056, 0.042, 0.031, 0.022, 0.015];
    const halfWidths = expectedScaleHw
      ? baseHalfWidths.filter(
          (hw) => hw >= expectedScaleHw.minHw * 0.85 && hw <= expectedScaleHw.maxHw * 1.15,
        )
      : baseHalfWidths;
    const activeHalfWidths = halfWidths.length > 0 ? halfWidths : baseHalfWidths;

    const perScaleBest: Array<{score: number; cx: number; cy: number; hw: number; hh: number; tiltDeg: number}> = [];
    const extraCandidates: Array<{score: number; cx: number; cy: number; hw: number; hh: number; tiltDeg: number}> = [];

    for (const rawHw of activeHalfWidths) {
      const hw = clampHw(rawHw);
      const hh = hw * normRatio;
      if (hh > 0.48 || hw * width < 4 || hh * height < 4) continue;

      const stepX = Math.max(0.01, hw * 0.27);
      const stepY = Math.max(0.01, hh * 0.27);
      const tilts = hw >= 0.07 ? [-8, 0, 8] : [0];
      const scaleHits: Array<{score: number; cx: number; cy: number; hw: number; hh: number; tiltDeg: number}> = [];

      for (let cy = hh + 0.01; cy <= 1 - hh - 0.01; cy += stepY) {
        for (let cx = hw + 0.01; cx <= 1 - hw - 0.01; cx += stepX) {
          for (const tiltDeg of tilts) {
            const sc = scoreCoarseQuad12(
              gray,
              rgb,
              width,
              height,
              model,
              cx,
              cy,
              hw,
              hh,
              (tiltDeg * Math.PI) / 180,
            );
            if (sc > 0.15) {
              scaleHits.push({score: sc, cx, cy, hw, hh, tiltDeg});
            }
          }
        }
      }

      // Guarantee the top distinct peak from EVERY scale enters fine scoring
      scaleHits.sort((a, b) => b.score - a.score);
      const keptScale: typeof scaleHits = [];
      for (const hit of scaleHits) {
        if (
          keptScale.every(
            (k) => Math.hypot(k.cx - hit.cx, k.cy - hit.cy) > Math.max(0.04, hw * 0.8),
          )
        ) {
          keptScale.push(hit);
          if (keptScale.length >= 2) break;
        }
      }
      if (keptScale[0]) perScaleBest.push(keptScale[0]);
      if (keptScale[1]) extraCandidates.push(keptScale[1]);
    }

    extraCandidates.sort((a, b) => b.score - a.score);
    const coarseSeeds = [...perScaleBest, ...extraCandidates.slice(0, 4)];

    // Stage 2a: Fast 24x24 center/offset evaluation across all scale seeds
    const fineWinners: Array<{score: number; cx: number; cy: number; hw: number; hh: number; tiltDeg: number}> = [];
    for (const cand of coarseSeeds) {
      const tiltRad = (cand.tiltDeg * Math.PI) / 180;
      for (const dy of [-cand.hh * 0.16, 0, cand.hh * 0.16]) {
        for (const dx of [-cand.hw * 0.16, 0, cand.hw * 0.16]) {
          const cx = cand.cx + dx;
          const cy = cand.cy + dy;
          if (cx - cand.hw < 0 || cx + cand.hw > 1 || cy - cand.hh < 0 || cy + cand.hh > 1) continue;
          const sc = scoreCandidateQuad(
            gray,
            rgb,
            width,
            height,
            model,
            cx,
            cy,
            cand.hw,
            cand.hh,
            tiltRad,
          );
          fineWinners.push({score: sc, cx, cy, hw: cand.hw, hh: cand.hh, tiltDeg: cand.tiltDeg});
          if (sc > bestScore) {
            bestScore = sc;
            bestCand = {cx, cy, halfW: cand.hw, halfH: cand.hh, tiltDeg: cand.tiltDeg};
          }
        }
      }
    }

    // Stage 2b: Stratify top seeds across distance bands (large >0.12, mid 0.05..0.12, small <=0.05) + overall top
    fineWinners.sort((a, b) => b.score - a.score);
    const refineTop: typeof fineWinners = [];
    const addSeed = (w: (typeof fineWinners)[number]) => {
      if (
        refineTop.every(
          (r) =>
            Math.hypot(r.cx - w.cx, r.cy - w.cy) > 0.03 ||
            Math.abs(r.hw - w.hw) > 0.02 ||
            Math.abs(r.tiltDeg - w.tiltDeg) > 4,
        )
      ) {
        refineTop.push(w);
        return true;
      }
      return false;
    };

    for (const w of fineWinners) {
      if (refineTop.length >= 4) break;
      addSeed(w);
    }
    for (const bandCheck of [
      (hw: number) => hw > 0.12,
      (hw: number) => hw >= 0.05 && hw <= 0.12,
      (hw: number) => hw < 0.05,
    ]) {
      let added = 0;
      for (const w of fineWinners) {
        if (bandCheck(w.hw) && addSeed(w)) {
          added++;
          if (added >= 2) break;
        }
      }
    }

    for (const cand of refineTop) {
      let seedBest = {
        score: cand.score,
        cx: cand.cx,
        cy: cand.cy,
        hw: cand.hw,
        hh: cand.hh,
        tiltDeg: cand.tiltDeg,
      };
      for (const sMult of [0.88, 1.0, 1.12]) {
        const hw = clampHw(cand.hw * sMult);
        for (const aMult of [0.85, 1.0, 1.15]) {
          const hh = Math.max(0.012, Math.min(0.48, hw * normRatio * aMult));
          for (const dt of [-8, 0, 8]) {
            const tiltDeg = cand.tiltDeg + dt;
            const tiltRad = (tiltDeg * Math.PI) / 180;
            const cx = cand.cx;
            const cy = cand.cy;
            if (cx - hw < 0 || cx + hw > 1 || cy - hh < 0 || cy + hh > 1) continue;
            const sc = scoreCandidateQuad(
              gray,
              rgb,
              width,
              height,
              model,
              cx,
              cy,
              hw,
              hh,
              tiltRad,
            );
            if (sc > seedBest.score) {
              seedBest = {score: sc, cx, cy, hw, hh, tiltDeg};
            }
          }
        }
      }
      // Final micro-position polish after scale/aspect/tilt fit
      const baseCx = seedBest.cx;
      const baseCy = seedBest.cy;
      const tiltRad = (seedBest.tiltDeg * Math.PI) / 180;
      for (const dy of [-seedBest.hh * 0.12, 0, seedBest.hh * 0.12]) {
        for (const dx of [-seedBest.hw * 0.12, 0, seedBest.hw * 0.12]) {
          const cx = baseCx + dx;
          const cy = baseCy + dy;
          if (cx - seedBest.hw < 0 || cx + seedBest.hw > 1 || cy - seedBest.hh < 0 || cy + seedBest.hh > 1) continue;
          const sc = scoreCandidateQuad(
            gray,
            rgb,
            width,
            height,
            model,
            cx,
            cy,
            seedBest.hw,
            seedBest.hh,
            tiltRad,
          );
          if (sc > seedBest.score) {
            seedBest = {...seedBest, score: sc, cx, cy};
          }
        }
      }
      if (seedBest.score > bestScore) {
        bestScore = seedBest.score;
        bestCand = {
          cx: seedBest.cx,
          cy: seedBest.cy,
          halfW: seedBest.hw,
          halfH: seedBest.hh,
          tiltDeg: seedBest.tiltDeg,
        };
      }
    }
  }

  // Anti-replacement verification on the winning candidate
  const detail = scoreCandidateQuadDetailed(
    gray,
    rgb,
    width,
    height,
    model,
    bestCand.cx,
    bestCand.cy,
    bestCand.halfW,
    bestCand.halfH,
    (bestCand.tiltDeg * Math.PI) / 180,
  );
  bestScore = detail.score;

  const corners = buildRotatedCorners(
    bestCand.cx,
    bestCand.cy,
    bestCand.halfW,
    bestCand.halfH,
    (bestCand.tiltDeg * Math.PI) / 180,
    width,
    height,
  );
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const bbox = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };

  const targetPixelSize = {
    w: Math.round(bbox.w * width),
    h: Math.round(bbox.h * height),
  };
  const sharpnessScore = measureRoiSharpness(gray, width, height, bbox);
  const tooSmall = Math.min(targetPixelSize.w, targetPixelSize.h) < 16;
  const tooBlurry = sharpnessScore < 9;

  // Component gates guarantee another shape or differently colored object never replaces the official calibrated target
  const hasColorfulModel = (model.chromaEnergy ?? 0) >= 6 && Boolean(rgb && model.patchChromaNorm);
  const chromaPass = !hasColorfulModel || (detail.dotChroma >= 0.36 && detail.candChromaEnergy >= 4);
  const monochromeVsColorMismatch =
    Boolean(rgb) &&
    (model.chromaEnergy ?? 0) < 6 &&
    detail.candChromaEnergy >= 24 &&
    detail.dotGray < 0.72;
  const structuralPass =
    detail.dotGray >= 0.36 &&
    detail.dotRgb >= 0.36 &&
    detail.dotEdge >= 0.22 &&
    chromaPass &&
    !monochromeVsColorMismatch;

  const rejectedAsDifferentObject = strictMatch && bestScore >= 0.38 && !structuralPass;
  const found =
    !tooSmall &&
    (strictMatch ? bestScore >= 0.48 && structuralPass : bestScore >= 0.45);

  let message = 'Recherche de la cible officielle...';
  if (tooSmall && bestScore >= 0.38) {
    message = `Cible trop petite (${targetPixelSize.w}×${targetPixelSize.h} px) — rapprochez-vous ou augmentez la résolution`;
  } else if (rejectedAsDifferentObject) {
    message = 'Objet différent détecté — cible officielle conservée, attente de sa réapparition';
  } else if (found && tooBlurry) {
    message = 'Cible trop floue — stabilisez le téléphone';
  } else if (found) {
    message = 'Cible officielle détectée';
  }

  return {
    found,
    confidence: Math.max(0, Math.min(0.99, Math.round(bestScore * 100) / 100)),
    corners,
    center: {x: bestCand.cx, y: bestCand.cy},
    boundingBox: bbox,
    targetPixelSize,
    sharpnessScore,
    tiltAngleDeg: bestCand.tiltDeg,
    tooBlurry,
    tooSmall,
    rejectedAsDifferentObject,
    componentScores: {
      dotGray: Math.round(detail.dotGray * 1000) / 1000,
      dotEdge: Math.round(detail.dotEdge * 1000) / 1000,
      dotRgb: Math.round(detail.dotRgb * 1000) / 1000,
      dotChroma: Math.round(detail.dotChroma * 1000) / 1000,
    },
    message,
    processingMs: Math.round((performance.now() - t0) * 10) / 10,
  };
}

/**
 * Step A: Iterative initial target recognition on the close-up/reference photo.
 * Uses Gaussian smoothing + radial symmetry rings + rectangular contrast boundary fallback.
 * Always extracts a canonical LearnedTargetModel when detected or manually corrected.
 */
export function analyzeTargetFrame(
  imageData: ImageData,
  referenceImageDataUrl: string,
  attemptIndex = 1,
  guidedBounds?: {corners: [Point2D, Point2D, Point2D, Point2D]; center: Point2D},
): TargetCalibration {
  const {width, height} = imageData;
  const rawGray = extractGrayscale(imageData);
  const gray = smoothGray3x3(rawGray, width, height);
  const {mag, gxArr, gyArr, maxMag} = computeSobelEdges(gray, width, height);

  // If user manually corrected corners/center, always learn & validate the target model cleanly
  if (guidedBounds) {
    const xs = guidedBounds.corners.map((c) => c.x);
    const ys = guidedBounds.corners.map((c) => c.y);
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(1, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(1, Math.max(...ys));
    const bbox = {x: minX, y: minY, w: Math.max(0.05, maxX - minX), h: Math.max(0.05, maxY - minY)};

    const cxPx = guidedBounds.center.x * width;
    const cyPx = guidedBounds.center.y * height;
    const maxR = Math.min(bbox.w * width, bbox.h * height) * 0.5;
    const circles = findConcentricRingsAtCenter(mag, maxMag, width, height, cxPx, cyPx, maxR);
    const sig = computeRoiSignature(gray, width, height, bbox);
    const sharpnessScore = measureRoiSharpness(rawGray, width, height, bbox);
    const edgeEnergy = measureRoiEdgeDensity(mag, maxMag, width, height, bbox);

    const learnedModel = buildLearnedTargetModel({
      imageData,
      referenceImageDataUrl,
      corners: guidedBounds.corners,
      center: guidedBounds.center,
      detectedCircles: circles,
      manualCorrected: true,
    });

    const confidence = Math.min(0.98, Math.max(0.62, 0.58 + edgeEnergy * 0.25 + circles.length * 0.08));

    return {
      corners: guidedBounds.corners,
      center: guidedBounds.center,
      boundingBox: bbox,
      detectedCircles: circles,
      referenceImageDataUrl,
      referenceWidth: width,
      referenceHeight: height,
      referenceSignature: sig,
      state: 'BLUE_DETECTED',
      trackingStatus: 'GREEN_LOCKED',
      confidence,
      sharpnessScore,
      targetPixelSize: {w: Math.round(bbox.w * width), h: Math.round(bbox.h * height)},
      tiltAngleDeg: 0,
      failureReasons: [],
      manualCorrected: true,
      attemptsCount: attemptIndex,
      analyzedAt: Date.now(),
      learnedModel,
    };
  }

  // Adaptive threshold lowers slightly on retries to catch low-contrast targets
  const thresholdFactor = Math.max(0.09, 0.2 - (attemptIndex - 1) * 0.025);
  const edgeThreshold = maxMag * thresholdFactor;

  // 1. Radial gradient voting for concentric circular targets
  const gridW = Math.max(24, Math.floor(width / 4));
  const gridH = Math.max(24, Math.floor(height / 4));
  const acc = new Float32Array(gridW * gridH);

  let edgePixelCount = 0;
  for (let y = 4; y < height - 4; y += 2) {
    for (let x = 4; x < width - 4; x += 2) {
      const idx = y * width + x;
      const m = mag[idx];
      if (m < edgeThreshold) continue;
      edgePixelCount++;

      const nx = gxArr[idx] / (m + 1e-5);
      const ny = gyArr[idx] / (m + 1e-5);
      for (const dir of [-1, 1]) {
        for (let step = 6; step <= Math.min(width, height) * 0.44; step += 5) {
          const vx = Math.round(((x + nx * step * dir) / width) * gridW);
          const vy = Math.round(((y + ny * step * dir) / height) * gridH);
          if (vx >= 1 && vx < gridW - 1 && vy >= 1 && vy < gridH - 1) {
            acc[vy * gridW + vx] += 1;
          }
        }
      }
    }
  }

  let bestScore = 0;
  let bestGx = Math.floor(gridW / 2);
  let bestGy = Math.floor(gridH / 2);
  for (let gy = 2; gy < gridH - 2; gy++) {
    for (let gx = 2; gx < gridW - 2; gx++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += acc[(gy + dy) * gridW + (gx + dx)];
        }
      }
      if (s > bestScore) {
        bestScore = s;
        bestGx = gx;
        bestGy = gy;
      }
    }
  }

  let centerPx = {
    x: ((bestGx + 0.5) / gridW) * width,
    y: ((bestGy + 0.5) / gridH) * height,
  };

  const maxPossibleR = Math.min(width, height) * 0.47;
  let circles = findConcentricRingsAtCenter(
    mag,
    maxMag,
    width,
    height,
    centerPx.x,
    centerPx.y,
    maxPossibleR,
  );

  // 2. Hybrid fallback: detect salient rectangular/bordered target region if radial ring voting is weak
  // (Handles square targets, digital targets, or targets photographed at an angle)
  let rectBbox: {x: number; y: number; w: number; h: number} | null = null;
  if (circles.length < 2) {
    rectBbox = findSalientTargetRect(mag, maxMag, width, height);
    if (rectBbox) {
      const rectCx = (rectBbox.x + rectBbox.w / 2) * width;
      const rectCy = (rectBbox.y + rectBbox.h / 2) * height;
      const rectCircles = findConcentricRingsAtCenter(
        mag,
        maxMag,
        width,
        height,
        rectCx,
        rectCy,
        Math.min(rectBbox.w * width, rectBbox.h * height) * 0.55,
      );
      if (rectCircles.length > circles.length) {
        circles = rectCircles;
        centerPx = {x: rectCx, y: rectCy};
      }
    }
  }

  let contrastVariance = 0;
  let lumSum = 0;
  for (let i = 0; i < gray.length; i += 4) lumSum += gray[i];
  const lumMean = lumSum / (gray.length / 4);
  for (let i = 0; i < gray.length; i += 4) {
    const d = gray[i] - lumMean;
    contrastVariance += d * d;
  }
  const contrastStd = Math.sqrt(contrastVariance / (gray.length / 4));

  const failureReasons: string[] = [];
  if (contrastStd < 14) {
    failureReasons.push('Contraste global trop faible (image uniforme ou sous-exposée)');
  }
  if (edgePixelCount < width * height * 0.002) {
    failureReasons.push('Contours insuffisamment nets (flou ou éclairage faible)');
  }

  const outerCircle = circles.length > 0 ? circles[circles.length - 1] : null;
  const radialSupportRatio = bestScore / Math.max(25, edgePixelCount * 0.11);
  const hasRealContrast = contrastStd >= 14 && maxMag >= 45;
  const hasCircleTarget =
    hasRealContrast &&
    (circles.length >= 2 || (circles.length >= 1 && radialSupportRatio >= 0.3 && contrastStd >= 16));
  const hasRectTarget = Boolean(
    hasRealContrast && rectBbox && rectBbox.w >= 0.14 && rectBbox.h >= 0.14 && contrastStd >= 18,
  );

  if (!hasCircleTarget && !hasRectTarget) {
    if (circles.length === 0) {
      failureReasons.push('Aucun contour fermé ni cercle concentrique détecté automatiquement');
    } else {
      failureReasons.push('Symétrie ou bordure insuffisante par rapport à l’arrière-plan');
    }
    if (lumMean < 30) {
      failureReasons.push('Luminosité insuffisante dans la zone filmée');
    } else if (lumMean > 228) {
      failureReasons.push('Surexposition détectée sur la scène');
    }

    const fallbackHalf = 0.28;
    const fallbackCorners: [Point2D, Point2D, Point2D, Point2D] = [
      {x: 0.5 - fallbackHalf, y: 0.5 - fallbackHalf},
      {x: 0.5 + fallbackHalf, y: 0.5 - fallbackHalf},
      {x: 0.5 + fallbackHalf, y: 0.5 + fallbackHalf},
      {x: 0.5 - fallbackHalf, y: 0.5 + fallbackHalf},
    ];

    return {
      corners: fallbackCorners,
      center: {x: 0.5, y: 0.5},
      boundingBox: {
        x: 0.5 - fallbackHalf,
        y: 0.5 - fallbackHalf,
        w: fallbackHalf * 2,
        h: fallbackHalf * 2,
      },
      detectedCircles: circles,
      referenceImageDataUrl,
      referenceWidth: width,
      referenceHeight: height,
      referenceSignature: computeRoiSignature(gray, width, height, {
        x: 0.22,
        y: 0.22,
        w: 0.56,
        h: 0.56,
      }),
      state: 'RED_NOT_FOUND',
      trackingStatus: 'RED_NOT_FOUND',
      confidence: Math.min(0.42, radialSupportRatio * 0.4),
      sharpnessScore: measureRoiSharpness(rawGray, width, height, {
        x: 0.22,
        y: 0.22,
        w: 0.56,
        h: 0.56,
      }),
      failureReasons,
      manualCorrected: false,
      attemptsCount: attemptIndex,
      analyzedAt: Date.now(),
    };
  }

  let bbox: {x: number; y: number; w: number; h: number};
  let corners: [Point2D, Point2D, Point2D, Point2D];
  let cxNorm: number;
  let cyNorm: number;

  if (hasCircleTarget && outerCircle) {
    const radiusNormX = Math.min(0.46, Math.max(0.1, (outerCircle.r * 1.03) / width));
    const radiusNormY = Math.min(0.46, Math.max(0.1, (outerCircle.r * 1.03) / height));
    cxNorm = Math.max(radiusNormX, Math.min(1 - radiusNormX, centerPx.x / width));
    cyNorm = Math.max(radiusNormY, Math.min(1 - radiusNormY, centerPx.y / height));
    corners = [
      {x: cxNorm - radiusNormX, y: cyNorm - radiusNormY},
      {x: cxNorm + radiusNormX, y: cyNorm - radiusNormY},
      {x: cxNorm + radiusNormX, y: cyNorm + radiusNormY},
      {x: cxNorm - radiusNormX, y: cyNorm + radiusNormY},
    ];
    bbox = {
      x: corners[0].x,
      y: corners[0].y,
      w: radiusNormX * 2,
      h: radiusNormY * 2,
    };
  } else {
    bbox = rectBbox!;
    cxNorm = bbox.x + bbox.w / 2;
    cyNorm = bbox.y + bbox.h / 2;
    corners = [
      {x: bbox.x, y: bbox.y},
      {x: bbox.x + bbox.w, y: bbox.y},
      {x: bbox.x + bbox.w, y: bbox.y + bbox.h},
      {x: bbox.x, y: bbox.y + bbox.h},
    ];
  }

  const sharpnessScore = measureRoiSharpness(rawGray, width, height, bbox);
  const learnedModel = buildLearnedTargetModel({
    imageData,
    referenceImageDataUrl,
    corners,
    center: {x: cxNorm, y: cyNorm},
    detectedCircles: circles,
    manualCorrected: false,
  });

  const confidence = Math.min(
    0.96,
    0.5 +
      Math.min(0.28, circles.length * 0.08) +
      Math.min(0.18, radialSupportRatio * 0.14) +
      (hasRectTarget ? 0.08 : 0),
  );

  return {
    corners,
    center: {x: cxNorm, y: cyNorm},
    boundingBox: bbox,
    detectedCircles: circles,
    referenceImageDataUrl,
    referenceWidth: width,
    referenceHeight: height,
    referenceSignature: computeRoiSignature(gray, width, height, bbox),
    state: 'BLUE_DETECTED',
    trackingStatus: 'GREEN_LOCKED',
    confidence,
    sharpnessScore,
    targetPixelSize: {w: Math.round(bbox.w * width), h: Math.round(bbox.h * height)},
    tiltAngleDeg: 0,
    failureReasons: sharpnessScore < 9 ? ['Attention : image légèrement floue, vérifiez le contour.'] : [],
    manualCorrected: false,
    attemptsCount: attemptIndex,
    analyzedAt: Date.now(),
    learnedModel,
  };
}

/**
 * Finds the dominant structured edge cluster (rectangular target board or circular cluster)
 * as a shape-agnostic complement to concentric circle voting.
 */
function findSalientTargetRect(
  mag: Float32Array,
  maxMag: number,
  width: number,
  height: number,
): {x: number; y: number; w: number; h: number} | null {
  if (maxMag < 65) return null;
  const cols = 24;
  const rows = 18;
  const cellW = width / cols;
  const cellH = height / rows;
  const active = new Uint8Array(cols * rows);
  const thr = Math.max(52, maxMag * 0.2);

  for (let gy = 1; gy < rows - 1; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.min(height - 1, Math.floor((gy + 1) * cellH));
    for (let gx = 1; gx < cols - 1; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.min(width - 1, Math.floor((gx + 1) * cellW));
      let strong = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 2) {
        const row = y * width;
        for (let x = x0; x < x1; x += 2) {
          total++;
          if (mag[row + x] >= thr) strong++;
        }
      }
      if (total > 0 && strong / total >= 0.14) {
        active[gy * cols + gx] = 1;
      }
    }
  }

  // Largest connected component near frame
  const visited = new Uint8Array(cols * rows);
  let bestBox: {x: number; y: number; w: number; h: number; count: number} | null = null;
  for (let i = 0; i < cols * rows; i++) {
    if (!active[i] || visited[i]) continue;
    const queue = [i];
    visited[i] = 1;
    let minX = cols;
    let maxX = 0;
    let minY = rows;
    let maxY = 0;
    let count = 0;
    while (queue.length > 0) {
      const idx = queue.pop()!;
      const cx = idx % cols;
      const cy = Math.floor(idx / cols);
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy);
      maxY = Math.max(maxY, cy);
      count++;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (active[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }
    const wNorm = (maxX - minX + 1) / cols;
    const hNorm = (maxY - minY + 1) / rows;
    if (
      count >= 6 &&
      wNorm >= 0.14 &&
      wNorm <= 0.85 &&
      hNorm >= 0.14 &&
      hNorm <= 0.85 &&
      (!bestBox || count > bestBox.count)
    ) {
      bestBox = {x: minX / cols, y: minY / rows, w: wNorm, h: hNorm, count};
    }
  }

  return bestBox ? {x: bestBox.x, y: bestBox.y, w: bestBox.w, h: bestBox.h} : null;
}

function measureRoiEdgeDensity(
  mag: Float32Array,
  maxMag: number,
  width: number,
  height: number,
  bbox: {x: number; y: number; w: number; h: number},
): number {
  const x0 = Math.max(1, Math.floor(bbox.x * width));
  const y0 = Math.max(1, Math.floor(bbox.y * height));
  const x1 = Math.min(width - 2, Math.floor((bbox.x + bbox.w) * width));
  const y1 = Math.min(height - 2, Math.floor((bbox.y + bbox.h) * height));
  const thr = maxMag * 0.16;
  let strong = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      total++;
      if (mag[y * width + x] >= thr) strong++;
    }
  }
  return total > 0 ? strong / total : 0;
}

function findConcentricRingsAtCenter(
  mag: Float32Array,
  maxMag: number,
  width: number,
  height: number,
  cxPx: number,
  cyPx: number,
  maxR: number,
): DetectedCircle[] {
  const minR = Math.max(8, maxR * 0.08);
  const steps = Math.max(12, Math.floor(maxR - minR));
  const radialProfile = new Float32Array(steps);
  const angles = 36;

  for (let ri = 0; ri < steps; ri++) {
    const r = minR + ri;
    let sum = 0;
    let hits = 0;
    for (let ai = 0; ai < angles; ai++) {
      const theta = (ai / angles) * Math.PI * 2;
      const sx = Math.round(cxPx + Math.cos(theta) * r);
      const sy = Math.round(cyPx + Math.sin(theta) * r);
      if (sx >= 1 && sx < width - 1 && sy >= 1 && sy < height - 1) {
        const v = mag[sy * width + sx] / (maxMag + 1e-5);
        sum += v;
        if (v > 0.16) hits++;
      }
    }
    radialProfile[ri] = (sum / angles) * (hits / angles);
  }

  // Pick local peaks separated by at least maxR * 0.11
  const minSep = Math.max(5, Math.floor(maxR * 0.11));
  const peaks: DetectedCircle[] = [];
  for (let i = 2; i < steps - 2; i++) {
    const val = radialProfile[i];
    if (
      val > 0.045 &&
      val >= radialProfile[i - 1] &&
      val >= radialProfile[i + 1] &&
      val >= radialProfile[i - 2] &&
      val >= radialProfile[i + 2]
    ) {
      const r = minR + i;
      if (peaks.every((p) => Math.abs(p.r - r) >= minSep)) {
        peaks.push({
          cx: cxPx / width,
          cy: cyPx / height,
          r,
          confidence: Math.min(0.99, val * 3.2),
        });
      }
    }
  }
  return peaks.slice(0, 6);
}

/**
 * Real-time adaptive background subtraction + frame-to-frame motion detector.
 * Optimized with preallocated grid/LUT buffers and ROI-focused sampling for >= 15-20 FPS on mobile.
 */
export class MotionDetector {
  private bgModel: Float32Array | null = null;
  private prevGray: Uint8Array | null = null;
  private prevRgb: Uint8Array | null = null;
  private bgRgb: Float32Array | null = null;
  private width = 0;
  private height = 0;
  private gridCols = 32;
  private gridRows = 24;
  private cellActive = new Uint8Array(32 * 24);
  private cellEnergy = new Float32Array(32 * 24);
  private cellCounts = new Uint16Array(32 * 24);
  private visited = new Uint8Array(32 * 24);
  private colToGx = new Uint8Array(0);
  private rowToGy = new Uint8Array(0);

  reset() {
    this.bgModel = null;
    this.prevGray = null;
    this.prevRgb = null;
    this.bgRgb = null;
  }

  private ensureLookupTables(width: number, height: number) {
    if (this.colToGx.length !== width) {
      this.colToGx = new Uint8Array(width);
      for (let x = 0; x < width; x++) {
        this.colToGx[x] = Math.min(this.gridCols - 1, Math.floor((x * this.gridCols) / width));
      }
    }
    if (this.rowToGy.length !== height) {
      this.rowToGy = new Uint8Array(height);
      for (let y = 0; y < height; y++) {
        this.rowToGy[y] = Math.min(this.gridRows - 1, Math.floor((y * this.gridRows) / height));
      }
    }
  }

  processFrame(
    gray: Uint8Array,
    width: number,
    height: number,
    calibration: TargetCalibration,
    sensitivity: number,
    minAreaRatio: number,
    colorBuffer?: Uint8ClampedArray | Uint8Array | null,
  ): MotionStepOutput {
    const t0 = performance.now();
    const len = width * height;
    const colorStride =
      colorBuffer && colorBuffer.length === len * 4
        ? 4
        : colorBuffer && colorBuffer.length === len * 3
          ? 3
          : 0;

    if (!this.bgModel || !this.prevGray || this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.ensureLookupTables(width, height);
      this.bgModel = new Float32Array(gray.length);
      for (let i = 0; i < gray.length; i++) this.bgModel[i] = gray[i];
      this.prevGray = new Uint8Array(gray);
      if (colorStride > 0 && colorBuffer) {
        this.prevRgb = new Uint8Array(len * 3);
        this.bgRgb = new Float32Array(len * 3);
        for (let i = 0, p = 0, q = 0; i < len; i++, p += colorStride, q += 3) {
          this.prevRgb[q] = colorBuffer[p];
          this.prevRgb[q + 1] = colorBuffer[p + 1];
          this.prevRgb[q + 2] = colorBuffer[p + 2];
          this.bgRgb[q] = colorBuffer[p];
          this.bgRgb[q + 1] = colorBuffer[p + 1];
          this.bgRgb[q + 2] = colorBuffer[p + 2];
        }
      }
      return {
        hasSignificantMotion: false,
        globalShakeDetected: false,
        frameDeltaEnergy: 0,
        bgDeltaEnergy: 0,
        blobs: [],
        roiDeltaEnergy: 0,
        maxPixelDelta: 0,
        processingMs: performance.now() - t0,
      };
    }

    if (colorStride > 0 && colorBuffer && (!this.prevRgb || !this.bgRgb)) {
      this.prevRgb = new Uint8Array(len * 3);
      this.bgRgb = new Float32Array(len * 3);
      for (let i = 0, p = 0, q = 0; i < len; i++, p += colorStride, q += 3) {
        this.prevRgb[q] = colorBuffer[p];
        this.prevRgb[q + 1] = colorBuffer[p + 1];
        this.prevRgb[q + 2] = colorBuffer[p + 2];
        this.bgRgb[q] = colorBuffer[p];
        this.bgRgb[q + 1] = colorBuffer[p + 1];
        this.bgRgb[q + 2] = colorBuffer[p + 2];
      }
    }

    const cellActive = this.cellActive;
    const cellEnergy = this.cellEnergy;
    const cellCounts = this.cellCounts;
    cellActive.fill(0);
    cellEnergy.fill(0);
    cellCounts.fill(0);

    const prevGray = this.prevGray;
    const bgModel = this.bgModel;
    const prevRgb = colorStride > 0 ? this.prevRgb : null;
    const bgRgb = colorStride > 0 ? this.bgRgb : null;
    const colToGx = this.colToGx;
    const rowToGy = this.rowToGy;
    const gridCols = this.gridCols;

    let frameDeltaSum = 0;
    let bgDeltaSum = 0;
    let totalSamples = 0;
    let activePixels = 0;
    let roiActivePixels = 0;
    let roiTotalPixels = 0;
    let roiTransientCount = 0;
    let maxPixelDelta = 0;

    // Padded ROI covers the target plus close approach corridor regardless of camera angle/position
    const padX = Math.max(0.06, calibration.boundingBox.w * 0.22);
    const padY = Math.max(0.06, calibration.boundingBox.h * 0.22);
    const roiX0 = Math.max(0, Math.floor((calibration.boundingBox.x - padX) * width));
    const roiY0 = Math.max(0, Math.floor((calibration.boundingBox.y - padY) * height));
    const roiX1 = Math.min(width - 1, Math.ceil((calibration.boundingBox.x + calibration.boundingBox.w + padX) * width));
    const roiY1 = Math.min(height - 1, Math.ceil((calibration.boundingBox.y + calibration.boundingBox.h + padY) * height));
    const bgThr = sensitivity * 1.25;
    const comboFrameThr = sensitivity * 0.6;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      const inRoiY = y >= roiY0 && y <= roiY1;
      const gyOffset = rowToGy[y] * gridCols;
      if (!inRoiY && (y & 1) === 1) continue;

      for (let x = 0; x < width; ) {
        const inRoi = inRoiY && x >= roiX0 && x <= roiX1;
        const idx = row + x;
        const curr = gray[idx];
        const pf = curr - prevGray[idx];
        let fDiff = pf < 0 ? -pf : pf;
        const pb = curr - bgModel[idx];
        let bDiff = pb < 0 ? -pb : pb;

        // Color-aware delta inside padded target ROI catches same-luminance colored Nerf darts
        if (inRoi && colorStride > 0 && colorBuffer && prevRgb && bgRgb) {
          const p = idx * colorStride;
          const q = idx * 3;
          const r = colorBuffer[p];
          const g = colorBuffer[p + 1];
          const b = colorBuffer[p + 2];

          const drF = r - prevRgb[q];
          const dgF = g - prevRgb[q + 1];
          const dbF = b - prevRgb[q + 2];
          const cF = Math.max(
            drF < 0 ? -drF : drF,
            dgF < 0 ? -dgF : dgF,
            dbF < 0 ? -dbF : dbF,
          ) * 0.88;
          if (cF > fDiff) fDiff = cF;

          const drB = r - bgRgb[q];
          const dgB = g - bgRgb[q + 1];
          const dbB = b - bgRgb[q + 2];
          const cB = Math.max(
            drB < 0 ? -drB : drB,
            dgB < 0 ? -dgB : dgB,
            dbB < 0 ? -dbB : dbB,
          ) * 0.88;
          if (cB > bDiff) bDiff = cB;
        }

        totalSamples++;
        frameDeltaSum += fDiff;
        bgDeltaSum += bDiff;
        if (inRoi) {
          roiTotalPixels++;
          if (fDiff > maxPixelDelta) maxPixelDelta = fDiff;
          if (fDiff >= sensitivity) roiTransientCount++;
        }

        // Require actual inter-frame change (fDiff) so already-stuck static darts never re-trigger
        const isPixelMoving =
          fDiff >= sensitivity || (fDiff >= comboFrameThr && bDiff >= bgThr);
        if (isPixelMoving) {
          activePixels++;
          if (inRoi) roiActivePixels++;
          const cIdx = gyOffset + colToGx[x];
          cellCounts[cIdx]++;
          cellEnergy[cIdx] += fDiff > bDiff ? fDiff : bDiff;
        }
        x += inRoi ? 2 : 4;
      }
    }

    const activeRatio = activePixels / Math.max(1, totalSamples);
    const globalShakeDetected = activeRatio > 0.36;

    // Fast settling when ROI is quiet so a newly stuck dart becomes part of background quickly
    const roiQuiet = roiTransientCount <= 1;
    const alpha = roiQuiet ? 0.25 : activeRatio < 0.04 ? 0.04 : 0.005;
    if (!globalShakeDetected) {
      for (let i = 0; i < len; i++) {
        bgModel[i] += (gray[i] - bgModel[i]) * alpha;
      }
      if (colorStride > 0 && colorBuffer && prevRgb && bgRgb) {
        for (let i = 0, p = 0, q = 0; i < len; i++, p += colorStride, q += 3) {
          const r = colorBuffer[p];
          const g = colorBuffer[p + 1];
          const b = colorBuffer[p + 2];
          prevRgb[q] = r;
          prevRgb[q + 1] = g;
          prevRgb[q + 2] = b;
          bgRgb[q] += (r - bgRgb[q]) * alpha;
          bgRgb[q + 1] += (g - bgRgb[q + 1]) * alpha;
          bgRgb[q + 2] += (b - bgRgb[q + 2]) * alpha;
        }
      }
    }
    prevGray.set(gray);

    if (globalShakeDetected) {
      return {
        hasSignificantMotion: false,
        globalShakeDetected: true,
        frameDeltaEnergy: frameDeltaSum / Math.max(1, totalSamples),
        bgDeltaEnergy: bgDeltaSum / Math.max(1, totalSamples),
        blobs: [],
        roiDeltaEnergy: 0,
        maxPixelDelta: Math.round(maxPixelDelta * 10) / 10,
        processingMs: performance.now() - t0,
      };
    }

    const cellW = width / this.gridCols;
    const cellH = height / this.gridRows;
    // Detect compact darts at 3-8m (straddled or small 2-3px) while rejecting single-pixel sensor noise
    const minCellSamples = Math.max(2, Math.floor((cellW * cellH) / 36));
    for (let c = 0; c < cellActive.length; c++) {
      if (cellCounts[c] >= minCellSamples) cellActive[c] = 1;
    }

    const rawBlobs = extractGridBlobs(
      cellActive,
      cellEnergy,
      cellCounts,
      this.gridCols,
      this.gridRows,
      minAreaRatio,
      this.visited,
    );

    // Filter scene-wide motion before it can reach the shot counter.
    const blobs = filterTargetMotionBlobs(rawBlobs, calibration);

    return {
      hasSignificantMotion: blobs.length > 0,
      globalShakeDetected: false,
      frameDeltaEnergy: frameDeltaSum / Math.max(1, totalSamples),
      bgDeltaEnergy: bgDeltaSum / Math.max(1, totalSamples),
      blobs,
      roiDeltaEnergy: roiTotalPixels > 0 ? roiActivePixels / roiTotalPixels : 0,
      maxPixelDelta: Math.round(maxPixelDelta * 10) / 10,
      processingMs: performance.now() - t0,
    };
  }
}

function extractGridBlobs(
  cellActive: Uint8Array,
  cellEnergy: Float32Array,
  cellCounts: Uint16Array,
  cols: number,
  rows: number,
  minAreaRatio: number,
  visitedBuf?: Uint8Array,
): MotionBlob[] {
  const visited = visitedBuf && visitedBuf.length === cols * rows ? visitedBuf : new Uint8Array(cols * rows);
  visited.fill(0);
  const blobs: MotionBlob[] = [];
  const totalCells = cols * rows;

  for (let start = 0; start < totalCells; start++) {
    if (!cellActive[start] || visited[start]) continue;

    const queue = [start];
    visited[start] = 1;
    let minGx = cols,
      maxGx = 0,
      minGy = rows,
      maxGy = 0;
    let weightedX = 0,
      weightedY = 0,
      totalWeight = 0,
      totalEnergy = 0,
      cellCount = 0;

    while (queue.length > 0) {
      const idx = queue.pop()!;
      const gx = idx % cols;
      const gy = Math.floor(idx / cols);
      const w = cellCounts[idx] || 1;

      minGx = Math.min(minGx, gx);
      maxGx = Math.max(maxGx, gx);
      minGy = Math.min(minGy, gy);
      maxGy = Math.max(maxGy, gy);

      weightedX += ((gx + 0.5) / cols) * w;
      weightedY += ((gy + 0.5) / rows) * w;
      totalWeight += w;
      totalEnergy += cellEnergy[idx];
      cellCount++;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          const ny = gy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (cellActive[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }

    const areaRatio = cellCount / totalCells;
    if (areaRatio >= minAreaRatio && areaRatio <= 0.35) {
      const wNorm = (maxGx - minGx + 1) / cols;
      const hNorm = (maxGy - minGy + 1) / rows;
      blobs.push({
        cx: weightedX / Math.max(1, totalWeight),
        cy: weightedY / Math.max(1, totalWeight),
        minX: minGx / cols,
        minY: minGy / rows,
        maxX: (maxGx + 1) / cols,
        maxY: (maxGy + 1) / rows,
        areaRatio,
        energy: totalEnergy / Math.max(1, totalWeight),
        aspectRatio: wNorm / Math.max(0.001, hNorm),
      });
    }
  }

  return blobs.sort((a, b) => b.energy - a.energy);
}

interface DeltaCluster {
  pixelCount: number;
  totalDelta: number;
  maxDelta: number;
  coreCx: number;
  coreCy: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Extracts 8-connected spatial clusters from a difference map inside [x0..x1, y0..y1]
 * so impact localization tracks the real physical dart cluster instead of averaging global noise.
 */
function extractDeltaClusters(params: {
  diffMap: Float32Array;
  width: number;
  height: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  threshold: number;
}): {
  clusters: DeltaCluster[];
  activePixels: number;
  totalPixels: number;
} {
  const {diffMap, width, height, x0, y0, x1, y1, threshold} = params;
  const boxW = Math.max(1, x1 - x0 + 1);
  const boxH = Math.max(1, y1 - y0 + 1);
  const mask = new Uint8Array(boxW * boxH);
  const visited = new Uint8Array(boxW * boxH);
  let activePixels = 0;

  for (let y = y0; y <= y1; y++) {
    const rowOff = y * width;
    const localRow = (y - y0) * boxW;
    for (let x = x0; x <= x1; x++) {
      if (diffMap[rowOff + x] >= threshold) {
        mask[localRow + (x - x0)] = 1;
        activePixels++;
      }
    }
  }

  const clusters: DeltaCluster[] = [];
  const totalBox = boxW * boxH;
  const dirs = [-1, 0, 1];

  for (let start = 0; start < totalBox; start++) {
    if (!mask[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    const componentIndices: number[] = [];
    let maxDelta = 0;
    let totalDelta = 0;
    let minLx = boxW;
    let maxLx = 0;
    let minLy = boxH;
    let maxLy = 0;

    while (queue.length > 0) {
      const idx = queue.pop()!;
      componentIndices.push(idx);
      const lx = idx % boxW;
      const ly = Math.floor(idx / boxW);
      const gx = x0 + lx;
      const gy = y0 + ly;
      const d = diffMap[gy * width + gx];
      totalDelta += d;
      if (d > maxDelta) maxDelta = d;
      if (lx < minLx) minLx = lx;
      if (lx > maxLx) maxLx = lx;
      if (ly < minLy) minLy = ly;
      if (ly > maxLy) maxLy = ly;

      for (const dy of dirs) {
        const ny = ly + dy;
        if (ny < 0 || ny >= boxH) continue;
        for (const dx of dirs) {
          if (dx === 0 && dy === 0) continue;
          const nx = lx + dx;
          if (nx < 0 || nx >= boxW) continue;
          const nIdx = ny * boxW + nx;
          if (mask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }

    if (componentIndices.length < 4) continue;

    // Weight centroid by squared excess delta inside the top core so the solid dart body/tip dominates edge halo
    const coreFloor = Math.max(threshold, maxDelta * 0.45);
    let sumX = 0;
    let sumY = 0;
    let sumW = 0;
    for (const idx of componentIndices) {
      const lx = idx % boxW;
      const ly = Math.floor(idx / boxW);
      const gx = x0 + lx;
      const gy = y0 + ly;
      const d = diffMap[gy * width + gx];
      const w = d >= coreFloor ? d * d : d * 0.25;
      sumX += ((gx + 0.5) / width) * w;
      sumY += ((gy + 0.5) / height) * w;
      sumW += w;
    }

    if (sumW > 0) {
      clusters.push({
        pixelCount: componentIndices.length,
        totalDelta,
        maxDelta,
        coreCx: sumX / sumW,
        coreCy: sumY / sumW,
        minX: (x0 + minLx) / width,
        maxX: (x0 + maxLx + 1) / width,
        minY: (y0 + minLy) / height,
        maxY: (y0 + maxLy + 1) / height,
      });
    }
  }

  clusters.sort((a, b) => b.totalDelta - a.totalDelta);
  return {clusters, activePixels, totalPixels: totalBox};
}

/**
 * Multi-pass event re-analysis on the full sequence of original frames (before + during + after impact).
 * Isolates each shot locally (preventing prior/next shots from corrupting baseline),
 * uses 8-connected spatial clusters for true impact position on custom irregular/diamond geometry,
 * and never fabricates an impact point: returns UNCERTAIN whenever impact or position cannot be confirmed.
 */
export function reanalyzeShotSequence(params: {
  frames: Array<{gray: Uint8Array; rgb?: Uint8Array; width: number; height: number; timestampMs: number}>;
  triggerIndex: number;
  calibration: TargetCalibration;
  targetProfile: TargetProfile;
  sensitivity: number;
  passes: number;
  captureFps: number;
  sessionId: string;
  shotNumber: number;
  boostSensitivity?: boolean;
}): Omit<ShotEvent, 'id' | 'videoBlobId' | 'frameSequenceId' | 'thumbnailDataUrl'> {
  const tStart = performance.now();
  const {
    frames,
    triggerIndex,
    calibration,
    targetProfile,
    sensitivity: rawSensitivity,
    passes,
    captureFps,
    sessionId,
    shotNumber,
    boostSensitivity = false,
  } = params;
  const sensitivity = boostSensitivity ? Math.max(12, Math.round(rawSensitivity * 0.72)) : rawSensitivity;

  const notes: string[] = [];
  if (frames.length < 4) {
    return {
      sessionId,
      shotNumber,
      timestamp: Date.now(),
      videoTimestampMs: frames[0]?.timestampMs ?? 0,
      result: 'UNCERTAIN',
      zoneId: null,
      zoneName: 'IMPACT INCERTAIN',
      score: 0,
      impactPoint: null,
      frameImpactPoint: null,
      confidence: 0.15,
      confidenceStatus: 'UNCERTAIN',
      validationState: 'AUTO',
      trajectory: [],
      evidence: {
        preFrames: triggerIndex,
        postFrames: Math.max(0, frames.length - triggerIndex),
        maxMotionEnergy: 0,
        sceneDeltaScore: 0,
        launchVisible: false,
        bounceDetected: false,
        reanalyzedPasses: 1,
        captureFpsAtEvent: captureFps,
        processingTimeMs: performance.now() - tStart,
        analysisNotes: ['Nombre d’images capturées insuffisant pour reconstituer l’événement.'],
        eventDetected: true,
        impactConfirmed: false,
        positionDetermined: false,
        scoreAssigned: false,
      },
    };
  }

  const width = frames[0].width;
  const height = frames[0].height;
  const hasRgb = Boolean(frames[0].rgb);
  const bbox = calibration.boundingBox;
  const activePoly =
    calibration.polygon && calibration.polygon.length >= 3 ? calibration.polygon : calibration.corners;

  // Padded search region (~18% around calibrated polygon) to catch near-misses and edge impacts accurately
  const padX = Math.max(0.05, bbox.w * 0.18);
  const padY = Math.max(0.05, bbox.h * 0.18);
  const searchX0 = Math.max(0, Math.floor((bbox.x - padX) * width));
  const searchY0 = Math.max(0, Math.floor((bbox.y - padY) * height));
  const searchX1 = Math.min(width - 1, Math.ceil((bbox.x + bbox.w + padX) * width));
  const searchY1 = Math.min(height - 1, Math.ceil((bbox.y + bbox.h + padY) * height));

  const roiPixCount = Math.max(
    1,
    (Math.floor((bbox.x + bbox.w) * width) - Math.floor(bbox.x * width) + 1) *
      (Math.floor((bbox.y + bbox.h) * height) - Math.floor(bbox.y * height) + 1),
  );

  // Measure frame-to-frame motion energy & active changing pixels inside padded target ROI
  const frameMotion = new Float32Array(frames.length);
  const frameActivePix = new Int32Array(frames.length);
  const activeStepThr = Math.max(16, sensitivity * 0.65);
  for (let f = 1; f < frames.length; f++) {
    const gCurr = frames[f].gray;
    const gPrev = frames[f - 1].gray;
    let sum = 0;
    let cnt = 0;
    let active = 0;
    for (let y = searchY0; y <= searchY1; y += 2) {
      const row = y * width;
      for (let x = searchX0; x <= searchX1; x += 2) {
        const diff = Math.abs(gCurr[row + x] - gPrev[row + x]);
        sum += diff;
        if (diff >= activeStepThr) active++;
        cnt++;
      }
    }
    frameMotion[f] = cnt > 0 ? sum / cnt : 0;
    frameActivePix[f] = active;
  }

  const safeTrigger = Math.max(1, Math.min(frames.length - 2, triggerIndex));
  const isLowFps = captureFps > 0 && captureFps < 12;

  // Choose quietest baseline frames right before safeTrigger so previous stuck darts stay in preAvg
  const preWinStart = Math.max(0, safeTrigger - (isLowFps ? 5 : 10));
  const preWinEnd = Math.max(preWinStart, safeTrigger - (isLowFps ? 1 : 2));
  const preCandidates: Array<{idx: number; active: number; motion: number}> = [];
  for (let f = preWinStart; f <= preWinEnd; f++) {
    const refIdx = f === 0 ? 1 : f;
    preCandidates.push({
      idx: f,
      active: frameActivePix[refIdx],
      motion: frameMotion[refIdx],
    });
  }
  preCandidates.sort((a, b) => a.active - b.active || a.motion - b.motion || b.idx - a.idx);
  const preIndices =
    preCandidates.length > 0
      ? preCandidates.slice(0, Math.min(isLowFps ? 3 : 4, preCandidates.length)).map((c) => c.idx)
      : [0];

  // Locate peak frame around triggerIndex and stop post-window BEFORE any later rapid-fire shot
  let peakFrameIdx = safeTrigger;
  let peakLocalActive = frameActivePix[safeTrigger];
  let peakLocalMotion = frameMotion[safeTrigger];
  const peakScanEnd = Math.min(frames.length - 1, safeTrigger + (isLowFps ? 3 : 6));
  for (let f = Math.max(1, safeTrigger - 1); f <= peakScanEnd; f++) {
    if (
      frameActivePix[f] > peakLocalActive ||
      (frameActivePix[f] === peakLocalActive && frameMotion[f] > peakLocalMotion)
    ) {
      peakLocalActive = frameActivePix[f];
      peakLocalMotion = frameMotion[f];
      peakFrameIdx = f;
    }
  }

  let nextEventCutoff = frames.length - 1;
  let sawPostDip = false;
  let minPostActive = peakLocalActive;
  for (let f = peakFrameIdx + 1; f < frames.length; f++) {
    if (frameActivePix[f] < minPostActive) minPostActive = frameActivePix[f];
    if (frameActivePix[f] <= Math.max(3, Math.floor(peakLocalActive * 0.25))) {
      sawPostDip = true;
    } else if (
      sawPostDip &&
      f >= peakFrameIdx + (isLowFps ? 2 : 4) &&
      frameActivePix[f] >= Math.max(5, Math.ceil(peakLocalActive * 0.35), minPostActive * 2)
    ) {
      nextEventCutoff = f - 1;
      notes.push('Fenêtre post-impact isolée avant un tir suivant très rapproché.');
      break;
    }
  }

  // Use the earliest settled frames immediately after impact so subsequent darts never contaminate postAvg
  const postCandidates: Array<{idx: number; active: number; motion: number}> = [];
  const settledStart = Math.min(nextEventCutoff, peakFrameIdx + (isLowFps ? 1 : 2));
  const settledEnd = Math.min(nextEventCutoff, settledStart + (isLowFps ? 4 : 7));
  for (let f = settledStart; f <= settledEnd; f++) {
    postCandidates.push({idx: f, active: frameActivePix[f], motion: frameMotion[f]});
  }
  postCandidates.sort((a, b) => a.active - b.active || a.motion - b.motion || a.idx - b.idx);
  const postIndices =
    postCandidates.length > 0
      ? postCandidates.slice(0, Math.min(isLowFps ? 3 : 5, postCandidates.length)).map((c) => c.idx)
      : [Math.min(frames.length - 1, safeTrigger + 1)];

  const preAvg = new Float32Array(width * height);
  const postAvg = new Float32Array(width * height);
  for (const idx of preIndices) {
    const g = frames[idx].gray;
    for (let i = 0; i < g.length; i++) preAvg[i] += g[i];
  }
  for (let i = 0; i < preAvg.length; i++) preAvg[i] /= preIndices.length;

  for (const idx of postIndices) {
    const g = frames[idx].gray;
    for (let i = 0; i < g.length; i++) postAvg[i] += g[i];
  }
  for (let i = 0; i < postAvg.length; i++) postAvg[i] /= postIndices.length;

  let preAvgRgb: Float32Array | null = null;
  let postAvgRgb: Float32Array | null = null;
  if (hasRgb) {
    preAvgRgb = new Float32Array(width * height * 3);
    postAvgRgb = new Float32Array(width * height * 3);
    for (const idx of preIndices) {
      const r = frames[idx].rgb!;
      for (let i = 0; i < r.length; i++) preAvgRgb[i] += r[i];
    }
    for (let i = 0; i < preAvgRgb.length; i++) preAvgRgb[i] /= preIndices.length;

    for (const idx of postIndices) {
      const r = frames[idx].rgb!;
      for (let i = 0; i < r.length; i++) postAvgRgb[i] += r[i];
    }
    for (let i = 0; i < postAvgRgb.length; i++) postAvgRgb[i] /= postIndices.length;
  }

  // Pass 1: Track moving dart trajectory around THIS event window only
  const trajectory: Point2D[] = [];
  let maxMotionEnergy = 0;
  let launchVisible = false;
  const trajStart = Math.max(0, safeTrigger - 6);
  const trajEnd = Math.min(nextEventCutoff, peakFrameIdx + 3);

  const detector = new MotionDetector();
  for (let f = trajStart; f <= trajEnd; f++) {
    const res = detector.processFrame(
      frames[f].gray,
      width,
      height,
      calibration,
      Math.max(14, sensitivity * 0.78),
      0.00035,
    );
    if (res.blobs.length > 0 && !res.globalShakeDetected) {
      const top = res.blobs[0];
      if (top.energy > maxMotionEnergy) maxMotionEnergy = top.energy;
      const pt = {x: top.cx, y: top.cy};
      trajectory.push(pt);
      if (f <= safeTrigger && !pointInPolygon(pt, activePoly)) {
        launchVisible = true;
      }
    }
  }

  if (launchVisible) {
    notes.push('Trajectoire d’approche détectée hors cible avant impact.');
  } else {
    notes.push('Départ du tir non visible dans le champ (détection proche cible uniquement).');
  }

  // Pass 2: Connected cluster analysis of persistent scene delta (postAvg vs preAvg)
  const persistDiff = new Float32Array(width * height);
  const persistThr = Math.max(15, sensitivity * 0.68);
  for (let y = searchY0; y <= searchY1; y++) {
    const row = y * width;
    for (let x = searchX0; x <= searchX1; x++) {
      const idx = row + x;
      let d = Math.abs(postAvg[idx] - preAvg[idx]);
      if (preAvgRgb && postAvgRgb) {
        const q = idx * 3;
        const dr = Math.abs(postAvgRgb[q] - preAvgRgb[q]);
        const dg = Math.abs(postAvgRgb[q + 1] - preAvgRgb[q + 1]);
        const db = Math.abs(postAvgRgb[q + 2] - preAvgRgb[q + 2]);
        d = Math.max(d, dr, dg, db);
      }
      persistDiff[idx] = d;
    }
  }

  const persistAnalysis = extractDeltaClusters({
    diffMap: persistDiff,
    width,
    height,
    x0: searchX0,
    y0: searchY0,
    x1: searchX1,
    y1: searchY1,
    threshold: persistThr,
  });

  // Pass 3: Connected cluster analysis of transient peak frames inside [peakFrameIdx-1 .. peakFrameIdx+2]
  const transientDiff = new Float32Array(width * height);
  const transientThr = Math.max(18, sensitivity * 0.85);
  const tWinStart = Math.max(1, peakFrameIdx - 1);
  const tWinEnd = Math.min(nextEventCutoff, peakFrameIdx + 2);
  for (let f = tWinStart; f <= tWinEnd; f++) {
    const g = frames[f].gray;
    const rgb = frames[f].rgb;
    for (let y = searchY0; y <= searchY1; y++) {
      const row = y * width;
      for (let x = searchX0; x <= searchX1; x++) {
        const idx = row + x;
        let d = Math.abs(g[idx] - preAvg[idx]);
        if (rgb && preAvgRgb) {
          const q = idx * 3;
          d = Math.max(
            d,
            Math.abs(rgb[q] - preAvgRgb[q]),
            Math.abs(rgb[q + 1] - preAvgRgb[q + 1]),
            Math.abs(rgb[q + 2] - preAvgRgb[q + 2]),
          );
        }
        if (d > transientDiff[idx]) transientDiff[idx] = d;
      }
    }
  }

  const transientAnalysis = extractDeltaClusters({
    diffMap: transientDiff,
    width,
    height,
    x0: searchX0,
    y0: searchY0,
    x1: searchX1,
    y1: searchY1,
    threshold: transientThr,
  });

  const persistentDeltaRatio = persistAnalysis.activePixels / roiPixCount;
  const topPersist = persistAnalysis.clusters[0] ?? null;
  const secondPersist = persistAnalysis.clusters[1] ?? null;
  const topTransient = transientAnalysis.clusters[0] ?? null;

  // Reject global illumination flicker or unlocalized whole-target vibration
  const globalLightingNoise =
    persistAnalysis.activePixels / Math.max(1, persistAnalysis.totalPixels) > 0.28 &&
    (!topPersist || topPersist.maxDelta < persistThr * 1.5);

  const competingAmbiguousClusters =
    Boolean(topPersist && secondPersist) &&
    secondPersist!.totalDelta >= topPersist!.totalDelta * 0.72 &&
    Math.hypot(secondPersist!.coreCx - topPersist!.coreCx, secondPersist!.coreCy - topPersist!.coreCy) > 0.16 &&
    topPersist!.pixelCount / roiPixCount < 0.0025;

  let frameImpactPoint: Point2D | null = null;
  let bounceDetected = false;
  let impactConfirmed = false;
  let positionDetermined = false;
  let result: ShotResult = 'UNCERTAIN';
  let confidence = 0.25;
  let confidenceStatus: DetectionConfidenceLevel = 'UNCERTAIN';
  let targetSpacePt: Point2D | null = null;
  let zoneId: string | null = null;
  let zoneName = 'IMPACT INCERTAIN';
  let score = 0;

  if (!globalLightingNoise && !competingAmbiguousClusters && topPersist) {
    const clusterAreaInRoi = topPersist.pixelCount / roiPixCount;
    // Genuine dart cluster occupies compact area (not >24% of whole target) and has sharp delta
    if (clusterAreaInRoi <= 0.24 && topPersist.maxDelta >= Math.max(20, persistThr * 1.15)) {
      frameImpactPoint = {x: topPersist.coreCx, y: topPersist.coreCy};
      positionDetermined = true;

      const polyEval = evaluateImpactInPolygon({
        framePoint: frameImpactPoint,
        polygon: activePoly,
        center: calibration.center,
        corners: calibration.corners,
        profile: targetProfile,
      });
      targetSpacePt = polyEval.targetSpacePt;

      confidence = Math.min(
        0.97,
        0.70 +
          Math.min(0.18, (topPersist.maxDelta - persistThr) / 140) +
          (trajectory.length >= 2 ? 0.08 : 0),
      );

      if (polyEval.insideTarget) {
        impactConfirmed = true;
        result = 'HIT';
        zoneId = polyEval.zoneId;
        zoneName = polyEval.zoneName;
        score = polyEval.points;
        notes.push('Impact persistant localisé avec précision à l’intérieur de la géométrie calibrée.');
      } else {
        impactConfirmed = false;
        result = 'MISS';
        zoneId = null;
        zoneName = 'Extérieur';
        score = 0;
        notes.push('Cluster persistant localisé en dehors du contour calibré de la cible.');
      }
    } else {
      notes.push('Variation trop étendue ou contraste insuffisant pour confirmer un impact.');
    }
  } else if (globalLightingNoise || competingAmbiguousClusters) {
    notes.push(
      globalLightingNoise
        ? 'Variation lumineuse globale détectée sans impact ponctuel confirmé.'
        : 'Plusieurs zones concurrentes détectées — position d’impact indéterminable.',
    );
  } else if (
    topTransient &&
    topTransient.pixelCount >= 5 &&
    topTransient.pixelCount / roiPixCount <= 0.22 &&
    topTransient.maxDelta >= Math.max(24, transientThr * 1.15)
  ) {
    const candPt = {x: topTransient.coreCx, y: topTransient.coreCy};
    const polyEval = evaluateImpactInPolygon({
      framePoint: candPt,
      polygon: activePoly,
      center: calibration.center,
      corners: calibration.corners,
      profile: targetProfile,
    });

    if (polyEval.insideTarget) {
      frameImpactPoint = candPt;
      targetSpacePt = polyEval.targetSpacePt;
      bounceDetected = true;
      impactConfirmed = true;
      positionDetermined = true;
      result = 'BOUNCE';
      zoneId = polyEval.zoneId;
      zoneName = `${polyEval.zoneName} (Rebond)`;
      score = polyEval.points;
      confidence = Math.min(0.84, 0.56 + Math.min(0.22, topTransient.pixelCount / 60));
      notes.push('Impact transitoire confirmé dans la cible suivi d’un rebond.');
    } else if (trajectory.length >= 2 && maxMotionEnergy >= sensitivity * 1.1) {
      frameImpactPoint = candPt;
      targetSpacePt = polyEval.targetSpacePt;
      impactConfirmed = false;
      positionDetermined = true;
      result = 'MISS';
      zoneId = null;
      zoneName = 'Extérieur';
      score = 0;
      confidence = Math.min(0.74, 0.50 + Math.min(0.18, trajectory.length * 0.04));
      notes.push('Mouvement/impact transitoire localisé hors du contour de la cible.');
    }
  } else {
    notes.push('Aucune variation ponctuelle fiable confirmée sur la cible.');
  }

  if (confidence >= 0.72 && positionDetermined && result !== 'UNCERTAIN') {
    confidenceStatus = 'CONFIRMED';
  } else if (confidence >= 0.48 && positionDetermined && result !== 'UNCERTAIN') {
    confidenceStatus = 'PROBABLE';
  } else {
    confidenceStatus = 'UNCERTAIN';
    result = 'UNCERTAIN';
    impactConfirmed = false;
    positionDetermined = false;
    zoneId = null;
    zoneName = 'IMPACT INCERTAIN';
    score = 0;
    frameImpactPoint = null;
    targetSpacePt = null;
  }

  return {
    sessionId,
    shotNumber,
    timestamp: Date.now(),
    videoTimestampMs: frames[Math.min(peakFrameIdx, frames.length - 1)].timestampMs,
    result,
    zoneId,
    zoneName,
    score,
    impactPoint: targetSpacePt,
    frameImpactPoint,
    confidence: Math.round(confidence * 100) / 100,
    confidenceStatus,
    validationState: 'AUTO',
    trajectory,
    evidence: {
      preFrames: safeTrigger,
      postFrames: Math.max(0, frames.length - safeTrigger),
      maxMotionEnergy: Math.round(maxMotionEnergy * 10) / 10,
      sceneDeltaScore: Math.round(persistentDeltaRatio * 10000) / 100,
      launchVisible,
      bounceDetected,
      reanalyzedPasses: Math.max(1, passes),
      captureFpsAtEvent: captureFps,
      processingTimeMs: Math.round((performance.now() - tStart) * 10) / 10,
      analysisNotes: notes,
      eventDetected: true,
      impactConfirmed,
      positionDetermined,
      scoreAssigned: result !== 'UNCERTAIN',
    },
  };
}
