import {ShotEvent, TargetCalibration, TargetProfile} from '../types/nerf';
import {reanalyzeShotSequence} from './visionEngine';

export interface WorkerReanalyzeRequest {
  id: number;
  params: {
    frames: Array<{
      gray: Uint8Array;
      rgb?: Uint8Array;
      width: number;
      height: number;
      timestampMs: number;
    }>;
    triggerIndex: number;
    calibration: TargetCalibration;
    targetProfile: TargetProfile;
    sensitivity: number;
    passes: number;
    captureFps: number;
    sessionId: string;
    shotNumber: number;
    boostSensitivity?: boolean;
  };
}

export interface WorkerReanalyzeResponse {
  id: number;
  result?: Omit<ShotEvent, 'id' | 'videoBlobId' | 'frameSequenceId' | 'thumbnailDataUrl'>;
  error?: string;
}

self.onmessage = (ev: MessageEvent<WorkerReanalyzeRequest>) => {
  const {id, params} = ev.data;
  try {
    const result = reanalyzeShotSequence(params);
    const resp: WorkerReanalyzeResponse = {id, result};
    self.postMessage(resp);
  } catch (err) {
    const resp: WorkerReanalyzeResponse = {
      id,
      error: err instanceof Error ? err.message : 'Erreur worker analyse tir',
    };
    self.postMessage(resp);
  }
};
