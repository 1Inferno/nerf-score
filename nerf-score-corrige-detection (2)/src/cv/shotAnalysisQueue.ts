import {
  saveDiagnosticLog,
  saveFrameSequence,
  saveShot,
  saveVideoBlob,
} from '../db/indexedDb';
import {
  DiagnosticEventEntry,
  DiagnosticLogStage,
  DiagnosticLogStatus,
  ShotEvent,
  TargetCalibration,
  TargetProfile,
} from '../types/nerf';
import {
  ensureFramesDataUrls,
  renderFrameSequenceToVideoBlobSafe,
  RingFrameEntry,
} from '../video/circularBuffer';
import {ReanalyzeOutput, ReanalyzeParams, reanalyzeShotInWorker} from './visionWorkerClient';

export interface ShotAnalysisTaskInput {
  shotId: string;
  sessionId: string;
  shotNumber: number;
  frames: RingFrameEntry[];
  triggerIndex: number;
  calibration: TargetCalibration;
  targetProfile: TargetProfile;
  sensitivity: number;
  passes: number;
  captureFps: number;
  interruptedCaptureReason?: string;
  audioCorroborated?: boolean;
  audioEventTimestampMs?: number;
  audioRecoveryNote?: string;
}

export type PendingShotStage = 'CAPTURING' | 'QUEUED' | 'ANALYZING';

export interface LivePendingShotEvent {
  shotId: string;
  shotNumber: number;
  sessionId: string;
  status: PendingShotStage;
  capturedPostFrames: number;
  targetPostCount: number;
  createdAt: number;
}

export interface ShotQueueError {
  id: string;
  shotId: string;
  sessionId: string;
  shotNumber: number;
  message: string;
  timestamp: number;
}

export interface ShotQueueSnapshot {
  queuedCount: number;
  capturingCount: number;
  videoExportQueuedCount: number;
  processingShotId: string | null;
  processingShotNumber: number | null;
  completedCount: number;
  uncertainCount: number;
  errorCount: number;
  recentLogs: DiagnosticEventEntry[];
}

export interface ShotAnalysisDependencies {
  reanalyze?: (params: ReanalyzeParams) => ReanalyzeOutput | Promise<ReanalyzeOutput>;
  ensureDataUrls?: typeof ensureFramesDataUrls;
  persistFrameSequence?: typeof saveFrameSequence;
  persistShot?: typeof saveShot;
  persistVideoBlob?: typeof saveVideoBlob;
  renderVideo?: typeof renderFrameSequenceToVideoBlobSafe;
  persistLog?: typeof saveDiagnosticLog;
}

interface BackgroundVideoTask {
  shot: ShotEvent;
  frames: RingFrameEntry[];
  captureFps: number;
}

/**
 * Isolated FIFO queue for shot event analysis that lives OUTSIDE React's component lifecycle.
 * - A new shot never overwrites, cancels, or drops a previous shot.
 * - Strict deduplication guarantees every shotId executes at most once.
 * - Analysis runs off-thread (Web Worker when supported) and publishes ShotEvent immediately,
 *   while slow WebM MediaRecorder encoding runs independently in a non-blocking background queue.
 */
export class ShotAnalysisQueueManager {
  private queue: ShotAnalysisTaskInput[] = [];
  private videoQueue: BackgroundVideoTask[] = [];
  private capturingMap = new Map<string, LivePendingShotEvent>();
  private seenShotIds = new Set<string>();
  private processingTask: ShotAnalysisTaskInput | null = null;
  private isProcessing = false;
  private isExportingVideo = false;
  private completedCount = 0;
  private uncertainCount = 0;
  private errorCount = 0;
  private recentLogs: DiagnosticEventEntry[] = [];
  private listeners = new Set<(snapshot: ShotQueueSnapshot) => void>();
  private pendingListeners = new Set<(pending: LivePendingShotEvent[]) => void>();
  private shotListeners = new Set<(shot: ShotEvent) => void>();
  private shotUpdatedListeners = new Set<(shot: ShotEvent) => void>();
  private errorListeners = new Set<(err: ShotQueueError) => void>();
  private drainWaiters = new Map<string, Array<() => void>>();
  private deps: Required<ShotAnalysisDependencies>;

