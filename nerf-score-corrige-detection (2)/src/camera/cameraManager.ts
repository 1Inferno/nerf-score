import {CameraCapabilities} from '../types/nerf';

export function buildHardwareFpsExplanation(
  requestedFps: number,
  measuredFps: number,
  maxCapFps: number | null,
): string {
  if (measuredFps <= 0) {
    return 'Flux caméra inactif ou en attente d’initialisation.';
  }
  if (requestedFps > 60 && measuredFps <= 62) {
    return `Fréquence demandée (${requestedFps} FPS) limitée par l’API WebRTC / navigateur à ${measuredFps} FPS réel (max capteur exposé : ${maxCapFps ?? 'non exposé'} FPS). Pour dépasser 60 FPS sur mobile (120/240 FPS), une capture native Android Camera2 HighSpeedCaptureSession ou iOS AVFoundation est requise.`;
  }
  if (measuredFps < requestedFps - 5) {
    return `Le capteur ou l’éclairage actuel limite le flux réel à ${measuredFps} FPS (demandé : ${requestedFps} FPS).`;
  }
  return `Flux stable mesuré à ${measuredFps} FPS réels.`;
}

export async function startCameraStream(
  videoEl: HTMLVideoElement,
  requestedFps: 30 | 60 | 120 | 240,
  preferredResolution: '720p' | '1080p',
  deviceId?: string,
): Promise<{stream: MediaStream; capabilities: CameraCapabilities}> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error(
      'L’API WebRTC caméra (getUserMedia) n’est pas disponible sur ce navigateur ou contexte (HTTPS requis).',
    );
  }

  const targetWidth = preferredResolution === '1080p' ? 1920 : 1280;
  const targetHeight = preferredResolution === '1080p' ? 1080 : 720;

  const videoConstraints: MediaTrackConstraints = {
    facingMode: deviceId ? undefined : {ideal: 'environment'},
    deviceId: deviceId ? {exact: deviceId} : undefined,
    width: {ideal: targetWidth},
    height: {ideal: targetHeight},
    frameRate: {ideal: requestedFps, max: requestedFps},
  };

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
  } catch (err) {
    // Fallback without strict frameRate constraint if mobile browser rejects high FPS request
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: {ideal: 'environment'},
        width: {ideal: targetWidth},
        height: {ideal: targetHeight},
      },
      audio: false,
    });
  }

  videoEl.srcObject = stream;
  videoEl.playsInline = true;
  videoEl.muted = true;
  await videoEl.play();

  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const caps =
    typeof track.getCapabilities === 'function'
      ? (track.getCapabilities() as MediaTrackCapabilities & {
          frameRate?: {min?: number; max?: number};
        })
      : undefined;

  const maxSupportedFps = caps?.frameRate?.max ?? null;
  const minSupportedFps = caps?.frameRate?.min ?? null;
  const reportedTrackFps = settings.frameRate ? Math.round(settings.frameRate * 10) / 10 : null;
  const w = settings.width || videoEl.videoWidth || targetWidth;
  const h = settings.height || videoEl.videoHeight || targetHeight;

  const initialMeasured = reportedTrackFps ?? 0;

  return {
    stream,
    capabilities: {
      requestedFps,
      actualMeasuredFps: initialMeasured,
      reportedTrackFps,
      maxSupportedFps,
      minSupportedFps,
      width: w,
      height: h,
      facingMode: settings.facingMode || 'environment',
      deviceLabel: track.label || 'Caméra arrière',
      analysisFps: 0,
      playbackFps: 0,
      avgProcessingMs: 0,
      status: 'active',
      errorMessage: null,
      hardwareLimitExplanation: buildHardwareFpsExplanation(
        requestedFps,
        initialMeasured,
        maxSupportedFps,
      ),
    },
  };
}

export function stopCameraStream(stream: MediaStream | null, videoEl?: HTMLVideoElement | null) {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
  }
  if (videoEl) {
    videoEl.srcObject = null;
  }
}

export async function listVideoCameras(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

/**
 * Measures true video frame delivery cadence using requestVideoFrameCallback when supported,
 * falling back to video.currentTime delta detection under requestAnimationFrame.
 */
export class FrameRateMeter {
  private timestamps: number[] = [];
  private analysisTimestamps: number[] = [];
  private skippedTimestamps: number[] = [];
  private processingTimes: number[] = [];
  private totalSkippedCount = 0;
  private totalAnalyzedCount = 0;

  recordVideoFrame(now = performance.now()) {
    this.timestamps.push(now);
    const cutoff = now - 1200;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  recordAnalysisFrame(processingMs: number, now = performance.now()) {
    this.totalAnalyzedCount++;
    this.analysisTimestamps.push(now);
    this.processingTimes.push(processingMs);
    const cutoff = now - 1200;
    while (this.analysisTimestamps.length > 0 && this.analysisTimestamps[0] < cutoff) {
      this.analysisTimestamps.shift();
      this.processingTimes.shift();
    }
  }

  recordSkippedFrame(now = performance.now()) {
    this.totalSkippedCount++;
    this.skippedTimestamps.push(now);
    const cutoff = now - 1200;
    while (this.skippedTimestamps.length > 0 && this.skippedTimestamps[0] < cutoff) {
      this.skippedTimestamps.shift();
    }
  }

  getCaptureFps(): number {
    if (this.timestamps.length < 2) return 0;
    const span = (this.timestamps[this.timestamps.length - 1] - this.timestamps[0]) / 1000;
    if (span <= 0.1) return 0;
    return Math.round(((this.timestamps.length - 1) / span) * 10) / 10;
  }

  getAnalysisFps(): number {
    if (this.analysisTimestamps.length < 2) return 0;
    const span =
      (this.analysisTimestamps[this.analysisTimestamps.length - 1] - this.analysisTimestamps[0]) /
      1000;
    if (span <= 0.1) return 0;
    return Math.round(((this.analysisTimestamps.length - 1) / span) * 10) / 10;
  }

  getSkippedFps(): number {
    if (this.skippedTimestamps.length === 0) return 0;
    if (this.skippedTimestamps.length === 1) return 0.8;
    const span = Math.max(
      0.5,
      (this.skippedTimestamps[this.skippedTimestamps.length - 1] - this.skippedTimestamps[0]) / 1000,
    );
    return Math.round((this.skippedTimestamps.length / span) * 10) / 10;
  }

  getSkippedTotal(): number {
    return this.totalSkippedCount;
  }

  getAnalyzedTotal(): number {
    return this.totalAnalyzedCount;
  }

  getAvgProcessingMs(): number {
    if (this.processingTimes.length === 0) return 0;
    const sum = this.processingTimes.reduce((a, b) => a + b, 0);
    return Math.round((sum / this.processingTimes.length) * 10) / 10;
  }

  reset() {
    this.timestamps = [];
    this.analysisTimestamps = [];
    this.skippedTimestamps = [];
    this.processingTimes = [];
    this.totalSkippedCount = 0;
    this.totalAnalyzedCount = 0;
  }
}
