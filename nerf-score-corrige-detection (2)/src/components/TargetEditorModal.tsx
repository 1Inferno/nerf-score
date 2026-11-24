import React, {useState} from 'react';
import {Plus, Trash2, X} from 'lucide-react';
import {TargetProfile, TargetZone, ZoneShape} from '../types/nerf';

interface TargetEditorModalProps {
  initialProfile: TargetProfile;
  onSave: (profile: TargetProfile) => Promise<void>;
  onClose: () => void;
}

export const TargetEditorModal: React.FC<TargetEditorModalProps> = ({
  initialProfile,
  onSave,
  onClose,
}) => {
  const [name, setName] = useState(initialProfile.name);
  const [description, setDescription] = useState(initialProfile.description);
  const [aspectRatio, setAspectRatio] = useState(initialProfile.aspectRatio);
  const [zones, setZones] = useState<TargetZone[]>(
    initialProfile.zones.map((z) => ({...z})),
  );
  const [saving, setSaving] = useState(false);

  const handleAddZone = () => {
    const nextIdx = zones.length + 1;
    setZones((prev) => [
      ...prev,
      {
        id: `zone-${Date.now()}`,
        name: `Zone ${nextIdx}`,
        points: 10,
        shape: 'circle',
        radiusRatio: Math.min(0.49, (prev[prev.length - 1]?.radiusRatio ?? 0.35) + 0.08),
        color: '#38BDF8',
      },
    ]);
  };

  const handleUpdateZone = (idx: number, patch: Partial<TargetZone>) => {
    setZones((prev) => prev.map((z, i) => (i === idx ? {...z, ...patch} : z)));
  };

  const handleRemoveZone = (idx: number) => {
    if (zones.length <= 1) return;
    setZones((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        ...initialProfile,
        name: name.trim() || 'Cible personnalisée',
        description: description.trim(),
        aspectRatio: Math.max(0.5, Math.min(2.0, aspectRatio)),
        zones: zones.sort((a, b) => a.radiusRatio - b.radiusRatio),
        updatedAt: Date.now(),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 backdrop-blur-sm md:items-center md:p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-3xl border border-slate-800 bg-[#0E1525] text-[#F8FAFC] md:rounded-2xl">
        <div className="flex items-center justify-between border-b border-slate-800/90 px-6 py-4">
          <h2 className="font-display text-lg font-semibold tracking-tight">
            Éditeur de cible personnalisée
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer l’éditeur"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Live geometry preview */}
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-800 bg-[#070B14] p-4">
              <svg viewBox="0 0 100 100" className="h-52 w-52">
                <rect
                  x="2"
                  y="2"
                  width="96"
                  height="96"
                  fill="none"
                  stroke="#1E293B"
                  strokeWidth="0.8"
                />
                {[...zones]
                  .sort((a, b) => b.radiusRatio - a.radiusRatio)
                  .map((zone) => {
                    const rx = zone.radiusRatio * 96;
                    const ry =
                      zone.shape === 'ellipse'
                        ? (zone.radiusRatio * 96) / Math.max(0.5, aspectRatio)
                        : rx;
                    if (zone.shape === 'polygon') {
                      const pts = Array.from({length: 6}, (_, k) => {
                        const a = (k / 6) * Math.PI * 2 - Math.PI / 6;
                        return `${50 + Math.cos(a) * rx},${50 + Math.sin(a) * ry}`;
                      }).join(' ');
                      return (
                        <polygon
                          key={zone.id}
                          points={pts}
                          fill={zone.color}
                          fillOpacity={0.14}
                          stroke={zone.color}
                          strokeWidth="0.9"
                        />
                      );
                    }
                    return (
                      <ellipse
                        key={zone.id}
                        cx="50"
                        cy="50"
                        rx={rx}
                        ry={ry}
                        fill={zone.color}
                        fillOpacity={0.14}
                        stroke={zone.color}
                        strokeWidth="0.9"
                      />
                    );
                  })}
                <line x1="46" y1="50" x2="54" y2="50" stroke="#F8FAFC" strokeWidth="0.7" />
                <line x1="50" y1="46" x2="50" y2="54" stroke="#F8FAFC" strokeWidth="0.7" />
              </svg>
              <p className="mt-2 text-xs text-slate-400">
                Extérieur de la cible : 0 point (automatique)
              </p>
            </div>

            {/* Profile metadata */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Nom de la configuration
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#070B14] px-3.5 py-2.5 text-sm text-[#F8FAFC] focus:border-[#4F7CFF] focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700 bg-[#070B14] px-3.5 py-2.5 text-sm text-[#F8FAFC] focus:border-[#4F7CFF] focus:outline-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs font-medium text-slate-300">
                  <span>Ratio largeur / hauteur</span>
                  <span className="font-mono tabular-nums text-[#38BDF8]">
                    {aspectRatio.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={0.6}
                  max={1.6}
                  step={0.05}
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(parseFloat(e.target.value))}
                  className="mt-2 w-full accent-[#4F7CFF]"
                />
              </div>
            </div>
          </div>

          {/* Zones list */}
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#F8FAFC]">
                Zones et barème de points
              </h3>
              <button
                type="button"
                onClick={handleAddZone}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-[#4F7CFF]/50 bg-[#4F7CFF]/15 px-3 py-1.5 text-xs font-semibold text-[#F8FAFC] hover:bg-[#4F7CFF]/25"
              >
                <Plus className="h-4 w-4 text-[#38BDF8]" />
                Ajouter une zone
              </button>
            </div>

            <div className="mt-3 divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#070B14]">
              {zones.map((zone, idx) => (
                <div
                  key={zone.id}
                  className="grid grid-cols-12 items-center gap-2.5 p-3 text-xs"
                >
                  <input
                    type="text"
                    value={zone.name}
                    onChange={(e) => handleUpdateZone(idx, {name: e.target.value})}
                    aria-label="Nom de la zone"
                    className="col-span-4 rounded-md border border-slate-800 bg-[#0E1525] px-2.5 py-2 text-[#F8FAFC] md:col-span-3"
                  />
                  <div className="col-span-3 md:col-span-2">
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      value={zone.points}
                      onChange={(e) =>
                        handleUpdateZone(idx, {points: Math.max(0, Number(e.target.value))})
                      }
                      aria-label="Points"
                      className="w-full rounded-md border border-slate-800 bg-[#0E1525] px-2.5 py-2 font-mono tabular-nums text-[#F8FAFC]"
                    />
                  </div>
                  <select
                    value={zone.shape}
                    onChange={(e) =>
                      handleUpdateZone(idx, {shape: e.target.value as ZoneShape})
                    }
                    aria-label="Forme de la zone"
                    className="col-span-4 rounded-md border border-slate-800 bg-[#0E1525] px-2 py-2 text-[#F8FAFC] md:col-span-3"
                  >
                    <option value="circle">Cercle</option>
                    <option value="ellipse">Ellipse</option>
                    <option value="polygon">Polygone</option>
                  </select>
                  <div className="col-span-8 flex items-center gap-2 md:col-span-3">
                    <span className="text-slate-400">Rayon</span>
                    <input
                      type="range"
                      min={0.05}
                      max={0.5}
                      step={0.01}
                      value={zone.radiusRatio}
                      onChange={(e) =>
                        handleUpdateZone(idx, {radiusRatio: parseFloat(e.target.value)})
                      }
                      className="w-full accent-[#38BDF8]"
                    />
                    <span className="font-mono tabular-nums text-slate-300">
                      {Math.round(zone.radiusRatio * 200)}%
                    </span>
                  </div>
                  <div className="col-span-4 flex items-center justify-end gap-1.5 md:col-span-1">
                    <input
                      type="color"
                      value={zone.color}
                      onChange={(e) => handleUpdateZone(idx, {color: e.target.value})}
                      aria-label="Couleur"
                      className="h-8 w-8 cursor-pointer rounded border border-slate-700 bg-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveZone(idx)}
                      disabled={zones.length <= 1}
                      aria-label="Supprimer la zone"
                      className="flex h-9 w-9 items-center justify-center rounded-md text-slate-400 hover:bg-red-500/15 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-xl border border-slate-700 px-5 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={saving}
              className="min-h-[44px] rounded-xl bg-[#4F7CFF] px-6 py-2.5 text-sm font-semibold text-white hover:bg-[#3E6AE8] disabled:opacity-50"
            >
              {saving ? 'Enregistrement…' : 'Enregistrer la cible'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
