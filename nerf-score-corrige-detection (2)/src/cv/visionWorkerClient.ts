import {ShotEvent} from '../types/nerf';
import {reanalyzeShotSequence} from './visionEngine';
import type {WorkerReanalyzeRequest, WorkerReanalyzeResponse} from './visionWorker';

export type ReanalyzeParams = Parameters<typeof reanalyzeShotSequence>[0];
export type ReanalyzeOutput = Omit<
  ShotEvent,
  'id' | 'videoBlobId' | 'frameSequenceId' | 'thumbnailDataUrl'
>;

let workerInstance: Worker | null = null;
let workerFailed = false;
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  {resolve: (val: ReanalyzeOutput) => void; reject: (err: Error) => void}
>();

function getOrCreateWorker(): Worker | null {
  if (workerFailed || typeof Worker === 'undefined') return null;
  if (workerInstance) return workerInstance;

  try {
    const w = new Worker(new URL('./visionWorker.ts', import.meta.url), {type: 'module'});
    w.onmessage = (ev: MessageEvent<WorkerReanalyzeResponse>) => {
      const {id, result, error} = ev.data;
      const entry = pendingRequests.get(id);
      if (!entry) return;
      pendingRequests.delete(id);
      if (error) {
        entry.reject(new Error(error));
      } else if (result) {
        entry.resolve(result);
      } else {
        entry.reject(new Error('Réponse worker vide'));
      }
    };
    w.onerror = () => {
      workerFailed = true;
      workerInstance = null;
      const entries = Array.from(pendingRequests.values());
      pendingRequests.clear();
      entries.forEach((e) => e.reject(new Error('Worker interrompu, bascule thread local')));
    };
    workerInstance = w;
    return workerInstance;
  } catch {
    workerFailed = true;
    return null;
  }
}

export function isVisionWorkerActive(): boolean {
  return !workerFailed && typeof Worker !== 'undefined';
}

export async function reanalyzeShotInWorker(params: ReanalyzeParams): Promise<ReanalyzeOutput> {
  const worker = getOrCreateWorker();
  if (!worker) {
    return reanalyzeShotSequence(params);
  }

  try {
    return await new Promise<ReanalyzeOutput>((resolve, reject) => {
      const id = nextRequestId++;
      pendingRequests.set(id, {resolve, reject});
      const payload: WorkerReanalyzeRequest = {id, params};
      worker.postMessage(payload);
    });
  } catch {
    // Graceful direct fallback if worker initialization or message failed
    return reanalyzeShotSequence(params);
  }
}
