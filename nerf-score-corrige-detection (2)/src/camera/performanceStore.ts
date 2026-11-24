import {RuntimePerformanceMetrics} from '../types/nerf';

const INITIAL_METRICS: RuntimePerformanceMetrics = {
  cameraFps: 0,
  analysisFps: 0,
  avgProcessingMs: 0,
  skippedFrames: 0,
  skippedFps: 0,
  workerEnabled: typeof Worker !== 'undefined',
  bufferFrames: 0,
  activeResolution: '—',
  videoFramesDelivered: 0,
  engineFramesAnalyzed: 0,
  lastFrameAgeMs: 0,
  lastTriggerReason: 'En attente de surveillance',
  lastMaxRoiDelta: 0,
  videoReadyState: 0,
  audioAssistanceActive: false,
  audioEventsCount: 0,
  updatedAt: 0,
};

class PerformanceTelemetryStore {
  private metrics: RuntimePerformanceMetrics = {...INITIAL_METRICS};
  private listeners = new Set<(m: RuntimePerformanceMetrics) => void>();

  getSnapshot(): RuntimePerformanceMetrics {
    return {...this.metrics};
  }

  update(patch: Partial<RuntimePerformanceMetrics>) {
    this.metrics = {
      ...this.metrics,
      ...patch,
      updatedAt: Date.now(),
    };
    const snap = this.getSnapshot();
    this.listeners.forEach((cb) => cb(snap));
  }

  subscribe(cb: (m: RuntimePerformanceMetrics) => void): () => void {
    this.listeners.add(cb);
    cb(this.getSnapshot());
    return () => {
      this.listeners.delete(cb);
    };
  }
}

export const performanceStore = new PerformanceTelemetryStore();
