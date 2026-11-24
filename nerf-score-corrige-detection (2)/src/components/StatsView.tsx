import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import {Download} from 'lucide-react';
import {exportStatisticsCsv} from '../db/indexedDb';
import {ShootingSession, ShotEvent, TargetProfile} from '../types/nerf';

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  PointElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
);

interface StatsViewProps {
  sessions: ShootingSession[];
  shots: ShotEvent[];
  activeTarget: TargetProfile;
}

export const StatsView: React.FC<StatsViewProps> = ({sessions, shots, activeTarget}) => {
  const [selectedSessionId, setSelectedSessionId] = useState<string>('ALL');
  const [showUncertainOnMap, setShowUncertainOnMap] = useState<boolean>(false);

  const distChartRef = useRef<HTMLCanvasElement | null>(null);
  const evoChartRef = useRef<HTMLCanvasElement | null>(null);
  const compChartRef = useRef<HTMLCanvasElement | null>(null);

  const activeShots = useMemo(
    () =>
      shots.filter(
        (s) =>
          s.validationState !== 'DISMISSED' &&
          (selectedSessionId === 'ALL' || s.sessionId === selectedSessionId),
      ),
    [shots, selectedSessionId],
  );

  const confirmedShots = useMemo(
    () => activeShots.filter((s) => s.result !== 'UNCERTAIN'),
    [activeShots],
  );
  const uncertainShots = useMemo(
    () => activeShots.filter((s) => s.result === 'UNCERTAIN'),
    [activeShots],
  );

  const hits = confirmedShots.filter((s) => s.result === 'HIT' || s.result === 'BOUNCE');
  const misses = confirmedShots.filter((s) => s.result === 'MISS');

  const totalScore = confirmedShots.reduce((sum, s) => sum + s.score, 0);
  const avgScore =
    confirmedShots.length > 0 ? Math.round((totalScore / confirmedShots.length) * 10) / 10 : 0;
  const bestShot = confirmedShots.reduce((max, s) => Math.max(max, s.score), 0);
  const successRate =
    confirmedShots.length > 0
      ? Math.round((hits.length / confirmedShots.length) * 1000) / 10
      : 0;

  // Radial precision: average distance from target center (0.5, 0.5) in % of target radius
  const radialPrecisionPct = useMemo(() => {
    const withPts = confirmedShots.filter((s) => s.impactPoint);
    if (withPts.length === 0) return null;
    const avgDist =
      withPts.reduce((acc, s) => {
        const dx = (s.impactPoint!.x - 0.5) * 2;
        const dy = (s.impactPoint!.y - 0.5) * 2;
        return acc + Math.min(1.5, Math.hypot(dx, dy));
      }, 0) / withPts.length;
    return Math.max(0, Math.round((1 - Math.min(1, avgDist)) * 1000) / 10);
  }, [confirmedShots]);

  // Score distribution chart
  useEffect(() => {
    if (!distChartRef.current) return;
    const buckets = new Map<string, number>();
    for (const z of activeTarget.zones) buckets.set(`${z.name} (${z.points})`, 0);
    buckets.set('Extérieur (0)', 0);

    for (const s of confirmedShots) {
      if (s.result === 'MISS') {
        buckets.set('Extérieur (0)', (buckets.get('Extérieur (0)') ?? 0) + 1);
      } else {
        const matchKey = Array.from(buckets.keys()).find((k) => k.includes(`(${s.score})`));
        const key = matchKey || `${s.score} pts`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }

    const chart = new Chart(distChartRef.current, {
      type: 'bar',
      data: {
        labels: Array.from(buckets.keys()),
        datasets: [
          {
            label: 'Tirs confirmés',
            data: Array.from(buckets.values()),
            backgroundColor: '#4F7CFF',
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {display: false},
        },
        scales: {
          x: {ticks: {color: '#94A3B8', font: {size: 11}}, grid: {display: false}},
          y: {
            beginAtZero: true,
            ticks: {color: '#94A3B8', stepSize: 1},
            grid: {color: 'rgba(148,163,184,0.1)'},
          },
        },
      },
    });
    return () => chart.destroy();
  }, [confirmedShots, activeTarget.zones]);

  // Evolution over sessions chart
  useEffect(() => {
    if (!evoChartRef.current) return;
    const ordered = [...sessions].sort((a, b) => a.createdAt - b.createdAt).slice(-12);
    const chart = new Chart(evoChartRef.current, {
      type: 'line',
      data: {
        labels: ordered.map((s, idx) =>
          s.title.length > 14 ? `${s.title.slice(0, 12)}…` : s.title || `S${idx + 1}`,
        ),
        datasets: [
          {
            label: 'Score moyen / tir',
            data: ordered.map((s) => s.summary.averageConfirmedScore),
            borderColor: '#38BDF8',
            backgroundColor: 'rgba(56, 189, 248, 0.15)',
            tension: 0.25,
            fill: false,
          },
          {
            label: 'Réussite (%)',
            data: ordered.map((s) => s.summary.confirmedAccuracyPct),
            borderColor: '#22C55E',
            tension: 0.25,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {labels: {color: '#CBD5E1', boxWidth: 12, font: {size: 11}}},
        },
        scales: {
          x: {ticks: {color: '#94A3B8', font: {size: 10}}, grid: {display: false}},
          y: {
            beginAtZero: true,
            ticks: {color: '#94A3B8'},
            grid: {color: 'rgba(148,163,184,0.1)'},
          },
        },
      },
    });
    return () => chart.destroy();
  }, [sessions]);

  // Session comparison chart
  useEffect(() => {
    if (!compChartRef.current) return;
    const recent = [...sessions].slice(0, 6).reverse();
    const chart = new Chart(compChartRef.current, {
      type: 'bar',
      data: {
        labels: recent.map((s) => (s.title.length > 14 ? `${s.title.slice(0, 12)}…` : s.title)),
        datasets: [
          {
            label: 'Score total confirmé',
            data: recent.map((s) => s.summary.confirmedScore),
            backgroundColor: '#4F7CFF',
            borderRadius: 6,
          },
          {
            label: 'Réussites',
            data: recent.map((s) => s.summary.hits),
            backgroundColor: '#22C55E',
            borderRadius: 6,
          },
          {
            label: 'Ratés',
            data: recent.map((s) => s.summary.misses),
            backgroundColor: '#EF4444',
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {labels: {color: '#CBD5E1', boxWidth: 12, font: {size: 11}}},
        },
        scales: {
          x: {ticks: {color: '#94A3B8', font: {size: 10}}, grid: {display: false}},
          y: {
            beginAtZero: true,
            ticks: {color: '#94A3B8'},
            grid: {color: 'rgba(148,163,184,0.1)'},
          },
        },
      },
    });
    return () => chart.destroy();
  }, [sessions]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-[#F8FAFC]">
            Statistiques
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Calculées sur les tirs confirmés et probables. Les impacts incertains sont comptabilisés séparément.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedSessionId}
            onChange={(e) => setSelectedSessionId(e.target.value)}
            aria-label="Filtrer statistiques par session"
            className="min-h-[44px] rounded-xl border border-slate-700 bg-[#0E1525] px-3.5 text-xs font-medium text-[#F8FAFC]"
          >
            <option value="ALL">Toutes les sessions</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => exportStatisticsCsv()}
            disabled={shots.length === 0}
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-700 bg-[#0E1525] px-4 text-xs font-semibold text-[#F8FAFC] hover:border-[#38BDF8] disabled:opacity-40"
          >
            <Download className="h-4 w-4 text-[#38BDF8]" />
            Exporter CSV
          </button>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Total tirs</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#F8FAFC]">
            {activeShots.length}
          </p>
          <p className="mt-0.5 text-[11px] font-mono tabular-nums text-amber-400">
            dont {uncertainShots.length} incertains
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Réussites</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-emerald-400">
            {hits.length}
          </p>
          <p className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
            {successRate}% confirmés
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Ratés</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-red-400">
            {misses.length}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Score total</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#38BDF8]">
            {totalScore}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Score moyen</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#F8FAFC]">
            {avgScore}
          </p>
          <p className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-400">
            Meilleur : {bestShot} pts
          </p>
        </div>
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-4">
          <p className="text-xs text-slate-400">Précision moyenne</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-[#4F7CFF]">
            {radialPrecisionPct !== null ? `${radialPrecisionPct}%` : '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">Proximité du centre</p>
        </div>
      </div>

      {/* Visual Impact Map + Distribution */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 lg:col-span-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
              Carte des impacts
            </h2>
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                checked={showUncertainOnMap}
                onChange={(e) => setShowUncertainOnMap(e.target.checked)}
                className="accent-[#F59E0B]"
              />
              Afficher incertains
            </label>
          </div>

          <div className="flex justify-center rounded-xl border border-slate-800 bg-[#070B14] p-4">
            <svg viewBox="0 0 100 100" className="h-64 w-64">
              <rect
                x="2"
                y="2"
                width="96"
                height="96"
                fill="none"
                stroke="#1E293B"
                strokeWidth="0.7"
              />
              {[...activeTarget.zones]
                .sort((a, b) => b.radiusRatio - a.radiusRatio)
                .map((zone) => (
                  <circle
                    key={zone.id}
                    cx="50"
                    cy="50"
                    r={zone.radiusRatio * 96}
                    fill={zone.color}
                    fillOpacity={0.07}
                    stroke={zone.color}
                    strokeOpacity={0.65}
                    strokeWidth="0.6"
                  />
                ))}
              <line x1="47" y1="50" x2="53" y2="50" stroke="#94A3B8" strokeWidth="0.4" />
              <line x1="50" y1="47" x2="50" y2="53" stroke="#94A3B8" strokeWidth="0.4" />

              {confirmedShots
                .filter((s) => s.impactPoint)
                .map((s) => {
                  const x = Math.max(3, Math.min(97, s.impactPoint!.x * 96 + 2));
                  const y = Math.max(3, Math.min(97, s.impactPoint!.y * 96 + 2));
                  const fill =
                    s.result === 'MISS'
                      ? '#EF4444'
                      : s.result === 'BOUNCE'
                        ? '#38BDF8'
                        : '#22C55E';
                  return (
                    <g key={s.id}>
                      <circle cx={x} cy={y} r="1.9" fill={fill} fillOpacity={0.9} stroke="#070B14" strokeWidth="0.4" />
                      <title>{`Tir #${s.shotNumber} · ${s.zoneName} · ${s.score} pts`}</title>
                    </g>
                  );
                })}

              {showUncertainOnMap &&
                uncertainShots
                  .filter((s) => s.impactPoint)
                  .map((s) => {
                    const x = Math.max(3, Math.min(97, s.impactPoint!.x * 96 + 2));
                    const y = Math.max(3, Math.min(97, s.impactPoint!.y * 96 + 2));
                    return (
                      <circle
                        key={s.id}
                        cx={x}
                        cy={y}
                        r="1.9"
                        fill="none"
                        stroke="#F59E0B"
                        strokeWidth="0.7"
                      />
                    );
                  })}
            </svg>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-400">
            <span className="text-emerald-400">● Réussite</span>
            <span className="text-[#38BDF8]">● Rebond</span>
            <span className="text-red-400">● Raté</span>
            {showUncertainOnMap && <span className="text-amber-400">○ Incertain</span>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 lg:col-span-7 space-y-4">
          <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
            Répartition des scores confirmés
          </h2>
          <div className="h-72">
            <canvas ref={distChartRef} />
          </div>
        </div>
      </div>

      {/* Evolution & Session comparison */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
            Évolution des performances
          </h2>
          <div className="h-64">
            <canvas ref={evoChartRef} />
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-[#0E1525] p-6 space-y-4">
          <h2 className="font-display text-base font-semibold text-[#F8FAFC]">
            Comparaison des sessions récentes
          </h2>
          <div className="h-64">
            <canvas ref={compChartRef} />
          </div>
        </div>
      </div>
    </div>
  );
};