  constructor(deps: ShotAnalysisDependencies = {}) {
    this.deps = {
      reanalyze: deps.reanalyze ?? reanalyzeShotInWorker,
      ensureDataUrls: deps.ensureDataUrls ?? ensureFramesDataUrls,
      persistFrameSequence: deps.persistFrameSequence ?? saveFrameSequence,
      persistShot: deps.persistShot ?? saveShot,
      persistVideoBlob: deps.persistVideoBlob ?? saveVideoBlob,
      renderVideo: deps.renderVideo ?? renderFrameSequenceToVideoBlobSafe,
      persistLog: deps.persistLog ?? saveDiagnosticLog,
    };
  }

  getSnapshot(): ShotQueueSnapshot {
    return {
      queuedCount: this.queue.length,
      capturingCount: this.capturingMap.size,
      videoExportQueuedCount: this.videoQueue.length + (this.isExportingVideo ? 1 : 0),
      processingShotId: this.processingTask?.shotId ?? null,
      processingShotNumber: this.processingTask?.shotNumber ?? null,
      completedCount: this.completedCount,
      uncertainCount: this.uncertainCount,
      errorCount: this.errorCount,
      recentLogs: [...this.recentLogs],
    };
  }

  getPendingEvents(sessionId?: string): LivePendingShotEvent[] {
    const items: LivePendingShotEvent[] = [];
    for (const cap of this.capturingMap.values()) {
      if (!sessionId || cap.sessionId === sessionId) {
        items.push({...cap});
      }
    }
    if (this.processingTask && (!sessionId || this.processingTask.sessionId === sessionId)) {
      items.push({
        shotId: this.processingTask.shotId,
        shotNumber: this.processingTask.shotNumber,
        sessionId: this.processingTask.sessionId,
        status: 'ANALYZING',
        capturedPostFrames: Math.max(
          0,
          this.processingTask.frames.length - this.processingTask.triggerIndex,
        ),
        targetPostCount: Math.max(
          0,
          this.processingTask.frames.length - this.processingTask.triggerIndex,
        ),
        createdAt: Date.now(),
      });
    }
    for (const q of this.queue) {
      if (!sessionId || q.sessionId === sessionId) {
        items.push({
          shotId: q.shotId,
          shotNumber: q.shotNumber,
          sessionId: q.sessionId,
          status: 'QUEUED',
          capturedPostFrames: Math.max(0, q.frames.length - q.triggerIndex),
          targetPostCount: Math.max(0, q.frames.length - q.triggerIndex),
          createdAt: Date.now(),
        });
      }
    }
    return items.sort((a, b) => b.shotNumber - a.shotNumber);
  }

  subscribeState(cb: (snapshot: ShotQueueSnapshot) => void): () => void {
    this.listeners.add(cb);
    cb(this.getSnapshot());
    return () => {
      this.listeners.delete(cb);
    };
  }

  subscribePendingEvents(cb: (pending: LivePendingShotEvent[]) => void): () => void {
    this.pendingListeners.add(cb);
    cb(this.getPendingEvents());
    return () => {
      this.pendingListeners.delete(cb);
    };
  }

  subscribeShotCompleted(cb: (shot: ShotEvent) => void): () => void {
    this.shotListeners.add(cb);
    return () => {
      this.shotListeners.delete(cb);
    };
  }

  subscribeShotUpdated(cb: (shot: ShotEvent) => void): () => void {
    this.shotUpdatedListeners.add(cb);
    return () => {
      this.shotUpdatedListeners.delete(cb);
    };
  }

