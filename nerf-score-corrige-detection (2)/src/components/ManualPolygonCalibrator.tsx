import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  Camera,
  Check,
  Crosshair,
  Diamond,
  Hand,
  Maximize2,
  Move,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Square,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  buildScaledPolygonRing,
  computePolygonCentroid,
  computePolygonGeometry,
  insertPointOnClosestEdge,
  rotatePolygonAroundCenter,
  scalePolygonAroundCenter,
  translatePolygon,
} from '../cv/geometry';
import {
  clampPanOffset,
  createDiamondPresetPolygon,
  createRectanglePresetPolygon,
  screenPointToOriginalNormalized,
  zoomAroundLocalAnchor,
  ZoomPanState,
} from '../cv/zoomMath';
import {CameraPlacement, OfficialCalibration, Point2D, TargetProfile} from '../types/nerf';

interface ManualPolygonCalibratorProps {
  /** Live camera stream when calibrating directly on rear camera */
  liveStream?: MediaStream | null;
  /** Live video file URL when calibrating from a test video */
  liveVideoUrl?: string | null;
  /** Optional frozen photo (e.g. when reopening saved reference photo or frozen snapshot) */
  frozenImageDataUrl?: string | null;
  imageWidth: number;
  imageHeight: number;
  polygon: Point2D[];
  center: Point2D;
  targetProfile: TargetProfile;
  cameraPlacement?: CameraPlacement;
  onCameraPlacementChange?: (placement: CameraPlacement) => void;
  savedCalibrations?: OfficialCalibration[];
  onSelectSavedCalibration?: (cal: OfficialCalibration) => void;
  fullScreen?: boolean;
  onChange: (polygon: Point2D[], center: Point2D) => void;
  /** Called when user clicks "Valider la cible" with optional freshly-captured frame from live video */
  onValidate?: (capturedFrame?: {imageData: ImageData; dataUrl: string; w: number; h: number} | null) => void;
  onCancel?: () => void;
  /** Optional callback to freeze/unfreeze frame manually without hiding the camera */
  onCaptureFreezeToggle?: (freeze: boolean) => void;
}

type CalibratorTool = 'move' | 'moveTarget' | 'add' | 'pan';

interface HistorySnapshot {
  polygon: Point2D[];
  center: Point2D;
}

const CAMERA_PLACEMENT_LABELS: Array<{id: CameraPlacement; label: string}> = [
  {id: 'front', label: 'Face'},
  {id: 'below', label: 'En dessous'},
  {id: 'above', label: 'Au-dessus'},
  {id: 'left', label: 'À gauche'},
  {id: 'right', label: 'À droite'},
  {id: 'tilted', label: 'Inclinée'},
];

