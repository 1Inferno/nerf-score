import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  HelpCircle,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import {
  buildScaledPolygonRing,
  evaluateImpactInPolygon,
  evaluateImpactZone,
  mapFramePointToTargetSpace,
} from '../cv/geometry';
import {extractGrayscale, extractRgb} from '../cv/visionEngine';
import {reanalyzeShotInWorker} from '../cv/visionWorkerClient';
import {
  getFrameSequence,
  getVideoBlob,
  triggerDownload,
} from '../db/indexedDb';
import {
  Point2D,
  ShootingSession,
  ShotEvent,
  ShotFrameArchive,
  TargetProfile,
} from '../types/nerf';

interface ReplayPlayerModalProps {
  shot: ShotEvent;
  session: ShootingSession;
  targetProfile: TargetProfile;
  onUpdateShot: (updated: ShotEvent) => Promise<void>;
  onClose: () => void;
}

const SLOW_FACTORS = [1, 2, 4, 8] as const;

export const ReplayPlayerModal: React.FC<ReplayPlayerModalProps> = ({
  shot,
  session,
  targetProfile,
  onUpdateShot,
  onClose,
}) => {
  const [archive, setArchive] = useState<ShotFrameArchive | null>(null);
  const [loading, setLoading] = useState(true);
  const [frameIdx, setFrameIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slowFactor, setSlowFactor] = useState<1 | 2 | 4 | 8>(2);
  const [showOverlay, setShowOverlay] = useState(true);
  const [correctingImpact, setCorrectingImpact] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeFeedback, setReanalyzeFeedback] = useState<string | null>(null);
  const [hasVideoBlob, setHasVideoBlob] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      shot.frameSequenceId ? getFrameSequence(shot.frameSequenceId) : Promise.resolve(undefined),
      shot.videoBlobId ? getVideoBlob(shot.videoBlobId) : Promise.resolve(undefined),
    ])
      .then(([seq, vid]) => {
        if (!active) return;
        setArchive(seq ?? null);
        setFrameIdx(seq ? Math.min(seq.frames.length - 1, Math.max(0, seq.impactFrameIndex)) : 0);
        setHasVideoBlob(Boolean(vid));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [shot.frameSequenceId, shot.videoBlobId]);

  const captureFps = archive?.captureFps || shot.evidence.captureFpsAtEvent || 30;
  const effectivePlaybackFps = Math.max(1, Math.round((captureFps / slowFactor) * 10) / 10);

  useEffect(() => {
    if (!playing || !archive || archive.frames.length <= 1) return;
    const intervalMs = Math.max(16, Math.round((1000 / Math.max(8, captureFps)) * slowFactor));
    const timer = window.setInterval(() => {
      setFrameIdx((prev) => (prev + 1 >= archive.frames.length ? 0 : prev + 1));
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [playing, archive, captureFps, slowFactor]);

  const currentFrame = archive?.frames[frameIdx] ?? null;

  const handleStep = (delta: number) => {
    if (!archive || archive.frames.length === 0) return;
    setPlaying(false);
    setFrameIdx((prev) => Math.max(0, Math.min(archive.frames.length - 1, prev + delta)));
  };

  const handleDownloadVideo = async () => {
    if (!shot.videoBlobId) return;
    const vid = await getVideoBlob(shot.videoBlobId);
    if (!vid) return;
    const ext = vid.mimeType.includes('mp4') ? 'mp4' : 'webm';
    triggerDownload(vid.blob, `nerf-score-tir-${shot.shotNumber}.${ext}`);
  };

  const handleCorrectTap = async (e: React.MouseEvent<HTMLDivElement>) => {
    if (!correctingImpact || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const framePt: Point2D = {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
    const cal = session.calibration;
    const polyEval =
      cal.polygon && cal.polygon.length >= 3
        ? evaluateImpactInPolygon({
            framePoint: framePt,
            polygon: cal.polygon,
            center: cal.center,
            corners: cal.corners,
            profile: targetProfile,
          })
        : null;
    const targetPt = polyEval
      ? polyEval.targetSpacePt
      : mapFramePointToTargetSpace(framePt, cal.corners);
    const evalRes = polyEval ?? evaluateImpactZone(targetPt, targetProfile);

    await onUpdateShot({
      ...shot,
      frameImpactPoint: framePt,
      impactPoint: targetPt,
      result: evalRes.insideTarget ? 'HIT' : 'MISS',
      zoneId: evalRes.zoneId,
      zoneName: evalRes.zoneName,
      score: evalRes.points,
      confidence: 1,
      confidenceStatus: 'CONFIRMED',
      validationState: 'USER_CORRECTED',
    });
    setCorrectingImpact(false);
  };

  const handleConfirm = async () => {
    await onUpdateShot({
      ...shot,
      confidenceStatus: shot.result === 'UNCERTAIN' ? 'UNCERTAIN' : 'CONFIRMED',
      validationState: 'USER_CONFIRMED',
    });
  };

  const handleMarkUncertain = async () => {
    await onUpdateShot({
      ...shot,
      result: 'UNCERTAIN',
      zoneId: null,
      zoneName: 'IMPACT INCERTAIN',
      score: 0,
      confidenceStatus: 'UNCERTAIN',
      validationState: 'USER_CORRECTED',
    });
  };

  const handleDismiss = async () => {
    await onUpdateShot({
      ...shot,
      validationState: 'DISMISSED',
      score: 0,
    });
    onClose();
  };

  const handleAutoReanalyze = async () => {
    if (!archive || archive.frames.length < 4 || reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeFeedback(null);
    try {
      const w = Math.max(160, archive.width || 320);
      const h = Math.max(120, archive.height || 180);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', {willReadFrequently: true});
      if (!ctx) throw new Error('Contexte canvas indisponible pour décoder les images.');

      const decodedFrames: Array<{
        gray: Uint8Array;
        rgb: Uint8Array;
        width: number;
        height: number;
        timestampMs: number;
      }> = [];

      for (const f of archive.frames) {
        if (!f.dataUrl) continue;
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h);
            decodedFrames.push({
              gray: extractGrayscale(imgData),
              rgb: extractRgb(imgData),
              width: w,
              height: h,
              timestampMs: f.timestampMs,
            });
            resolve();
          };
          img.onerror = () => resolve();
          img.src = f.dataUrl;
        });
      }

      if (decodedFrames.length < 4) {
        setReanalyzeFeedback(
          'Images insuffisantes dans l’archive pour relancer la réanalyse automatique.',
        );
        return;
      }

      const reanalyzed = await reanalyzeShotInWorker({
        frames: decodedFrames,
        triggerIndex: Math.min(decodedFrames.length - 2, Math.max(1, archive.impactFrameIndex)),
        calibration: session.calibration,
        targetProfile,
        sensitivity: 22,
        passes: Math.max(3, shot.evidence.reanalyzedPasses + 1),
        captureFps,
        sessionId: session.id,
        shotNumber: shot.shotNumber,
        boostSensitivity: true,
      });

      const updated: ShotEvent = {
        ...shot,
        ...reanalyzed,
        id: shot.id,
        sessionId: shot.sessionId,
        shotNumber: shot.shotNumber,
        videoBlobId: shot.videoBlobId,
        frameSequenceId: shot.frameSequenceId,
        thumbnailDataUrl: shot.thumbnailDataUrl,
      };
      await onUpdateShot(updated);
      setReanalyzeFeedback(
        updated.result === 'UNCERTAIN'
          ? 'Réexamen terminé : position toujours incertaine — aucune valeur inventée. Pointez manuellement si visible.'
          : `Réexamen confirmé : ${updated.zoneName} (+${updated.score} pts, confiance ${Math.round(updated.confidence * 100)}%).`,
      );
    } catch (err) {
      setReanalyzeFeedback(
        err instanceof Error ? err.message : 'Échec du réexamen automatique de l’extrait.',
      );
    } finally {
      setReanalyzing(false);
    }
  };

  const activeContour = useMemo(
    () =>
      session.calibration.polygon && session.calibration.polygon.length >= 3
        ? session.calibration.polygon
        : session.calibration.corners,
    [session.calibration.polygon, session.calibration.corners],
  );

  const quadPoints = useMemo(
    () =>
      activeContour
        .map((c) => `${(c.x * 100).toFixed(2)},${(c.y * 100).toFixed(2)}`)
        .join(' '),
    [activeContour],
  );

  const replayZoneRings = useMemo(() => {
    if (!session.calibration.polygon || session.calibration.polygon.length < 3) return [];
    return targetProfile.zones
      .filter((z) => z.shape !== 'polygon')
      .map((z) => ({
        id: z.id,
        color: z.color,
        points: buildScaledPolygonRing(
          activeContour,
          session.calibration.center,
          Math.min(1, z.radiusRatio * 2),
        )
          .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
          .join(' '),
      }));
  }, [activeContour, session.calibration.center, session.calibration.polygon, targetProfile.zones]);

  const trajectoryPoints = useMemo(
    () => shot.trajectory.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(' '),
    [shot.trajectory],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-0 backdrop-blur-sm md:items-center md:p-4">
      <div className="flex max-h-[94vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border border-slate-800 bg-[#0E1525] text-[#F8FAFC] md:rounded-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div>
            <h2 className="font-display text-base font-semibold md:text-lg">
              Tir #{shot.shotNumber} — {shot.zoneName}
            </h2>
            <p className="text-xs text-slate-400 font-mono tabular-nums">
              {session.title} · {shot.score} pts · Confiance {Math.round(shot.confidence * 100)}%
            </p>
          </div>
          <div className="flex items-center gap-2">
            {hasVideoBlob && (
              <button
                type="button"
                onClick={handleDownloadVideo}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#070B14] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
              >
                <Download className="h-4 w-4 text-[#38BDF8]" />
                <span className="hidden sm:inline">Exporter vidéo</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer le lecteur"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {loading ? (
            <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800 bg-[#070B14] text-sm text-slate-400">
              Chargement des images originales enregistrées…
            </div>
          ) : (
            <>
              {/* Video frame viewport */}
              <div
                ref={viewportRef}
                onClick={handleCorrectTap}
                className={`relative mx-auto aspect-video w-full overflow-hidden rounded-xl border border-slate-800 bg-[#070B14] ${
                  correctingImpact ? 'cursor-crosshair ring-2 ring-[#38BDF8]' : ''
                }`}
              >
                {currentFrame ? (
                  <img
                    src={currentFrame.dataUrl}
                    alt={`Image ${frameIdx + 1} du tir ${shot.shotNumber}`}
                    className="h-full w-full object-contain"
                  />
                ) : shot.thumbnailDataUrl ? (
                  <img
                    src={shot.thumbnailDataUrl}
                    alt={`Capture tir ${shot.shotNumber}`}
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-slate-500">
                    Séquence d’images non disponible
                  </div>
                )}

                {showOverlay && (
                  <svg
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    className="pointer-events-none absolute inset-0 h-full w-full"
                  >
                    <polygon
                      points={quadPoints}
                      fill="none"
                      stroke="#38BDF8"
                      strokeOpacity={0.75}
                      strokeWidth="0.45"
                    />
                    {replayZoneRings.map((ring) => (
                      <polygon
                        key={ring.id}
                        points={ring.points}
                        fill="none"
                        stroke={ring.color || '#38BDF8'}
                        strokeOpacity={0.55}
                        strokeWidth="0.3"
                      />
                    ))}
                    {shot.trajectory.length >= 2 && (
                      <polyline
                        points={trajectoryPoints}
                        fill="none"
                        stroke="#F59E0B"
                        strokeWidth="0.55"
                        strokeDasharray="1.2 1"
                      />
                    )}
                    {shot.frameImpactPoint && (
                      <g>
                        <circle
                          cx={shot.frameImpactPoint.x * 100}
                          cy={shot.frameImpactPoint.y * 100}
                          r="2.2"
                          fill="none"
                          stroke={shot.result === 'UNCERTAIN' ? '#F59E0B' : '#22C55E'}
                          strokeWidth="0.6"
                        />
                        <circle
                          cx={shot.frameImpactPoint.x * 100}
                          cy={shot.frameImpactPoint.y * 100}
                          r="0.7"
                          fill={shot.result === 'UNCERTAIN' ? '#F59E0B' : '#22C55E'}
                        />
                      </g>
                    )}
                  </svg>
                )}

                {correctingImpact && (
                  <div className="absolute inset-x-0 top-3 flex justify-center pointer-events-none">
                    <span className="rounded-lg bg-[#070B14]/90 px-3 py-1.5 text-xs font-medium text-[#38BDF8] border border-[#38BDF8]/50">
                      Touchez la position exacte de l’impact sur l’image
                    </span>
                  </div>
                )}
              </div>

              {/* Scrubber & honest FPS info */}
              {archive && archive.frames.length > 0 && (
                <div className="space-y-2 rounded-xl border border-slate-800 bg-[#070B14] p-3.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                    <span className="font-mono tabular-nums">
                      Image {frameIdx + 1} / {archive.frames.length}
                      {archive.impactFrameIndex === frameIdx ? ' · Pic détecté' : ''}
                    </span>
                    <span className="font-mono tabular-nums text-[#38BDF8]">
                      Capture réelle : {captureFps} FPS · Lecture : {effectivePlaybackFps} img/s (ralenti x{slowFactor})
                    </span>
                  </div>

                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, archive.frames.length - 1)}
                    value={frameIdx}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrameIdx(Number(e.target.value));
                    }}
                    className="w-full accent-[#4F7CFF]"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                    {/* Transport controls */}
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleStep(-1)}
                        className="flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-700 bg-[#0E1525] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Retour
                      </button>
                      <button
                        type="button"
                        onClick={() => setPlaying((p) => !p)}
                        className="flex min-h-[44px] min-w-[104px] items-center justify-center gap-1.5 rounded-lg bg-[#4F7CFF] px-4 text-xs font-semibold text-white hover:bg-[#3E6AE8]"
                      >
                        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                        {playing ? 'Pause' : 'Lecture'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleStep(1)}
                        className="flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-700 bg-[#0E1525] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
                      >
                        Avance
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>

                    {/* Slow-motion factors */}
                    <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-[#0E1525] p-1">
                      {SLOW_FACTORS.map((factor) => (
                        <button
                          key={factor}
                          type="button"
                          onClick={() => setSlowFactor(factor)}
                          className={`min-h-[36px] rounded-md px-3 text-xs font-mono font-semibold transition-colors ${
                            slowFactor === factor
                              ? 'bg-[#4F7CFF] text-white'
                              : 'text-slate-400 hover:text-white'
                          }`}
                        >
                          x{factor}
                        </button>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={() => setShowOverlay((s) => !s)}
                      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0E1525] px-3 text-xs font-medium text-slate-300 hover:text-white"
                    >
                      {showOverlay ? <Eye className="h-4 w-4 text-[#38BDF8]" /> : <EyeOff className="h-4 w-4" />}
                      Calque CV
                    </button>
                  </div>
                </div>
              )}

              {/* Evidence & Manual Verification */}
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4 space-y-2">
                  <h3 className="text-xs font-semibold text-slate-300">
                    Journal d’analyse & réanalyse
                  </h3>
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono tabular-nums text-slate-400">
                    <span>Images pré-impact : {shot.evidence.preFrames}</span>
                    <span>Images post-impact : {shot.evidence.postFrames}</span>
                    <span>Passes d’analyse : {shot.evidence.reanalyzedPasses}</span>
                    <span>Temps calcul : {shot.evidence.processingTimeMs} ms</span>
                    <span>Départ visible : {shot.evidence.launchVisible ? 'Oui' : 'Non'}</span>
                    <span>Rebond détecté : {shot.evidence.bounceDetected ? 'Oui' : 'Non'}</span>
                  </div>
                  <ul className="pt-1 space-y-1 text-xs text-slate-300">
                    {shot.evidence.analysisNotes.map((note, idx) => (
                      <li key={idx}>• {note}</li>
                    ))}
                  </ul>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#070B14] p-4 space-y-3">
                  <h3 className="text-xs font-semibold text-slate-300">
                    Validation, réexamen & correction manuelle
                  </h3>
                  {archive && archive.frames.length >= 4 && (
                    <button
                      type="button"
                      onClick={() => void handleAutoReanalyze()}
                      disabled={reanalyzing}
                      className={`flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg border px-3 text-xs font-semibold ${
                        shot.result === 'UNCERTAIN'
                          ? 'border-[#38BDF8] bg-[#4F7CFF] text-white hover:bg-[#3E6AE8]'
                          : 'border-[#38BDF8]/50 bg-[#0E1525] text-[#38BDF8] hover:bg-[#38BDF8]/10'
                      } disabled:opacity-50`}
                    >
                      <RefreshCw className={`h-4 w-4 ${reanalyzing ? 'animate-spin' : ''}`} />
                      {reanalyzing
                        ? 'Réanalyse approfondie en cours…'
                        : shot.result === 'UNCERTAIN'
                          ? 'Réexaminer ce tir incertain (passe fine)'
                          : 'Réanalyser l’extrait vidéo'}
                    </button>
                  )}
                  {reanalyzeFeedback && (
                    <p className="rounded-lg border border-slate-700 bg-[#0E1525] px-3 py-2 text-[11px] text-slate-200">
                      {reanalyzeFeedback}
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={handleConfirm}
                      className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25"
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      Confirmer
                    </button>
                    <button
                      type="button"
                      onClick={() => setCorrectingImpact((c) => !c)}
                      className={`flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${
                        correctingImpact
                          ? 'border-[#38BDF8] bg-[#38BDF8]/20 text-[#38BDF8]'
                          : 'border-slate-700 bg-[#0E1525] text-slate-200 hover:border-[#38BDF8]'
                      }`}
                    >
                      <Crosshair className="h-4 w-4" />
                      {correctingImpact ? 'Annuler pointage' : 'Corriger impact'}
                    </button>
                    <button
                      type="button"
                      onClick={handleMarkUncertain}
                      className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
                    >
                      <HelpCircle className="h-4 w-4" />
                      Impact incertain
                    </button>
                    <button
                      type="button"
                      onClick={handleDismiss}
                      className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 text-xs font-medium text-red-300 hover:bg-red-500/20"
                    >
                      <Trash2 className="h-4 w-4" />
                      Faux positif
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
