import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Activity,
  AlertTriangle,
  Camera,
  CheckCircle2,
  Crosshair,
  Film,
  History,
  Lock,
  Mic,
  MicOff,
  ShieldCheck,
  Sliders,
  Square,
  Upload,
  Video,
} from 'lucide-react';
import {
  AudioDetectorStatus,
  AudioImpactDetector,
  AudioImpactEvent,
  correlateAudioEventWithVideoBuffer,
} from '../audio/audioImpactDetector';
import {
  buildHardwareFpsExplanation,
  FrameRateMeter,
  listVideoCameras,
  startCameraStream,
  stopCameraStream,
} from '../camera/cameraManager';
import {performanceStore} from '../camera/performanceStore';
import {
  authorizeModifyCalibration,
  authorizeNewSession,
  authorizeRedoCalibration,
  buildFrozenTargetProfile,
  buildTargetCalibrationForShot,
  createInitialTracking,
  createOfficialCalibration,
  updateTrackingManualPose,
} from '../cv/calibrationLock';
import {
  computePolygonBoundingBox,
  computePolygonCentroid,
  computePolygonGeometry,
  computeSessionSummary,
  polygonToQuadCorners,
} from '../cv/geometry';
import {
  extractGrayAndRgb,
  MotionBlob,
  MotionDetector,
} from '../cv/visionEngine';
import {
  LivePendingShotEvent,
  shotAnalysisQueue,
  ShotQueueError,
  ShotQueueSnapshot,
} from '../cv/shotAnalysisQueue';
import {isVisionWorkerActive} from '../cv/visionWorkerClient';
import {createDiamondPresetPolygon} from '../cv/zoomMath';
import {
  getLatestSavedCalibration,
  getSavedCalibrations,
  saveSavedCalibration,
  saveSession,
  saveShot,
} from '../db/indexedDb';
import {
  AppSettings,
  CameraCapabilities,
  CameraPlacement,
  LiveTargetTracking,
  OfficialCalibration,
  Point2D,
  ShootingSession,
  ShotEvent,
  TargetCalibration,
  TargetProfile,
} from '../types/nerf';
import {
  CircularVideoBuffer,
  RingFrameEntry,
} from '../video/circularBuffer';
import {FinalTargetSummary} from './FinalTargetSummary';
import {ManualPolygonCalibrator} from './ManualPolygonCalibrator';
import {ReplayPlayerModal} from './ReplayPlayerModal';
import {TargetCalibrationOverlay} from './TargetCalibrationOverlay';
import {TargetEditorModal} from './TargetEditorModal';

interface SessionViewProps {
  settings: AppSettings;
  targets: TargetProfile[];
  activeTarget: TargetProfile;
  savedOfficialCalibration: OfficialCalibration | null;
  shotsResetVersion: number;
  onCalibrationValidated: (cal: OfficialCalibration) => void;
  onCalibrationCleared: () => void;
  onSaveTargetProfile: (profile: TargetProfile) => Promise<void>;
  onSessionSaved: () => Promise<void>;
  onOpenReplaysForSession: (sessionId: string) => void;
}

type WorkflowStage =
  | 'CALIBRATE_PHOTO'
  | 'READY_TO_SHOOT'
  | 'ACTIVE_MONITORING'
  | 'COMPLETED';

interface FrozenCalibrationImage {
  imageData?: ImageData;
  dataUrl: string;
  w: number;
  h: number;
}

interface PendingEventCapture {
  shotId: string;
  shotNumber: number;
  sessionId: string;
  preFrames: RingFrameEntry[];
  postFrames: RingFrameEntry[];
  targetPostCount: number;
  triggeredAtMs: number;
  calibration: TargetCalibration;
  targetProfile: TargetProfile;
  captureFps: number;
  sensitivity: number;
  passes: number;
  audioCorroborated?: boolean;
  audioEventTimestampMs?: number;
}

