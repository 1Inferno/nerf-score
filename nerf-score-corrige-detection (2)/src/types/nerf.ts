export interface Point2D {
  x: number; // normalized 0..1 unless stated otherwise
  y: number;
}

export type TargetState = 'RED_NOT_FOUND' | 'BLUE_DETECTED' | 'GREEN_VALIDATED';

export type TargetTrackingStatus =
  | 'GREEN_LOCKED'
  | 'ORANGE_SEARCHING'
  | 'RED_NOT_FOUND';

export type ZoneShape = 'circle' | 'ellipse' | 'polygon';

export interface TargetZone {
  id: string;
  name: string;
  points: number;
  shape: ZoneShape;
  radiusRatio: number; // 0..0.5 relative to target normalized unit square (0.5 = edge)
  color: string;
  polygonNormalized?: Point2D[];
}

export interface TargetProfile {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  aspectRatio: number; // width / height
  zones: TargetZone[];
}

export interface TargetContourGeometry {
  vertexCount: number;
  sideLengthsNormalized: number[];
  sideLengthsPx: number[];
  interiorAnglesDeg: number[];
  perimeterPx: number;
  areaNormalized: number;
  isIrregular: boolean;
  shapeLabel: string;
}

export interface DetectedCircle {
  cx: number;
  cy: number;
  r: number;
  confidence: number;
}

export interface LearnedTargetModel {
  id: string;
  referenceImageDataUrl: string;
  referenceWidth: number;
  referenceHeight: number;
  learnedCorners: [Point2D, Point2D, Point2D, Point2D];
  learnedCenter: Point2D;
  aspectRatio: number;
  patchSize: number; // e.g. 24
  patchGrayNorm: number[]; // zero-mean unit-norm 24x24 luminance patch
  patchEdgeNorm: number[]; // unit-norm 24x24 gradient magnitude patch
  patchColorMeanRgb: [number, number, number];
  patchRgbNorm: number[]; // normalized 24x24x3 RGB descriptors
  patchGray12Norm?: number[]; // pooled 12x12 luminance patch for fast coarse pyramid search
  patchRgb12Norm?: number[]; // pooled 12x12x3 RGB patch for fast coarse pyramid search
  patchChromaNorm?: number[]; // brightness-invariant 24x24 (R-L, G-L, B-L) color layout descriptor
  chromaEnergy?: number; // RMS chroma strength in target so grayscale targets skip chroma gating
  detectedCircles: DetectedCircle[];
  sharpnessScore: number;
  manualCorrected: boolean;
  learnedAt: number;
}

export type CameraPlacement = 'front' | 'below' | 'above' | 'left' | 'right' | 'tilted';

/**
 * CALIBRATION : Référence officielle validée et verrouillée pour la session.
 * Protégée contre toute modification automatique (ne change que sur action explicite de l'utilisateur).
 */
export interface OfficialCalibration {
  readonly id: string;
  readonly locked: boolean;
  readonly autoSearchDisabled: boolean;
  readonly validatedAt: number;
  readonly referenceImageDataUrl: string;
  readonly referenceWidth: number;
  readonly referenceHeight: number;
  readonly polygon: Point2D[]; // Contour libre (N >= 3 points en coordonnées d'image originale 0..1)
  readonly corners: [Point2D, Point2D, Point2D, Point2D]; // Enveloppe 4 coins compatible
  readonly center: Point2D;
  readonly boundingBox: { x: number; y: number; w: number; h: number };
  readonly targetGeometry: TargetContourGeometry;
  readonly detectedCircles: DetectedCircle[];
  readonly scoringZones: TargetZone[];
  readonly targetProfileId: string;
  readonly targetProfileName: string;
  readonly aspectRatio: number;
  readonly referenceSignature: number[];
  readonly learnedModel?: LearnedTargetModel;
  readonly manualCorrected: boolean;
  readonly cameraPlacement?: CameraPlacement;
}

/**
 * SUIVI : État d'affichage/position utilisé par la caméra sans jamais modifier CALIBRATION.
 */
export interface LiveTargetTracking {
  status: TargetTrackingStatus;
  positionLocked: boolean;
  polygon: Point2D[];
  corners: [Point2D, Point2D, Point2D, Point2D];
  center: Point2D;
  boundingBox: { x: number; y: number; w: number; h: number };
  referenceSignature: number[];
  confidence: number;
  sharpnessScore: number;
  targetPixelSize: { w: number; h: number };
  tiltAngleDeg: number;
  driftScore: number;
  lostStreak: number;
  lastSeenAt: number;
  message: string;
}