  subscribeError(cb: (err: ShotQueueError) => void): () => void {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  private emitState() {
    const snap = this.getSnapshot();
    const pending = this.getPendingEvents();
    this.listeners.forEach((cb) => cb(snap));
    this.pendingListeners.forEach((cb) => cb(pending));
  }

  registerCaptureStarted(params: {
    shotId: string;
    shotNumber: number;
    sessionId: string;
    targetPostCount: number;
  }): void {
    this.capturingMap.set(params.shotId, {
      shotId: params.shotId,
      shotNumber: params.shotNumber,
      sessionId: params.sessionId,
      status: 'CAPTURING',
      capturedPostFrames: 0,
      targetPostCount: params.targetPostCount,
      createdAt: Date.now(),
    });
    this.emitState();
  }

  updateCaptureProgress(shotId: string, capturedPostFrames: number): void {
    const entry = this.capturingMap.get(shotId);
    if (!entry) return;
    entry.capturedPostFrames = capturedPostFrames;
  }

  async recordDiagnostic(params: {
    shotId: string;
    sessionId: string;
    shotNumber: number;
    status: DiagnosticLogStatus;
    stage: DiagnosticLogStage;
    message: string;
    reason?: string;
    durationMs?: number;
    details?: string;
  }): Promise<DiagnosticEventEntry> {
    const entry: DiagnosticEventEntry = {
      id: `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      shotId: params.shotId,
      sessionId: params.sessionId,
      shotNumber: params.shotNumber,
      status: params.status,
      stage: params.stage,
      message: params.message,
      reason: params.reason,
      timestamp: Date.now(),
      durationMs: params.durationMs,
      details: params.details,
    };
    this.recentLogs = [entry, ...this.recentLogs].slice(0, 140);
    if (typeof console !== 'undefined') {
      console.info(
        `[NERF-SCORE][${entry.status}][${entry.shotId}] ${entry.message}${
          entry.reason ? ` — Raison : ${entry.reason}` : ''
        }`,
      );
    }
    try {
      await this.deps.persistLog(entry);
    } catch (err) {
      if (typeof console !== 'undefined') {
        console.warn('[NERF-SCORE] Échec de persistance du journal diagnostic IndexedDB:', err);
      }
    }
    this.emitState();
    return entry;
  }

  clearRecentDiagnostics(): void {
    this.recentLogs = [];
    this.emitState();
  }

  /**
   * Enqueues a captured shot event without interrupting or cancelling any prior event.
   * Deduplicates strictly by shotId so no event is ever analyzed twice.
   */
  enqueue(task: ShotAnalysisTaskInput): void {
    this.capturingMap.delete(task.shotId);
    if (this.seenShotIds.has(task.shotId)) {
      this.emitState();
      return;
    }
    this.seenShotIds.add(task.shotId);

    const clonedTask: ShotAnalysisTaskInput = {
      ...task,
      frames: [...task.frames],
    };
    this.queue.push(clonedTask);

    if (clonedTask.interruptedCaptureReason) {
      void this.recordDiagnostic({
        shotId: clonedTask.shotId,
        sessionId: clonedTask.sessionId,
        shotNumber: clonedTask.shotNumber,
        status: 'INTERRUPTED',
        stage: 'CAPTURE',
        message: `Capture post-impact du tir #${clonedTask.shotNumber} interrompue avant la fin de fenêtre`,
        reason: clonedTask.interruptedCaptureReason,
        details: `${clonedTask.frames.length} images transmises en analyse`,
      });
    }

    void this.recordDiagnostic({
      shotId: clonedTask.shotId,
      sessionId: clonedTask.sessionId,
      shotNumber: clonedTask.shotNumber,
      status: 'QUEUED',
      stage: 'QUEUE',
      message: `Tir #${clonedTask.shotNumber} mis en file d’attente (${clonedTask.frames.length} images)`,
      details: `Position file : ${this.queue.length}`,
    });