export const SessionView: React.FC<SessionViewProps> = ({
  settings,
  targets,
  activeTarget,
  savedOfficialCalibration,
  shotsResetVersion,
  onCalibrationValidated,
  onCalibrationCleared,
  onSaveTargetProfile,
  onSessionSaved,
  onOpenReplaysForSession,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fpsMeterRef = useRef(new FrameRateMeter());
  const motionDetectorRef = useRef(new MotionDetector());
  const circularBufferRef = useRef(new CircularVideoBuffer(96));
  const activeCaptureWindowsRef = useRef<PendingEventCapture[]>([]);
  const nextShotNumberRef = useRef<number>(1);
  const lastTriggerTimeRef = useRef<number>(0);
  const wasQuietSinceLastTriggerRef = useRef<boolean>(true);
  const quietFrameStreakRef = useRef<number>(2);
  const deliveredVideoSeqRef = useRef<number>(0);
  const lastAnalyzedVideoSeqRef = useRef<number>(0);
  const lastAnalyzedVideoTimeRef = useRef<number>(-1);
  const lastEngineAnalysisAtMsRef = useRef<number>(0);
  const engineFramesAnalyzedRef = useRef<number>(0);
  const lastTriggerReasonRef = useRef<string>('En attente de surveillance');
  const lastMaxRoiDeltaRef = useRef<number>(0);
  const audioDetectorRef = useRef<AudioImpactDetector>(new AudioImpactDetector());
  const audioEventsRef = useRef<AudioImpactEvent[]>([]);
  const audioEventsCountRef = useRef<number>(0);
  const audioActiveRef = useRef<boolean>(false);
  const lastUiSyncMsRef = useRef<number>(0);
  const lastStatusTextRef = useRef<string>('En attente');

  const [sourceMode, setSourceMode] = useState<'camera' | 'video_file'>('camera');
  const [videoFileUrl, setVideoFileUrl] = useState<string | null>(null);
  const [videoFileName, setVideoFileName] = useState<string>('');
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [camCaps, setCamCaps] = useState<CameraCapabilities>({
    requestedFps: settings.requestedFps,
    actualMeasuredFps: 0,
    reportedTrackFps: null,
    maxSupportedFps: null,
    minSupportedFps: null,
    width: 0,
    height: 0,
    facingMode: 'environment',
    deviceLabel: 'Caméra arrière',
    analysisFps: 0,
    playbackFps: 0,
    avgProcessingMs: 0,
    skippedFrames: 0,
    skippedFps: 0,
    status: 'idle',
    errorMessage: null,
    hardwareLimitExplanation: '',
  });

  const [stage, setStage] = useState<WorkflowStage>(() =>
    savedOfficialCalibration ? 'READY_TO_SHOOT' : 'CALIBRATE_PHOTO',
  );
  const [selectedTargetId, setSelectedTargetId] = useState<string>(
    savedOfficialCalibration?.targetProfileId ?? activeTarget.id,
  );
  const [editingTarget, setEditingTarget] = useState<TargetProfile | null>(null);
  const [distanceMeters, setDistanceMeters] = useState<number>(settings.defaultDistanceMeters);
  const [sessionTitle, setSessionTitle] = useState<string>(
    `Session ${new Date().toLocaleDateString('fr-FR')} ${new Date().toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    })}`,
  );

  // Plein écran de calibration sur flux caméra en direct (ou image figée facultative)
  const [fullScreenCalOpen, setFullScreenCalOpen] = useState<boolean>(() => !savedOfficialCalibration);
  const [calPolygon, setCalPolygon] = useState<Point2D[]>(() =>
    savedOfficialCalibration
      ? savedOfficialCalibration.polygon.map((p) => ({...p}))
      : createDiamondPresetPolygon(),
  );
  const [calCenter, setCalCenter] = useState<Point2D>(() =>
    savedOfficialCalibration
      ? {...savedOfficialCalibration.center}
      : computePolygonCentroid(createDiamondPresetPolygon()),
  );
  const [cameraPlacement, setCameraPlacement] = useState<CameraPlacement>(
    () => savedOfficialCalibration?.cameraPlacement ?? 'front',
  );
  const [frozenCalImage, setFrozenCalImage] = useState<FrozenCalibrationImage | null>(null);
  const [savedRecentCal, setSavedRecentCal] = useState<OfficialCalibration | null>(
    savedOfficialCalibration,
  );
  const [savedCalibrations, setSavedCalibrations] = useState<OfficialCalibration[]>([]);

  // 1) CALIBRATION : Référence officielle validée, enregistrée durablement et figée
  //    (recherche automatique strictement désactivée après validation)
  const [officialCalibration, setOfficialCalibration] = useState<OfficialCalibration | null>(
    savedOfficialCalibration,
  );
  const officialCalibrationRef = useRef<OfficialCalibration | null>(officialCalibration);
  officialCalibrationRef.current = officialCalibration;

  // 2) SUIVI D'AFFICHAGE : Contour affiché à l'écran à partir de la calibration enregistrée
  const [tracking, setTracking] = useState<LiveTargetTracking | null>(() =>
    savedOfficialCalibration
      ? createInitialTracking(savedOfficialCalibration, {
          positionLocked: true,
          status: 'GREEN_LOCKED',
          message: 'Calibration verrouillée conservée — recherche auto désactivée',
        })
      : null,
  );
  const trackingRef = useRef<LiveTargetTracking | null>(tracking);
  trackingRef.current = tracking;

  const [manualCorrectionMode, setManualCorrectionMode] = useState<boolean>(false);
  const manualCorrectionModeRef = useRef<boolean>(false);
  manualCorrectionModeRef.current = manualCorrectionMode;
  const preEditTrackingRef = useRef<LiveTargetTracking | null>(null);

  const [liveBlobs, setLiveBlobs] = useState<MotionBlob[]>([]);
  const [detectionStatusLabel, setDetectionStatusLabel] = useState<string>('En attente');
  const [showFluxDiagnostic, setShowFluxDiagnostic] = useState<boolean>(true);
  const [diagSnapshot, setDiagSnapshot] = useState<{
    videoFrames: number;
    engineFrames: number;
    lastAnalysisAgeMs: number;
    maxRoiDelta: number;
    threshold: number;
    reason: string;
    videoReadyState: number;
  }>({
    videoFrames: 0,
    engineFrames: 0,
    lastAnalysisAgeMs: 0,
    maxRoiDelta: 0,
    threshold: settings.motionSensitivity,
    reason: 'En attente de démarrage',
    videoReadyState: 0,
  });
  const [audioStatus, setAudioStatus] = useState<AudioDetectorStatus>('off');
  const [audioMessage, setAudioMessage] = useState<string>(
    'Assistance audio désactivée (réglable dans Paramètres).',
  );
  const [audioEventsCount, setAudioEventsCount] = useState<number>(0);
  const [queueSnapshot, setQueueSnapshot] = useState<ShotQueueSnapshot>(() =>
    shotAnalysisQueue.getSnapshot(),
  );
  const [pendingEvents, setPendingEvents] = useState<LivePendingShotEvent[]>([]);
  const [analysisErrors, setAnalysisErrors] = useState<ShotQueueError[]>([]);
  const [endingSession, setEndingSession] = useState<boolean>(false);
  const [completedSessionSnapshot, setCompletedSessionSnapshot] = useState<ShootingSession | null>(null);
  const [replayShot, setReplayShot] = useState<ShotEvent | null>(null);

  const [sessionId, setSessionId] = useState<string>(() => `sess-${Date.now()}`);
  const sessionIdRef = useRef<string>(sessionId);
  sessionIdRef.current = sessionId;

  const [sessionShots, setSessionShots] = useState<ShotEvent[]>([]);
  const sessionShotsRef = useRef<ShotEvent[]>([]);
  sessionShotsRef.current = sessionShots;

  const currentTarget = targets.find((t) => t.id === selectedTargetId) || activeTarget;
  const currentTargetRef = useRef<TargetProfile>(currentTarget);
  currentTargetRef.current = currentTarget;

  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;

  const measuredFpsRef = useRef<number>(camCaps.actualMeasuredFps);
  measuredFpsRef.current = camCaps.actualMeasuredFps;

  // Calibration combinée en lecture seule pour affichage overlay, détection tirs & export session
  const effectiveCalibration: TargetCalibration | null =
    officialCalibration && tracking
      ? buildTargetCalibrationForShot(officialCalibration, tracking)
      : null;

  const effectiveProfile: TargetProfile = officialCalibration
    ? buildFrozenTargetProfile(officialCalibration, currentTarget)
    : currentTarget;

  // Synchronize external calibration changes (e.g. "Nouvelle calibration" clicked from Settings)
  useEffect(() => {
    if (savedOfficialCalibration === null && officialCalibrationRef.current !== null) {
      const freshPoly = createDiamondPresetPolygon();
      setOfficialCalibration(null);
      officialCalibrationRef.current = null;
      setTracking(null);
      trackingRef.current = null;
      setCalPolygon(freshPoly);
      setCalCenter(computePolygonCentroid(freshPoly));
      setFrozenCalImage(null);
      setStage('CALIBRATE_PHOTO');
      setFullScreenCalOpen(true);
    } else if (savedOfficialCalibration && !officialCalibrationRef.current) {
      const initialTrack = createInitialTracking(savedOfficialCalibration, {
        positionLocked: true,
        status: 'GREEN_LOCKED',
        message: 'Calibration verrouillée restaurée — recherche auto désactivée',
      });
      setOfficialCalibration(savedOfficialCalibration);
      officialCalibrationRef.current = savedOfficialCalibration;
      setTracking(initialTrack);
      trackingRef.current = initialTrack;
      setSavedRecentCal(savedOfficialCalibration);
      setFullScreenCalOpen(false);
      setStage('READY_TO_SHOOT');
    }
  }, [savedOfficialCalibration]);

  // Clear local session shots cleanly when "RÉINITIALISER TOUS LES TIRS" runs in Settings
  const lastShotsResetVersionRef = useRef<number>(shotsResetVersion);
  useEffect(() => {
    if (shotsResetVersion === lastShotsResetVersionRef.current) return;
    lastShotsResetVersionRef.current = shotsResetVersion;
    nextShotNumberRef.current = 1;
    activeCaptureWindowsRef.current = [];
    lastTriggerTimeRef.current = 0;
    wasQuietSinceLastTriggerRef.current = true;
    quietFrameStreakRef.current = 2;
    setSessionId(`sess-${Date.now()}`);
    setSessionShots([]);
    sessionShotsRef.current = [];
    setAnalysisErrors([]);
    setReplayShot(null);
    setCompletedSessionSnapshot(null);
    setLiveBlobs([]);
    setDetectionStatusLabel('Tirs réinitialisés (calibration cible conservée)');
    if (officialCalibrationRef.current) {
      setStage('READY_TO_SHOOT');
    }
  }, [shotsResetVersion]);

  useEffect(() => {
    const unsubState = shotAnalysisQueue.subscribeState(setQueueSnapshot);
    const unsubPending = shotAnalysisQueue.subscribePendingEvents((pending) => {
      setPendingEvents(pending.filter((p) => p.sessionId === sessionIdRef.current));
    });
    const unsubShot = shotAnalysisQueue.subscribeShotCompleted((fullShot) => {
      if (fullShot.sessionId !== sessionIdRef.current) return;
      setSessionShots((prev) => {
        if (prev.some((s) => s.id === fullShot.id)) return prev;
        return [...prev, fullShot].sort((a, b) => a.shotNumber - b.shotNumber);
      });
      setDetectionStatusLabel(
        fullShot.result === 'UNCERTAIN'
          ? `Tir #${fullShot.shotNumber} : IMPACT INCERTAIN`
          : `Tir #${fullShot.shotNumber} : ${fullShot.zoneName} (+${fullShot.score} pts)`,
      );
    });
    const unsubShotUpdated = shotAnalysisQueue.subscribeShotUpdated((updatedShot) => {
      if (updatedShot.sessionId !== sessionIdRef.current) return;
      setSessionShots((prev) =>
        prev.map((s) => (s.id === updatedShot.id ? updatedShot : s)),
      );
    });
    const unsubError = shotAnalysisQueue.subscribeError((err) => {
      if (err.sessionId !== sessionIdRef.current) return;
      setAnalysisErrors((prev) => [err, ...prev].slice(0, 10));
      setDetectionStatusLabel(`Erreur tir #${err.shotNumber} : ${err.message}`);
    });
    return () => {
      unsubState();
      unsubPending();
      unsubShot();
      unsubShotUpdated();
      unsubError();
    };
  }, []);

  useEffect(() => {
    if (
      fullScreenCalOpen &&
      sourceMode === 'camera' &&
      !frozenCalImage &&
      (camCaps.status === 'denied' || camCaps.status === 'error')
    ) {
      setFullScreenCalOpen(false);
    }
  }, [fullScreenCalOpen, sourceMode, frozenCalImage, camCaps.status]);

  // Load saved calibrations list from IndexedDB for instant one-tap reuse
  useEffect(() => {
    getSavedCalibrations()
      .then((list) => {
        setSavedCalibrations(list);
        if (list[0]) setSavedRecentCal(list[0]);
      })
      .catch(() => {
        getLatestSavedCalibration()
          .then((cal) => {
            if (cal) setSavedRecentCal(cal);
          })
          .catch(() => {});
      });
  }, []);

  // Initialize camera when in camera mode
  const initCamera = useCallback(async () => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    stopCameraStream(streamRef.current, videoEl);
    streamRef.current = null;
    fpsMeterRef.current.reset();

    setCamCaps((prev) => ({...prev, status: 'initializing', errorMessage: null}));
    try {
      const {stream, capabilities} = await startCameraStream(
        videoEl,
        settings.requestedFps,
        settings.preferredResolution,
        selectedDeviceId || undefined,
      );
      streamRef.current = stream;
      setCamCaps(capabilities);
      const list = await listVideoCameras();
      setCameras(list);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Impossible d’accéder à la caméra arrière.';
      setCamCaps((prev) => ({
        ...prev,
        status:
          msg.toLowerCase().includes('denied') || msg.toLowerCase().includes('permission')
            ? 'denied'
            : 'error',
        errorMessage: msg,
      }));
    }
  }, [settings.requestedFps, settings.preferredResolution, selectedDeviceId]);

  useEffect(() => {
    if (sourceMode === 'camera') {
      initCamera();
    } else {
      stopCameraStream(streamRef.current, videoRef.current);
      streamRef.current = null;
    }
    return () => {
      stopCameraStream(streamRef.current, videoRef.current);
      streamRef.current = null;
    };
  }, [sourceMode, initCamera]);

  useEffect(() => {
    return () => {
      if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
    };
  }, [videoFileUrl]);

  // Measure real video frame cadence via requestVideoFrameCallback + currentTime watchdog (never freezes on remount)
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    let isMeterActive = true;
    let rvfcHandle = 0;
    let rafWatchHandle = 0;

    const hasRvfc =
      typeof (videoEl as unknown as {requestVideoFrameCallback?: unknown})
        .requestVideoFrameCallback === 'function';

    const onVideoFrame = () => {
      if (!isMeterActive) return;
      deliveredVideoSeqRef.current++;
      fpsMeterRef.current.recordVideoFrame(performance.now());
      if (hasRvfc) {
        rvfcHandle = (
          videoEl as unknown as {
            requestVideoFrameCallback: (cb: () => void) => number;
          }
        ).requestVideoFrameCallback(onVideoFrame);
      }
    };

    let lastTime = -1;
    let lastRvfcSeqSeen = deliveredVideoSeqRef.current;
    const onRaf = () => {
      if (!isMeterActive) return;
      if (videoEl.readyState >= 2 && videoEl.currentTime !== lastTime) {
        lastTime = videoEl.currentTime;
        // Count via rAF fallback whenever rVFC didn't already count this frame
        if (!hasRvfc || deliveredVideoSeqRef.current === lastRvfcSeqSeen) {
          deliveredVideoSeqRef.current++;
          fpsMeterRef.current.recordVideoFrame(performance.now());
        }
        lastRvfcSeqSeen = deliveredVideoSeqRef.current;
      }
      rafWatchHandle = requestAnimationFrame(onRaf);
    };

    if (hasRvfc) {
      rvfcHandle = (
        videoEl as unknown as {
          requestVideoFrameCallback: (cb: () => void) => number;
        }
      ).requestVideoFrameCallback(onVideoFrame);
    }
    rafWatchHandle = requestAnimationFrame(onRaf);

    const metricsTimer = window.setInterval(() => {
      const measured = fpsMeterRef.current.getCaptureFps();
      const analysis = fpsMeterRef.current.getAnalysisFps();
      const procMs = fpsMeterRef.current.getAvgProcessingMs();
      const skippedFrames = fpsMeterRef.current.getSkippedTotal();
      const skippedFps = fpsMeterRef.current.getSkippedFps();
      const vw = videoEl.videoWidth || 0;
      const vh = videoEl.videoHeight || 0;
      const lastAge =
        lastEngineAnalysisAtMsRef.current > 0
          ? Math.round(performance.now() - lastEngineAnalysisAtMsRef.current)
          : 0;

      setDiagSnapshot({
        videoFrames: deliveredVideoSeqRef.current,
        engineFrames: engineFramesAnalyzedRef.current,
        lastAnalysisAgeMs: lastAge,
        maxRoiDelta: lastMaxRoiDeltaRef.current,
        threshold: settingsRef.current.motionSensitivity,
        reason: lastTriggerReasonRef.current,
        videoReadyState: videoEl.readyState,
      });

      setCamCaps((prev) => {
        const cameraFps = measured || prev.actualMeasuredFps;
        const nextWidth = vw || prev.width;
        const nextHeight = vh || prev.height;
        performanceStore.update({
          cameraFps,
          analysisFps: analysis,
          avgProcessingMs: procMs,
          skippedFrames,
          skippedFps,
          workerEnabled: isVisionWorkerActive(),
          bufferFrames: circularBufferRef.current.getLength(),
          activeResolution: nextWidth > 0 ? `${nextWidth}×${nextHeight}` : '—',
          videoFramesDelivered: deliveredVideoSeqRef.current,
          engineFramesAnalyzed: engineFramesAnalyzedRef.current,
          lastFrameAgeMs: lastAge,
          lastTriggerReason: lastTriggerReasonRef.current,
          lastMaxRoiDelta: lastMaxRoiDeltaRef.current,
          videoReadyState: videoEl.readyState,
          audioAssistanceActive: audioActiveRef.current,
          audioEventsCount: audioEventsCountRef.current,
        });
        return {
          ...prev,
          width: nextWidth,
          height: nextHeight,
          actualMeasuredFps: cameraFps,
          analysisFps: analysis,
          avgProcessingMs: procMs,
          skippedFrames,
          skippedFps,
          hardwareLimitExplanation: buildHardwareFpsExplanation(
            prev.requestedFps,
            cameraFps,
            prev.maxSupportedFps,
          ),
        };
      });
    }, 650);

    return () => {
      isMeterActive = false;
      window.clearInterval(metricsTimer);
      if (
        hasRvfc &&
        typeof (videoEl as unknown as {cancelVideoFrameCallback?: (h: number) => void})
          .cancelVideoFrameCallback === 'function'
      ) {
        (
          videoEl as unknown as {cancelVideoFrameCallback: (h: number) => void}
        ).cancelVideoFrameCallback(rvfcHandle);
      }
      cancelAnimationFrame(rafWatchHandle);
    };
  }, [sourceMode, videoFileUrl, stage]);

  // Capture current video frame WITH JPEG (only used on calibration photo snapshot, never in hot loop)
  const captureFrameFromVideo = useCallback((targetWidth = 480) => {
    const videoEl = videoRef.current;
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0) return null;

    const canvas = analysisCanvasRef.current || document.createElement('canvas');
    analysisCanvasRef.current = canvas;
    const maxDim = Math.max(240, targetWidth);
    const scale = Math.min(1, maxDim / Math.max(videoEl.videoWidth, videoEl.videoHeight));
    const w = Math.max(120, Math.round(videoEl.videoWidth * scale));
    const h = Math.max(120, Math.round(videoEl.videoHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) return null;

    ctx.drawImage(videoEl, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    return {imageData, dataUrl, w, h};
  }, []);

  // Ultra-fast raw ImageData capture for live monitoring (no JPEG toDataURL overhead; handles portrait & landscape equally)
  const captureFastRawFrame = useCallback((maxDim = 420) => {
    const videoEl = videoRef.current;
    if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0 || videoEl.videoHeight <= 0) {
      return null;
    }
    const canvas = analysisCanvasRef.current || document.createElement('canvas');
    analysisCanvasRef.current = canvas;
    const scale = Math.min(1, maxDim / Math.max(videoEl.videoWidth, videoEl.videoHeight));
    const w = Math.max(120, Math.round(videoEl.videoWidth * scale));
    const h = Math.max(120, Math.round(videoEl.videoHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) return null;

    ctx.drawImage(videoEl, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return {imageData, w, h};
  }, []);

  // =========================================================================
  // CALIBRATION EN PLEIN ÉCRAN (CAMÉRA ARRIÈRE DIRECTE OU IMAGE FIGÉE + ZOOM)
  // =========================================================================
  const handleOpenFullScreenCalibration = (mode: 'fresh' | 'edit_live' | 'edit_photo') => {
    const existing = officialCalibrationRef.current;
    if (mode === 'edit_live' && existing) {
      setCalPolygon(existing.polygon.map((p) => ({...p})));
      setCalCenter({...existing.center});
      setFrozenCalImage(null);
    } else if (mode === 'edit_photo' && existing && existing.referenceImageDataUrl) {
      setCalPolygon(existing.polygon.map((p) => ({...p})));
      setCalCenter({...existing.center});
      setFrozenCalImage({
        dataUrl: existing.referenceImageDataUrl,
        w: existing.referenceWidth,
        h: existing.referenceHeight,
      });
    } else {
      const freshPoly = createDiamondPresetPolygon();
      setCalPolygon(freshPoly);
      setCalCenter(computePolygonCentroid(freshPoly));
      setFrozenCalImage(null);
    }
    setFullScreenCalOpen(true);
  };

  const handleToggleFreezeInFullScreen = (freeze: boolean) => {
    if (!freeze) {
      setFrozenCalImage(null);
      return;
    }
    const videoEl = videoRef.current;
    const capWidth =
      videoEl && videoEl.videoWidth > 0
        ? Math.min(1280, Math.max(720, videoEl.videoWidth))
        : 960;
    const cap = captureFrameFromVideo(capWidth);
    if (cap) {
      setFrozenCalImage({
        imageData: cap.imageData,
        dataUrl: cap.dataUrl,
        w: cap.w,
        h: cap.h,
      });
    }
  };

  const handleLoadSavedCalibration = (calToLoad?: OfficialCalibration | null) => {
    const targetCal = calToLoad ?? savedRecentCal;
    if (!targetCal) return;
    const initialTrack = createInitialTracking(targetCal, {
      positionLocked: true,
      status: 'GREEN_LOCKED',
      message: 'Calibration enregistrée chargée — recherche automatique désactivée',
    });
    setOfficialCalibration(targetCal);
    officialCalibrationRef.current = targetCal;
    setCalPolygon(targetCal.polygon.map((p) => ({...p})));
    setCalCenter({...targetCal.center});
    setCameraPlacement(targetCal.cameraPlacement ?? 'front');
    onCalibrationValidated(targetCal);
    setTracking(initialTrack);
    trackingRef.current = initialTrack;
    setFrozenCalImage(null);
    setFullScreenCalOpen(false);
    setManualCorrectionMode(false);
    manualCorrectionModeRef.current = false;
    setStage('READY_TO_SHOOT');
  };

  // Validation définitive -> enregistre photo, points, contour, centre, zones & géométrie
  // dans IndexedDB, puis DÉSACTIVE COMPLÈTEMENT toute recherche automatique de cible.
  const handleValidateCalibration = async (
    capturedFromCalibrator?: {imageData: ImageData; dataUrl: string; w: number; h: number} | null,
  ) => {
    if (calPolygon.length < 3) return;

    const fallbackVideoCap =
      frozenCalImage || capturedFromCalibrator
        ? null
        : captureFrameFromVideo(
            videoRef.current && videoRef.current.videoWidth > 0
              ? Math.min(1280, Math.max(720, videoRef.current.videoWidth))
              : 960,
          );

    const refDataUrl =
      frozenCalImage?.dataUrl ||
      capturedFromCalibrator?.dataUrl ||
      fallbackVideoCap?.dataUrl ||
      officialCalibrationRef.current?.referenceImageDataUrl ||
      '';
    const refW =
      frozenCalImage?.w ||
      capturedFromCalibrator?.w ||
      fallbackVideoCap?.w ||
      (camCaps.width > 0 ? camCaps.width : 1280);
    const refH =
      frozenCalImage?.h ||
      capturedFromCalibrator?.h ||
      fallbackVideoCap?.h ||
      (camCaps.height > 0 ? camCaps.height : 720);

    const corners = polygonToQuadCorners(calPolygon);
    const bbox = computePolygonBoundingBox(calPolygon);
    const baseSource: TargetCalibration = {
      polygon: calPolygon.map((p) => ({...p})),
      corners,
      center: {...calCenter},
      boundingBox: bbox,
      targetGeometry: computePolygonGeometry(calPolygon, refW, refH),
      detectedCircles: [],
      referenceImageDataUrl: refDataUrl,
      referenceWidth: refW,
      referenceHeight: refH,
      referenceSignature: [],
      state: 'GREEN_VALIDATED',
      trackingStatus: 'GREEN_LOCKED',
      confidence: 1,
      sharpnessScore: 25,
      targetPixelSize: {
        w: Math.round(bbox.w * refW),
        h: Math.round(bbox.h * refH),
      },
      failureReasons: [],
      manualCorrected: true,
      attemptsCount: 1,
      analyzedAt: Date.now(),
      cameraPlacement,
    };

    const official = createOfficialCalibration({
      sourceCalibration: baseSource,
      polygon: calPolygon,
      center: calCenter,
      targetProfile: currentTarget,
      manualCorrected: true,
      cameraPlacement,
    });

    await saveSavedCalibration(official);
    setSavedRecentCal(official);
    setSavedCalibrations((prev) => [official, ...prev.filter((c) => c.id !== official.id)].slice(0, 12));
    onCalibrationValidated(official);

    const initialTrack = createInitialTracking(official, {
      positionLocked: true,
      status: 'GREEN_LOCKED',
      message: 'Calibration manuelle validée — recherche automatique désactivée',
    });

    setOfficialCalibration(official);
    officialCalibrationRef.current = official;
    setTracking(initialTrack);
    trackingRef.current = initialTrack;
    setFrozenCalImage(null);
    setFullScreenCalOpen(false);
    setManualCorrectionMode(false);
    manualCorrectionModeRef.current = false;
    setStage('READY_TO_SHOOT');
  };

  // =========================================================================
  // ACTIONS EXPLICITES UTILISATEUR : MODIFIER / REFAIRE / NOUVELLE SESSION
  // =========================================================================
  const handleToggleModifyTarget = async () => {
    const official = officialCalibrationRef.current;
    const currTrack = trackingRef.current;
    if (!official || !currTrack) return;

    if (manualCorrectionModeRef.current) {
      const calFromEdit = buildTargetCalibrationForShot(official, currTrack);
      const mod = authorizeModifyCalibration({
        sourceCalibration: calFromEdit,
        polygon: currTrack.polygon,
        center: currTrack.center,
        targetProfile: currentTarget,
        learnedModel: official.learnedModel,
        previousTracking: currTrack,
        cameraPlacement,
      });
      await saveSavedCalibration(mod.officialCalibration);
      setSavedRecentCal(mod.officialCalibration);
      onCalibrationValidated(mod.officialCalibration);
      setOfficialCalibration(mod.officialCalibration);
      officialCalibrationRef.current = mod.officialCalibration;
      setTracking(mod.tracking);
      trackingRef.current = mod.tracking;
      preEditTrackingRef.current = null;
      setManualCorrectionMode(false);
      manualCorrectionModeRef.current = false;
    } else {
      preEditTrackingRef.current = {
        ...currTrack,
        polygon: currTrack.polygon.map((p) => ({...p})),
        corners: currTrack.corners.map((c) => ({...c})) as [Point2D, Point2D, Point2D, Point2D],
        center: {...currTrack.center},
        boundingBox: {...currTrack.boundingBox},
      };
      setManualCorrectionMode(true);
      manualCorrectionModeRef.current = true;
    }
  };

  const handleCancelModifyTarget = () => {
    if (preEditTrackingRef.current) {
      setTracking(preEditTrackingRef.current);
      trackingRef.current = preEditTrackingRef.current;
    }
    preEditTrackingRef.current = null;
    setManualCorrectionMode(false);
    manualCorrectionModeRef.current = false;
  };

  const handleRedoCalibration = () => {
    const reset = authorizeRedoCalibration();
    onCalibrationCleared();
    setOfficialCalibration(reset.officialCalibration);
    officialCalibrationRef.current = null;
    setTracking(reset.tracking);
    trackingRef.current = null;
    const freshPoly = createDiamondPresetPolygon();
    setCalPolygon(freshPoly);
    setCalCenter(computePolygonCentroid(freshPoly));
    setFrozenCalImage(null);
    setManualCorrectionMode(false);
    manualCorrectionModeRef.current = false;
    preEditTrackingRef.current = null;
    setStage('CALIBRATE_PHOTO');
    setFullScreenCalOpen(true);
  };

  const handleStartNewSession = () => {
    const reset = authorizeNewSession();
    onCalibrationCleared();
    setSessionId(`sess-${Date.now()}`);
    nextShotNumberRef.current = 1;
    activeCaptureWindowsRef.current = [];
    lastTriggerTimeRef.current = 0;
    wasQuietSinceLastTriggerRef.current = true;
    quietFrameStreakRef.current = 2;
    setSessionShots([]);
    sessionShotsRef.current = [];
    setAnalysisErrors([]);
    setCompletedSessionSnapshot(null);
    setReplayShot(null);
    setOfficialCalibration(reset.officialCalibration);
    officialCalibrationRef.current = null;
    setTracking(reset.tracking);
    trackingRef.current = null;
    const freshPoly = createDiamondPresetPolygon();
    setCalPolygon(freshPoly);
    setCalCenter(computePolygonCentroid(freshPoly));
    setFrozenCalImage(null);
    setManualCorrectionMode(false);
    manualCorrectionModeRef.current = false;
    preEditTrackingRef.current = null;
    setLiveBlobs([]);
    setDetectionStatusLabel('En attente');
    setStage('CALIBRATE_PHOTO');
    setFullScreenCalOpen(true);
  };

  const handleSelectVideoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
    const url = URL.createObjectURL(file);
    setVideoFileUrl(url);
    setVideoFileName(file.name);
    setSourceMode('video_file');
    setCamCaps((prev) => ({
      ...prev,
      status: 'video_file',
      deviceLabel: `Vidéo : ${file.name}`,
      errorMessage: null,
    }));
  };

  const captureFastRawFrameRef = useRef(captureFastRawFrame);
  captureFastRawFrameRef.current = captureFastRawFrame;

  const flushOpenCaptureWindows = useCallback((reason: string) => {
    const pendingList = activeCaptureWindowsRef.current;
    if (pendingList.length === 0) return;
    activeCaptureWindowsRef.current = [];

    for (const win of pendingList) {
      const combined = [...win.preFrames, ...win.postFrames];
      if (combined.length >= 4) {
        shotAnalysisQueue.enqueue({
          shotId: win.shotId,
          sessionId: win.sessionId,
          shotNumber: win.shotNumber,
          frames: combined,
          triggerIndex: win.preFrames.length,
          calibration: win.calibration,
          targetProfile: win.targetProfile,
          sensitivity: win.sensitivity,
          passes: win.passes,
          captureFps: win.captureFps,
          interruptedCaptureReason: reason,
        });
      } else {
        shotAnalysisQueue.recordDroppedCapture({
          shotId: win.shotId,
          sessionId: win.sessionId,
          shotNumber: win.shotNumber,
          capturedCount: combined.length,
          reason,
        });
      }
    }
  }, []);

  // =========================================================================
  // SURVEILLANCE ACTIVE HAUTE FRÉQUENCE (>= 15–20 FPS RÉELS) + ASSISTANCE AUDIO FACULTATIVE
  // - 320px plus grand côté + extraction mono-passe + détection hybride luminance/couleur.
  // - Mémoïsation calibration/profil hors boucle rAF pour zéro allocation parasite.
  // - Ne bloque jamais sur requestVideoFrameCallback seul (double garde currentTime / horloge caméra).
  // - Aucune annulation lorsqu'un nouveau tir survient.
  // =========================================================================
  useEffect(() => {
    if (stage !== 'ACTIVE_MONITORING') {
      audioDetectorRef.current.stop();
      audioActiveRef.current = false;
      setAudioStatus(settingsRef.current.audioAssistanceEnabled ? 'off' : 'off');
      return;
    }

    let loopActive = true;
    let rafId = 0;
    const audioPendingTimers: number[] = [];

    motionDetectorRef.current.reset();
    lastAnalyzedVideoSeqRef.current = 0;
    lastAnalyzedVideoTimeRef.current = -1;
    engineFramesAnalyzedRef.current = 0;
    lastEngineAnalysisAtMsRef.current = performance.now();
    lastTriggerTimeRef.current = 0;
    wasQuietSinceLastTriggerRef.current = true;
    quietFrameStreakRef.current = 2;
    lastTriggerReasonRef.current = 'Surveillance initialisée — en attente d’images';

    const initFps = Math.max(15, Math.min(30, Math.round(measuredFpsRef.current || 25)));
    circularBufferRef.current.setMaxFrames(
      Math.min(
        96,
        Math.round((settingsRef.current.preEventSeconds + settingsRef.current.postEventSeconds) * initFps),
      ),
    );

    // Ensure video playback is active when entering ACTIVE_MONITORING
    const startVideoEl = videoRef.current;
    if (startVideoEl && startVideoEl.paused) {
      startVideoEl.play().catch(() => {});
    }

    // Optional experimental microphone assistance (never blocks or triggers without video evidence)
    if (settingsRef.current.audioAssistanceEnabled) {
      setAudioStatus('starting');
      setAudioMessage('Demande d’accès au microphone (corrélation locale d’impact uniquement)…');
      void audioDetectorRef.current
        .start((audioEv) => {
          if (!loopActive) return;
          audioEventsCountRef.current++;
          setAudioEventsCount(audioEventsCountRef.current);
          audioEventsRef.current = [...audioEventsRef.current.slice(-15), audioEv];

          // 1) Corroborate an already-active capture window within ±350 ms
          const nearWin = activeCaptureWindowsRef.current.find(
            (w) => Math.abs(audioEv.timestampMs - w.triggeredAtMs) <= 380,
          );
          if (nearWin) {
            nearWin.audioCorroborated = true;
            nearWin.audioEventTimestampMs = audioEv.timestampMs;
            return;
          }

          // 2) If no video trigger fired yet around this snap, inspect video buffer after 180ms post-impact
          if (audioEv.timestampMs - lastTriggerTimeRef.current <= 420) return;

          const timerId = window.setTimeout(() => {
            if (!loopActive) return;
            if (Math.abs(audioEv.timestampMs - lastTriggerTimeRef.current) <= 450) return;
            const official = officialCalibrationRef.current;
            const currTrack = trackingRef.current;
            if (!official || !currTrack) return;

            const recent = circularBufferRef.current.snapshotPreEvent(48);
            const liveShotCal = buildTargetCalibrationForShot(official, currTrack);
            const corr = correlateAudioEventWithVideoBuffer({
              audioTimestampMs: audioEv.timestampMs,
              recentFrames: recent,
              calibration: liveShotCal,
              baseSensitivity: settingsRef.current.motionSensitivity,
              minMotionAreaRatio: settingsRef.current.minMotionAreaRatio,
            });

            if (corr.hasVisualEvidence && corr.triggerIndex >= 1) {
              const preStart = Math.max(0, corr.triggerIndex - 8);
              const slice = recent.slice(preStart);
              if (slice.length >= 4) {
                const shotNumber = nextShotNumberRef.current++;
                const sid = sessionIdRef.current;
                const shotId = `shot-${sid}-${shotNumber}-${Date.now()}`;
                lastTriggerTimeRef.current = audioEv.timestampMs;
                lastTriggerReasonRef.current = `Récupération audio+vidéo (delta ${corr.peakDelta})`;

                shotAnalysisQueue.enqueue({
                  shotId,
                  sessionId: sid,
                  shotNumber,
                  frames: slice,
                  triggerIndex: corr.triggerIndex - preStart,
                  calibration: liveShotCal,
                  targetProfile: buildFrozenTargetProfile(official, currentTargetRef.current),
                  sensitivity: Math.max(11, Math.round(settingsRef.current.motionSensitivity * 0.75)),
                  passes: settingsRef.current.autoReanalyzePasses,
                  captureFps: Math.max(10, fpsMeterRef.current.getAnalysisFps() || 15),
                  audioCorroborated: true,
                  audioEventTimestampMs: audioEv.timestampMs,
                  audioRecoveryNote:
                    'Événement vidéo récupéré grâce à la corrélation avec un pic sonore d’impact.',
                });
              }
            }
          }, 180);
          audioPendingTimers.push(timerId);
        })
        .then((res) => {
          if (!loopActive) {
            audioDetectorRef.current.stop();
            return;
          }
          audioActiveRef.current = res.status === 'active';
          setAudioStatus(res.status);
          setAudioMessage(res.message);
        });
    } else {
      audioDetectorRef.current.stop();
      audioActiveRef.current = false;
      setAudioStatus('off');
      setAudioMessage('Assistance audio désactivée (mode vidéo pure).');
    }

    // Memoize calibration + target profile across frames; recompute only if reference changes
    let cachedOfficialRef: OfficialCalibration | null = null;
    let cachedTrackingRef: LiveTargetTracking | null = null;
    let cachedTargetProfileRef: TargetProfile | null = null;
    let memoShotCal: TargetCalibration | null = null;
    let memoFrozenProfile: TargetProfile | null = null;

    const loop = () => {
      if (!loopActive) return;
      const videoEl = videoRef.current;
      const official = officialCalibrationRef.current;
      const currTrack = trackingRef.current;

      if (!videoEl || videoEl.readyState < 2) {
        lastTriggerReasonRef.current = !videoEl
          ? 'Élément vidéo absent'
          : `Caméra en attente (readyState=${videoEl.readyState})`;
        rafId = requestAnimationFrame(loop);
        return;
      }

      if ((videoEl.paused || videoEl.ended) && activeCaptureWindowsRef.current.length > 0) {
        flushOpenCaptureWindows(
          videoEl.ended
            ? 'Fin de la vidéo atteinte avant la fin de fenêtre post-impact'
            : 'Flux vidéo mis en pause avant la fin de fenêtre post-impact',
        );
      }

      if (!official || !currTrack) {
        lastTriggerReasonRef.current = 'Calibration cible manquante';
        rafId = requestAnimationFrame(loop);
        return;
      }
      if (manualCorrectionModeRef.current) {
        lastTriggerReasonRef.current = 'Édition manuelle de la cible en cours';
        rafId = requestAnimationFrame(loop);
        return;
      }
      if (videoEl.paused) {
        lastTriggerReasonRef.current = 'Vidéo en pause';
        rafId = requestAnimationFrame(loop);
        return;
      }

      const nowMs = performance.now();
      const currentSeq = deliveredVideoSeqRef.current;
      const vidTime = videoEl.currentTime;
      const hasNewSeq = currentSeq > lastAnalyzedVideoSeqRef.current;
      const hasNewTime = vidTime !== lastAnalyzedVideoTimeRef.current;
      // Camera watchdog: if live stream is playing and rVFC/currentTime didn't advance in >=33ms, still sample!
      const cameraHeartbeatDue =
        sourceMode === 'camera' && nowMs - lastEngineAnalysisAtMsRef.current >= 33;

      if (hasNewSeq || hasNewTime || lastAnalyzedVideoSeqRef.current === 0 || cameraHeartbeatDue) {
        const missedSinceLast = hasNewSeq
          ? Math.max(0, currentSeq - lastAnalyzedVideoSeqRef.current - 1)
          : 0;
        for (let k = 0; k < Math.min(8, missedSinceLast); k++) {
          fpsMeterRef.current.recordSkippedFrame(nowMs);
        }
        lastAnalyzedVideoSeqRef.current = currentSeq;
        lastAnalyzedVideoTimeRef.current = vidTime;

        if (
          cachedOfficialRef !== official ||
          cachedTrackingRef !== currTrack ||
          !memoShotCal
        ) {
          cachedOfficialRef = official;
          cachedTrackingRef = currTrack;
          memoShotCal = buildTargetCalibrationForShot(official, currTrack);
        }
        if (
          cachedOfficialRef !== official ||
          cachedTargetProfileRef !== currentTargetRef.current ||
          !memoFrozenProfile
        ) {
          cachedTargetProfileRef = currentTargetRef.current;
          memoFrozenProfile = buildFrozenTargetProfile(official, currentTargetRef.current);
        }

        const cap = captureFastRawFrameRef.current(320);
        if (cap) {
          const activeSettings = settingsRef.current;
          const {gray, rgb} = extractGrayAndRgb(cap.imageData);
          const step = motionDetectorRef.current.processFrame(
            gray,
            cap.w,
            cap.h,
            memoShotCal,
            activeSettings.motionSensitivity,
            activeSettings.minMotionAreaRatio,
            cap.imageData.data,
          );

          const postProcMs = performance.now();
          fpsMeterRef.current.recordAnalysisFrame(step.processingMs, postProcMs);
          engineFramesAnalyzedRef.current++;
          lastEngineAnalysisAtMsRef.current = postProcMs;
          lastMaxRoiDeltaRef.current = step.maxPixelDelta;

          const entry: RingFrameEntry = {
            timestampMs: postProcMs,
            gray,
            rgb,
            width: cap.w,
            height: cap.h,
            dataUrl: '',
          };
          circularBufferRef.current.push(entry);

          // Feed every open capture window concurrently so rapid back-to-back shots never overwrite each other
          const stillCollecting: PendingEventCapture[] = [];
          for (const win of activeCaptureWindowsRef.current) {
            win.postFrames.push(entry);
            shotAnalysisQueue.updateCaptureProgress(win.shotId, win.postFrames.length);
            if (win.postFrames.length >= win.targetPostCount) {
              const combined = [...win.preFrames, ...win.postFrames];
              shotAnalysisQueue.enqueue({
                shotId: win.shotId,
                sessionId: win.sessionId,
                shotNumber: win.shotNumber,
                frames: combined,
                triggerIndex: win.preFrames.length,
                calibration: win.calibration,
                targetProfile: win.targetProfile,
                sensitivity: win.sensitivity,
                passes: win.passes,
                captureFps: win.captureFps,
                audioCorroborated: win.audioCorroborated,
                audioEventTimestampMs: win.audioEventTimestampMs,
              });
            } else {
              stillCollecting.push(win);
            }
          }
          activeCaptureWindowsRef.current = stillCollecting;

          // Rearm only after two consecutive frames without a localized target candidate.
          // The former frameDelta/ROI-energy shortcuts often declared "quiet" during
          // background movement, which let one disturbance increment the shot counter repeatedly.
          const elapsedSinceLast = postProcMs - lastTriggerTimeRef.current;
          if (!step.hasSignificantMotion && !step.globalShakeDetected) {
            quietFrameStreakRef.current = Math.min(quietFrameStreakRef.current + 1, 3);
            if (quietFrameStreakRef.current >= 2) {
              wasQuietSinceLastTriggerRef.current = true;
            }
          } else {
            quietFrameStreakRef.current = 0;
          }

          const canTriggerShot =
            step.hasSignificantMotion &&
            !step.globalShakeDetected &&
            elapsedSinceLast > 280 &&
            wasQuietSinceLastTriggerRef.current;

          if (step.globalShakeDetected) {
            lastTriggerReasonRef.current = 'Mouvement global caméra ignoré';
          } else if (canTriggerShot) {
            lastTriggerReasonRef.current = `Candidat localisé sur la cible (delta=${step.maxPixelDelta}, blobs=${step.blobs.length})`;
          } else if (step.hasSignificantMotion) {
            lastTriggerReasonRef.current = `Mouvement sur cible filtré (délai=${Math.round(elapsedSinceLast)}ms, réarmement après 2 images calmes)`;
          } else {
            lastTriggerReasonRef.current = `Aucun candidat localisé sur la cible (delta max ${step.maxPixelDelta} / seuil ${activeSettings.motionSensitivity})`;
          }

          let nextStatusText = 'Surveillance continue active (calibration figée)';

          // Open a new independent capture window on impact without cancelling any open window
          if (canTriggerShot) {
            lastTriggerTimeRef.current = postProcMs;
            wasQuietSinceLastTriggerRef.current = false;
            quietFrameStreakRef.current = 0;

            // Check if an audio snap occurred within the last 250ms before this visual trigger
            const matchingAudio = audioEventsRef.current.find(
              (a) => Math.abs(postProcMs - a.timestampMs) <= 280,
            );

            const liveFps = Math.max(
              8,
              fpsMeterRef.current.getAnalysisFps() ||
                fpsMeterRef.current.getCaptureFps() ||
                measuredFpsRef.current ||
                15,
            );
            const preCount = Math.max(5, Math.round(Math.min(1.4, activeSettings.preEventSeconds) * liveFps));
            const postCount = Math.max(5, Math.round(Math.min(1.0, activeSettings.postEventSeconds) * liveFps));
            const shotNumber = nextShotNumberRef.current++;
            const sid = sessionIdRef.current;
            const shotId = `shot-${sid}-${shotNumber}-${Date.now()}`;

            const newWin: PendingEventCapture = {
              shotId,
              shotNumber,
              sessionId: sid,
              preFrames: circularBufferRef.current.snapshotPreEvent(preCount),
              postFrames: [],
              targetPostCount: postCount,
              triggeredAtMs: postProcMs,
              calibration: memoShotCal,
              targetProfile: memoFrozenProfile,
              captureFps: liveFps,
              sensitivity: activeSettings.motionSensitivity,
              passes: activeSettings.autoReanalyzePasses,
              audioCorroborated: Boolean(matchingAudio),
              audioEventTimestampMs: matchingAudio?.timestampMs,
            };
            activeCaptureWindowsRef.current.push(newWin);
            shotAnalysisQueue.registerCaptureStarted({
              shotId,
              shotNumber,
              sessionId: sid,
              targetPostCount: postCount,
            });
            void shotAnalysisQueue.recordDiagnostic({
              shotId,
              sessionId: sid,
              shotNumber,
              status: 'STARTED',
              stage: 'CAPTURE',
              message: `Déclenchement capture tir #${shotNumber} (pré: ${newWin.preFrames.length} img, cible post: ${postCount} img${matchingAudio ? ', audio corrélé' : ''})`,
            });
            nextStatusText = `Tir #${shotNumber} détecté — capture post-impact (${activeCaptureWindowsRef.current.length} active(s))`;
            lastUiSyncMsRef.current = 0; // force immediate UI feedback on trigger
          } else if (activeCaptureWindowsRef.current.length > 0) {
            nextStatusText = `Capture post-impact en cours (${activeCaptureWindowsRef.current.length} événement(s))…`;
          } else if (step.globalShakeDetected) {
            nextStatusText = 'Mouvement caméra ignoré (calibration intacte)';
          }

          // Throttle React overlay/label re-renders (~8 Hz max) so monitoring loop keeps full hardware FPS
          if (postProcMs - lastUiSyncMsRef.current >= 120) {
            lastUiSyncMsRef.current = postProcMs;
            setLiveBlobs(step.blobs);
            if (nextStatusText !== lastStatusTextRef.current) {
              lastStatusTextRef.current = nextStatusText;
              setDetectionStatusLabel(nextStatusText);
            }
          }
        }
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => {
      loopActive = false;
      cancelAnimationFrame(rafId);
      audioPendingTimers.forEach((id) => window.clearTimeout(id));
      audioDetectorRef.current.stop();
      audioActiveRef.current = false;
      flushOpenCaptureWindows(
        'Arrêt de la surveillance ou fermeture du composant avant la fin de fenêtre post-impact',
      );
    };
  }, [stage, sourceMode, flushOpenCaptureWindows]);

  const handleStartMonitoring = async () => {
    if (manualCorrectionModeRef.current) {
      await handleToggleModifyTarget();
    }
    if (!officialCalibrationRef.current) return;

    if (sourceMode === 'video_file' && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
    setDetectionStatusLabel('Surveillance continue active (calibration figée)');
    setStage('ACTIVE_MONITORING');
  };

  const handleEndSession = async () => {
    const official = officialCalibrationRef.current;
    const currTrack = trackingRef.current;
    if (!official || !currTrack || endingSession) return;

    setEndingSession(true);
    try {
      flushOpenCaptureWindows('Fin de session demandée par l’utilisateur');
      setDetectionStatusLabel('Finalisation des analyses en file d’attente…');
      await shotAnalysisQueue.waitForSessionDrain(sessionIdRef.current);

      const calSnapshot = buildTargetCalibrationForShot(official, currTrack);
      const summary = computeSessionSummary(sessionShotsRef.current);
      const session: ShootingSession = {
        id: sessionIdRef.current,
        title: sessionTitle.trim() || 'Session Nerf',
        createdAt: Date.now(),
        endedAt: Date.now(),
        distanceMeters,
        targetProfileId: official.targetProfileId,
        targetProfileName: official.targetProfileName,
        calibration: calSnapshot,
        sourceType: sourceMode,
        videoFileName: sourceMode === 'video_file' ? videoFileName : undefined,
        cameraMetrics: {
          requestedFps: camCaps.requestedFps,
          actualMeasuredFps: camCaps.actualMeasuredFps,
          analysisFps: camCaps.analysisFps,
          resolution: `${camCaps.width}x${camCaps.height}`,
        },
        summary,
      };
      await saveSession(session);
      setCompletedSessionSnapshot(session);
      await onSessionSaved();
      setStage('COMPLETED');
    } finally {
      setEndingSession(false);
    }
  };

  const handleUpdateCompletedShot = async (updatedShot: ShotEvent) => {
    await saveShot(updatedShot);
    const nextShots = sessionShotsRef.current.map((s) =>
      s.id === updatedShot.id ? updatedShot : s,
    );
    setSessionShots(nextShots);
    sessionShotsRef.current = nextShots;
    setReplayShot(updatedShot);

    if (completedSessionSnapshot) {
      const updatedSession: ShootingSession = {
        ...completedSessionSnapshot,
        summary: computeSessionSummary(nextShots),
      };
      await saveSession(updatedSession);
      setCompletedSessionSnapshot(updatedSession);
    }
    await onSessionSaved();
  };

  const liveSummary = computeSessionSummary(sessionShots);
  const draftGeometry = computePolygonGeometry(
    calPolygon,
    frozenCalImage?.w || (camCaps.width > 0 ? camCaps.width : 1280),
    frozenCalImage?.h || (camCaps.height > 0 ? camCaps.height : 720),
  );

  return (
    <div className="space-y-6">
      {/* Full-Screen Live Camera Calibration Workspace (~100% of tablet/mobile viewport) */}
      {fullScreenCalOpen && (
        <ManualPolygonCalibrator
          fullScreen
          liveStream={sourceMode === 'camera' ? streamRef.current : null}
          liveVideoUrl={sourceMode === 'video_file' ? videoFileUrl : null}
          frozenImageDataUrl={frozenCalImage?.dataUrl ?? null}
          imageWidth={frozenCalImage?.w || (camCaps.width > 0 ? camCaps.width : 1280)}
          imageHeight={frozenCalImage?.h || (camCaps.height > 0 ? camCaps.height : 720)}
          polygon={calPolygon}
          center={calCenter}
          targetProfile={currentTarget}
          cameraPlacement={cameraPlacement}
          onCameraPlacementChange={setCameraPlacement}
          savedCalibrations={savedCalibrations}
          onSelectSavedCalibration={(cal) => {
            setCalPolygon(cal.polygon.map((p) => ({...p})));
            setCalCenter({...cal.center});
            if (cal.cameraPlacement) setCameraPlacement(cal.cameraPlacement);
          }}
          onChange={(nextPoly, nextCenter) => {
            setCalPolygon(nextPoly);
            setCalCenter(nextCenter);
          }}
          onCaptureFreezeToggle={handleToggleFreezeInFullScreen}
          onValidate={(captured) => {
            void handleValidateCalibration(captured);
          }}
          onCancel={() => {
            setFullScreenCalOpen(false);
            setFrozenCalImage(null);
          }}
        />
      )}

      {/* Header & source switch */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F8FAFC]">
            Nouvelle session
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {stage === 'CALIBRATE_PHOTO' &&
              'Étape 1 · Calibration en plein écran sur la caméra arrière directe (zoom et points libres)'}
            {stage === 'READY_TO_SHOOT' &&
              'Calibration validée et verrouillée · Recherche automatique désactivée'}
            {stage === 'ACTIVE_MONITORING' &&
              'Session active · Surveillance des tirs sur la calibration enregistrée'}
            {stage === 'COMPLETED' && 'Bilan final · Session enregistrée dans IndexedDB'}
          </p>
        </div>

        {stage !== 'ACTIVE_MONITORING' && stage !== 'COMPLETED' && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-[#0E1525] p-1">
              <button
                type="button"
                onClick={() => setSourceMode('camera')}
                className={`min-h-[38px] rounded-lg px-3 text-xs font-medium transition-colors ${
                  sourceMode === 'camera'
                    ? 'bg-[#4F7CFF] text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Caméra arrière
              </button>
              <label className="flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium text-slate-300 hover:bg-slate-800/60">
                <Upload className="h-3.5 w-3.5 text-[#38BDF8]" />
                <span>Vidéo test</span>
                <input
                  type="file"
                  accept="video/*"
                  onChange={handleSelectVideoFile}
                  className="hidden"
                />
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Camera error banner */}
      {sourceMode === 'camera' && camCaps.errorMessage && (
        <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-xs text-red-200 space-y-2">
          <div className="flex items-center gap-2 font-semibold text-red-300">
            <AlertTriangle className="h-4 w-4" />
            <span>Erreur d’accès caméra : {camCaps.errorMessage}</span>
          </div>
          <p className="text-slate-300">
            Vérifiez les permissions caméra du navigateur ou chargez une vidéo réelle via « Vidéo test ».
          </p>
          <button
            type="button"
            onClick={initCamera}
            className="min-h-[40px] rounded-lg border border-red-400/50 bg-red-500/20 px-4 font-semibold text-white"
          >
            Réessayer la caméra
          </button>
        </div>
      )}

      {stage !== 'COMPLETED' ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left: Live Camera Viewport */}
          <div className="space-y-4 lg:col-span-8">
            <div className="flex w-full justify-center overflow-hidden rounded-2xl border border-slate-800 bg-[#070B14]">
              <div
                style={{
                  aspectRatio:
                    camCaps.width > 0 && camCaps.height > 0
                      ? `${camCaps.width} / ${camCaps.height}`
                      : '16 / 9',
                  maxWidth:
                    camCaps.width > 0 && camCaps.height > 0 && camCaps.width < camCaps.height
                      ? 'min(100%, 430px)'
                      : '100%',
                }}
                className="relative w-full overflow-hidden bg-black"
              >
                <video
                  ref={videoRef}
                  src={sourceMode === 'video_file' ? videoFileUrl ?? undefined : undefined}
                  onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth > 0 && v.videoHeight > 0) {
                      setCamCaps((prev) => ({
                        ...prev,
                        width: v.videoWidth,
                        height: v.videoHeight,
                      }));
                    }
                  }}
                  onResize={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth > 0 && v.videoHeight > 0) {
                      setCamCaps((prev) => ({
                        ...prev,
                        width: v.videoWidth,
                        height: v.videoHeight,
                      }));
                    }
                  }}
                  controls={
                    sourceMode === 'video_file' &&
                    (stage === 'CALIBRATE_PHOTO' || stage === 'READY_TO_SHOOT')
                  }
                  loop={sourceMode === 'video_file'}
                  playsInline
                  muted
                  className="h-full w-full object-fill"
                />

              {effectiveCalibration && (
                <TargetCalibrationOverlay
                  calibration={effectiveCalibration}
                  targetProfile={effectiveProfile}
                  scoringZonesOverride={officialCalibration?.scoringZones}
                  aspectRatioOverride={officialCalibration?.aspectRatio}
                  editable={manualCorrectionMode}
                  onChangePolygon={(poly, center) => {
                    if (trackingRef.current) {
                      const nextTrack = updateTrackingManualPose(
                        trackingRef.current,
                        poly,
                        center,
                      );
                      setTracking(nextTrack);
                      trackingRef.current = nextTrack;
                    }
                  }}
                />
              )}

              {/* Live Motion Blobs Overlay during Active Monitoring */}
              {stage === 'ACTIVE_MONITORING' && liveBlobs.length > 0 && (
                <svg
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  {liveBlobs.slice(0, 3).map((b, i) => (
                    <rect
                      key={i}
                      x={b.minX * 100}
                      y={b.minY * 100}
                      width={(b.maxX - b.minX) * 100}
                      height={(b.maxY - b.minY) * 100}
                      fill="none"
                      stroke="#F59E0B"
                      strokeWidth="0.45"
                    />
                  ))}
                </svg>
              )}

              {/* Status Bar showing Auto-Search is OFF and Calibration is Locked */}
              {(stage === 'READY_TO_SHOOT' || stage === 'ACTIVE_MONITORING') &&
                officialCalibration && (
                  <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-[#070B14]/85 px-3.5 py-2 text-xs font-semibold text-emerald-300 backdrop-blur-md">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      <span>
                        Calibration figée · Recherche auto désactivée
                      </span>
                    </div>

                    <div className="rounded-xl border border-slate-700/80 bg-[#070B14]/85 px-3 py-1.5 font-mono text-[11px] tabular-nums text-slate-300 backdrop-blur-md">
                      {officialCalibration.targetGeometry.shapeLabel}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Real-time honest telemetry bar during active monitoring */}
            {stage === 'ACTIVE_MONITORING' && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Tirs détectés</p>
                  <p className="font-mono text-xl font-bold tabular-nums text-[#F8FAFC]">
                    {liveSummary.totalShots}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Réussites</p>
                  <p className="font-mono text-xl font-bold tabular-nums text-emerald-400">
                    {liveSummary.hits}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Ratés</p>
                  <p className="font-mono text-xl font-bold tabular-nums text-red-400">
                    {liveSummary.misses}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Score provisoire</p>
                  <p className="font-mono text-xl font-bold tabular-nums text-[#38BDF8]">
                    {liveSummary.confirmedScore}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">FPS caméra</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#F8FAFC]">
                    {camCaps.actualMeasuredFps}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">FPS analysés</p>
                  <p
                    className={`font-mono text-lg font-bold tabular-nums ${
                      camCaps.analysisFps >= 15
                        ? 'text-emerald-400'
                        : camCaps.analysisFps >= 10
                          ? 'text-[#38BDF8]'
                          : 'text-amber-400'
                    }`}
                  >
                    {camCaps.analysisFps}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Délai calcul</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#F8FAFC]">
                    {camCaps.avgProcessingMs} ms
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-3">
                  <p className="text-[11px] text-slate-400">Images ignorées</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-slate-300">
                    {camCaps.skippedFrames ?? 0}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Right Sidebar: Calibration Controls / Session Monitoring */}
          <div className="space-y-4 lg:col-span-4">
            {/* ÉTAPE 1 : LANCEMENT CALIBRATION PLEIN ÉCRAN */}
            {stage === 'CALIBRATE_PHOTO' && (
              <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
                    Calibration manuelle
                  </h2>
                  <span className="text-xs font-medium text-[#38BDF8]">
                    {calPolygon.length} points prêts
                  </span>
                </div>

                {/* Target profile selector + editor */}
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-400">
                    Barème de zones
                  </label>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedTargetId}
                      onChange={(e) => setSelectedTargetId(e.target.value)}
                      className="min-h-[44px] flex-1 rounded-xl border border-slate-700 bg-[#070B14] px-3 text-xs font-medium text-[#F8FAFC]"
                    >
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => setEditingTarget(currentTarget)}
                      aria-label="Personnaliser les zones de la cible"
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-slate-700 bg-[#070B14] text-slate-300 hover:border-[#38BDF8] hover:text-white"
                    >
                      <Sliders className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {cameras.length > 1 && sourceMode === 'camera' && (
                  <select
                    value={selectedDeviceId}
                    onChange={(e) => setSelectedDeviceId(e.target.value)}
                    aria-label="Choisir caméra"
                    className="min-h-[42px] w-full rounded-xl border border-slate-700 bg-[#070B14] px-3 text-xs text-slate-200"
                  >
                    <option value="">Caméra arrière par défaut</option>
                    {cameras.map((c, idx) => (
                      <option key={c.deviceId} value={c.deviceId}>
                        {c.label || `Caméra ${idx + 1}`}
                      </option>
                    ))}
                  </select>
                )}

                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3 text-xs space-y-1">
                  <p className="font-semibold text-[#38BDF8]">{draftGeometry.shapeLabel}</p>
                  <p className="text-[11px] text-slate-400">
                    Ouvrez la vue plein écran : la caméra arrière reste visible en direct à 100 %, avec zoom à 2 doigts et placement précis des sommets.
                  </p>
                </div>

                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => handleOpenFullScreenCalibration('fresh')}
                    className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#4F7CFF] px-5 text-sm font-semibold text-white hover:bg-[#3E6AE8]"
                  >
                    <Camera className="h-4 w-4" />
                    Ouvrir calibration plein écran
                  </button>

                  {savedCalibrations.length > 0 && (
                    <div className="space-y-1.5">
                      <button
                        type="button"
                        onClick={() => handleLoadSavedCalibration(savedCalibrations[0])}
                        className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-slate-700 bg-[#070B14] px-4 text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
                      >
                        <History className="h-4 w-4 text-[#38BDF8]" />
                        Charger la dernière calibration
                      </button>
                      {savedCalibrations.length > 1 && (
                        <select
                          defaultValue=""
                          onChange={(e) => {
                            const found = savedCalibrations.find((c) => c.id === e.target.value);
                            if (found) handleLoadSavedCalibration(found);
                            e.target.value = '';
                          }}
                          aria-label="Choisir une autre calibration enregistrée"
                          className="min-h-[40px] w-full rounded-xl border border-slate-800 bg-[#070B14] px-3 text-xs text-slate-300"
                        >
                          <option value="">Ou choisir parmi {savedCalibrations.length} calibrations…</option>
                          {savedCalibrations.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.targetGeometry.shapeLabel} · {c.targetProfileName} (
                              {new Date(c.validatedAt).toLocaleDateString('fr-FR')})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ÉTAPE 2 : CALIBRATION VERROUILLÉE & DÉMARRAGE SESSION */}
            {stage === 'READY_TO_SHOOT' && officialCalibration && (
              <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
                    Calibration enregistrée
                  </h2>
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
                    <ShieldCheck className="h-4 w-4" />
                    Figée
                  </span>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3 text-xs space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-emerald-400">Recherche auto</span>
                    <span className="font-mono text-[11px] text-emerald-300">DÉSACTIVÉE</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-800/80 pt-1.5">
                    <span className="text-slate-400">Géométrie</span>
                    <span className="font-mono text-[11px] text-slate-200">
                      {officialCalibration.targetGeometry.shapeLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Zones actives</span>
                    <span className="font-mono text-[11px] text-slate-200">
                      {officialCalibration.scoringZones.length} zones
                    </span>
                  </div>
                </div>

                <p className="text-xs leading-relaxed text-slate-300">
                  Aucune recherche automatique ne modifiera cette cible, même si vous déplacez le téléphone. La calibration reste active toute la session.
                </p>

                <div className="space-y-3 border-t border-slate-800 pt-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-400">
                      Titre de la session
                    </label>
                    <input
                      type="text"
                      value={sessionTitle}
                      onChange={(e) => setSessionTitle(e.target.value)}
                      className="mt-1 w-full rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2 text-xs text-[#F8FAFC]"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs text-slate-300">
                      <span>Distance de tir</span>
                      <span className="font-mono font-bold tabular-nums text-[#38BDF8]">
                        {distanceMeters} m
                      </span>
                    </div>
                    <input
                      type="range"
                      min={3}
                      max={10}
                      step={0.5}
                      value={distanceMeters}
                      onChange={(e) => setDistanceMeters(parseFloat(e.target.value))}
                      className="mt-1.5 w-full accent-[#4F7CFF]"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleStartMonitoring}
                    className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-[#4F7CFF] px-5 text-sm font-semibold text-white hover:bg-[#3E6AE8]"
                  >
                    <Video className="h-4 w-4" />
                    DÉMARRER LA SESSION
                  </button>

                  <div className="grid grid-cols-1 gap-2">
                    <button
                      type="button"
                      onClick={handleToggleModifyTarget}
                      className={`flex min-h-[44px] items-center justify-center gap-2 rounded-xl border px-4 text-xs font-semibold ${
                        manualCorrectionMode
                          ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#38BDF8]'
                          : 'border-slate-700 bg-[#070B14] text-slate-200 hover:border-[#38BDF8]'
                      }`}
                    >
                      <Crosshair className="h-4 w-4" />
                      {manualCorrectionMode ? 'Valider la modification' : 'Modifier la cible'}
                    </button>

                    {manualCorrectionMode && (
                      <button
                        type="button"
                        onClick={handleCancelModifyTarget}
                        className="flex min-h-[40px] items-center justify-center rounded-xl border border-slate-800 bg-[#070B14] px-4 text-xs font-medium text-slate-400 hover:text-white"
                      >
                        Annuler la modification
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => handleOpenFullScreenCalibration('edit_live')}
                      className="flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-[#38BDF8]/50 bg-[#070B14] px-3 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/10"
                    >
                      <Camera className="h-4 w-4" />
                      Recadrer pour un nouvel angle caméra
                    </button>

                    <button
                      type="button"
                      onClick={() => handleOpenFullScreenCalibration('edit_photo')}
                      className="flex min-h-[42px] items-center justify-center rounded-xl border border-slate-800 bg-[#070B14] px-3 text-xs font-medium text-slate-300 hover:border-[#38BDF8]"
                    >
                      Réouvrir la photo avec zoom
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleRedoCalibration}
                      className="min-h-[42px] rounded-xl border border-slate-800 px-3 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-white"
                    >
                      Refaire la calibration
                    </button>
                    <button
                      type="button"
                      onClick={handleStartNewSession}
                      className="min-h-[42px] rounded-xl border border-slate-800 px-3 text-xs font-medium text-slate-400 hover:border-slate-600 hover:text-white"
                    >
                      Nouvelle session
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ÉTAPE 3 : SURVEILLANCE ACTIVE DES TIRS */}
            {stage === 'ACTIVE_MONITORING' && officialCalibration && (
              <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
                    Session en cours
                  </h2>
                  <span className="font-mono text-xs text-[#38BDF8] tabular-nums">
                    {distanceMeters} m
                  </span>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3 text-xs text-slate-300 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
                      <Lock className="h-3.5 w-3.5" />
                      CALIBRATION figée
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowFluxDiagnostic((v) => !v)}
                      className="inline-flex items-center gap-1 font-mono text-[11px] text-[#38BDF8] hover:underline"
                    >
                      <Activity className="h-3 w-3" />
                      {showFluxDiagnostic ? 'Masquer diag' : 'Diag flux'}
                    </button>
                  </div>
                  <p className="font-medium text-[#F8FAFC]">{detectionStatusLabel}</p>
                  <p className="font-mono tabular-nums text-[11px] text-slate-400">
                    Buffer circulaire : {circularBufferRef.current.getLength()} images · Calcul{' '}
                    {camCaps.avgProcessingMs} ms/img
                  </p>
                  <p className="font-mono tabular-nums text-[11px] text-[#38BDF8]">
                    File d’analyse :{' '}
                    {queueSnapshot.processingShotNumber
                      ? `Tir #${queueSnapshot.processingShotNumber} en cours · `
                      : ''}
                    {queueSnapshot.queuedCount} en attente · {queueSnapshot.completedCount} traitée(s)
                  </p>

                  {/* Mode diagnostic en direct : caméra -> moteur -> détection */}
                  {showFluxDiagnostic && (
                    <div className="mt-2 rounded-lg border border-slate-800 bg-[#0B1120] p-2.5 font-mono text-[11px] space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Images caméra reçues</span>
                        <span
                          className={
                            diagSnapshot.videoFrames > 0 ? 'text-emerald-400' : 'text-red-400'
                          }
                        >
                          {diagSnapshot.videoFrames} (ready={diagSnapshot.videoReadyState})
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Images analysées moteur</span>
                        <span
                          className={
                            diagSnapshot.engineFrames > 0 ? 'text-emerald-400' : 'text-red-400'
                          }
                        >
                          {diagSnapshot.engineFrames} ({diagSnapshot.lastAnalysisAgeMs} ms)
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Delta max ROI / Seuil</span>
                        <span className="text-slate-200">
                          {diagSnapshot.maxRoiDelta} / {diagSnapshot.threshold}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-400 flex items-center gap-1">
                          {audioStatus === 'active' ? (
                            <Mic className="h-3 w-3 text-emerald-400" />
                          ) : (
                            <MicOff className="h-3 w-3 text-slate-500" />
                          )}
                          Audio
                        </span>
                        <span className="truncate text-right text-slate-300">
                          {audioStatus === 'active'
                            ? `Actif (${audioEventsCount} pics)`
                            : audioStatus === 'denied' || audioStatus === 'unavailable'
                              ? 'Indisponible (vidéo seule)'
                              : 'Désactivé'}
                        </span>
                      </div>
                      <p className="border-t border-slate-800/80 pt-1 text-[10px] text-slate-400">
                        {diagSnapshot.reason}
                      </p>
                      {settings.audioAssistanceEnabled && audioMessage && (
                        <p className="text-[10px] text-[#38BDF8]">{audioMessage}</p>
                      )}
                    </div>
                  )}
                </div>

                {analysisErrors.length > 0 && (
                  <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-xs text-red-200 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-semibold text-red-300">
                      <span className="flex items-center gap-1.5">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        Erreurs d’analyse ({analysisErrors.length})
                      </span>
                      <button
                        type="button"
                        onClick={() => setAnalysisErrors([])}
                        className="text-[11px] underline hover:text-white"
                      >
                        Effacer
                      </button>
                    </div>
                    {analysisErrors.slice(0, 3).map((err) => (
                      <p key={err.id} className="text-[11px] leading-snug text-red-200/90">
                        <span className="font-mono font-semibold">Tir #{err.shotNumber}</span> (
                        {err.shotId.slice(-8)}) : {err.message}
                      </p>
                    ))}
                  </div>
                )}

                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={handleToggleModifyTarget}
                    className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-semibold ${
                      manualCorrectionMode
                        ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#38BDF8]'
                        : 'border-slate-700 bg-[#070B14] text-slate-200 hover:border-[#38BDF8]'
                    }`}
                  >
                    <Crosshair className="h-3.5 w-3.5" />
                    {manualCorrectionMode ? 'Valider la modification' : 'Modifier la cible'}
                  </button>

                  {manualCorrectionMode && (
                    <button
                      type="button"
                      onClick={handleCancelModifyTarget}
                      className="w-full min-h-[40px] rounded-xl border border-slate-800 bg-[#070B14] text-xs font-medium text-slate-400 hover:text-white"
                    >
                      Annuler la modification
                    </button>
                  )}
                </div>

                {/* Live Shot Feed: Immediate Pending/Analyzing states + Completed Results */}
                <div className="max-h-64 overflow-y-auto divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#070B14] px-3">
                  {pendingEvents.length === 0 && sessionShots.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-500">
                      En attente du premier tir…
                    </p>
                  ) : (
                    <>
                      {pendingEvents.map((pend) => (
                        <div
                          key={pend.shotId}
                          className="flex items-center justify-between py-2.5 text-xs"
                        >
                          <div>
                            <p className="font-semibold text-[#38BDF8]">
                              Tir #{pend.shotNumber} ·{' '}
                              {pend.status === 'CAPTURING'
                                ? 'Capture post-impact…'
                                : pend.status === 'ANALYZING'
                                  ? 'Analyse en cours…'
                                  : 'En attente'}
                            </p>
                            <p className="font-mono text-[11px] tabular-nums text-slate-400">
                              {pend.status === 'CAPTURING'
                                ? `${pend.capturedPostFrames}/${pend.targetPostCount} images`
                                : 'Traitement hors-thread actif'}
                            </p>
                          </div>
                          <span className="font-mono text-[11px] font-bold text-amber-300">
                            {pend.status === 'ANALYZING' ? 'ANALYSE' : 'EN ATTENTE'}
                          </span>
                        </div>
                      ))}

                      {[...sessionShots].reverse().map((s) => (
                        <div key={s.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-slate-200">
                              Tir #{s.shotNumber} · {s.zoneName}
                            </p>
                            <p className="font-mono text-[11px] tabular-nums text-slate-400">
                              Confiance {Math.round(s.confidence * 100)}% ·{' '}
                              {s.evidence.processingTimeMs} ms
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {s.result === 'UNCERTAIN' && (
                              <button
                                type="button"
                                onClick={() => setReplayShot(s)}
                                className="min-h-[34px] rounded-lg border border-amber-400/50 bg-amber-500/15 px-2.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/25"
                              >
                                Réexaminer
                              </button>
                            )}
                            <span
                              className={`font-mono font-bold tabular-nums ${
                                s.result === 'UNCERTAIN'
                                  ? 'text-amber-400'
                                  : s.result === 'MISS'
                                    ? 'text-red-400'
                                    : 'text-emerald-400'
                              }`}
                            >
                              {s.result === 'UNCERTAIN' ? 'INCERTAIN' : `+${s.score}`}
                            </span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={handleEndSession}
                    disabled={endingSession}
                    className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl bg-red-600 px-5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-60"
                  >
                    <Square className="h-4 w-4 fill-current" />
                    {endingSession ? 'FINALISATION DES ANALYSES…' : 'TERMINER LA SESSION'}
                  </button>
                  <button
                    type="button"
                    onClick={handleRedoCalibration}
                    className="flex w-full min-h-[42px] items-center justify-center rounded-xl border border-slate-800 text-xs font-medium text-slate-400 hover:text-white"
                  >
                    Refaire la calibration
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Bilan final : Cible unique calibrée + impacts réels + replays vidéo */
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold text-emerald-400">Bilan final · Session sauvegardée</p>
              <h2 className="mt-1 font-display text-2xl font-bold text-[#F8FAFC]">
                {sessionTitle}
              </h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => onOpenReplaysForSession(sessionId)}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#4F7CFF] px-5 text-xs font-semibold text-white hover:bg-[#3E6AE8]"
              >
                <Film className="h-4 w-4" />
                Consulter les replays ({liveSummary.totalShots})
              </button>
              <button
                type="button"
                onClick={() => {
                  nextShotNumberRef.current = 1;
                  activeCaptureWindowsRef.current = [];
                  setSessionId(`sess-${Date.now()}`);
                  setSessionShots([]);
                  sessionShotsRef.current = [];
                  setCompletedSessionSnapshot(null);
                  setReplayShot(null);
                  setStage('READY_TO_SHOOT');
                }}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-[#38BDF8]/40 bg-[#070B14] px-4 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/10"
              >
                Rejouer sur cette cible
              </button>
              <button
                type="button"
                onClick={handleStartNewSession}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-[#070B14] px-4 text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
              >
                Nouvelle calibration
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <p className="text-xs text-slate-400">Score confirmé</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#38BDF8]">
                {liveSummary.confirmedScore} pts
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <p className="text-xs text-slate-400">Réussites / Ratés</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#F8FAFC]">
                {liveSummary.hits} / {liveSummary.misses}
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <p className="text-xs text-slate-400">Précision confirmée</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-emerald-400">
                {liveSummary.confirmedAccuracyPct}%
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <p className="text-xs text-slate-400">Impacts incertains</p>
              <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-amber-400">
                {liveSummary.uncertain}
              </p>
            </div>
          </div>

          {(completedSessionSnapshot?.calibration || effectiveCalibration || officialCalibration) && (
            <FinalTargetSummary
              calibration={
                completedSessionSnapshot?.calibration ??
                effectiveCalibration ??
                officialCalibration!
              }
              scoringZones={officialCalibration?.scoringZones ?? effectiveProfile.zones}
              shots={sessionShots}
              totalConfirmedScore={liveSummary.confirmedScore}
              onSelectShotReplay={(shot) => setReplayShot(shot)}
            />
          )}
        </div>
      )}

      {/* Video Replay Modal launched directly from an impact on Bilan Final */}
      {replayShot && (completedSessionSnapshot || officialCalibration) && (
        <ReplayPlayerModal
          shot={replayShot}
          session={
            completedSessionSnapshot ?? {
              id: sessionId,
              title: sessionTitle,
              createdAt: Date.now(),
              endedAt: Date.now(),
              distanceMeters,
              targetProfileId: effectiveProfile.id,
              targetProfileName: effectiveProfile.name,
              calibration:
                effectiveCalibration ??
                buildTargetCalibrationForShot(
                  officialCalibration!,
                  tracking ?? createInitialTracking(officialCalibration!),
                ),
              sourceType: sourceMode,
              cameraMetrics: {
                requestedFps: camCaps.requestedFps,
                actualMeasuredFps: camCaps.actualMeasuredFps,
                analysisFps: camCaps.analysisFps,
                resolution: `${camCaps.width}x${camCaps.height}`,
              },
              summary: liveSummary,
            }
          }
          targetProfile={effectiveProfile}
          onUpdateShot={handleUpdateCompletedShot}
          onClose={() => setReplayShot(null)}
        />
      )}

      {/* Custom Target Editor Modal */}
      {editingTarget && (
        <TargetEditorModal
          initialProfile={editingTarget}
          onSave={async (profile) => {
            await onSaveTargetProfile(profile);
            setSelectedTargetId(profile.id);
          }}
          onClose={() => setEditingTarget(null)}
        />
      )}
    </div>
  );
};
