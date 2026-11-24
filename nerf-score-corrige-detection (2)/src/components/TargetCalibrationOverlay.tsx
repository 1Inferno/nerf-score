import React, {useRef, useState} from 'react';
import {buildScaledPolygonRing, mapTargetPointToFrameSpace} from '../cv/geometry';
import {Point2D, TargetCalibration, TargetProfile, TargetZone} from '../types/nerf';

interface TargetCalibrationOverlayProps {
  calibration: TargetCalibration;
  targetProfile: TargetProfile;
  scoringZonesOverride?: TargetZone[];
  aspectRatioOverride?: number;
  editable: boolean;
  showRawReferenceCircles?: boolean;
  onChangeCorners?: (corners: [Point2D, Point2D, Point2D, Point2D], center: Point2D) => void;
  onChangePolygon?: (polygon: Point2D[], center: Point2D) => void;
}

export const TargetCalibrationOverlay: React.FC<TargetCalibrationOverlayProps> = ({
  calibration,
  targetProfile,
  scoringZonesOverride,
  aspectRatioOverride,
  editable,
  showRawReferenceCircles = false,
  onChangeCorners,
  onChangePolygon,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<'center' | number | null>(null);

  const activePolygon: Point2D[] =
    calibration.polygon && calibration.polygon.length >= 3
      ? calibration.polygon
      : calibration.corners;

  const isCustomPolygon = Boolean(calibration.polygon && calibration.polygon.length >= 3);

  const tracking = calibration.trackingStatus;
  const isLostOrange = tracking === 'ORANGE_SEARCHING';
  const isNotFoundRed =
    tracking === 'RED_NOT_FOUND' || (!tracking && calibration.state === 'RED_NOT_FOUND');

  const contourStroke = isNotFoundRed
    ? '#EF4444'
    : isLostOrange
      ? '#F59E0B'
      : '#38BDF8';

  const contourFill = isNotFoundRed
    ? 'rgba(239, 68, 68, 0.08)'
    : isLostOrange
      ? 'rgba(245, 158, 11, 0.08)'
      : 'rgba(56, 189, 248, 0.08)';

  const getRelativePoint = (clientX: number, clientY: number): Point2D => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return {x: 0.5, y: 0.5};
    return {
      x: Math.max(0.01, Math.min(0.99, (clientX - rect.left) / rect.width)),
      y: Math.max(0.01, Math.min(0.99, (clientY - rect.top) / rect.height)),
    };
  };

  const emitChange = (nextPoly: Point2D[], nextCenter: Point2D) => {
    if (onChangePolygon) {
      onChangePolygon(nextPoly, nextCenter);
    }
    if (onChangeCorners && nextPoly.length === 4) {
      onChangeCorners(nextPoly as [Point2D, Point2D, Point2D, Point2D], nextCenter);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!editable || dragging === null) return;
    const pt = getRelativePoint(e.clientX, e.clientY);

    if (dragging === 'center') {
      const dx = pt.x - calibration.center.x;
      const dy = pt.y - calibration.center.y;
      const movedPoly = activePolygon.map((c) => ({
        x: Math.max(0.01, Math.min(0.99, c.x + dx)),
        y: Math.max(0.01, Math.min(0.99, c.y + dy)),
      }));
      emitChange(movedPoly, pt);
      return;
    }

    const nextPoly = activePolygon.map((p, idx) => (idx === dragging ? pt : {...p}));
    const avgX = nextPoly.reduce((acc, p) => acc + p.x, 0) / nextPoly.length;
    const avgY = nextPoly.reduce((acc, p) => acc + p.y, 0) / nextPoly.length;
    emitChange(nextPoly, {x: avgX, y: avgY});
  };

  const handlePointerUp = () => {
    setDragging(null);
  };

  const zonesToRender = scoringZonesOverride ?? targetProfile.zones;
  const effectiveAspectRatio = aspectRatioOverride ?? targetProfile.aspectRatio;

  const projectedZonePaths = zonesToRender.map((zone) => {
    if (isCustomPolygon && zone.shape !== 'polygon') {
      const scaled = buildScaledPolygonRing(
        activePolygon,
        calibration.center,
        Math.min(1, zone.radiusRatio * 2),
      );
      return {
        zone,
        pointsAttr: scaled.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(' '),
      };
    }

    const pts: string[] = [];
    if (zone.shape === 'polygon' && zone.polygonNormalized && zone.polygonNormalized.length >= 3) {
      for (const p of zone.polygonNormalized) {
        const fp = mapTargetPointToFrameSpace(p, calibration.corners);
        pts.push(`${(fp.x * 100).toFixed(2)},${(fp.y * 100).toFixed(2)}`);
      }
    } else {
      const steps = 40;
      const rx = zone.radiusRatio;
      const ry =
        zone.shape === 'ellipse'
          ? zone.radiusRatio / Math.max(0.4, Math.min(2.5, effectiveAspectRatio))
          : zone.radiusRatio;
      for (let i = 0; i < steps; i++) {
        const theta = (i / steps) * Math.PI * 2;
        const tp = {x: 0.5 + Math.cos(theta) * rx, y: 0.5 + Math.sin(theta) * ry};
        const fp = mapTargetPointToFrameSpace(tp, calibration.corners);
        pts.push(`${(fp.x * 100).toFixed(2)},${(fp.y * 100).toFixed(2)}`);
      }
    }
    return {zone, pointsAttr: pts.join(' ')};
  });

  const contourPointsAttr = activePolygon
    .map((c) => `${(c.x * 100).toFixed(2)},${(c.y * 100).toFixed(2)}`)
    .join(' ');

  const mappedCenter = isCustomPolygon
    ? calibration.center
    : mapTargetPointToFrameSpace({x: 0.5, y: 0.5}, calibration.corners);

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      className={`absolute inset-0 select-none ${editable ? 'touch-none cursor-crosshair' : 'pointer-events-none'}`}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full overflow-visible"
      >
        <polygon
          points={contourPointsAttr}
          fill={contourFill}
          stroke={contourStroke}
          strokeWidth="0.65"
          strokeDasharray={isNotFoundRed || isLostOrange ? '2 1.5' : undefined}
        />

        {projectedZonePaths.map(({zone, pointsAttr}) => (
          <polygon
            key={zone.id}
            points={pointsAttr}
            fill="none"
            stroke={zone.color || contourStroke}
            strokeOpacity={0.75}
            strokeWidth="0.38"
          />
        ))}

        {showRawReferenceCircles &&
          calibration.detectedCircles.map((circle, idx) => {
            const rx = (circle.r / Math.max(1, calibration.referenceWidth)) * 100;
            const ry = (circle.r / Math.max(1, calibration.referenceHeight)) * 100;
            return (
              <ellipse
                key={idx}
                cx={circle.cx * 100}
                cy={circle.cy * 100}
                rx={rx}
                ry={ry}
                fill="none"
                stroke="#4F7CFF"
                strokeOpacity={0.45}
                strokeWidth="0.3"
                strokeDasharray="1 1"
              />
            );
          })}

        <line
          x1={mappedCenter.x * 100 - 2.2}
          y1={mappedCenter.y * 100}
          x2={mappedCenter.x * 100 + 2.2}
          y2={mappedCenter.y * 100}
          stroke={contourStroke}
          strokeWidth="0.45"
        />
        <line
          x1={mappedCenter.x * 100}
          y1={mappedCenter.y * 100 - 2.2}
          x2={mappedCenter.x * 100}
          y2={mappedCenter.y * 100 + 2.2}
          stroke={contourStroke}
          strokeWidth="0.45"
        />
      </svg>

      {editable &&
        activePolygon.map((pt, idx) => (
          <button
            key={idx}
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              setDragging(idx);
            }}
            style={{
              left: `${pt.x * 100}%`,
              top: `${pt.y * 100}%`,
              transform: 'translate(-50%, -50%)',
            }}
            aria-label={`Déplacer point P${idx + 1}`}
            className="absolute flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#38BDF8] bg-[#070B14]/90 text-[10px] font-mono font-bold text-[#F8FAFC] shadow-md touch-none active:scale-110"
          >
            P{idx + 1}
          </button>
        ))}

      {editable && (
        <button
          type="button"
          onPointerDown={(e) => {
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            setDragging('center');
          }}
          style={{
            left: `${calibration.center.x * 100}%`,
            top: `${calibration.center.y * 100}%`,
            transform: 'translate(-50%, -50%)',
          }}
          aria-label="Déplacer la cible"
          className="absolute flex h-9 w-9 items-center justify-center rounded-full border-2 border-[#4F7CFF] bg-[#4F7CFF]/35 text-xs font-mono font-bold text-white touch-none"
        >
          +
        </button>
      )}
    </div>
  );
};
