import JSZip from 'jszip';
import {
  AppSettings,
  BenchmarkTestRun,
  DEFAULT_SETTINGS,
  DEFAULT_TARGET_PROFILE,
  DiagnosticEventEntry,
  OfficialCalibration,
  ShootingSession,
  ShotEvent,
  ShotFrameArchive,
  TargetProfile,
} from '../types/nerf';

const DB_NAME = 'nerf_score_db';
const DB_VERSION = 3;

const STORES = {
  SESSIONS: 'sessions',
  SHOTS: 'shots',
  VIDEOS: 'videos',
  FRAME_SEQUENCES: 'frame_sequences',
  TARGETS: 'targets',
  CALIBRATIONS: 'calibrations',
  DIAGNOSTICS: 'diagnostics',
  SETTINGS: 'settings',
  BENCHMARKS: 'benchmarks',
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        const s = db.createObjectStore(STORES.SESSIONS, {keyPath: 'id'});
        s.createIndex('createdAt', 'createdAt', {unique: false});
      }
      if (!db.objectStoreNames.contains(STORES.SHOTS)) {
        const sh = db.createObjectStore(STORES.SHOTS, {keyPath: 'id'});
        sh.createIndex('sessionId', 'sessionId', {unique: false});
        sh.createIndex('timestamp', 'timestamp', {unique: false});
      }
      if (!db.objectStoreNames.contains(STORES.VIDEOS)) {
        db.createObjectStore(STORES.VIDEOS, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORES.FRAME_SEQUENCES)) {
        db.createObjectStore(STORES.FRAME_SEQUENCES, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORES.TARGETS)) {
        db.createObjectStore(STORES.TARGETS, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORES.CALIBRATIONS)) {
        const calStore = db.createObjectStore(STORES.CALIBRATIONS, {keyPath: 'id'});
        calStore.createIndex('validatedAt', 'validatedAt', {unique: false});
      }
      if (!db.objectStoreNames.contains(STORES.DIAGNOSTICS)) {
        const diagStore = db.createObjectStore(STORES.DIAGNOSTICS, {keyPath: 'id'});
        diagStore.createIndex('timestamp', 'timestamp', {unique: false});
        diagStore.createIndex('sessionId', 'sessionId', {unique: false});
      }
      if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
        db.createObjectStore(STORES.SETTINGS, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORES.BENCHMARKS)) {
        db.createObjectStore(STORES.BENCHMARKS, {keyPath: 'id'});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbGetAll<T>(storeName: string): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve((req.result as T[]) ?? []);
        req.onerror = () => reject(req.error);
      }),
  );
}

