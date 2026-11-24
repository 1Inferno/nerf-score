export interface RingFrameEntry {
  timestampMs: number;
  gray: Uint8Array;
  rgb?: Uint8Array;
  width: number;
  height: number;
  dataUrl: string;
}

/**
 * Circular frame buffer retaining exact original frames before & after a shot event.
 * Keeps memory bounded while guaranteeing pre-impact + impact + post-impact sequences
 * for multi-pass CV reanalysis and deterministic slow-motion playback (x1, x2, x4, x8).
 */
export class CircularVideoBuffer {
  private buffer: RingFrameEntry[] = [];
  private maxFrames: number;

  constructor(maxFrames = 140) {
    this.maxFrames = Math.max(24, Math.min(180, maxFrames));
  }

  setMaxFrames(maxFrames: number) {
    this.maxFrames = Math.max(24, Math.min(180, maxFrames));
    while (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
  }

  push(entry: RingFrameEntry) {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxFrames) {
      this.buffer.shift();
    }
  }

  getLength(): number {
    return this.buffer.length;
  }

  snapshotPreEvent(preCount: number): RingFrameEntry[] {
    const start = Math.max(0, this.buffer.length - preCount);
    return this.buffer.slice(start);
  }

  clear() {
    this.buffer = [];
  }
}

function writeFrameToImageData(frame: RingFrameEntry, imgData: ImageData): void {
  const {width, height, rgb, gray} = frame;
  const dst = imgData.data;
  const len = width * height;
  if (rgb && rgb.length >= len * 3) {
    for (let i = 0, p = 0, q = 0; i < len; i++, p += 4, q += 3) {
      dst[p] = rgb[q];
      dst[p + 1] = rgb[q + 1];
      dst[p + 2] = rgb[q + 2];
      dst[p + 3] = 255;
    }
  } else {
    for (let i = 0, p = 0; i < len; i++, p += 4) {
      const g = gray[i] ?? 0;
      dst[p] = g;
      dst[p + 1] = g;
      dst[p + 2] = g;
      dst[p + 3] = 255;
    }
  }
}

/**
 * Lazily encodes JPEG thumbnails ONLY for frames belonging to a confirmed/triggered shot event,
 * yielding cleanly every few frames so live camera monitoring FPS is never degraded.
 */
export async function ensureFramesDataUrls(
  frames: RingFrameEntry[],
  quality = 0.78,
): Promise<RingFrameEntry[]> {
  if (frames.length === 0 || typeof document === 'undefined') {
    return frames;
  }
  const needsEncoding = frames.some((f) => !f.dataUrl);
  if (!needsEncoding) return frames;

  const w = frames[0].width;
  const h = frames[0].height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return frames;
  const imgData = ctx.createImageData(w, h);

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame.dataUrl && frame.width === w && frame.height === h) {
      writeFrameToImageData(frame, imgData);
      ctx.putImageData(imgData, 0, 0);
      frame.dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (i % 4 === 3) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }
  return frames;
}

export interface VideoRenderResult {
  blob: Blob | null;
  errorReason?: string;
}

/**
 * Safe video encoder that never hangs indefinitely on MediaRecorder errors or missing onstop events.
 */
export async function renderFrameSequenceToVideoBlobSafe(
  frames: RingFrameEntry[],
  fps: number,
): Promise<VideoRenderResult> {
  if (frames.length < 2) {
    return {blob: null, errorReason: 'Séquence insuffisante (< 2 images) pour l’encodage vidéo.'};
  }
  if (typeof MediaRecorder === 'undefined') {
    return {blob: null, errorReason: 'MediaRecorder indisponible sur ce navigateur.'};
  }

  const srcW = Math.max(1, frames[0].width);
  const srcH = Math.max(1, frames[0].height);
  const targetW = Math.min(960, Math.max(320, srcW * 2));
  const targetH = Math.round((targetW * srcH) / srcW);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof canvas.captureStream !== 'function') {
    return {blob: null, errorReason: 'canvas.captureStream() non supporté sur cet appareil.'};
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d');
  const srcImgData = srcCtx ? srcCtx.createImageData(srcW, srcH) : null;

  const preferredMimes = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  const mimeType = preferredMimes.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';

  let stream: MediaStream;
  let recorder: MediaRecorder;
  try {
    stream = canvas.captureStream(Math.max(15, Math.min(60, Math.round(fps || 30))));
    recorder = mimeType
      ? new MediaRecorder(stream, {mimeType, videoBitsPerSecond: 1_500_000})
      : new MediaRecorder(stream);
  } catch (err) {
    return {
      blob: null,
      errorReason: err instanceof Error ? err.message : 'Échec d’initialisation MediaRecorder.',
    };
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  let settled = false;
  let recorderFailureReason: string | undefined;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const stopPromise = new Promise<VideoRenderResult>((resolve) => {
    const finish = (errorReason?: string) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      stream.getTracks().forEach((t) => t.stop());
      if (errorReason) {
        resolve({blob: null, errorReason});
        return;
      }
      if (chunks.length === 0) {
        resolve({blob: null, errorReason: 'Aucune donnée vidéo produite par MediaRecorder.'});
      } else {
        resolve({blob: new Blob(chunks, {type: mimeType || 'video/webm'})});
      }
    };

    recorder.onstop = () => finish(recorderFailureReason);
    recorder.onerror = (ev) => {
      const msg =
        (ev as Event & {error?: {message?: string}})?.error?.message ||
        'Erreur MediaRecorder pendant l’encodage du replay.';
      recorderFailureReason = msg;
      finish(msg);
    };

    const estimatedTotalMs = Math.max(5000, frames.length * 60 + 4000);
    timeoutId = setTimeout(() => {
      if (!settled) {
        recorderFailureReason = `Délai d’attente dépassé pour MediaRecorder.onstop (${estimatedTotalMs} ms).`;
        try {
          if (recorder.state !== 'inactive') recorder.stop();
        } catch {
          // ignore
        }
        finish(recorderFailureReason);
      }
    }, estimatedTotalMs);
  });

  try {
    recorder.start(100);
    const frameDelayMs = Math.max(16, Math.round(1000 / Math.max(12, Math.min(60, fps || 30))));
    for (const frame of frames) {
      if (srcCtx && srcImgData && frame.width === srcW && frame.height === srcH && frame.gray.length > 0) {
        writeFrameToImageData(frame, srcImgData);
        srcCtx.putImageData(srcImgData, 0, 0);
        ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);
        await new Promise((res) => setTimeout(res, frameDelayMs));
      } else if (frame.dataUrl) {
        await new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, targetW, targetH);
            setTimeout(res, frameDelayMs);
          };
          img.onerror = () => setTimeout(res, frameDelayMs);
          img.src = frame.dataUrl;
        });
      }
    }

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  } catch (err) {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      // ignore
    }
    stream.getTracks().forEach((t) => t.stop());
    return {
      blob: null,
      errorReason: err instanceof Error ? err.message : 'Erreur pendant le rendu des images vidéo.',
    };
  }

  return stopPromise;
}

/**
 * Encodes an array of captured original frames into a real playable WebM video Blob
 * using an offscreen Canvas + MediaRecorder.
 */
export async function renderFrameSequenceToVideoBlob(
  frames: RingFrameEntry[],
  fps: number,
): Promise<Blob | null> {
  const res = await renderFrameSequenceToVideoBlobSafe(frames, fps);
  return res.blob;
}
