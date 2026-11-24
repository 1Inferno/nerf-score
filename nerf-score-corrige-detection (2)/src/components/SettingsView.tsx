import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Activity,
  Camera,
  Check,
  Code2,
  Database,
  Download,
  FileArchive,
  Mic,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sliders,
  Trash2,
  Upload,
} from 'lucide-react';
import {buildHardwareFpsExplanation, FrameRateMeter, startCameraStream, stopCameraStream} from '../camera/cameraManager';
import {performanceStore} from '../camera/performanceStore';
import {shotAnalysisQueue, ShotQueueSnapshot} from '../cv/shotAnalysisQueue';
import {
  clearAllAppData,
  clearDiagnosticLogs,
  exportFullBackupZip,
  getDiagnosticLogs,
  restoreFullBackupZip,
  saveBenchmark,
} from '../db/indexedDb';
import {exportStandaloneProjectZip} from '../pwa/projectExporter';
import {PWAInstallButton} from '../pwa/usePWAInstall';
import {
  AppSettings,
  BenchmarkTestRun,
  CameraCapabilities,
  DEFAULT_TARGET_PROFILE,
  DiagnosticEventEntry,
  DiagnosticLogStatus,
  RuntimePerformanceMetrics,
  ShotEvent,
  TargetProfile,
} from '../types/nerf';
import {TargetEditorModal} from './TargetEditorModal';