export interface TargetCalibration {
  polygon?: Point2D[]; // Contour exact à N points (losange, forme irrégulière, etc.)
  corners: [Point2D, Point2D, Point2D, Point2D]; // TL, TR, BR, BL in normalized frame coords
  center: Point2D; // normalized frame coords
  boundingBox: { x: number; y: number; w: number; h: number };
  targetGeometry?: TargetContourGeometry;
  detectedCircles: DetectedCircle[];
  referenceImageDataUrl: string;
  referenceWidth: number;
  referenceHeight: number;
  referenceSignature: number[]; // 16x16 normalized luminance block inside ROI
  state: TargetState;
  trackingStatus?: TargetTrackingStatus;
  confidence: number;
  sharpnessScore?: number;
  targetPixelSize?: { w: number; h: number };
  tiltAngleDeg?: number;
  failureReasons: string[];
  manualCorrected: boolean;
  attemptsCount: number;
  analyzedAt: number;
  learnedModel?: LearnedTargetModel;
  cameraPlacement?: CameraPlacement;
}

export interface CameraCapabilities {
  requestedFps: number;
  actualMeasuredFps: number;
  reportedTrackFps: number | null;
  maxSupportedFps: number | null;
  minSupportedFps: number | null;
  width: number;
  height: number;
  facingMode: string;
  deviceLabel: string;
  analysisFps: number;
  playbackFps: number;
  avgProcessingMs: number;
  skippedFrames?: number;
  skippedFps?: number;
  status: 'idle' | 'initializing' | 'active' | 'denied' | 'error' | 'video_file';
  errorMessage: string | null;
  hardwareLimitExplanation: string;
}

export interface RuntimePerformanceMetrics {
  cameraFps: number;
  analysisFps: number;
  avgProcessingMs: number;
  skippedFrames: number;
  skippedFps: number;
  workerEnabled: boolean;
  bufferFrames: number;
  activeResolution: string;
  videoFramesDelivered?: number;
  engineFramesAnalyzed?: number;
  lastFrameAgeMs?: number;
  lastTriggerReason?: string;
  lastMaxRoiDelta?: number;
  videoReadyState?: number;
  audioAssistanceActive?: boolean;
  audioEventsCount?: number;
  updatedAt: number;
}

export type DetectionConfidenceLevel = 'CONFIRMED' | 'PROBABLE' | 'UNCERTAIN';

export type ShotResult = 'HIT' | 'MISS' | 'BOUNCE' | 'UNCERTAIN';

export type ShotValidationState =
  | 'AUTO'
  | 'USER_CONFIRMED'
  | 'USER_CORRECTED'
  | 'DISMISSED';

export interface ShotEvidence {
  preFrames: number;
  postFrames: number;
  maxMotionEnergy: number;
  sceneDeltaScore: number;
  launchVisible: boolean;
  bounceDetected: boolean;
  reanalyzedPasses: number;
  captureFpsAtEvent: number;
  processingTimeMs: number;
  analysisNotes: string[];
  eventDetected?: boolean;
  impactConfirmed?: boolean;
  positionDetermined?: boolean;
  scoreAssigned?: boolean;
  audioCorroborated?: boolean;
  audioEventTimestampMs?: number;
}

export interface BufferedFrameMeta {
  dataUrl: string;
  timestampMs: number;
}

export interface ShotEvent {
  id: string;
  sessionId: string;
  shotNumber: number;
  timestamp: number;
  videoTimestampMs: number;
  result: ShotResult;
  zoneId: string | null;
  zoneName: string;
  score: number;
  impactPoint: Point2D | null; // Target normalized space (0.5, 0.5 is center)
  frameImpactPoint: Point2D | null; // Camera frame normalized space
  confidence: number; // 0..1
  confidenceStatus: DetectionConfidenceLevel;
  validationState: ShotValidationState;
  trajectory: Point2D[]; // Camera frame normalized centroids
  evidence: ShotEvidence;
  videoBlobId: string | null;
  frameSequenceId: string | null;
  thumbnailDataUrl: string | null;
}

export interface ShotFrameArchive {
  id: string;
  shotId: string;
  sessionId: string;
  captureFps: number;
  width: number;
  height: number;
  impactFrameIndex: number;
  frames: BufferedFrameMeta[];
}

