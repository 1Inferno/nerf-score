import {
  CameraPlacement,
  LearnedTargetModel,
  LiveTargetTracking,
  OfficialCalibration,
  Point2D,
  TargetCalibration,
  TargetProfile,
  TargetTrackingStatus,
} from '../types/nerf';
import {
  computePolygonBoundingBox,
  computePolygonGeometry,
  polygonToQuadCorners,
} from './geometry';
import {DistanceLocateResult} from './visionEngine';

function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  Object.freeze(obj);
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

function clonePoints(points: Point2D[]): Point2D[] {
  return points.map((p) => ({x: p.x, y: p.y}));
}

function cloneCorners(
  corners: [Point2D, Point2D, Point2D, Point2D],
): [Point2D, Point2D, Point2D, Point2D] {
  return corners.map((c) => ({x: c.x, y: c.y})) as [Point2D, Point2D, Point2D, Point2D];
}

/**
 * Construit CALIBRATION : la référence officielle validée manuellement pour la session.
 * Enregistre durablement photo originale, tous les points placés, contour complet,
 * centre, zones de score et géométrie exacte (losange, forme irrégulière, etc.).
 * Désactive définitivement toute recherche automatique après validation.
 */
export function createOfficialCalibration(params: {
  sourceCalibration: TargetCalibration;
  polygon?: Point2D[];
  center?: Point2D;
  targetProfile: TargetProfile;
  learnedModel?: LearnedTargetModel;
  manualCorrected?: boolean;
  cameraPlacement?: CameraPlacement;
}): OfficialCalibration {
  const {sourceCalibration, targetProfile, learnedModel, manualCorrected} = params;
  const rawPoly =
    params.polygon && params.polygon.length >= 3
      ? params.polygon
      : sourceCalibration.polygon && sourceCalibration.polygon.length >= 3
        ? sourceCalibration.polygon
        : sourceCalibration.corners;

  const polygon = clonePoints(rawPoly);
  const corners = polygonToQuadCorners(polygon);
  const boundingBox = computePolygonBoundingBox(polygon);
  const center = params.center ? {x: params.center.x, y: params.center.y} : {...sourceCalibration.center};
  const targetGeometry = computePolygonGeometry(
    polygon,
    sourceCalibration.referenceWidth,
    sourceCalibration.referenceHeight,
  );

  const official: OfficialCalibration = {
    id: `cal-official-${Date.now()}`,
    locked: true,
    autoSearchDisabled: true,
    validatedAt: Date.now(),
    referenceImageDataUrl: sourceCalibration.referenceImageDataUrl,
    referenceWidth: sourceCalibration.referenceWidth,
    referenceHeight: sourceCalibration.referenceHeight,
    polygon,
    corners,
    center,
    boundingBox,
    targetGeometry,
    detectedCircles: sourceCalibration.detectedCircles.map((c) => ({...c})),
    scoringZones: targetProfile.zones.map((z) => ({
      ...z,
      polygonNormalized: z.polygonNormalized?.map((p) => ({x: p.x, y: p.y})),
    })),
    targetProfileId: targetProfile.id,
    targetProfileName: targetProfile.name,
    aspectRatio: targetProfile.aspectRatio,
    referenceSignature: [...sourceCalibration.referenceSignature],
    learnedModel: learnedModel
      ? {
          ...learnedModel,
          learnedCorners: cloneCorners(learnedModel.learnedCorners),
          learnedCenter: {...learnedModel.learnedCenter},
          patchGrayNorm: [...learnedModel.patchGrayNorm],
          patchEdgeNorm: [...learnedModel.patchEdgeNorm],
          patchColorMeanRgb: [...learnedModel.patchColorMeanRgb] as [number, number, number],
          patchRgbNorm: [...learnedModel.patchRgbNorm],
          patchGray12Norm: learnedModel.patchGray12Norm
            ? [...learnedModel.patchGray12Norm]
            : undefined,
          patchRgb12Norm: learnedModel.patchRgb12Norm ? [...learnedModel.patchRgb12Norm] : undefined,
          patchChromaNorm: learnedModel.patchChromaNorm
            ? [...learnedModel.patchChromaNorm]
            : undefined,
          detectedCircles: learnedModel.detectedCircles.map((c) => ({...c})),
        }
      : undefined,
    manualCorrected: manualCorrected ?? true,
    cameraPlacement: params.cameraPlacement ?? sourceCalibration.cameraPlacement ?? 'front',
  };

  return deepFreeze(official);
}