interface SettingsViewProps {
  settings: AppSettings;
  targets: TargetProfile[];
  shots: ShotEvent[];
  benchmarks: BenchmarkTestRun[];
  hasActiveCalibration: boolean;
  onSaveSettings: (next: AppSettings) => Promise<void>;
  onSaveTarget: (profile: TargetProfile) => Promise<void>;
  onDeleteTarget: (id: string) => Promise<void>;
  onResetAllShots: () => Promise<void>;
  onStartNewCalibration: () => void;
  onRefreshAll: () => Promise<void>;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  targets,
  shots,
  benchmarks,
  hasActiveCalibration,
  onSaveSettings,
  onSaveTarget,
  onDeleteTarget,
  onResetAllShots,
  onStartNewCalibration,
  onRefreshAll,
}) => {
  const probeVideoRef = useRef<HTMLVideoElement | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<CameraCapabilities | null>(null);
  const [showAndroidArch, setShowAndroidArch] = useState(false);
  const [editingTarget, setEditingTarget] = useState<TargetProfile | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmResetShotsOpen, setConfirmResetShotsOpen] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticEventEntry[]>([]);
  const [diagFilter, setDiagFilter] = useState<'ALL' | DiagnosticLogStatus>('ALL');
  const [perfMetrics, setPerfMetrics] = useState<RuntimePerformanceMetrics>(() =>
    performanceStore.getSnapshot(),
  );
  const [queueSnap, setQueueSnap] = useState<ShotQueueSnapshot>(() =>
    shotAnalysisQueue.getSnapshot(),
  );

  // Benchmark form state (Section 17 empirical test logging)
  const [benchName, setBenchName] = useState('Test terrain 5m');
  const [benchVideoName, setBenchVideoName] = useState('');
  const [benchDistance, setBenchDistance] = useState(5);
  const [benchLighting, setBenchLighting] = useState('Intérieur LED');
  const [benchDart, setBenchDart] = useState('Nerf Elite 2.0');
  const [benchExpected, setBenchExpected] = useState(10);
  const [benchDetected, setBenchDetected] = useState(9);
  const [benchFalsePos, setBenchFalsePos] = useState(0);
  const [benchNotes, setBenchNotes] = useState('');

  const notify = (msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => setStatusMessage(null), 4500);
  };

  const refreshDiagnostics = useCallback(async () => {
    try {
      const persisted = await getDiagnosticLogs(300);
      const liveMem = shotAnalysisQueue.getSnapshot().recentLogs;
      const mergedMap = new Map<string, DiagnosticEventEntry>();
      for (const item of persisted) mergedMap.set(item.id, item);
      for (const item of liveMem) mergedMap.set(item.id, item);
      setDiagnosticLogs(
        Array.from(mergedMap.values()).sort((a, b) => b.timestamp - a.timestamp).slice(0, 300),
      );
    } catch {
      setDiagnosticLogs(shotAnalysisQueue.getSnapshot().recentLogs);
    }
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
    const unsubPerf = performanceStore.subscribe(setPerfMetrics);
    const unsubQueue = shotAnalysisQueue.subscribeState((snap) => {
      setQueueSnap(snap);
      void refreshDiagnostics();
    });
    return () => {
      unsubPerf();
      unsubQueue();
    };
  }, [refreshDiagnostics]);

  const handleProbeCamera = async () => {
    const vid = probeVideoRef.current;
    if (!vid) return;
    setProbing(true);
    let activeStream: MediaStream | null = null;
    try {
      const {stream, capabilities} = await startCameraStream(
        vid,
        settings.requestedFps,
        settings.preferredResolution,
      );
      activeStream = stream;
      const meter = new FrameRateMeter();
      let stopMeasure = false;
      let lastT = -1;
      const tick = () => {
        if (stopMeasure) return;
        if (vid.readyState >= 2 && vid.currentTime !== lastT) {
          lastT = vid.currentTime;
          meter.recordVideoFrame(performance.now());
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, 1400));
      stopMeasure = true;
      const measured = meter.getCaptureFps() || capabilities.actualMeasuredFps;
      setProbeResult({
        ...capabilities,
        actualMeasuredFps: measured,
        hardwareLimitExplanation: buildHardwareFpsExplanation(
          settings.requestedFps,
          measured,
          capabilities.maxSupportedFps,
        ),
      });
    } catch (err) {
      setProbeResult({
        requestedFps: settings.requestedFps,
        actualMeasuredFps: 0,
        reportedTrackFps: null,
        maxSupportedFps: null,
        minSupportedFps: null,
        width: 0,
        height: 0,
        facingMode: 'environment',
        deviceLabel: 'Indisponible',
        analysisFps: 0,
        playbackFps: 0,
        avgProcessingMs: 0,
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Erreur caméra',
        hardwareLimitExplanation: 'Impossible d’ouvrir le flux caméra sur cet appareil.',
      });
    } finally {
      stopCameraStream(activeStream, vid);
      setProbing(false);
    }
  };

  const handleRestoreZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await restoreFullBackupZip(file);
      await onRefreshAll();
      notify(`Restauration terminée : ${res.sessions} sessions et ${res.shots} tirs importés.`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Erreur lors de la restauration ZIP.');
    }
    e.target.value = '';
  };

  const handleExportProjectZip = async () => {
    try {
      const {fileCount} = await exportStandaloneProjectZip();
      notify(`Projet autonome exporté en ZIP (${fileCount} fichiers inclus).`);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Échec de l’exportation du projet.');
    }
  };

  const handleAddBenchmark = async (e: React.FormEvent) => {
    e.preventDefault();
    await saveBenchmark({
      id: `bench-${Date.now()}`,
      name: benchName,
      createdAt: Date.now(),
      videoName: benchVideoName || 'Caméra directe',
      distanceMeters: benchDistance,
      lightingCondition: benchLighting,
      dartType: benchDart,
      expectedShots: benchExpected,
      detectedShots: benchDetected,
      confirmedHits: benchDetected,
      bouncesDetected: 0,
      falsePositives: benchFalsePos,
      uncertainCount: Math.max(0, benchExpected - benchDetected),
      avgProcessingMs: probeResult?.avgProcessingMs ?? 0,
      measuredVideoFps: probeResult?.actualMeasuredFps ?? settings.requestedFps,
      analysisFps: probeResult?.analysisFps ?? 30,
      notes: benchNotes,
    });
    await onRefreshAll();
    notify('Résultat de test expérimental enregistré.');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F8FAFC]">
            Paramètres
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Configuration caméra haute fréquence, seuils Computer Vision, cibles et sauvegardes locales.
          </p>
        </div>
        <PWAInstallButton />
      </div>

      {statusMessage && (
        <div className="flex items-center gap-2 rounded-xl border border-[#38BDF8]/40 bg-[#0E1525] px-4 py-3 text-xs text-[#38BDF8]">
          <Check className="h-4 w-4 shrink-0" />
          <span>{statusMessage}</span>
        </div>
      )}

      {/* 0. Quick Session Shot Reset (preserves calibrated target) & Explicit New Calibration */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <RotateCcw className="h-5 w-5 text-[#38BDF8]" />
            <div>
              <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
                Gestion des tirs & cible calibrée
              </h2>
              <p className="text-xs text-slate-400">
                Effacez uniquement l’historique des tirs et vidéos pour recommencer à zéro sur votre cible déjà calibrée.
              </p>
            </div>
          </div>
          {hasActiveCalibration && (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <ShieldCheck className="h-4 w-4" />
              Cible calibrée conservée
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setConfirmResetShotsOpen(true)}
            className="inline-flex min-h-[46px] items-center gap-2 rounded-xl bg-red-600 px-5 text-xs font-bold tracking-wide text-white shadow hover:bg-red-500"
          >
            <Trash2 className="h-4 w-4" />
            RÉINITIALISER TOUS LES TIRS
          </button>

          <button
            type="button"
            onClick={onStartNewCalibration}
            className="inline-flex min-h-[46px] items-center gap-2 rounded-xl border border-[#38BDF8]/50 bg-[#070B14] px-4 text-xs font-semibold text-[#38BDF8] hover:bg-[#38BDF8]/10"
          >
            <Camera className="h-4 w-4" />
            Nouvelle calibration
          </button>
        </div>
      </section>

      {/* 1. Camera & FPS Settings */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Camera className="h-5 w-5 text-[#38BDF8]" />
            <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Caméra & Fréquence d’images
            </h2>
          </div>
          <button
            type="button"
            onClick={handleProbeCamera}
            disabled={probing}
            className="inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#4F7CFF] px-4 text-xs font-semibold text-white hover:bg-[#3E6AE8] disabled:opacity-50"
          >
            {probing ? 'Mesure réelle en cours…' : 'Tester les capacités réelles'}
          </button>
        </div>

        <video ref={probeVideoRef} className="hidden" playsInline muted />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-300">
              Fréquence demandée (FPS)
            </label>
            <div className="mt-2 grid grid-cols-4 gap-2">
              {([30, 60, 120, 240] as const).map((fps) => (
                <button
                  key={fps}
                  type="button"
                  onClick={() => onSaveSettings({...settings, requestedFps: fps})}
                  className={`min-h-[42px] rounded-xl border font-mono text-xs font-semibold tabular-nums transition-colors ${
                    settings.requestedFps === fps
                      ? 'border-[#4F7CFF] bg-[#4F7CFF]/20 text-white'
                      : 'border-slate-800 bg-[#070B14] text-slate-400 hover:text-white'
                  }`}
                >
                  {fps} FPS
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-300">
              Résolution cible
            </label>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(['720p', '1080p'] as const).map((res) => (
                <button
                  key={res}
                  type="button"
                  onClick={() => onSaveSettings({...settings, preferredResolution: res})}
                  className={`min-h-[42px] rounded-xl border font-mono text-xs font-semibold transition-colors ${
                    settings.preferredResolution === res
                      ? 'border-[#4F7CFF] bg-[#4F7CFF]/20 text-white'
                      : 'border-slate-800 bg-[#070B14] text-slate-400 hover:text-white'
                  }`}
                >
                  {res === '720p' ? '1280×720 (Rapide)' : '1920×1080 (Précis)'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Camera diagnostics display */}
        <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-[#070B14] p-4 sm:grid-cols-5">
          <div>
            <p className="text-[11px] text-slate-400">Fréquence demandée</p>
            <p className="font-mono text-sm font-bold tabular-nums text-[#F8FAFC]">
              {settings.requestedFps} FPS
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">Fréquence obtenue</p>
            <p className="font-mono text-sm font-bold tabular-nums text-[#38BDF8]">
              {probeResult ? `${probeResult.actualMeasuredFps} FPS` : 'Non testée'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">Résolution</p>
            <p className="font-mono text-sm font-bold tabular-nums text-[#F8FAFC]">
              {probeResult && probeResult.width > 0
                ? `${probeResult.width}×${probeResult.height}`
                : settings.preferredResolution}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">Max capteur WebRTC</p>
            <p className="font-mono text-sm font-bold tabular-nums text-[#F8FAFC]">
              {probeResult?.maxSupportedFps ? `${probeResult.maxSupportedFps} FPS` : '—'}
            </p>
          </div>
          <div>
            <p className="text-[11px] text-slate-400">État caméra</p>
            <p
              className={`font-mono text-sm font-bold ${
                probeResult?.status === 'error'
                  ? 'text-red-400'
                  : probeResult?.status === 'active'
                    ? 'text-emerald-400'
                    : 'text-slate-300'
              }`}
            >
              {probeResult ? probeResult.status.toUpperCase() : 'PRÊT'}
            </p>
          </div>
        </div>

        {probeResult?.hardwareLimitExplanation && (
          <p className="text-xs leading-relaxed text-slate-300">
            {probeResult.hardwareLimitExplanation}
          </p>
        )}

        <div>
          <button
            type="button"
            onClick={() => setShowAndroidArch((s) => !s)}
            className="inline-flex items-center gap-2 text-xs font-medium text-[#38BDF8] hover:underline"
          >
            <Code2 className="h-4 w-4" />
            {showAndroidArch
              ? 'Masquer l’architecture native Android 120/240 FPS'
              : 'Architecture native Android (Camera2 120/240 FPS si navigateur limité)'}
          </button>

          {showAndroidArch && (
            <div className="mt-3 rounded-xl border border-slate-800 bg-[#070B14] p-4 text-xs leading-relaxed text-slate-300 space-y-2">
              <p className="font-semibold text-[#F8FAFC]">
                Architecture alternative native Android (Camera2 Constrained High-Speed)
              </p>
              <p>
                Les navigateurs mobiles (Chrome Android / Safari iOS) limitent généralement <code className="font-mono text-[#38BDF8]">getUserMedia</code> à 30 ou 60 FPS pour préserver l’autonomie et les API WebRTC. Si une fléchette dépasse 25 m/s à courte distance, une capture 120–240 FPS requiert un module natif Kotlin :
              </p>
              <ul className="space-y-1 text-slate-400">
                <li>• <code className="font-mono text-slate-200">StreamConfigurationMap.getHighSpeedVideoFpsRanges()</code> pour vérifier 120/240 FPS matériels.</li>
                <li>• <code className="font-mono text-slate-200">CameraDevice.createConstrainedHighSpeedCaptureSession()</code> relié à un <code className="font-mono text-slate-200">ImageReader</code> YUV_420_888 + buffer circulaire natif JNI.</li>
                <li>• Exposition manuelle verrouillée (<code className="font-mono text-slate-200">SENSOR_EXPOSURE_TIME</code> ≤ 1/500 s) pour supprimer le flou de mouvement des fléchettes.</li>
              </ul>
            </div>
          )}
        </div>
      </section>

      {/* 2. Detection Engine & Buffer Parameters */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Sliders className="h-5 w-5 text-[#4F7CFF]" />
          <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
            Moteur Computer Vision & Buffer circulaire
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div>
            <div className="flex justify-between text-xs text-slate-300">
              <span>Seuil de différence pixel (sensibilité mouvement)</span>
              <span className="font-mono tabular-nums text-[#38BDF8]">
                {settings.motionSensitivity}
              </span>
            </div>
            <input
              type="range"
              min={12}
              max={60}
              value={settings.motionSensitivity}
              onChange={(e) =>
                onSaveSettings({...settings, motionSensitivity: Number(e.target.value)})
              }
              className="mt-2 w-full accent-[#4F7CFF]"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-slate-300">
              <span>Tolérance dérive caméra (stabilité cible)</span>
              <span className="font-mono tabular-nums text-[#38BDF8]">
                {Math.round(settings.cameraDriftTolerance * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.1}
              max={0.45}
              step={0.02}
              value={settings.cameraDriftTolerance}
              onChange={(e) =>
                onSaveSettings({...settings, cameraDriftTolerance: parseFloat(e.target.value)})
              }
              className="mt-2 w-full accent-[#4F7CFF]"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-slate-300">
              <span>Mémoire avant impact (secondes)</span>
              <span className="font-mono tabular-nums text-[#38BDF8]">
                {settings.preEventSeconds} s
              </span>
            </div>
            <input
              type="range"
              min={0.8}
              max={4.0}
              step={0.2}
              value={settings.preEventSeconds}
              onChange={(e) =>
                onSaveSettings({...settings, preEventSeconds: parseFloat(e.target.value)})
              }
              className="mt-2 w-full accent-[#4F7CFF]"
            />
          </div>

          <div>
            <div className="flex justify-between text-xs text-slate-300">
              <span>Capture après impact (secondes)</span>
              <span className="font-mono tabular-nums text-[#38BDF8]">
                {settings.postEventSeconds} s
              </span>
            </div>
            <input
              type="range"
              min={0.8}
              max={4.0}
              step={0.2}
              value={settings.postEventSeconds}
              onChange={(e) =>
                onSaveSettings({...settings, postEventSeconds: parseFloat(e.target.value)})
              }
              className="mt-2 w-full accent-[#4F7CFF]"
            />
          </div>
        </div>

        {/* Assistance audio facultative (expérimental) */}
        <div className="mt-2 rounded-xl border border-slate-800 bg-[#070B14] p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <Mic className="h-4 w-4 text-[#38BDF8] shrink-0" />
              <div>
                <p className="text-xs font-semibold text-[#F8FAFC]">
                  Assistance audio (expérimental) :{' '}
                  <span
                    className={
                      settings.audioAssistanceEnabled ? 'text-emerald-400' : 'text-slate-400'
                    }
                  >
                    {settings.audioAssistanceEnabled ? 'Activée' : 'Désactivée'}
                  </span>
                </p>
                <p className="text-[11px] text-slate-400">
                  Utilise le microphone uniquement pendant la session pour dater les bruits d’impact et retrouver un tir vidéo manqué. Aucun enregistrement vocal ni déclenchement sur un simple bruit sans preuve visuelle.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onSaveSettings({...settings, audioAssistanceEnabled: true})}
                className={`min-h-[38px] rounded-lg border px-3 text-xs font-semibold ${
                  settings.audioAssistanceEnabled
                    ? 'border-emerald-500 bg-emerald-600/20 text-emerald-300'
                    : 'border-slate-700 bg-[#0E1525] text-slate-300 hover:border-[#38BDF8]'
                }`}
              >
                Activée
              </button>
              <button
                type="button"
                onClick={() => onSaveSettings({...settings, audioAssistanceEnabled: false})}
                className={`min-h-[38px] rounded-lg border px-3 text-xs font-semibold ${
                  !settings.audioAssistanceEnabled
                    ? 'border-[#38BDF8] bg-[#4F7CFF]/20 text-[#38BDF8]'
                    : 'border-slate-700 bg-[#0E1525] text-slate-300 hover:border-[#38BDF8]'
                }`}
              >
                Désactivée
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Custom Targets Manager */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
            Configurations de cibles enregistrées
          </h2>
          <button
            type="button"
            onClick={() =>
              setEditingTarget({
                ...DEFAULT_TARGET_PROFILE,
                id: `target-${Date.now()}`,
                name: `Cible personnalisée ${targets.length + 1}`,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              })
            }
            className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-[#4F7CFF]/50 bg-[#4F7CFF]/15 px-4 text-xs font-semibold text-[#F8FAFC] hover:bg-[#4F7CFF]/25"
          >
            <Plus className="h-4 w-4 text-[#38BDF8]" />
            Nouvelle cible
          </button>
        </div>

        <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#070B14]">
          {targets.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
            >
              <div>
                <p className="text-sm font-semibold text-[#F8FAFC]">{t.name}</p>
                <p className="text-xs text-slate-400 font-mono tabular-nums">
                  {t.zones.length} zones · Max {Math.max(...t.zones.map((z) => z.points))} pts
                  {settings.activeTargetProfileId === t.id ? ' · Active par défaut' : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {settings.activeTargetProfileId !== t.id && (
                  <button
                    type="button"
                    onClick={() => onSaveSettings({...settings, activeTargetProfileId: t.id})}
                    className="min-h-[38px] rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
                  >
                    Définir par défaut
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setEditingTarget(t)}
                  className="min-h-[38px] rounded-lg border border-slate-700 px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
                >
                  Modifier
                </button>
                {t.id !== DEFAULT_TARGET_PROFILE.id && (
                  <button
                    type="button"
                    onClick={() => onDeleteTarget(t.id)}
                    aria-label="Supprimer cette cible"
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 hover:bg-red-500/15 hover:text-red-400"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Empirical Video Test Benchmark Log (Section 17) */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
        <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
          Journal de validation expérimentale (Tests réels)
        </h2>
        <p className="text-xs text-slate-400">
          Consignez ici les résultats mesurés sur vos vraies vidéos de test (3 à 10 m, rebonds, ratés, différents éclairages) pour évaluer le taux de détection et les faux positifs réels.
        </p>

        <form onSubmit={handleAddBenchmark} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <input
            type="text"
            value={benchName}
            onChange={(e) => setBenchName(e.target.value)}
            placeholder="Scénario (ex: Rebond 7m)"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-[#F8FAFC]"
          />
          <input
            type="text"
            value={benchVideoName}
            onChange={(e) => setBenchVideoName(e.target.value)}
            placeholder="Fichier vidéo ou caméra"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-[#F8FAFC]"
          />
          <input
            type="text"
            value={benchLighting}
            onChange={(e) => setBenchLighting(e.target.value)}
            placeholder="Éclairage"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-[#F8FAFC]"
          />
          <input
            type="text"
            value={benchDart}
            onChange={(e) => setBenchDart(e.target.value)}
            placeholder="Type de fléchette"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-[#F8FAFC]"
          />
          <input
            type="number"
            min={3}
            max={10}
            value={benchDistance}
            onChange={(e) => setBenchDistance(Number(e.target.value))}
            aria-label="Distance (m)"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 font-mono text-xs text-[#F8FAFC]"
          />
          <input
            type="number"
            min={1}
            value={benchExpected}
            onChange={(e) => setBenchExpected(Number(e.target.value))}
            aria-label="Tirs réels tirés"
            placeholder="Tirs tirés"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 font-mono text-xs text-[#F8FAFC]"
          />
          <input
            type="number"
            min={0}
            value={benchDetected}
            onChange={(e) => setBenchDetected(Number(e.target.value))}
            aria-label="Tirs détectés"
            placeholder="Détectés"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 font-mono text-xs text-[#F8FAFC]"
          />
          <input
            type="number"
            min={0}
            value={benchFalsePos}
            onChange={(e) => setBenchFalsePos(Number(e.target.value))}
            aria-label="Faux positifs"
            placeholder="Faux positifs"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 font-mono text-xs text-[#F8FAFC]"
          />
          <input
            type="text"
            value={benchNotes}
            onChange={(e) => setBenchNotes(e.target.value)}
            placeholder="Observations terrain (précision, rebonds, flou)…"
            className="rounded-xl border border-slate-700 bg-[#070B14] px-3 py-2.5 text-xs text-[#F8FAFC] sm:col-span-3"
          />
          <button
            type="submit"
            className="min-h-[42px] rounded-xl bg-[#4F7CFF] px-4 text-xs font-semibold text-white hover:bg-[#3E6AE8]"
          >
            Consigner le test
          </button>
        </form>

        {benchmarks.length > 0 && (
          <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#070B14]">
            {benchmarks.slice(0, 6).map((b) => {
              const rate = b.expectedShots > 0 ? Math.round((b.detectedShots / b.expectedShots) * 100) : 0;
              return (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs">
                  <div>
                    <p className="font-semibold text-[#F8FAFC]">
                      {b.name} · {b.distanceMeters} m · {b.dartType}
                    </p>
                    <p className="text-slate-400">
                      {b.lightingCondition} · {b.notes || b.videoName}
                    </p>
                  </div>
                  <div className="font-mono tabular-nums text-right">
                    <span className="text-emerald-400">{rate}% détection</span> ·{' '}
                    <span className="text-red-400">{b.falsePositives} faux positifs</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 4b. Performance & Diagnostic Panel */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Activity className="h-5 w-5 text-[#38BDF8]" />
            <div>
              <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
                Performance et diagnostic
              </h2>
              <p className="text-xs text-slate-400">
                Métriques réelles de capture/analyse (zéro valeur simulée) et traçabilité complète par tir.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void refreshDiagnostics()}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#070B14] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
            >
              <RefreshCw className="h-3.5 w-3.5 text-[#38BDF8]" />
              Actualiser
            </button>
            <button
              type="button"
              onClick={async () => {
                await clearDiagnosticLogs();
                shotAnalysisQueue.clearRecentDiagnostics();
                setDiagnosticLogs([]);
                notify('Historique de diagnostic vidé.');
              }}
              disabled={diagnosticLogs.length === 0}
              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/10 px-3 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Vider
            </button>
          </div>
        </div>

        {/* 9 Mandatory Performance & Diagnostic Metrics */}
        {(() => {
          const detectedEventIds = new Set([
            ...shots.map((s) => s.id),
            ...diagnosticLogs.map((d) => d.shotId),
          ]);
          const analyzedCount = Math.max(
            shots.filter((s) => s.validationState !== 'DISMISSED').length,
            diagnosticLogs.filter((d) => d.status === 'COMPLETED').length,
          );
          const pendingCount =
            queueSnap.capturingCount +
            queueSnap.queuedCount +
            (queueSnap.processingShotId ? 1 : 0);
          const uncertainPositions = shots.filter(
            (s) =>
              (s.result === 'UNCERTAIN' || s.evidence.positionDetermined === false) &&
              s.validationState !== 'DISMISSED',
          ).length;
          const technicalErrors = Math.max(
            queueSnap.errorCount,
            diagnosticLogs.filter((d) => d.status === 'ERROR').length,
          );
          const displayCameraFps =
            perfMetrics.cameraFps || probeResult?.actualMeasuredFps || 0;
          const displayAnalysisFps = perfMetrics.analysisFps || 0;
          const avgShotMs =
            shots.length > 0
              ? Math.round(
                  (shots.reduce((acc, s) => acc + (s.evidence.processingTimeMs || 0), 0) /
                    shots.length) *
                    10,
                ) / 10
              : 0;
          const displayProcessingMs = perfMetrics.avgProcessingMs || avgShotMs;

          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">FPS caméra</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#F8FAFC]">
                    {displayCameraFps} FPS
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">FPS d’analyse</p>
                  <p
                    className={`font-mono text-lg font-bold tabular-nums ${
                      displayAnalysisFps >= 15
                        ? 'text-emerald-400'
                        : displayAnalysisFps >= 10
                          ? 'text-[#38BDF8]'
                          : 'text-slate-300'
                    }`}
                  >
                    {displayAnalysisFps} FPS
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Délai moyen traitement</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#38BDF8]">
                    {displayProcessingMs} ms
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Images ignorées</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-slate-200">
                    {perfMetrics.skippedFrames}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Traitement parallèle</p>
                  <p className="font-mono text-sm font-bold text-emerald-400 mt-1">
                    {perfMetrics.workerEnabled ? 'Web Worker actif' : 'Thread principal'}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Événements enregistrés</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#F8FAFC]">
                    {detectedEventIds.size}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Événements analysés</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-emerald-400">
                    {analyzedCount}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Événements en attente</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-[#38BDF8]">
                    {pendingCount}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Erreurs</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-red-400">
                    {technicalErrors}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-3">
                  <p className="text-[11px] text-slate-400">Événements incertains</p>
                  <p className="font-mono text-lg font-bold tabular-nums text-amber-300">
                    {uncertainPositions}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-800 bg-[#070B14] p-3 text-xs sm:grid-cols-4">
                <div>
                  <p className="text-[11px] text-slate-400">Images caméra reçues</p>
                  <p className="font-mono text-sm font-bold tabular-nums text-[#F8FAFC]">
                    {perfMetrics.videoFramesDelivered ?? 0} (ready={perfMetrics.videoReadyState ?? 0})
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Images analysées moteur</p>
                  <p className="font-mono text-sm font-bold tabular-nums text-emerald-400">
                    {perfMetrics.engineFramesAnalyzed ?? 0}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">Delta max ROI / Audio</p>
                  <p className="font-mono text-sm font-bold tabular-nums text-[#38BDF8]">
                    {perfMetrics.lastMaxRoiDelta ?? 0} ·{' '}
                    {perfMetrics.audioAssistanceActive
                      ? `Audio (${perfMetrics.audioEventsCount ?? 0} pics)`
                      : 'Audio off'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-400">État moteur</p>
                  <p className="truncate font-mono text-[11px] text-slate-300">
                    {perfMetrics.lastTriggerReason ?? '—'}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Filter buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              {id: 'ALL', label: 'Tous'},
              {id: 'ERROR', label: 'Erreurs'},
              {id: 'INTERRUPTED', label: 'Interruptions'},
              {id: 'STARTED', label: 'Débuts'},
              {id: 'COMPLETED', label: 'Terminées'},
              {id: 'QUEUED', label: 'File d’attente'},
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setDiagFilter(tab.id)}
              className={`min-h-[36px] rounded-lg border px-3 text-xs font-medium transition-colors ${
                diagFilter === tab.id
                  ? 'border-[#38BDF8] bg-[#4F7CFF] text-white'
                  : 'border-slate-800 bg-[#070B14] text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Diagnostic Entries */}
        <div className="max-h-80 overflow-y-auto divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#070B14]">
          {diagnosticLogs.filter((d) => diagFilter === 'ALL' || d.status === diagFilter).length === 0 ? (
            <p className="p-6 text-center text-xs text-slate-500">
              Aucun événement de diagnostic enregistré pour ce filtre.
            </p>
          ) : (
            diagnosticLogs
              .filter((d) => diagFilter === 'ALL' || d.status === diagFilter)
              .map((entry) => {
                const statusColor =
                  entry.status === 'ERROR'
                    ? 'text-red-400 border-red-500/40 bg-red-500/10'
                    : entry.status === 'INTERRUPTED'
                      ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
                      : entry.status === 'COMPLETED'
                        ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
                        : entry.status === 'STARTED'
                          ? 'text-[#38BDF8] border-[#38BDF8]/40 bg-[#38BDF8]/10'
                          : 'text-slate-300 border-slate-700 bg-slate-800/40';
                const timeStr = new Date(entry.timestamp).toLocaleTimeString('fr-FR', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });

                return (
                  <div key={entry.id} className="px-4 py-3 text-xs space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-md border px-2 py-0.5 font-mono text-[10px] font-bold ${statusColor}`}
                        >
                          {entry.status}
                        </span>
                        <span className="font-mono font-semibold text-[#F8FAFC]">
                          Tir #{entry.shotNumber}
                        </span>
                        <span className="font-mono text-[11px] text-slate-400">
                          ID : {entry.shotId}
                        </span>
                        <span className="font-mono text-[10px] text-slate-500">
                          [{entry.stage}]
                        </span>
                      </div>
                      <span className="font-mono text-[11px] tabular-nums text-slate-400">
                        {timeStr}
                        {entry.durationMs !== undefined ? ` · ${entry.durationMs} ms` : ''}
                      </span>
                    </div>
                    <p className="text-slate-200">{entry.message}</p>
                    {entry.reason && (
                      <p className="text-[11px] text-amber-300">
                        Raison : {entry.reason}
                      </p>
                    )}
                    {entry.details && (
                      <p className="font-mono text-[11px] text-slate-400">{entry.details}</p>
                    )}
                  </div>
                );
              })
          )}
        </div>
      </section>

      {/* 5. Backup, Restore & Standalone Project ZIP Export */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-5">
        <div className="flex items-center gap-2.5">
          <Database className="h-5 w-5 text-[#38BDF8]" />
          <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
            Sauvegarde IndexedDB & Déploiement indépendant
          </h2>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => exportFullBackupZip().then(() => notify('Sauvegarde complète exportée.'))}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-[#070B14] px-4 text-xs font-semibold text-[#F8FAFC] hover:border-[#38BDF8]"
          >
            <Download className="h-4 w-4 text-[#38BDF8]" />
            Sauvegarde complète (.zip)
          </button>

          <label className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-[#070B14] px-4 text-xs font-semibold text-[#F8FAFC] hover:border-[#38BDF8]">
            <Upload className="h-4 w-4 text-emerald-400" />
            <span>Restaurer sauvegarde (.zip)</span>
            <input type="file" accept=".zip" onChange={handleRestoreZip} className="hidden" />
          </label>

          <button
            type="button"
            onClick={() => setConfirmClearOpen(true)}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 text-xs font-semibold text-red-300 hover:bg-red-500/20"
          >
            <Trash2 className="h-4 w-4" />
            Réinitialiser les données
          </button>
        </div>

        {/* Discrete yet easy-to-find full project ZIP export */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-400">
            Code source autonome avec manifest PWA, icônes PNG/SVG et configuration Vite pour hébergement indépendant.
          </p>
          <button
            type="button"
            onClick={handleExportProjectZip}
            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-700 bg-[#070B14] px-3.5 text-xs font-medium text-slate-200 transition-colors hover:border-[#4F7CFF] hover:text-white"
          >
            <FileArchive className="h-4 w-4 text-[#4F7CFF]" />
            Exporter le projet complet (.zip)
          </button>
        </div>
      </section>

      {editingTarget && (
        <TargetEditorModal
          initialProfile={editingTarget}
          onSave={onSaveTarget}
          onClose={() => setEditingTarget(null)}
        />
      )}

      {confirmResetShotsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
            <h3 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Réinitialiser tous les tirs ?
            </h3>
            <p className="text-xs leading-relaxed text-slate-300">
              Cette action supprime définitivement tous les événements de tirs, les résultats, les scores, les statistiques de session, les séquences et extraits vidéo enregistrés.
            </p>
            <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300">
              Conservés intactes : votre cible calibrée, sa photo de référence, son contour et ses zones de score.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmResetShotsOpen(false)}
                className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs font-medium text-slate-300"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={async () => {
                  setConfirmResetShotsOpen(false);
                  await onResetAllShots();
                  notify('Tous les tirs et vidéos ont été réinitialisés. Cible calibrée conservée.');
                }}
                className="min-h-[44px] rounded-xl bg-red-600 px-4 text-xs font-bold text-white hover:bg-red-500"
              >
                Confirmer la réinitialisation
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClearOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
            <h3 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Effacer toutes les données locales ?
            </h3>
            <p className="text-xs leading-relaxed text-slate-300">
              Toutes les sessions, vidéos de tirs, statistiques et cibles personnalisées seront définitivement supprimées d’IndexedDB. Exportez une sauvegarde avant de continuer si nécessaire.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmClearOpen(false)}
                className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs font-medium text-slate-300"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={async () => {
                  setConfirmClearOpen(false);
                  await clearAllAppData();
                  shotAnalysisQueue.clearRecentDiagnostics();
                  setDiagnosticLogs([]);
                  await onRefreshAll();
                  notify('Données IndexedDB réinitialisées.');
                }}
                className="min-h-[44px] rounded-xl bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500"
              >
                Confirmer la suppression
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
