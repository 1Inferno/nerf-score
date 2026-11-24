import {TargetCalibration} from '../types/nerf';
import {RingFrameEntry} from '../video/circularBuffer';
import {MotionDetector} from '../cv/visionEngine';

export interface AudioImpactEvent {
  id: string;
  timestampMs: number;
  peakAmplitude: number;
  noiseFloor: number;
  snrRatio: number;
  crestFactor: number;
}

export type AudioDetectorStatus = 'off' | 'starting' | 'active' | 'denied' | 'unavailable';

export interface AudioStartResult {
  status: AudioDetectorStatus;
  message: string;
}

/**
 * Pure audio transient scorer (also testable offline on PCM Float32 buffers).
 * Distinguishes brief sharp impact snaps (high peak/noise SNR + high crest factor)
 * from continuous voice or background room noise.
 */
export function evaluateAudioFrameTransient(
  samples: Float32Array,
  noiseFloor: number,
): {
  isImpactSnap: boolean;
  peak: number;
  rms: number;
  snrRatio: number;
  crestFactor: number;
  nextNoiseFloor: number;
} {
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = samples[i] < 0 ? -samples[i] : samples[i];
    if (abs > peak) peak = abs;
    sumSq += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSq / Math.max(1, samples.length));
  const safeFloor = Math.max(0.006, noiseFloor);
  const snrRatio = peak / safeFloor;
  const crestFactor = peak / Math.max(0.004, rms);

  // Sharp impact: brief high-peak impulsive pop well above ambient noise floor
  const isImpactSnap =
    peak >= Math.max(0.075, safeFloor * 4.5) &&
    snrRatio >= 4.5 &&
    crestFactor >= 2.8;

  // Adapt noise floor smoothly only when not spiking
  const nextNoiseFloor = isImpactSnap
    ? noiseFloor
    : noiseFloor * 0.92 + Math.max(0.004, rms) * 0.08;

  return {
    isImpactSnap,
    peak,
    rms,
    snrRatio,
    crestFactor,
    nextNoiseFloor,
  };
}

/**
 * Checks whether a timestamped audio transient coincides with real localized visual change
 * inside the calibrated target ROI in recent buffered video frames.
 * Audio NEVER creates a shot event without real visual evidence in the target zone.
 */
export function correlateAudioEventWithVideoBuffer(params: {
  audioTimestampMs: number;
  recentFrames: RingFrameEntry[];
  calibration: TargetCalibration;
  baseSensitivity: number;
  minMotionAreaRatio: number;
}): {
  hasVisualEvidence: boolean;
  triggerIndex: number;
  peakDelta: number;
  blobsCount: number;
} {
  const {audioTimestampMs, recentFrames, calibration, baseSensitivity, minMotionAreaRatio} = params;
  if (recentFrames.length < 4) {
    return {hasVisualEvidence: false, triggerIndex: -1, peakDelta: 0, blobsCount: 0};
  }

  // Isolate window [audioTs - 500ms .. audioTs + 300ms]
  const winFrames = recentFrames.filter(
    (f) => f.timestampMs >= audioTimestampMs - 500 && f.timestampMs <= audioTimestampMs + 300,
  );
  const scanFrames = winFrames.length >= 4 ? winFrames : recentFrames.slice(-Math.min(14, recentFrames.length));

  const detector = new MotionDetector();
  const refinedSensitivity = Math.max(11, Math.round(baseSensitivity * 0.72));
  let bestIdx = -1;
  let bestDelta = 0;
  let bestBlobs = 0;

  for (let i = 0; i < scanFrames.length; i++) {
    const f = scanFrames[i];
    const step = detector.processFrame(
      f.gray,
      f.width,
      f.height,
      calibration,
      refinedSensitivity,
      minMotionAreaRatio,
      f.rgb ?? null,
    );
    if (step.hasSignificantMotion && !step.globalShakeDetected && step.maxPixelDelta > bestDelta) {
      bestDelta = step.maxPixelDelta;
      bestBlobs = step.blobs.length;
      const globalIdx = recentFrames.indexOf(f);
      bestIdx = globalIdx >= 0 ? globalIdx : i;
    }
  }

  return {
    hasVisualEvidence: bestBlobs > 0 && bestIdx >= 1,
    triggerIndex: bestIdx,
    peakDelta: Math.round(bestDelta * 10) / 10,
    blobsCount: bestBlobs,
  };
}

/**
 * Optional browser microphone transient detector using Web Audio API.
 * Fails gracefully if permission is denied or microphone hardware is absent.
 */
export class AudioImpactDetector {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId = 0;
  private running = false;
  private noiseFloor = 0.015;
  private lastEventTs = 0;

  async start(onEvent: (ev: AudioImpactEvent) => void): Promise<AudioStartResult> {
    this.stop();

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function' ||
      typeof AudioContext === 'undefined'
    ) {
      return {
        status: 'unavailable',
        message: 'API microphone / Web Audio indisponible sur ce navigateur.',
      };
    }

    try {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: false,
        });
      } catch {
        this.stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      }

      const ctx = new AudioContext();
      this.audioCtx = ctx;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      const source = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      this.analyser = analyser;

      const buf = new Float32Array(analyser.fftSize);
      this.noiseFloor = 0.015;
      this.lastEventTs = 0;
      this.running = true;

      const tick = () => {
        if (!this.running || !this.analyser) return;
        this.analyser.getFloatTimeDomainData(buf);
        const now = performance.now();
        const evalRes = evaluateAudioFrameTransient(buf, this.noiseFloor);
        this.noiseFloor = evalRes.nextNoiseFloor;

        if (evalRes.isImpactSnap && now - this.lastEventTs > 220) {
          this.lastEventTs = now;
          onEvent({
            id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestampMs: now,
            peakAmplitude: Math.round(evalRes.peak * 1000) / 1000,
            noiseFloor: Math.round(evalRes.nextNoiseFloor * 1000) / 1000,
            snrRatio: Math.round(evalRes.snrRatio * 10) / 10,
            crestFactor: Math.round(evalRes.crestFactor * 10) / 10,
          });
        }

        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);

      return {
        status: 'active',
        message: 'Assistance audio active (corrélation locale sans enregistrement).',
      };
    } catch (err) {
      this.stop();
      const msg = err instanceof Error ? err.message : '';
      const isDenied =
        msg.toLowerCase().includes('denied') ||
        msg.toLowerCase().includes('permission') ||
        msg.toLowerCase().includes('notallowed');
      return {
        status: isDenied ? 'denied' : 'unavailable',
        message: isDenied
          ? 'Autorisation microphone refusée — détection vidéo seule conservée.'
          : 'Microphone indisponible — détection vidéo seule conservée.',
      };
    }
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch {
        // ignore
      }
      this.analyser = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
  }
}