/**
 * Initialise l'état d'affichage SUIVI à partir de la CALIBRATION officielle.
 * En mode calibration manuelle définitive, aucune recherche automatique ne modifie ce contour.
 */
export function createInitialTracking(
  officialCal: OfficialCalibration,
  options?: {
    positionLocked?: boolean;
    status?: TargetTrackingStatus;
    message?: string;
    polygon?: Point2D[];
    corners?: [Point2D, Point2D, Point2D, Point2D];
    center?: Point2D;
    boundingBox?: {x: number; y: number; w: number; h: number};
    referenceSignature?: number[];
    sharpnessScore?: number;
    confidence?: number;
  },
): LiveTargetTracking {
  const polygon = options?.polygon
    ? clonePoints(options.polygon)
    : clonePoints(officialCal.polygon);
  const corners = options?.corners ? cloneCorners(options.corners) : polygonToQuadCorners(polygon);
  const center = options?.center ? {...options.center} : {...officialCal.center};
  const bbox = options?.boundingBox
    ? {...options.boundingBox}
    : computePolygonBoundingBox(polygon);
  const status = options?.status ?? 'GREEN_LOCKED';

  return {
    status,
    positionLocked: options?.positionLocked ?? true,
    polygon,
    corners,
    center,
    boundingBox: bbox,
    referenceSignature: options?.referenceSignature
      ? [...options.referenceSignature]
      : [...officialCal.referenceSignature],
    confidence: options?.confidence ?? 1,
    sharpnessScore: options?.sharpnessScore ?? officialCal.learnedModel?.sharpnessScore ?? 20,
    targetPixelSize: {
      w: Math.round(bbox.w * officialCal.referenceWidth),
      h: Math.round(bbox.h * officialCal.referenceHeight),
    },
    tiltAngleDeg: 0,
    driftScore: 0,
    lostStreak: 0,
    lastSeenAt: Date.now(),
    message:
      options?.message ??
      'Calibration manuelle validée — recherche automatique désactivée',
  };
}

/**
 * Conservé uniquement si un mode de correspondance opt-in est explicitement utilisé.
 * Quand `officialCal.autoSearchDisabled === true`, retourne `prevTracking` inchangé sans aucune modification.
 */
export function updateTrackingFromCamera(params: {
  officialCal: OfficialCalibration;
  prevTracking: LiveTargetTracking;
  locateResult: DistanceLocateResult;
  nextSignature?: number[];
  driftScore?: number;
  lostThresholdForRed?: number;
}): LiveTargetTracking {
  const {officialCal, prevTracking} = params;
  if (officialCal.autoSearchDisabled || !officialCal.locked) {
    return prevTracking;
  }
  return prevTracking;
}

/**
 * Mise à jour manuelle du contour avant validation finale ou en édition explicite.
 */
export function updateTrackingManualPose(
  prevTracking: LiveTargetTracking,
  polygon: Point2D[],
  center: Point2D,
): LiveTargetTracking {
  const cloned = clonePoints(polygon);
  return {
    ...prevTracking,
    polygon: cloned,
    corners: polygonToQuadCorners(cloned),
    center: {...center},
    boundingBox: computePolygonBoundingBox(cloned),
  };
}

