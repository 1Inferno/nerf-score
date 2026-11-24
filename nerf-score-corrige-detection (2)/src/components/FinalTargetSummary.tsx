import React, {useMemo, useState} from 'react';
import {Film, Image as ImageIcon, Play, Target} from 'lucide-react';
import {buildScaledPolygonRing} from '../cv/geometry';
import {OfficialCalibration, ShotEvent, TargetCalibration, TargetZone} from '../types/nerf';

interface FinalTargetSummaryProps {
  calibration: TargetCalibration | OfficialCalibration;
  scoringZones: TargetZone[];
  shots: ShotEvent[];
  totalConfirmedScore: number;
  onSelectShotReplay: (shot: ShotEvent) => void;
}

export const FinalTargetSummary: React.FC<FinalTargetSummaryProps> = ({
  calibration,
  scoringZones,
  shots,
  totalConfirmedScore,
  onSelectShotReplay,
}) => {
  const [showRefPhoto, setShowRefPhoto] = useState(true);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const activeShots = useMemo(
    () => shots.filter((s) => s.validationState !== 'DISMISSED'),
    [shots],
  );

  // Strict rule: only plot confirmed/bounced impacts INSIDE the target with a real position.
  // Never plot shots that are completely outside the target (MISS) or UNCERTAIN.
  const plottedHits = useMemo(
    () =>
      activeShots
        .filter(
          (s) =>
            (s.result === 'HIT' || s.result === 'BOUNCE') &&
            s.frameImpactPoint !== null &&
            s.evidence.positionDetermined !== false,
        )
        .sort((a, b) => a.shotNumber - b.shotNumber),
    [activeShots],
  );

  const outsideMissCount = useMemo(
    () => activeShots.filter((s) => s.result === 'MISS').length,
    [activeShots],
  );
  const uncertainCount = useMemo(
    () => activeShots.filter((s) => s.result === 'UNCERTAIN').length,
    [activeShots],
  );

  const selectedShot = useMemo(() => {
    if (plottedHits.length === 0) return null;
    return plottedHits.find((s) => s.id === selectedShotId) ?? plottedHits[0];
  }, [plottedHits, selectedShotId]);

  const activePolygon =
    calibration.polygon && calibration.polygon.length >= 3
      ? calibration.polygon
      : calibration.corners;

  // Frame the SVG viewBox closely around the calibrated polygon (preserving true image aspect ratio)
  const viewCrop = useMemo(() => {
    const bbox = calibration.boundingBox;
    const padX = Math.max(0.06, bbox.w * 0.16);
    const padY = Math.max(0.06, bbox.h * 0.16);
    const x0 = Math.max(0, bbox.x - padX);
    const y0 = Math.max(0, bbox.y - padY);
    const x1 = Math.min(1, bbox.x + bbox.w + padX);
    const y1 = Math.min(1, bbox.y + bbox.h + padY);
    const refW = Math.max(1, calibration.referenceWidth || 960);
    const refH = Math.max(1, calibration.referenceHeight || 540);
    const cropWpx = (x1 - x0) * refW;
    const cropHpx = (y1 - y0) * refH;
    return {
      x0,
      y0,
      w: Math.max(0.05, x1 - x0),
      h: Math.max(0.05, y1 - y0),
      aspectRatio: cropWpx / Math.max(1, cropHpx),
    };
  }, [calibration.boundingBox, calibration.referenceWidth, calibration.referenceHeight]);

  const contourPointsAttr = activePolygon
    .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
    .join(' ');

  const zoneRings = useMemo(
    () =>
      [...scoringZones]
        .sort((a, b) => b.radiusRatio - a.radiusRatio)
        .filter((z) => z.shape !== 'polygon')
        .map((zone) => {
          const ring = buildScaledPolygonRing(
            activePolygon,
            calibration.center,
            Math.min(1, zone.radiusRatio * 2),
          );
          const topPt = ring.reduce((best, p) => (p.y < best.y ? p : best), ring[0]);
          return {
            zone,
            pointsAttr: ring
              .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
              .join(' '),
            labelPt: topPt,
          };
        }),
    [activePolygon, calibration.center, scoringZones],
  );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left: Single Calibrated Target Canvas with Real Numbered Impacts */}
      <div className="rounded-2xl border border-slate-800 bg-[#070B14] p-4 space-y-3 lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-[#38BDF8]" />
            <h3 className="text-sm font-semibold text-[#F8FAFC]">
              Cible calibrée · Impacts confirmés ({plottedHits.length})
            </h3>
          </div>
          {calibration.referenceImageDataUrl && (
            <button
              type="button"
              onClick={() => setShowRefPhoto((s) => !s)}
              className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-slate-700 bg-[#0E1525] px-3 text-xs font-medium text-slate-200 hover:border-[#38BDF8]"
            >
              <ImageIcon className="h-3.5 w-3.5 text-[#38BDF8]" />
              {showRefPhoto ? 'Masquer photo' : 'Afficher photo'}
            </button>
          )}
        </div>

        <div className="flex items-center justify-center rounded-xl border border-slate-800/80 bg-black p-2">
          <svg
            viewBox={`${(viewCrop.x0 * 100).toFixed(2)} ${(viewCrop.y0 * 100).toFixed(2)} ${(viewCrop.w * 100).toFixed(2)} ${(viewCrop.h * 100).toFixed(2)}`}
            preserveAspectRatio="xMidYMid meet"
            style={{aspectRatio: `${viewCrop.aspectRatio}`}}
            className="max-h-[430px] w-full"
          >
            {showRefPhoto && calibration.referenceImageDataUrl && (
              <image
                href={calibration.referenceImageDataUrl}
                x="0"
                y="0"
                width="100"
                height="100"
                preserveAspectRatio="none"
                opacity={0.48}
              />
            )}

            {/* Outer Calibrated Polygon Contour */}
            <polygon
              points={contourPointsAttr}
              fill="rgba(56, 189, 248, 0.06)"
              stroke="#38BDF8"
              strokeWidth={Math.max(0.25, viewCrop.w * 0.45)}
            />

            {/* Scoring Zones matching custom diamond/irregular shape */}
            {zoneRings.map(({zone, pointsAttr, labelPt}) => (
              <g key={zone.id}>
                <polygon
                  points={pointsAttr}
                  fill={zone.color || '#38BDF8'}
                  fillOpacity={0.07}
                  stroke={zone.color || '#38BDF8'}
                  strokeOpacity={0.8}
                  strokeWidth={Math.max(0.18, viewCrop.w * 0.28)}
                />
                {labelPt && (
                  <text
                    x={labelPt.x * 100}
                    y={labelPt.y * 100 + viewCrop.h * 2.4}
                    textAnchor="middle"
                    fill={zone.color || '#CBD5E1'}
                    fontSize={Math.max(1.2, viewCrop.w * 2.1)}
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {zone.points}
                  </text>
                )}
              </g>
            ))}

            {/* Exact Calibrated Center */}
            <line
              x1={calibration.center.x * 100 - viewCrop.w * 1.6}
              y1={calibration.center.y * 100}
              x2={calibration.center.x * 100 + viewCrop.w * 1.6}
              y2={calibration.center.y * 100}
              stroke="#94A3B8"
              strokeWidth={Math.max(0.14, viewCrop.w * 0.22)}
            />
            <line
              x1={calibration.center.x * 100}
              y1={calibration.center.y * 100 - viewCrop.h * 1.6}
              x2={calibration.center.x * 100}
              y2={calibration.center.y * 100 + viewCrop.h * 1.6}
              stroke="#94A3B8"
              strokeWidth={Math.max(0.14, viewCrop.w * 0.22)}
            />

            {/* Numbered Real Impact Markers (Strictly confirmed/bounced hits inside target) */}
            {plottedHits.map((shot) => {
              const pt = shot.frameImpactPoint!;
              const isSelected = selectedShot?.id === shot.id;
              const markerR = Math.max(1.1, viewCrop.w * (isSelected ? 2.4 : 1.95));
              const fill = shot.result === 'BOUNCE' ? '#38BDF8' : '#22C55E';
              return (
                <g
                  key={shot.id}
                  onClick={() => setSelectedShotId(shot.id)}
                  className="cursor-pointer"
                >
                  <circle
                    cx={pt.x * 100}
                    cy={pt.y * 100}
                    r={markerR}
                    fill={fill}
                    stroke={isSelected ? '#F59E0B' : '#070B14'}
                    strokeWidth={Math.max(0.22, viewCrop.w * (isSelected ? 0.55 : 0.32))}
                  />
                  <text
                    x={pt.x * 100}
                    y={pt.y * 100 + markerR * 0.36}
                    textAnchor="middle"
                    fill="#070B14"
                    fontSize={markerR * 1.05}
                    fontFamily="monospace"
                    fontWeight="bold"
                  >
                    {shot.shotNumber}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <p className="text-[11px] text-slate-400">
          Touchez un numéro d’impact sur la cible pour afficher son détail et lire son extrait vidéo.
          {(outsideMissCount > 0 || uncertainCount > 0) &&
            ` (${outsideMissCount} tir(s) hors cible non affichés · ${uncertainCount} incertain(s))`}
        </p>
      </div>

      {/* Right: Total Points, Impact Selector & Video Replay Launcher */}
      <div className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-800 bg-[#070B14] p-5 lg:col-span-5">
        <div className="space-y-4">
          <div className="flex items-baseline justify-between border-b border-slate-800 pb-3">
            <span className="text-xs font-medium text-slate-400">Total des points</span>
            <span className="font-mono text-3xl font-bold tabular-nums text-[#38BDF8]">
              {totalConfirmedScore} <span className="text-sm font-normal text-slate-400">pts</span>
            </span>
          </div>

          {selectedShot ? (
            <div className="rounded-xl border border-slate-800 bg-[#0E1525] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-[#F8FAFC]">
                  Impact #{selectedShot.shotNumber} · {selectedShot.zoneName}
                </span>
                <span className="font-mono text-sm font-bold tabular-nums text-emerald-400">
                  +{selectedShot.score} pts
                </span>
              </div>
              <p className="font-mono text-xs tabular-nums text-slate-400">
                Confiance {Math.round(selectedShot.confidence * 100)}%
                {selectedShot.frameImpactPoint
                  ? ` · Position exacte (${(selectedShot.frameImpactPoint.x * 100).toFixed(1)}%, ${(selectedShot.frameImpactPoint.y * 100).toFixed(1)}%)`
                  : ''}
              </p>
              <button
                type="button"
                onClick={() => onSelectShotReplay(selectedShot)}
                className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl bg-[#4F7CFF] px-4 text-xs font-semibold text-white hover:bg-[#3E6AE8]"
              >
                <Play className="h-4 w-4" />
                Voir l’extrait vidéo de l’impact #{selectedShot.shotNumber}
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-800 p-5 text-center text-xs text-slate-400">
              Aucun impact confirmé dans la cible sur cette session.
            </div>
          )}

          {plottedHits.length > 0 && (
            <div className="max-h-52 overflow-y-auto divide-y divide-slate-800/80 rounded-xl border border-slate-800 bg-[#0E1525] px-3">
              {plottedHits.map((s) => {
                const isSel = selectedShot?.id === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSelectedShotId(s.id)}
                    className={`flex w-full items-center justify-between py-2.5 text-left text-xs transition-colors ${
                      isSel ? 'text-[#38BDF8]' : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    <span className="font-mono font-semibold">
                      #{s.shotNumber} · {s.zoneName}
                    </span>
                    <span className="inline-flex items-center gap-2 font-mono tabular-nums">
                      <span className="text-emerald-400">+{s.score} pts</span>
                      <Film className="h-3.5 w-3.5 text-slate-400" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