    this.emitState();
    void this.drainQueue();
  }

  /**
   * Records an event that could not gather the minimum 4 frames needed for CV analysis.
   */
  recordDroppedCapture(params: {
    shotId: string;
    sessionId: string;
    shotNumber: number;
    capturedCount: number;
    reason: string;
  }): void {
    this.capturingMap.delete(params.shotId);
    this.errorCount++;
    void this.recordDiagnostic({
      shotId: params.shotId,
      sessionId: params.sessionId,
      shotNumber: params.shotNumber,
      status: 'INTERRUPTED',
      stage: 'CAPTURE',
      message: `Capture du tir #${params.shotNumber} impossible à analyser (${params.capturedCount} images)`,
      reason: params.reason,
    });
    const errPayload: ShotQueueError = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      shotId: params.shotId,
      sessionId: params.sessionId,
      shotNumber: params.shotNumber,
      message: `Tir #${params.shotNumber} interrompu avant analyse complète : ${params.reason}`,
      timestamp: Date.now(),
    };
    this.errorListeners.forEach((cb) => cb(errPayload));
    this.emitState();
  }

  private hasPendingForSession(sessionId: string): boolean {
    if (this.processingTask?.sessionId === sessionId) return true;
    return this.queue.some((t) => t.sessionId === sessionId);
  }

  waitForSessionDrain(sessionId: string): Promise<void> {
    if (!this.hasPendingForSession(sessionId)) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const list = this.drainWaiters.get(sessionId) ?? [];
      list.push(resolve);
      this.drainWaiters.set(sessionId, list);
    });
  }

  private notifyDrainIfIdle(sessionId: string) {
    if (this.hasPendingForSession(sessionId)) return;
    const waiters = this.drainWaiters.get(sessionId);
    if (!waiters || waiters.length === 0) return;
    this.drainWaiters.delete(sessionId);
    waiters.forEach((resolve) => resolve());
  }

  private async drainQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        this.processingTask = task;
        this.emitState();
        await this.processSingleTask(task);
        const sid = task.sessionId;
        this.processingTask = null;
        this.emitState();
        this.notifyDrainIfIdle(sid);
      }
    } finally {
      this.isProcessing = false;
      this.processingTask = null;
      this.emitState();
    }
  }

  private enqueueVideoExport(task: BackgroundVideoTask): void {
    this.videoQueue.push(task);
    this.emitState();
    void this.drainVideoQueue();
  }

  private async drainVideoQueue(): Promise<void> {
    if (this.isExportingVideo) return;
    this.isExportingVideo = true;
    try {
      while (this.videoQueue.length > 0) {
        const item = this.videoQueue.shift()!;
        this.emitState();
        try {
          const videoRes = await this.deps.renderVideo(item.frames, item.captureFps || 30);
          if (videoRes.blob) {
            const videoBlobId = `vid-${item.shot.id}`;
            await this.deps.persistVideoBlob({
              id: videoBlobId,
              shotId: item.shot.id,
              sessionId: item.shot.sessionId,
              mimeType: videoRes.blob.type || 'video/webm',
              blob: videoRes.blob,
              createdAt: Date.now(),
            });
            const updatedShot: ShotEvent = {
              ...item.shot,
              videoBlobId,
            };
            await this.deps.persistShot(updatedShot);
            this.shotUpdatedListeners.forEach((cb) => cb(updatedShot));
          } else if (videoRes.errorReason) {
            await this.recordDiagnostic({
              shotId: item.shot.id,
              sessionId: item.shot.sessionId,
              shotNumber: item.shot.shotNumber,
              status: 'INTERRUPTED',
              stage: 'VIDEO_EXPORT',
              message: `Encodage vidéo WebM du tir #${item.shot.shotNumber} indisponible (séquence images conservée)`,
              reason: videoRes.errorReason,
            });
          }
        } catch (err) {
          await this.recordDiagnostic({
            shotId: item.shot.id,
            sessionId: item.shot.sessionId,
            shotNumber: item.shot.shotNumber,
            status: 'ERROR',
            stage: 'VIDEO_EXPORT',
            message: `Erreur encodage vidéo WebM du tir #${item.shot.shotNumber}`,
            reason: err instanceof Error ? err.message : 'Erreur export vidéo',
          });
        }
      }
    } finally {
      this.isExportingVideo = false;
      this.emitState();
    }
  }

  private async processSingleTask(task: ShotAnalysisTaskInput): Promise<void> {
    const t0 = performance.now();
    await this.recordDiagnostic({
      shotId: task.shotId,
      sessionId: task.sessionId,
      shotNumber: task.shotNumber,
      status: 'STARTED',
      stage: 'REANALYSIS',
      message: `Début d’analyse du tir #${task.shotNumber} (${task.frames.length} images)`,
    });

    try {
      if (task.frames.length < 4) {
        throw new Error(
          `Nombre d’images capturées insuffisant (${task.frames.length}/4 minimum) pour exécuter l’analyse.`,
        );
      }

      const analyzed = await Promise.resolve(
        this.deps.reanalyze({
          frames: task.frames.map((f) => ({
            gray: f.gray,
            rgb: f.rgb,
            width: f.width,
            height: f.height,
            timestampMs: f.timestampMs,
          })),
          triggerIndex: task.triggerIndex,
          calibration: task.calibration,
          targetProfile: task.targetProfile,
          sensitivity: task.sensitivity,
          passes: task.passes,
          captureFps: task.captureFps,
          sessionId: task.sessionId,
          shotNumber: task.shotNumber,
        }),
      );

      // Encode JPEGs lazily ONLY for the captured shot window so live camera monitoring never drops FPS
      await this.deps.ensureDataUrls(task.frames, 0.78);

      const seqId = `seq-${task.shotId}`;
      const impactFrameIndex = Math.min(task.frames.length - 1, task.triggerIndex);
      const thumbnailDataUrl = task.frames[impactFrameIndex]?.dataUrl || null;

      await this.deps.persistFrameSequence({
        id: seqId,
        shotId: task.shotId,
        sessionId: task.sessionId,
        captureFps: Math.max(15, Math.round(task.captureFps || 30)),
        width: task.frames[0]?.width ?? 320,
        height: task.frames[0]?.height ?? 180,
        impactFrameIndex,
        frames: task.frames.map((f) => ({dataUrl: f.dataUrl, timestampMs: f.timestampMs})),
      });

      const mergedNotes = task.audioRecoveryNote
        ? [...analyzed.evidence.analysisNotes, task.audioRecoveryNote]
        : analyzed.evidence.analysisNotes;

      const fullShot: ShotEvent = {
        ...analyzed,
        id: task.shotId,
        videoBlobId: null,
        frameSequenceId: seqId,
        thumbnailDataUrl,
        evidence: {
          ...analyzed.evidence,
          analysisNotes: mergedNotes,
          audioCorroborated: task.audioCorroborated ?? analyzed.evidence.audioCorroborated,
          audioEventTimestampMs: task.audioEventTimestampMs ?? analyzed.evidence.audioEventTimestampMs,
        },
      };

      await this.deps.persistShot(fullShot);
      this.completedCount++;
      if (fullShot.result === 'UNCERTAIN') {
        this.uncertainCount++;
      }
      const durationMs = Math.round(performance.now() - t0);

      await this.recordDiagnostic({
        shotId: task.shotId,
        sessionId: task.sessionId,
        shotNumber: task.shotNumber,
        status: 'COMPLETED',
        stage: 'PERSISTENCE',
        message: `Fin d’analyse du tir #${task.shotNumber} : ${fullShot.result} · ${fullShot.zoneName} (${fullShot.score} pts)`,
        durationMs,
      });

      // Immediately emit result before non-blocking WebM video export
      this.shotListeners.forEach((cb) => cb(fullShot));

      // Schedule non-blocking WebM video encoding in background
      this.enqueueVideoExport({
        shot: fullShot,
        frames: task.frames,
        captureFps: task.captureFps || 30,
      });
    } catch (err) {
      this.errorCount++;
      const durationMs = Math.round(performance.now() - t0);
      const errMsg =
        err instanceof Error ? err.message : 'Erreur inconnue pendant l’analyse du tir.';

      await this.recordDiagnostic({
        shotId: task.shotId,
        sessionId: task.sessionId,
        shotNumber: task.shotNumber,
        status: 'ERROR',
        stage: 'REANALYSIS',
        message: `Échec de l’analyse du tir #${task.shotNumber}`,
        reason: errMsg,
        durationMs,
      });

      const errPayload: ShotQueueError = {
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        shotId: task.shotId,
        sessionId: task.sessionId,
        shotNumber: task.shotNumber,
        message: errMsg,
        timestamp: Date.now(),
      };
      this.errorListeners.forEach((cb) => cb(errPayload));
    }
  }
}

export const shotAnalysisQueue = new ShotAnalysisQueueManager();