export const ManualPolygonCalibrator: React.FC<ManualPolygonCalibratorProps> = ({
  liveStream = null,
  liveVideoUrl = null,
  frozenImageDataUrl = null,
  imageWidth,
  imageHeight,
  polygon,
  center,
  targetProfile,
  cameraPlacement = 'front',
  onCameraPlacementChange,
  savedCalibrations = [],
  onSelectSavedCalibration,
  fullScreen = false,
  onChange,
  onValidate,
  onCancel,
  onCaptureFreezeToggle,
}) => {
  const outerViewportRef = useRef<HTMLDivElement | null>(null);
  const stageBoxRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

  const [tool, setTool] = useState<CalibratorTool>('move');
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [draggingTarget, setDraggingTarget] = useState<'center' | 'pan' | 'whole' | number | null>(
    null,
  );
  const [zoomState, setZoomState] = useState<ZoomPanState>({zoom: 1, panX: 0, panY: 0});
  const [undoStack, setUndoStack] = useState<HistorySnapshot[]>([]);
  const [videoDims, setVideoDims] = useState<{w: number; h: number}>({
    w: Math.max(1, imageWidth),
    h: Math.max(1, imageHeight),
  });
  const [viewportDims, setViewportDims] = useState<{w: number; h: number}>({
    w: 960,
    h: 540,
  });

  const zoomStateRef = useRef<ZoomPanState>(zoomState);
  zoomStateRef.current = zoomState;

  const dragStartPanRef = useRef<{clientX: number; clientY: number; panX: number; panY: number} | null>(null);
  const dragStartWholeRef = useRef<{
    startNorm: Point2D;
    originPolygon: Point2D[];
    originCenter: Point2D;
  } | null>(null);
  const dragHistorySavedRef = useRef<boolean>(false);
  const activeTouchesRef = useRef<Map<number, {x: number; y: number}>>(new Map());
  const pinchStartRef = useRef<{
    distance: number;
    midLocalX: number;
    midLocalY: number;
    zoomState: ZoomPanState;
  } | null>(null);

  const isShowingFrozen = Boolean(frozenImageDataUrl);

  // Keep live camera stream or test video playing continuously inside calibration viewport
  useEffect(() => {
    const vid = videoPreviewRef.current;
    if (!vid || isShowingFrozen) return;

    if (liveStream) {
      if (vid.srcObject !== liveStream) {
        vid.srcObject = liveStream;
      }
      vid.play().catch(() => {});
    } else if (liveVideoUrl) {
      vid.srcObject = null;
      if (vid.src !== liveVideoUrl) {
        vid.src = liveVideoUrl;
      }
      vid.play().catch(() => {});
    }
  }, [liveStream, liveVideoUrl, isShowingFrozen]);

  // Update natural dimensions when video metadata loads or image dimensions change
  useEffect(() => {
    setVideoDims({
      w: Math.max(1, imageWidth),
      h: Math.max(1, imageHeight),
    });
  }, [imageWidth, imageHeight]);

  // Measure outer viewport precisely with ResizeObserver so full-screen canvas preserves 1:1 aspect ratio
  useEffect(() => {
    const el = outerViewportRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setViewportDims({w: rect.width, h: rect.height});
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [fullScreen]);

  // Compute exact fitted media box filling virtually 100% of screen without stretching aspect ratio
  const fittedStageSize = useMemo(() => {
    const mediaAspect = Math.max(0.25, videoDims.w / Math.max(1, videoDims.h));
    const vpAspect = viewportDims.w / Math.max(1, viewportDims.h);
    if (vpAspect > mediaAspect) {
      const h = viewportDims.h;
      return {w: Math.round(h * mediaAspect), h: Math.round(h)};
    }
    const w = viewportDims.w;
    return {w: Math.round(w), h: Math.round(w / mediaAspect)};
  }, [viewportDims, videoDims]);

  const stageSizeRef = useRef(fittedStageSize);
  stageSizeRef.current = fittedStageSize;

  const pushHistory = () => {
    setUndoStack((prev) => [
      ...prev.slice(-24),
      {
        polygon: polygon.map((p) => ({x: p.x, y: p.y})),
        center: {x: center.x, y: center.y},
      },
    ]);
  };

  const handleUndo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    setSelectedIndex((idx) => Math.min(idx, prev.polygon.length - 1));
    onChange(prev.polygon, prev.center);
  };

  const handleZoomStep = (delta: number) => {
    const {w, h} = stageSizeRef.current;
    setZoomState((curr) => zoomAroundLocalAnchor(curr, curr.zoom + delta, w / 2, h / 2, w, h));
  };

  const handleResetView = () => {
    setZoomState({zoom: 1, panX: 0, panY: 0});
  };

  const handleRestartPoints = () => {
    pushHistory();
    const nextPoly = createDiamondPresetPolygon();
    setSelectedIndex(0);
    onChange(nextPoly, computePolygonCentroid(nextPoly));
  };

  const handleRotateWhole = (deltaDeg: number) => {
    pushHistory();
    const nextPoly = rotatePolygonAroundCenter(
      polygon,
      center,
      deltaDeg,
      videoDims.h > 0 ? videoDims.w / videoDims.h : 1,
    );
    onChange(nextPoly, {...center});
  };

  const handleScaleWhole = (factor: number) => {
    pushHistory();
    const nextPoly = scalePolygonAroundCenter(polygon, center, factor);
    onChange(nextPoly, {...center});
  };

  const handleDeleteSelectedPoint = () => {
    if (polygon.length <= 3) return;
    pushHistory();
    const safeIdx = Math.max(0, Math.min(polygon.length - 1, selectedIndex));
    const nextPoly = polygon.filter((_, i) => i !== safeIdx);
    const nextCenter = computePolygonCentroid(nextPoly);
    setSelectedIndex(Math.max(0, Math.min(nextPoly.length - 1, safeIdx - 1)));
    onChange(nextPoly, nextCenter);
  };

  const applyPreset = (preset: 'diamond' | 'rectangle') => {
    pushHistory();
    const nextPoly =
      preset === 'diamond' ? createDiamondPresetPolygon() : createRectanglePresetPolygon();
    setSelectedIndex(0);
    onChange(nextPoly, computePolygonCentroid(nextPoly));
  };

  const captureCurrentVideoFrame = () => {
    const vid = videoPreviewRef.current;
    if (!vid || vid.readyState < 2 || vid.videoWidth <= 0 || vid.videoHeight <= 0) {
      return null;
    }
    const maxDim = 1280;
    const scale = Math.min(1, maxDim / Math.max(vid.videoWidth, vid.videoHeight));
    const w = Math.max(320, Math.round(vid.videoWidth * scale));
    const h = Math.max(240, Math.round(vid.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    if (!ctx) return null;
    ctx.drawImage(vid, 0, 0, w, h);
    return {
      imageData: ctx.getImageData(0, 0, w, h),
      dataUrl: canvas.toDataURL('image/jpeg', 0.9),
      w,
      h,
    };
  };

  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});

    if (activeTouchesRef.current.size === 2 && stageBoxRef.current) {
      const pts = Array.from(activeTouchesRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const boxRect = stageBoxRef.current.getBoundingClientRect();
      pinchStartRef.current = {
        distance: Math.max(10, dist),
        midLocalX: (pts[0].x + pts[1].x) / 2 - boxRect.left,
        midLocalY: (pts[0].y + pts[1].y) / 2 - boxRect.top,
        zoomState: zoomStateRef.current,
      };
      setDraggingTarget(null);
      return;
    }

    if (tool === 'add') {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const origPt = screenPointToOriginalNormalized(e.clientX, e.clientY, rect);
      pushHistory();
      const {polygon: nextPoly, insertedIndex} = insertPointOnClosestEdge(polygon, origPt);
      setSelectedIndex(insertedIndex);
      onChange(nextPoly, computePolygonCentroid(nextPoly));
      return;
    }

    if (tool === 'moveTarget') {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      stageBoxRef.current?.setPointerCapture?.(e.pointerId);
      const startNorm = screenPointToOriginalNormalized(e.clientX, e.clientY, rect);
      dragStartWholeRef.current = {
        startNorm,
        originPolygon: polygon.map((p) => ({...p})),
        originCenter: {...center},
      };
      dragHistorySavedRef.current = false;
      setDraggingTarget('whole');
      return;
    }

    // 1-finger pan when zoomed in OR when pan tool is active
    if (tool === 'pan' || zoomStateRef.current.zoom > 1.01) {
      stageBoxRef.current?.setPointerCapture?.(e.pointerId);
      setDraggingTarget('pan');
      dragStartPanRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        panX: zoomStateRef.current.panX,
        panY: zoomStateRef.current.panY,
      };
    }
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (activeTouchesRef.current.has(e.pointerId)) {
      activeTouchesRef.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
    }

    // Two-finger pinch-to-zoom + two-finger pan
    if (activeTouchesRef.current.size === 2 && pinchStartRef.current && stageBoxRef.current) {
      const pts = Array.from(activeTouchesRef.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const boxRect = stageBoxRef.current.getBoundingClientRect();
      const midLocalX = (pts[0].x + pts[1].x) / 2 - boxRect.left;
      const midLocalY = (pts[0].y + pts[1].y) / 2 - boxRect.top;
      const scaleRatio = dist / pinchStartRef.current.distance;
      const targetZoom = pinchStartRef.current.zoomState.zoom * scaleRatio;

      const zoomed = zoomAroundLocalAnchor(
        pinchStartRef.current.zoomState,
        targetZoom,
        pinchStartRef.current.midLocalX,
        pinchStartRef.current.midLocalY,
        boxRect.width,
        boxRect.height,
      );
      const dx = midLocalX - pinchStartRef.current.midLocalX;
      const dy = midLocalY - pinchStartRef.current.midLocalY;
      const clamped = clampPanOffset(
        zoomed.panX + dx,
        zoomed.panY + dy,
        zoomed.zoom,
        boxRect.width,
        boxRect.height,
      );
      setZoomState({zoom: zoomed.zoom, panX: clamped.panX, panY: clamped.panY});
      return;
    }

    // One-finger pan
    if (draggingTarget === 'pan' && dragStartPanRef.current && stageBoxRef.current) {
      const boxRect = stageBoxRef.current.getBoundingClientRect();
      const dx = e.clientX - dragStartPanRef.current.clientX;
      const dy = e.clientY - dragStartPanRef.current.clientY;
      const clamped = clampPanOffset(
        dragStartPanRef.current.panX + dx,
        dragStartPanRef.current.panY + dy,
        zoomStateRef.current.zoom,
        boxRect.width,
        boxRect.height,
      );
      setZoomState((curr) => ({...curr, panX: clamped.panX, panY: clamped.panY}));
      return;
    }

    // Whole calibrated target drag (fast angle / framing adjustment preserving polygon shape)
    if (draggingTarget === 'whole' && dragStartWholeRef.current && stageRef.current) {
      const rect = stageRef.current.getBoundingClientRect();
      if (!dragHistorySavedRef.current) {
        pushHistory();
        dragHistorySavedRef.current = true;
      }
      const curNorm = screenPointToOriginalNormalized(e.clientX, e.clientY, rect);
      const dx = curNorm.x - dragStartWholeRef.current.startNorm.x;
      const dy = curNorm.y - dragStartWholeRef.current.startNorm.y;
      const moved = translatePolygon(
        dragStartWholeRef.current.originPolygon,
        dragStartWholeRef.current.originCenter,
        dx,
        dy,
      );
      onChange(moved.polygon, moved.center);
      return;
    }

    if (draggingTarget === null) return;
    const stageRect = stageRef.current?.getBoundingClientRect();
    if (!stageRect) return;

    if (!dragHistorySavedRef.current) {
      pushHistory();
      dragHistorySavedRef.current = true;
    }

    const origPt = screenPointToOriginalNormalized(e.clientX, e.clientY, stageRect);
    if (draggingTarget === 'center') {
      onChange(polygon, origPt);
      return;
    }

    if (typeof draggingTarget === 'number') {
      const nextPoly = polygon.map((p, idx) => (idx === draggingTarget ? origPt : {...p}));
      onChange(nextPoly, computePolygonCentroid(nextPoly));
    }
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    activeTouchesRef.current.delete(e.pointerId);
    if (activeTouchesRef.current.size < 2) {
      pinchStartRef.current = null;
    }
    setDraggingTarget(null);
    dragStartPanRef.current = null;
    dragStartWholeRef.current = null;
    dragHistorySavedRef.current = false;
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!stageBoxRef.current) return;
    e.preventDefault();
    const rect = stageBoxRef.current.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    const anchorY = e.clientY - rect.top;
    const delta = e.deltaY < 0 ? 0.35 : -0.35;
    setZoomState((curr) =>
      zoomAroundLocalAnchor(curr, curr.zoom + delta, anchorX, anchorY, rect.width, rect.height),
    );
  };

  const geometry = useMemo(
    () => computePolygonGeometry(polygon, videoDims.w, videoDims.h),
    [polygon, videoDims.w, videoDims.h],
  );

  const safeSelectedIndex = Math.max(0, Math.min(polygon.length - 1, selectedIndex));
  const selectedPoint = polygon[safeSelectedIndex];

  const zoneRings = useMemo(
    () =>
      targetProfile.zones
        .filter((z) => z.shape !== 'polygon')
        .map((zone) => ({
          zone,
          pointsAttr: buildScaledPolygonRing(
            polygon,
            center,
            Math.min(1, zone.radiusRatio * 2),
          )
            .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
            .join(' '),
        })),
    [polygon, center, targetProfile.zones],
  );

  const midpoints = useMemo(
    () =>
      polygon.map((p, i) => {
        const next = polygon[(i + 1) % polygon.length];
        return {
          edgeIndex: i,
          x: (p.x + next.x) / 2,
          y: (p.y + next.y) / 2,
        };
      }),
    [polygon],
  );

  const contourPointsAttr = polygon
    .map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
    .join(' ');

  const renderInteractiveStage = (
    <div
      ref={outerViewportRef}
      onWheel={handleWheel}
      onPointerMove={handleStagePointerMove}
      onPointerUp={handleStagePointerUp}
      onPointerCancel={handleStagePointerUp}
      className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black select-none touch-none"
    >
      <div
        ref={stageBoxRef}
        style={{
          width: `${fittedStageSize.w}px`,
          height: `${fittedStageSize.h}px`,
        }}
        className="relative overflow-hidden bg-black select-none touch-none"
      >
        <div
          ref={stageRef}
          onPointerDown={handleStagePointerDown}
          style={{
            transform: `translate3d(${zoomState.panX}px, ${zoomState.panY}px, 0) scale(${zoomState.zoom})`,
            transformOrigin: '0 0',
          }}
          className={`relative h-full w-full ${
            tool === 'add'
              ? 'cursor-crosshair'
              : tool === 'moveTarget'
                ? 'cursor-move'
                : tool === 'pan' || zoomState.zoom > 1.01
                  ? 'cursor-grab active:cursor-grabbing'
                  : 'cursor-default'
          }`}
        >
          {isShowingFrozen && frozenImageDataUrl ? (
            <img
              src={frozenImageDataUrl}
              alt="Vue figée de calibration"
              draggable={false}
              className="pointer-events-none h-full w-full object-fill select-none"
            />
          ) : (
            <video
              ref={videoPreviewRef}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setVideoDims({w: v.videoWidth, h: v.videoHeight});
                }
              }}
              onResize={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setVideoDims({w: v.videoWidth, h: v.videoHeight});
                }
              }}
              loop={Boolean(liveVideoUrl)}
              playsInline
              muted
              autoPlay
              className="pointer-events-none h-full w-full object-fill select-none"
            />
          )}

          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          >
            <polygon
              points={contourPointsAttr}
              fill="rgba(56, 189, 248, 0.12)"
              stroke="#38BDF8"
              strokeWidth={0.5 / Math.sqrt(zoomState.zoom)}
            />
            {zoneRings.map(({zone, pointsAttr}) => (
              <polygon
                key={zone.id}
                points={pointsAttr}
                fill="none"
                stroke={zone.color || '#38BDF8'}
                strokeOpacity={0.82}
                strokeWidth={0.32 / Math.sqrt(zoomState.zoom)}
              />
            ))}
            <line
              x1={center.x * 100 - 2.2 / Math.sqrt(zoomState.zoom)}
              y1={center.y * 100}
              x2={center.x * 100 + 2.2 / Math.sqrt(zoomState.zoom)}
              y2={center.y * 100}
              stroke="#F59E0B"
              strokeWidth={0.45 / Math.sqrt(zoomState.zoom)}
            />
            <line
              x1={center.x * 100}
              y1={center.y * 100 - 2.2 / Math.sqrt(zoomState.zoom)}
              x2={center.x * 100}
              y2={center.y * 100 + 2.2 / Math.sqrt(zoomState.zoom)}
              stroke="#F59E0B"
              strokeWidth={0.45 / Math.sqrt(zoomState.zoom)}
            />
          </svg>

          {/* Edge midpoint "+" handles to add a point along any slanted side */}
          {tool !== 'pan' &&
            tool !== 'moveTarget' &&
            midpoints.map((mid) => (
              <button
                key={`mid-${mid.edgeIndex}`}
                type="button"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  pushHistory();
                  const nextPoly = [...polygon];
                  const insertAt = mid.edgeIndex + 1;
                  nextPoly.splice(insertAt, 0, {x: mid.x, y: mid.y});
                  setSelectedIndex(insertAt);
                  onChange(nextPoly, computePolygonCentroid(nextPoly));
                }}
                style={{
                  left: `${mid.x * 100}%`,
                  top: `${mid.y * 100}%`,
                  transform: `translate(-50%, -50%) scale(${1 / zoomState.zoom})`,
                }}
                aria-label={`Ajouter un point sur le côté ${mid.edgeIndex + 1}`}
                className="absolute flex h-7 w-7 items-center justify-center rounded-full border border-[#38BDF8]/80 bg-[#070B14]/85 text-xs font-bold text-[#38BDF8] shadow hover:bg-[#38BDF8] hover:text-[#070B14] touch-none"
              >
                +
              </button>
            ))}

          {/* Individual Calibration Vertex Handles */}
          {polygon.map((pt, idx) => {
            const isSelected = idx === safeSelectedIndex;
            return (
              <button
                key={`pt-${idx}`}
                type="button"
                onPointerDown={(e) => {
                  if (tool === 'pan' || tool === 'moveTarget') return;
                  e.stopPropagation();
                  stageBoxRef.current?.setPointerCapture?.(e.pointerId);
                  dragHistorySavedRef.current = false;
                  setSelectedIndex(idx);
                  setDraggingTarget(idx);
                }}
                style={{
                  left: `${pt.x * 100}%`,
                  top: `${pt.y * 100}%`,
                  transform: `translate(-50%, -50%) scale(${1 / zoomState.zoom})`,
                }}
                aria-label={`Déplacer le point P${idx + 1}`}
                className={`absolute flex h-11 w-11 items-center justify-center rounded-full border-2 font-mono text-[11px] font-bold shadow-lg touch-none ${
                  isSelected
                    ? 'z-20 border-amber-400 bg-amber-500/35 text-amber-100 ring-2 ring-amber-400/70'
                    : 'z-10 border-[#38BDF8] bg-[#070B14]/90 text-[#F8FAFC]'
                }`}
              >
                P{idx + 1}
              </button>
            );
          })}

          {/* Independent Center Handle */}
          <button
            type="button"
            onPointerDown={(e) => {
              if (tool === 'pan' || tool === 'moveTarget') return;
              e.stopPropagation();
              stageBoxRef.current?.setPointerCapture?.(e.pointerId);
              dragHistorySavedRef.current = false;
              setDraggingTarget('center');
            }}
            style={{
              left: `${center.x * 100}%`,
              top: `${center.y * 100}%`,
              transform: `translate(-50%, -50%) scale(${1 / zoomState.zoom})`,
            }}
            aria-label="Déplacer le centre de la cible"
            className="absolute z-20 flex h-10 w-10 items-center justify-center rounded-full border-2 border-amber-400 bg-[#070B14]/85 text-[11px] font-mono font-bold text-amber-300 shadow touch-none"
          >
            C
          </button>
        </div>
      </div>
    </div>
  );

  // Full-screen tablet/mobile calibration workspace (~100% screen, commands overlaid on live camera)
  if (fullScreen) {
    return (
      <div className="fixed inset-0 z-50 bg-black overflow-hidden select-none">
        {/* 100% Full-Screen Live Camera / Frozen Frame */}
        {renderInteractiveStage}

        {/* Top Floating HUD Bar overlaid on camera */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-b from-black/85 via-black/45 to-transparent p-3 sm:px-5 sm:py-3.5">
          <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/70 bg-[#070B14]/85 px-3 py-1.5 backdrop-blur-md">
            <Camera className="h-4 w-4 text-[#38BDF8]" />
            <span className="text-xs font-semibold text-[#F8FAFC] whitespace-nowrap">
              {geometry.shapeLabel}
            </span>
            <span className="text-slate-500">·</span>
            <span className="font-mono text-xs tabular-nums text-[#38BDF8] whitespace-nowrap">
              {polygon.length} pts
            </span>
            {selectedPoint && (
              <>
                <span className="hidden md:inline text-slate-500">·</span>
                <span className="hidden md:inline font-mono text-[11px] tabular-nums text-amber-300 whitespace-nowrap">
                  P{safeSelectedIndex + 1} ({Math.round(selectedPoint.x * videoDims.w)},
                  {Math.round(selectedPoint.y * videoDims.h)})
                </span>
              </>
            )}
          </div>

          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            {onCameraPlacementChange && (
              <select
                value={cameraPlacement}
                onChange={(e) => onCameraPlacementChange(e.target.value as CameraPlacement)}
                aria-label="Position caméra"
                className="min-h-[42px] rounded-xl border border-slate-700/80 bg-[#070B14]/90 px-2.5 text-xs font-medium text-slate-100 backdrop-blur-md"
              >
                {CAMERA_PLACEMENT_LABELS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    Caméra : {opt.label}
                  </option>
                ))}
              </select>
            )}

            {savedCalibrations.length > 0 && onSelectSavedCalibration && (
              <select
                defaultValue=""
                onChange={(e) => {
                  const found = savedCalibrations.find((c) => c.id === e.target.value);
                  if (found) {
                    pushHistory();
                    onSelectSavedCalibration(found);
                  }
                  e.target.value = '';
                }}
                aria-label="Charger une calibration précédente"
                className="min-h-[42px] max-w-[190px] rounded-xl border border-[#38BDF8]/50 bg-[#070B14]/90 px-2.5 text-xs font-medium text-[#38BDF8] backdrop-blur-md"
              >
                <option value="">
                  Réutiliser une calibration…
                </option>
                {savedCalibrations.slice(0, 8).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.targetGeometry.shapeLabel} · {new Date(c.validatedAt).toLocaleDateString('fr-FR')}
                  </option>
                ))}
              </select>
            )}

            {onCaptureFreezeToggle && (
              <button
                type="button"
                onClick={() => onCaptureFreezeToggle(!isShowingFrozen)}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-700/80 bg-[#070B14]/85 px-3 text-xs font-semibold text-slate-100 backdrop-blur-md hover:border-[#38BDF8] whitespace-nowrap"
              >
                {isShowingFrozen ? (
                  <>
                    <Play className="h-3.5 w-3.5 text-emerald-400" />
                    <span className="hidden sm:inline">Caméra en direct</span>
                  </>
                ) : (
                  <>
                    <Pause className="h-3.5 w-3.5 text-[#38BDF8]" />
                    <span className="hidden sm:inline">Figer l’image</span>
                  </>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={() => applyPreset('diamond')}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-700/80 bg-[#070B14]/85 px-3 text-xs font-medium text-slate-200 backdrop-blur-md hover:border-[#38BDF8] whitespace-nowrap"
            >
              <Diamond className="h-3.5 w-3.5 text-[#38BDF8]" />
              <span className="hidden sm:inline">Losange</span>
            </button>

            <button
              type="button"
              onClick={() => applyPreset('rectangle')}
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-slate-700/80 bg-[#070B14]/85 px-3 text-xs font-medium text-slate-200 backdrop-blur-md hover:border-[#38BDF8] whitespace-nowrap"
            >
              <Square className="h-3.5 w-3.5 text-slate-300" />
              <span className="hidden sm:inline">Rectangle</span>
            </button>

            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-red-500/50 bg-[#070B14]/85 px-3.5 text-xs font-semibold text-red-200 backdrop-blur-md hover:bg-red-600 hover:text-white whitespace-nowrap"
              >
                <X className="h-4 w-4" />
                Annuler
              </button>
            )}
          </div>
        </div>

        {/* Bottom Floating HUD Bar overlaid on camera (Thumb-accessible primary actions) */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-3 sm:px-5 sm:py-4">
          <div className="pointer-events-auto mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-700/75 bg-[#070B14]/85 p-2.5 backdrop-blur-md">
            {/* Point & Whole-Target Manipulation Modes */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setTool('move')}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold whitespace-nowrap ${
                  tool === 'move'
                    ? 'border-[#38BDF8] bg-[#4F7CFF] text-white'
                    : 'border-slate-700 bg-[#0E1525]/90 text-slate-200'
                }`}
              >
                <Crosshair className="h-4 w-4" />
                <span className="hidden md:inline">Points</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('moveTarget')}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold whitespace-nowrap ${
                  tool === 'moveTarget'
                    ? 'border-[#38BDF8] bg-[#4F7CFF] text-white'
                    : 'border-slate-700 bg-[#0E1525]/90 text-slate-200'
                }`}
              >
                <Move className="h-4 w-4" />
                <span className="hidden sm:inline">Déplacer cible</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('add')}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold whitespace-nowrap ${
                  tool === 'add'
                    ? 'border-[#38BDF8] bg-[#4F7CFF] text-white'
                    : 'border-slate-700 bg-[#0E1525]/90 text-slate-200'
                }`}
              >
                <Plus className="h-4 w-4" />
                <span className="hidden md:inline">Ajouter</span>
              </button>
              <button
                type="button"
                onClick={() => setTool('pan')}
                className={`inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border px-3 text-xs font-semibold whitespace-nowrap ${
                  tool === 'pan'
                    ? 'border-[#38BDF8] bg-[#4F7CFF] text-white'
                    : 'border-slate-700 bg-[#0E1525]/90 text-slate-200'
                }`}
              >
                <Hand className="h-4 w-4" />
                <span className="hidden lg:inline">Déplacer vue</span>
              </button>

              {tool === 'moveTarget' && (
                <>
                  <button
                    type="button"
                    onClick={() => handleRotateWhole(-4)}
                    aria-label="Pivoter cible à gauche"
                    className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-2.5 text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    -4°
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRotateWhole(4)}
                    aria-label="Pivoter cible à droite"
                    className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-2.5 text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
                  >
                    <RotateCw className="h-3.5 w-3.5" />
                    +4°
                  </button>
                  <button
                    type="button"
                    onClick={() => handleScaleWhole(0.94)}
                    className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-[#0E1525]/90 px-2.5 font-mono text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
                  >
                    -6%
                  </button>
                  <button
                    type="button"
                    onClick={() => handleScaleWhole(1.06)}
                    className="inline-flex min-h-[44px] items-center rounded-xl border border-slate-700 bg-[#0E1525]/90 px-2.5 font-mono text-xs font-semibold text-slate-200 hover:border-[#38BDF8]"
                  >
                    +6%
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={handleDeleteSelectedPoint}
                disabled={polygon.length <= 3}
                aria-label={`Supprimer point P${safeSelectedIndex + 1}`}
                className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-red-500/40 bg-red-500/15 px-3 text-xs font-semibold text-red-200 hover:bg-red-500/25 disabled:opacity-40 whitespace-nowrap"
              >
                <Trash2 className="h-4 w-4" />
                <span>P{safeSelectedIndex + 1}</span>
              </button>
              <button
                type="button"
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                aria-label="Annuler dernier déplacement"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-2.5 text-xs font-medium text-slate-200 disabled:opacity-40"
              >
                <Undo2 className="h-4 w-4" />
              </button>
            </div>

            {/* Zoom + Recentrer + Recommencer */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleZoomStep(-0.5)}
                disabled={zoomState.zoom <= 1}
                aria-label="Zoom -"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-3 text-xs font-semibold text-slate-100 hover:border-[#38BDF8] disabled:opacity-40 whitespace-nowrap"
              >
                <ZoomOut className="h-4 w-4" />
                <span className="hidden sm:inline">Zoom -</span>
              </button>
              <span className="min-w-[46px] text-center font-mono text-xs font-bold tabular-nums text-[#38BDF8]">
                {zoomState.zoom.toFixed(1)}×
              </span>
              <button
                type="button"
                onClick={() => handleZoomStep(0.5)}
                disabled={zoomState.zoom >= 6}
                aria-label="Zoom +"
                className="inline-flex min-h-[44px] items-center gap-1 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-3 text-xs font-semibold text-slate-100 hover:border-[#38BDF8] disabled:opacity-40 whitespace-nowrap"
              >
                <ZoomIn className="h-4 w-4" />
                <span className="hidden sm:inline">Zoom +</span>
              </button>
              <button
                type="button"
                onClick={handleResetView}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-3 text-xs font-semibold text-slate-100 hover:border-[#38BDF8] whitespace-nowrap"
              >
                <Maximize2 className="h-4 w-4 text-[#38BDF8]" />
                <span>Recentrer</span>
              </button>
              <button
                type="button"
                onClick={handleRestartPoints}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-slate-700 bg-[#0E1525]/90 px-3 text-xs font-semibold text-slate-200 hover:border-amber-400 whitespace-nowrap"
              >
                <RotateCcw className="h-4 w-4 text-amber-400" />
                <span className="hidden sm:inline">Recommencer</span>
              </button>
            </div>

            {/* Primary Validation CTA */}
            {onValidate && (
              <button
                type="button"
                onClick={() => onValidate(isShowingFrozen ? null : captureCurrentVideoFrame())}
                className="inline-flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 text-sm font-bold text-white shadow-lg hover:bg-emerald-500 whitespace-nowrap"
              >
                <Check className="h-4 w-4" />
                Valider la cible
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Fallback embedded view (used only if fullScreen=false)
  return (
    <div className="space-y-3">
      <div className="h-[62vh] w-full overflow-hidden rounded-2xl border border-slate-800 bg-black">
        {renderInteractiveStage}
      </div>
    </div>
  );
};