export interface ShootingSession {
  id: string;
  title: string;
  createdAt: number;
  endedAt: number | null;
  distanceMeters: number;
  targetProfileId: string;
  targetProfileName: string;
  calibration: TargetCalibration;
  sourceType: 'camera' | 'video_file';
  videoFileName?: string;
  cameraMetrics: {
    requestedFps: number;
    actualMeasuredFps: number;
    analysisFps: number;
    resolution: string;
  };
  summary: {
    totalShots: number;
    hits: number;
    misses: number;
    bounces: number;
    uncertain: number;
    confirmedScore: number;
    averageConfirmedScore: number;
    bestShotScore: number;
    confirmedAccuracyPct: number;
  };
}

export interface AppSettings {
  id: 'default';
  requestedFps: 30 | 60 | 120 | 240;
  preferredResolution: '720p' | '1080p';
  motionSensitivity: number; // 12..60 pixel delta threshold
  minMotionAreaRatio: number; // 0.0005..0.02
  preEventSeconds: number; // 1.0..4.0
  postEventSeconds: number; // 1.0..4.0
  cameraDriftTolerance: number; // 0.12..0.45
  autoReanalyzePasses: number; // 1..3
  defaultDistanceMeters: number; // 3..10
  activeTargetProfileId: string;
  includeUncertainInCharts: boolean;
  audioAssistanceEnabled?: boolean;
}

export interface BenchmarkTestRun {
  id: string;
  name: string;
  createdAt: number;
  videoName: string;
  distanceMeters: number;
  lightingCondition: string;
  dartType: string;
  expectedShots: number;
  detectedShots: number;
  confirmedHits: number;
  bouncesDetected: number;
  falsePositives: number;
  uncertainCount: number;
  avgProcessingMs: number;
  measuredVideoFps: number;
  analysisFps: number;
  notes: string;
}

export type DiagnosticLogStatus =
  | 'QUEUED'
  | 'STARTED'
  | 'COMPLETED'
  | 'INTERRUPTED'
  | 'ERROR';

export type DiagnosticLogStage =
  | 'CAPTURE'
  | 'QUEUE'
  | 'REANALYSIS'
  | 'VIDEO_EXPORT'
  | 'PERSISTENCE'
  | 'LIFECYCLE';

export interface DiagnosticEventEntry {
  id: string;
  shotId: string;
  sessionId: string;
  shotNumber: number;
  status: DiagnosticLogStatus;
  stage: DiagnosticLogStage;
  message: string;
  reason?: string;
  timestamp: number;
  durationMs?: number;
  details?: string;
}

export type AppRoute = 'home' | 'session' | 'replays' | 'stats' | 'settings';

export const DEFAULT_TARGET_PROFILE: TargetProfile = {
  id: 'target-standard-nerf',
  name: 'Cible Standard 4 Zones',
  description: 'Barème officiel Nerf Score : Centre 100 pts, Zones 75 / 50 / 25 pts, Extérieur 0 pt.',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  aspectRatio: 1,
  zones: [
    {
      id: 'zone-center',
      name: 'Centre',
      points: 100,
      shape: 'circle',
      radiusRatio: 0.12,
      color: '#38BDF8',
    },
    {
      id: 'zone-2',
      name: 'Zone 2',
      points: 75,
      shape: 'circle',
      radiusRatio: 0.24,
      color: '#4F7CFF',
    },
    {
      id: 'zone-3',
      name: 'Zone 3',
      points: 50,
      shape: 'circle',
      radiusRatio: 0.37,
      color: '#22C55E',
    },
    {
      id: 'zone-4',
      name: 'Zone 4',
      points: 25,
      shape: 'circle',
      radiusRatio: 0.49,
      color: '#F8FAFC',
    },
  ],
};

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'default',
  requestedFps: 60,
  preferredResolution: '720p',
  motionSensitivity: 26,
  minMotionAreaRatio: 0.0012,
  preEventSeconds: 1.8,
  postEventSeconds: 1.8,
  cameraDriftTolerance: 0.24,
  autoReanalyzePasses: 2,
  defaultDistanceMeters: 5,
  activeTargetProfileId: DEFAULT_TARGET_PROFILE.id,
  includeUncertainInCharts: false,
  audioAssistanceEnabled: false,
};