/**
 * Construit un objet TargetCalibration compatible (MotionDetector, reanalyzeShotSequence, Overlay, IndexedDB)
 * en préservant le polygone irrégulier/losange exact et la géométrie de CALIBRATION.
 */
export function buildTargetCalibrationForShot(
  officialCal: OfficialCalibration,
  tracking: LiveTargetTracking,
): TargetCalibration {
  return {
    polygon: clonePoints(tracking.polygon),
    corners: cloneCorners(tracking.corners),
    center: {...tracking.center},
    boundingBox: {...tracking.boundingBox},
    targetGeometry: officialCal.targetGeometry,
    detectedCircles: officialCal.detectedCircles.map((c) => ({...c})),
    referenceImageDataUrl: officialCal.referenceImageDataUrl,
    referenceWidth: officialCal.referenceWidth,
    referenceHeight: officialCal.referenceHeight,
    referenceSignature: [...tracking.referenceSignature],
    state: 'GREEN_VALIDATED',
    trackingStatus: tracking.status,
    confidence: tracking.confidence,
    sharpnessScore: tracking.sharpnessScore,
    targetPixelSize: {...tracking.targetPixelSize},
    tiltAngleDeg: tracking.tiltAngleDeg,
    failureReasons: [],
    manualCorrected: officialCal.manualCorrected,
    attemptsCount: 1,
    analyzedAt: officialCal.validatedAt,
    learnedModel: officialCal.learnedModel,
    cameraPlacement: officialCal.cameraPlacement,
  };
}

/**
 * Construit le TargetProfile figé à partir de CALIBRATION afin que les zones de score
 * officielles soient utilisées tout au long de la session.
 */
export function buildFrozenTargetProfile(
  officialCal: OfficialCalibration,
  fallbackProfile: TargetProfile,
): TargetProfile {
  return {
    ...fallbackProfile,
    id: officialCal.targetProfileId,
    name: officialCal.targetProfileName,
    aspectRatio: officialCal.aspectRatio,
    zones: officialCal.scoringZones.map((z) => ({
      ...z,
      polygonNormalized: z.polygonNormalized?.map((p) => ({x: p.x, y: p.y})),
    })),
  };
}

/**
 * ACTION EXPLICITE 1 : « Modifier la cible » / « Valider la nouvelle calibration »
 */
export function authorizeModifyCalibration(params: {
  sourceCalibration: TargetCalibration;
  polygon?: Point2D[];
  center?: Point2D;
  targetProfile: TargetProfile;
  learnedModel?: LearnedTargetModel;
  previousTracking?: LiveTargetTracking | null;
  cameraPlacement?: CameraPlacement;
}): {
  officialCalibration: OfficialCalibration;
  tracking: LiveTargetTracking;
} {
  const officialCalibration = createOfficialCalibration({
    sourceCalibration: params.sourceCalibration,
    polygon: params.polygon,
    center: params.center,
    targetProfile: params.targetProfile,
    learnedModel: params.learnedModel,
    manualCorrected: true,
    cameraPlacement: params.cameraPlacement ?? params.sourceCalibration.cameraPlacement,
  });
  const tracking = createInitialTracking(officialCalibration, {
    positionLocked: true,
    status: 'GREEN_LOCKED',
    confidence: 1,
    sharpnessScore: params.sourceCalibration.sharpnessScore,
    message: 'Calibration manuelle mise à jour et verrouillée sur demande utilisateur',
  });
  return {officialCalibration, tracking};
}

/**
 * ACTION EXPLICITE 2 : « Nouvelle calibration » / « Refaire la calibration »
 */
export function authorizeRedoCalibration(): {
  officialCalibration: null;
  tracking: null;
} {
  return {officialCalibration: null, tracking: null};
}

/**
 * ACTION EXPLICITE 3 : « Nouvelle session »
 */
export function authorizeNewSession(): {
  officialCalibration: null;
  tracking: null;
  clearShots: true;
} {
  return {officialCalibration: null, tracking: null, clearShots: true};
}
