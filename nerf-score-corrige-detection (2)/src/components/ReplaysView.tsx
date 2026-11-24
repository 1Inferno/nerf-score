import React, {useMemo, useState} from 'react';
import {Archive, Film, Play, Trash2} from 'lucide-react';
import {exportSessionZip} from '../db/indexedDb';
import {ShootingSession, ShotEvent, ShotResult, TargetProfile} from '../types/nerf';
import {ReplayPlayerModal} from './ReplayPlayerModal';

interface ReplaysViewProps {
  sessions: ShootingSession[];
  shots: ShotEvent[];
  targets: TargetProfile[];
  initialSessionFilter?: string | null;
  onUpdateShot: (updated: ShotEvent) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
}

const RESULT_LABELS: Record<ShotResult, {label: string; colorClass: string}> = {
  HIT: {label: 'Réussite', colorClass: 'text-emerald-400'},
  BOUNCE: {label: 'Rebond en cible', colorClass: 'text-[#38BDF8]'},
  MISS: {label: 'Raté / Extérieur', colorClass: 'text-red-400'},
  UNCERTAIN: {label: 'IMPACT INCERTAIN', colorClass: 'text-amber-400'},
};

export const ReplaysView: React.FC<ReplaysViewProps> = ({
  sessions,
  shots,
  targets,
  initialSessionFilter,
  onUpdateShot,
  onDeleteSession,
}) => {
  const [sessionFilter, setSessionFilter] = useState<string>(initialSessionFilter || 'ALL');
  const [resultFilter, setResultFilter] = useState<string>('ALL');
  const [activeShot, setActiveShot] = useState<ShotEvent | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const sessionMap = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const targetMap = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);

  const filteredShots = useMemo(() => {
    return shots.filter((s) => {
      if (s.validationState === 'DISMISSED') return false;
      if (sessionFilter !== 'ALL' && s.sessionId !== sessionFilter) return false;
      if (resultFilter !== 'ALL' && s.result !== resultFilter) return false;
      return true;
    });
  }, [shots, sessionFilter, resultFilter]);

  const handleExportSession = async (sid: string) => {
    setExportStatus('Préparation de l’archive ZIP de la session…');
    try {
      await exportSessionZip(sid);
      setExportStatus('Archive session exportée.');
    } catch (err) {
      setExportStatus(err instanceof Error ? err.message : 'Échec de l’exportation.');
    }
    setTimeout(() => setExportStatus(null), 3500);
  };

  const activeSession = activeShot ? sessionMap.get(activeShot.sessionId) : undefined;
  const activeTarget = activeSession
    ? targetMap.get(activeSession.targetProfileId) || targets[0]
    : targets[0];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F8FAFC]">
            Mes replays
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Bibliothèque des séquences vidéo individuelles avec ralenti réel jusqu’à x8 et vérification d’impact.
          </p>
        </div>

        {sessionFilter !== 'ALL' && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleExportSession(sessionFilter)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-[#0E1525] px-4 text-xs font-medium text-[#F8FAFC] hover:border-[#38BDF8]"
            >
              <Archive className="h-4 w-4 text-[#38BDF8]" />
              Exporter cette session (.zip)
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeleteId(sessionFilter)}
              className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-red-500/40 bg-red-500/10 px-4 text-xs font-medium text-red-300 hover:bg-red-500/20"
            >
              <Trash2 className="h-4 w-4" />
              Supprimer session
            </button>
          </div>
        )}
      </div>

      {exportStatus && (
        <div className="rounded-xl border border-[#38BDF8]/40 bg-[#0E1525] px-4 py-3 text-xs text-[#38BDF8]">
          {exportStatus}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
        <select
          value={sessionFilter}
          onChange={(e) => setSessionFilter(e.target.value)}
          aria-label="Filtrer par session"
          className="min-h-[44px] rounded-xl border border-slate-700 bg-[#070B14] px-3.5 text-xs font-medium text-[#F8FAFC]"
        >
          <option value="ALL">Toutes les sessions ({sessions.length})</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title} — {new Date(s.createdAt).toLocaleDateString('fr-FR')} ({s.summary.totalShots} tirs)
            </option>
          ))}
        </select>

        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-800 bg-[#070B14] p-1">
          {[
            {id: 'ALL', label: 'Tous'},
            {id: 'HIT', label: 'Réussites'},
            {id: 'BOUNCE', label: 'Rebonds'},
            {id: 'MISS', label: 'Ratés'},
            {id: 'UNCERTAIN', label: 'Incertains'},
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setResultFilter(tab.id)}
              className={`min-h-[36px] rounded-lg px-3 text-xs font-medium transition-colors whitespace-nowrap ${
                resultFilter === tab.id
                  ? 'bg-[#4F7CFF] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Shots Grid */}
      {filteredShots.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-800 bg-[#0E1525] p-12 text-center">
          <Film className="mx-auto h-8 w-8 text-slate-600" />
          <p className="mt-3 text-sm font-medium text-slate-200">
            Aucun replay ne correspond à ces critères
          </p>
          <p className="mt-1 text-xs text-slate-400">
            Chaque tir détecté durant une session crée automatiquement sa vidéo individuelle avant/pendant/après impact.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredShots.map((shot) => {
            const sess = sessionMap.get(shot.sessionId);
            const meta = RESULT_LABELS[shot.result];
            return (
              <div
                key={shot.id}
                className="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#0E1525]"
              >
                <button
                  type="button"
                  onClick={() => setActiveShot(shot)}
                  className="group relative aspect-video w-full overflow-hidden bg-[#070B14] text-left"
                >
                  {shot.thumbnailDataUrl ? (
                    <img
                      src={shot.thumbnailDataUrl}
                      alt={`Tir ${shot.shotNumber}`}
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-slate-500">
                      Aperçu indisponible
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
                  <div className="absolute inset-0 flex items-center justify-center opacity-85 transition-opacity group-hover:opacity-100">
                    <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#4F7CFF]/90 text-white shadow-lg">
                      <Play className="h-5 w-5 translate-x-0.5" />
                    </span>
                  </div>
                  <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs font-mono tabular-nums text-white">
                    <span>Tir #{shot.shotNumber}</span>
                    <span>{shot.evidence.captureFpsAtEvent} FPS</span>
                  </div>
                </button>

                <div className="flex flex-1 flex-col justify-between p-4 space-y-3">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-semibold ${meta.colorClass}`}>
                        {meta.label}
                      </span>
                      <span className="font-mono text-sm font-bold tabular-nums text-[#F8FAFC]">
                        {shot.result === 'UNCERTAIN' ? '—' : `${shot.score} pts`}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-sm font-medium text-slate-200">
                      {shot.zoneName}
                    </p>
                    <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
                      {sess?.title ?? 'Session'} · Confiance {Math.round(shot.confidence * 100)}%
                      {shot.impactPoint
                        ? ` · (${(shot.impactPoint.x * 100).toFixed(0)}%, ${(shot.impactPoint.y * 100).toFixed(0)}%)`
                        : ''}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setActiveShot(shot)}
                    className="w-full min-h-[42px] rounded-xl border border-slate-700 bg-[#070B14] text-xs font-semibold text-[#F8FAFC] transition-colors hover:border-[#38BDF8]"
                  >
                    Ouvrir ralenti x1 / x2 / x4 / x8
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Replay Modal */}
      {activeShot && activeSession && activeTarget && (
        <ReplayPlayerModal
          shot={activeShot}
          session={activeSession}
          targetProfile={activeTarget}
          onUpdateShot={async (updated) => {
            await onUpdateShot(updated);
            setActiveShot(updated);
          }}
          onClose={() => setActiveShot(null)}
        />
      )}

      {/* Delete session confirmation modal */}
      {confirmDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
            <h3 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Supprimer cette session ?
            </h3>
            <p className="text-xs leading-relaxed text-slate-300">
              Cette action supprimera définitivement la session, tous ses tirs et ses vidéos associées de la base IndexedDB.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="min-h-[44px] rounded-xl border border-slate-700 px-4 text-xs font-medium text-slate-300"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={async () => {
                  const id = confirmDeleteId;
                  setConfirmDeleteId(null);
                  setSessionFilter('ALL');
                  await onDeleteSession(id);
                }}
                className="min-h-[44px] rounded-xl bg-red-600 px-4 text-xs font-semibold text-white hover:bg-red-500"
              >
                Supprimer définitivement
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