function idbPut<T>(storeName: string, value: T): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbDelete(storeName: string, key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

// --- Settings ---
export async function getSettings(): Promise<AppSettings> {
  const saved = await idbGet<AppSettings>(STORES.SETTINGS, 'default');
  return saved ? {...DEFAULT_SETTINGS, ...saved} : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await idbPut(STORES.SETTINGS, settings);
}

// --- Target Profiles ---
export async function getAllTargetProfiles(): Promise<TargetProfile[]> {
  const list = await idbGetAll<TargetProfile>(STORES.TARGETS);
  if (list.length === 0) {
    await idbPut(STORES.TARGETS, DEFAULT_TARGET_PROFILE);
    return [DEFAULT_TARGET_PROFILE];
  }
  return list.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveTargetProfile(profile: TargetProfile): Promise<void> {
  await idbPut(STORES.TARGETS, profile);
}

export async function deleteTargetProfile(id: string): Promise<void> {
  if (id === DEFAULT_TARGET_PROFILE.id) return;
  await idbDelete(STORES.TARGETS, id);
}

// --- Saved Official Calibrations ---
export async function saveSavedCalibration(cal: OfficialCalibration): Promise<void> {
  const serializable: OfficialCalibration = JSON.parse(JSON.stringify(cal)) as OfficialCalibration;
  await idbPut(STORES.CALIBRATIONS, serializable);
}

export async function getSavedCalibrations(): Promise<OfficialCalibration[]> {
  const list = await idbGetAll<OfficialCalibration>(STORES.CALIBRATIONS);
  return list.sort((a, b) => b.validatedAt - a.validatedAt);
}

export async function getLatestSavedCalibration(): Promise<OfficialCalibration | null> {
  const list = await getSavedCalibrations();
  return list[0] ?? null;
}

// --- Sessions ---
export async function getAllSessions(): Promise<ShootingSession[]> {
  const list = await idbGetAll<ShootingSession>(STORES.SESSIONS);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveSession(session: ShootingSession): Promise<void> {
  await idbPut(STORES.SESSIONS, session);
}

export async function deleteSessionCascade(sessionId: string): Promise<void> {
  const shots = await getShotsBySession(sessionId);
  for (const shot of shots) {
    await idbDelete(STORES.SHOTS, shot.id);
    if (shot.videoBlobId) await idbDelete(STORES.VIDEOS, shot.videoBlobId);
    if (shot.frameSequenceId) await idbDelete(STORES.FRAME_SEQUENCES, shot.frameSequenceId);
  }
  await idbDelete(STORES.SESSIONS, sessionId);
}

// --- Shots, Videos & Frame Sequences ---
export async function getAllShots(): Promise<ShotEvent[]> {
  const list = await idbGetAll<ShotEvent>(STORES.SHOTS);
  return list.sort((a, b) => b.timestamp - a.timestamp);
}

export async function getShotsBySession(sessionId: string): Promise<ShotEvent[]> {
  const all = await getAllShots();
  return all.filter((s) => s.sessionId === sessionId).sort((a, b) => a.shotNumber - b.shotNumber);
}

export async function saveShot(shot: ShotEvent): Promise<void> {
  await idbPut(STORES.SHOTS, shot);
}

export interface StoredVideoBlob {
  id: string;
  shotId: string;
  sessionId: string;
  mimeType: string;
  blob: Blob;
  createdAt: number;
}

export async function saveVideoBlob(record: StoredVideoBlob): Promise<void> {
  await idbPut(STORES.VIDEOS, record);
}

export async function getVideoBlob(id: string): Promise<StoredVideoBlob | undefined> {
  return idbGet<StoredVideoBlob>(STORES.VIDEOS, id);
}

export async function saveFrameSequence(seq: ShotFrameArchive): Promise<void> {
  await idbPut(STORES.FRAME_SEQUENCES, seq);
}

export async function getFrameSequence(id: string): Promise<ShotFrameArchive | undefined> {
  return idbGet<ShotFrameArchive>(STORES.FRAME_SEQUENCES, id);
}

// --- Benchmarks ---
export async function getAllBenchmarks(): Promise<BenchmarkTestRun[]> {
  const list = await idbGetAll<BenchmarkTestRun>(STORES.BENCHMARKS);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveBenchmark(run: BenchmarkTestRun): Promise<void> {
  await idbPut(STORES.BENCHMARKS, run);
}

// --- Diagnostics ---
export async function saveDiagnosticLog(entry: DiagnosticEventEntry): Promise<void> {
  await idbPut(STORES.DIAGNOSTICS, entry);
}

export async function getDiagnosticLogs(limit = 300): Promise<DiagnosticEventEntry[]> {
  const list = await idbGetAll<DiagnosticEventEntry>(STORES.DIAGNOSTICS);
  return list.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export async function clearDiagnosticLogs(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.DIAGNOSTICS, 'readwrite');
    tx.objectStore(STORES.DIAGNOSTICS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Deletes all shot events, shot video clips, frame sequences, and resets session shot stats to 0
 * while strictly preserving calibrated targets (STORES.CALIBRATIONS), target profiles, and settings.
 */
export async function resetAllShotsPreservingCalibration(): Promise<{
  deletedShots: number;
  deletedVideos: number;
  resetSessions: number;
}> {
  const [shots, videos, sessions] = await Promise.all([
    idbGetAll<ShotEvent>(STORES.SHOTS),
    idbGetAll<StoredVideoBlob>(STORES.VIDEOS),
    idbGetAll<ShootingSession>(STORES.SESSIONS),
  ]);

  const db = await openDb();
  await Promise.all(
    [STORES.SHOTS, STORES.VIDEOS, STORES.FRAME_SEQUENCES].map(
      (storeName) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          tx.objectStore(storeName).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    ),
  );

  for (const s of sessions) {
    const zeroed: ShootingSession = {
      ...s,
      summary: {
        totalShots: 0,
        hits: 0,
        misses: 0,
        bounces: 0,
        uncertain: 0,
        confirmedScore: 0,
        averageConfirmedScore: 0,
        bestShotScore: 0,
        confirmedAccuracyPct: 0,
      },
    };
    await idbPut(STORES.SESSIONS, zeroed);
  }

  return {
    deletedShots: shots.length,
    deletedVideos: videos.length,
    resetSessions: sessions.length,
  };
}

// --- Export & Backup / Restore ---
export function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportSessionZip(sessionId: string): Promise<void> {
  const sessions = await getAllSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error('Session introuvable.');
  const shots = await getShotsBySession(sessionId);

  const zip = new JSZip();
  zip.file('session.json', JSON.stringify(session, null, 2));
  zip.file('shots.json', JSON.stringify(shots, null, 2));

  for (const shot of shots) {
    if (shot.videoBlobId) {
      const vid = await getVideoBlob(shot.videoBlobId);
      if (vid) {
        const ext = vid.mimeType.includes('mp4') ? 'mp4' : 'webm';
        zip.file(`videos/tir-${shot.shotNumber}.${ext}`, vid.blob);
      }
    }
  }

  const blob = await zip.generateAsync({type: 'blob'});
  const dateTag = new Date(session.createdAt).toISOString().slice(0, 10);
  triggerDownload(blob, `nerf-score-session-${dateTag}-${session.id.slice(0, 6)}.zip`);
}

export async function exportStatisticsCsv(): Promise<void> {
  const sessions = await getAllSessions();
  const shots = await getAllShots();
  const header = [
    'session_id',
    'session_titre',
    'distance_m',
    'tir_num',
    'horodatage',
    'resultat',
    'zone',
    'score',
    'confiance',
    'statut_confiance',
    'validation',
    'impact_x',
    'impact_y',
  ].join(',');

  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const rows = shots.map((sh) => {
    const sess = sessionMap.get(sh.sessionId);
    return [
      sh.sessionId,
      `"${(sess?.title ?? 'Session').replace(/"/g, '""')}"`,
      sess?.distanceMeters ?? '',
      sh.shotNumber,
      new Date(sh.timestamp).toISOString(),
      sh.result,
      `"${sh.zoneName.replace(/"/g, '""')}"`,
      sh.score,
      sh.confidence,
      sh.confidenceStatus,
      sh.validationState,
      sh.impactPoint ? sh.impactPoint.x.toFixed(4) : '',
      sh.impactPoint ? sh.impactPoint.y.toFixed(4) : '',
    ].join(',');
  });

  const csv = [header, ...rows].join('\n');
  triggerDownload(
    new Blob([csv], {type: 'text/csv;charset=utf-8'}),
    `nerf-score-statistiques-${new Date().toISOString().slice(0, 10)}.csv`,
  );
}

export async function exportFullBackupZip(): Promise<void> {
  const [sessions, shots, targets, calibrations, diagnostics, settings, benchmarks, videos, sequences] = await Promise.all([
    idbGetAll<ShootingSession>(STORES.SESSIONS),
    idbGetAll<ShotEvent>(STORES.SHOTS),
    idbGetAll<TargetProfile>(STORES.TARGETS),
    idbGetAll<OfficialCalibration>(STORES.CALIBRATIONS),
    idbGetAll<DiagnosticEventEntry>(STORES.DIAGNOSTICS),
    getSettings(),
    idbGetAll<BenchmarkTestRun>(STORES.BENCHMARKS),
    idbGetAll<StoredVideoBlob>(STORES.VIDEOS),
    idbGetAll<ShotFrameArchive>(STORES.FRAME_SEQUENCES),
  ]);

  const zip = new JSZip();
  zip.file(
    'backup-manifest.json',
    JSON.stringify(
      {
        app: 'NERF SCORE',
        version: 3,
        exportedAt: new Date().toISOString(),
        counts: {
          sessions: sessions.length,
          shots: shots.length,
          targets: targets.length,
          calibrations: calibrations.length,
          diagnostics: diagnostics.length,
          videos: videos.length,
          sequences: sequences.length,
        },
      },
      null,
      2,
    ),
  );
  zip.file('data/sessions.json', JSON.stringify(sessions));
  zip.file('data/shots.json', JSON.stringify(shots));
  zip.file('data/targets.json', JSON.stringify(targets));
  zip.file('data/calibrations.json', JSON.stringify(calibrations));
  zip.file('data/diagnostics.json', JSON.stringify(diagnostics));
  zip.file('data/settings.json', JSON.stringify(settings));
  zip.file('data/benchmarks.json', JSON.stringify(benchmarks));
  zip.file('data/frame_sequences.json', JSON.stringify(sequences));

  for (const v of videos) {
    zip.file(
      `videos/${v.id}.meta.json`,
      JSON.stringify({id: v.id, shotId: v.shotId, sessionId: v.sessionId, mimeType: v.mimeType, createdAt: v.createdAt}),
    );
    zip.file(`videos/${v.id}.bin`, v.blob);
  }

  const blob = await zip.generateAsync({type: 'blob'});
  triggerDownload(blob, `nerf-score-sauvegarde-${new Date().toISOString().slice(0, 10)}.zip`);
}

export async function restoreFullBackupZip(file: File): Promise<{sessions: number; shots: number}> {
  const zip = await JSZip.loadAsync(file);
  const manifestFile = zip.file('backup-manifest.json');
  if (!manifestFile) {
    throw new Error('Archive invalide : fichier backup-manifest.json introuvable.');
  }

  const readJson = async <T,>(path: string, fallback: T): Promise<T> => {
    const f = zip.file(path);
    if (!f) return fallback;
    return JSON.parse(await f.async('string')) as T;
  };

  const sessions = await readJson<ShootingSession[]>('data/sessions.json', []);
  const shots = await readJson<ShotEvent[]>('data/shots.json', []);
  const targets = await readJson<TargetProfile[]>('data/targets.json', []);
  const calibrations = await readJson<OfficialCalibration[]>('data/calibrations.json', []);
  const diagnostics = await readJson<DiagnosticEventEntry[]>('data/diagnostics.json', []);
  const settings = await readJson<AppSettings>('data/settings.json', DEFAULT_SETTINGS);
  const benchmarks = await readJson<BenchmarkTestRun[]>('data/benchmarks.json', []);
  const sequences = await readJson<ShotFrameArchive[]>('data/frame_sequences.json', []);

  for (const s of sessions) await idbPut(STORES.SESSIONS, s);
  for (const sh of shots) await idbPut(STORES.SHOTS, sh);
  for (const t of targets) await idbPut(STORES.TARGETS, t);
  for (const c of calibrations) await idbPut(STORES.CALIBRATIONS, c);
  for (const d of diagnostics) await idbPut(STORES.DIAGNOSTICS, d);
  await idbPut(STORES.SETTINGS, settings);
  for (const b of benchmarks) await idbPut(STORES.BENCHMARKS, b);
  for (const seq of sequences) await idbPut(STORES.FRAME_SEQUENCES, seq);

  const metaFiles = Object.keys(zip.files).filter((k) => k.startsWith('videos/') && k.endsWith('.meta.json'));
  for (const metaPath of metaFiles) {
    const meta = JSON.parse(await zip.file(metaPath)!.async('string')) as Omit<StoredVideoBlob, 'blob'>;
    const binFile = zip.file(`videos/${meta.id}.bin`);
    if (binFile) {
      const arrayBuf = await binFile.async('arraybuffer');
      await idbPut(STORES.VIDEOS, {
        ...meta,
        blob: new Blob([arrayBuf], {type: meta.mimeType || 'video/webm'}),
      });
    }
  }

  return {sessions: sessions.length, shots: shots.length};
}

export async function clearAllAppData(): Promise<void> {
  const db = await openDb();
  const storeNames = Object.values(STORES);
  await Promise.all(
    storeNames.map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(name, 'readwrite');
          tx.objectStore(name).clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        }),
    ),
  );
  await idbPut(STORES.TARGETS, DEFAULT_TARGET_PROFILE);
  await idbPut(STORES.SETTINGS, DEFAULT_SETTINGS);
}
