import React from 'react';
import {ArrowRight, Camera, Film, Settings2, Target, TrendingUp} from 'lucide-react';
import {AppRoute, ShootingSession, ShotEvent, TargetProfile} from '../types/nerf';

interface HomeViewProps {
  sessions: ShootingSession[];
  shots: ShotEvent[];
  activeTarget: TargetProfile;
  onNavigate: (route: AppRoute) => void;
  onSelectSessionReplays: (sessionId: string) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  sessions,
  shots,
  activeTarget,
  onNavigate,
  onSelectSessionReplays,
}) => {
  const activeShots = shots.filter((s) => s.validationState !== 'DISMISSED');
  const confirmedShots = activeShots.filter((s) => s.result !== 'UNCERTAIN');
  const confirmedHits = confirmedShots.filter(
    (s) => s.result === 'HIT' || s.result === 'BOUNCE',
  );
  const accuracyPct =
    confirmedShots.length > 0
      ? Math.round((confirmedHits.length / confirmedShots.length) * 1000) / 10
      : 0;
  const bestScore = confirmedShots.reduce((m, s) => Math.max(m, s.score), 0);
  const totalPoints = confirmedShots.reduce((acc, s) => acc + s.score, 0);

  return (
    <div className="space-y-8">
      {/* Hero section */}
      <section className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 md:p-8">
        <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-8">
            <p className="text-xs font-medium tracking-wide text-[#38BDF8]">
              Analyse balistique locale · Traitement vidéo hors ligne
            </p>
            <h1 className="font-display text-3xl font-bold tracking-tight text-[#F8FAFC] text-balance md:text-4xl">
              Surveillance de cible, détection rapide et calcul automatique du score
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-slate-300 md:text-base">
              Calibrez votre cible par photographie, surveillez les tirs en continu entre 3 et 10 mètres, capturez chaque impact dans une mémoire tampon circulaire et réanalysez chaque séquence au ralenti.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => onNavigate('session')}
                className="inline-flex min-h-[48px] items-center gap-2.5 rounded-xl bg-[#4F7CFF] px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#3E6AE8] whitespace-nowrap"
              >
                <Camera className="h-4 w-4" />
                Démarrer une nouvelle session
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('settings')}
                className="inline-flex min-h-[48px] items-center gap-2 rounded-xl border border-slate-700 bg-[#070B14] px-5 py-3 text-sm font-medium text-slate-200 transition-colors hover:border-[#38BDF8] whitespace-nowrap"
              >
                <Settings2 className="h-4 w-4 text-[#38BDF8]" />
                Caméra & banc de test
              </button>
            </div>
          </div>

          {/* Active target profile summary */}
          <div className="rounded-xl border border-slate-800 bg-[#070B14] p-5 lg:col-span-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-400">Cible active</span>
              <Target className="h-4 w-4 text-[#38BDF8]" />
            </div>
            <p className="mt-2 font-display text-lg font-semibold text-[#F8FAFC]">
              {activeTarget.name}
            </p>
            <p className="mt-1 text-xs text-slate-400">{activeTarget.description}</p>
            <div className="mt-4 divide-y divide-slate-800/80 border-t border-slate-800/80 pt-2">
              {activeTarget.zones.map((z) => (
                <div key={z.id} className="flex items-center justify-between py-1.5 text-xs">
                  <span className="text-slate-300">{z.name}</span>
                  <span className="font-mono font-semibold tabular-nums text-[#38BDF8]">
                    {z.points} pts
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 4-column real KPI strip */}
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5">
          <p className="text-xs font-medium text-slate-400">Sessions enregistrées</p>
          <p className="mt-2 font-display text-2xl font-bold font-mono tabular-nums text-[#F8FAFC] md:text-3xl">
            {sessions.length}
          </p>
          <p className="mt-1 text-xs text-slate-400">Stockage local IndexedDB</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5">
          <p className="text-xs font-medium text-slate-400">Tirs analysés</p>
          <p className="mt-2 font-display text-2xl font-bold font-mono tabular-nums text-[#F8FAFC] md:text-3xl">
            {activeShots.length}
          </p>
          <p className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            {confirmedShots.length} confirmés · {activeShots.length - confirmedShots.length} incertains
          </p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5">
          <p className="text-xs font-medium text-slate-400">Réussite confirmée</p>
          <p className="mt-2 font-display text-2xl font-bold font-mono tabular-nums text-emerald-400 md:text-3xl">
            {accuracyPct}%
          </p>
          <p className="mt-1 text-xs text-slate-400">Hors impacts incertains</p>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-5">
          <p className="text-xs font-medium text-slate-400">Cumul / Meilleur tir</p>
          <p className="mt-2 font-display text-2xl font-bold font-mono tabular-nums text-[#38BDF8] md:text-3xl">
            {totalPoints} <span className="text-sm font-normal text-slate-400">pts</span>
          </p>
          <p className="mt-1 text-xs font-mono tabular-nums text-slate-400">
            Record : {bestScore} pts
          </p>
        </div>
      </section>

      {/* Recent sessions & quick access */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 lg:col-span-8">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
              Sessions récentes
            </h2>
            {sessions.length > 0 && (
              <button
                type="button"
                onClick={() => onNavigate('replays')}
                className="text-xs font-medium text-[#38BDF8] hover:underline"
              >
                Voir tous les replays
              </button>
            )}
          </div>

          {sessions.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-slate-800 bg-[#070B14] p-8 text-center">
              <p className="text-sm font-medium text-slate-200">
                Aucune session enregistrée pour le moment
              </p>
              <p className="mt-1 text-xs text-slate-400">
                Démarrez une session pour photographier votre cible, calibrer son contour bleu et enregistrer vos premiers tirs.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('session')}
                className="mt-4 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#4F7CFF] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#3E6AE8]"
              >
                <Camera className="h-4 w-4" />
                Calibrer une cible
              </button>
            </div>
          ) : (
            <div className="mt-4 divide-y divide-slate-800/80">
              {sessions.slice(0, 6).map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSelectSessionReplays(session.id)}
                  className="flex w-full min-h-[60px] items-center justify-between gap-4 py-3.5 text-left transition-colors hover:bg-slate-800/30 rounded-lg px-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#F8FAFC]">
                      {session.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400 font-mono tabular-nums">
                      {new Date(session.createdAt).toLocaleDateString('fr-FR')} · {session.distanceMeters} m ·{' '}
                      {session.cameraMetrics.actualMeasuredFps} FPS · {session.summary.totalShots} tirs
                    </p>
                  </div>
                  <div className="shrink-0 text-right font-mono tabular-nums">
                    <p className="text-sm font-bold text-[#38BDF8]">
                      {session.summary.confirmedScore} pts
                    </p>
                    <p className="text-xs text-emerald-400">
                      {session.summary.confirmedAccuracyPct}% réussite
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Workflow checklist */}
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 lg:col-span-4 space-y-4">
          <h2 className="font-display text-lg font-semibold text-[#F8FAFC]">
            Protocole de tir recommandé
          </h2>
          <ol className="space-y-3 text-xs leading-relaxed text-slate-300">
            <li>
              <strong className="text-[#F8FAFC]">1. Photographie de référence :</strong> Cadrez la cible bien éclairée et validez son contour bleu ou corrigez les 4 coins manuellement.
            </li>
            <li>
              <strong className="text-[#F8FAFC]">2. Distance 3 à 10 m :</strong> Stabilisez le téléphone (trépied conseillé) et vérifiez l’alerte de visibilité.
            </li>
            <li>
              <strong className="text-[#F8FAFC]">3. Surveillance continue :</strong> Chaque mouvement rapide déclenche l’enregistrement circulaire pré/post impact sans couper le flux.
            </li>
            <li>
              <strong className="text-[#F8FAFC]">4. Réanalyse & Ralenti :</strong> Contrôlez chaque séquence image par image jusqu’à x8 dans Mes replays.
            </li>
          </ol>

          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              type="button"
              onClick={() => onNavigate('replays')}
              className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#070B14] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
            >
              <Film className="h-4 w-4 text-[#38BDF8]" />
              Mes replays
            </button>
            <button
              type="button"
              onClick={() => onNavigate('stats')}
              className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#070B14] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
            >
              <TrendingUp className="h-4 w-4 text-[#4F7CFF]" />
              Statistiques
            </button>
          </div>
        </div>
      </section>
    </div>
  );
};
