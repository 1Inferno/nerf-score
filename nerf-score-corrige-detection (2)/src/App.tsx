import {useCallback, useEffect, useState} from 'react';
import {BarChart3, Camera, Film, Home, Settings} from 'lucide-react';
import {HomeView} from './components/HomeView';
import {ReplaysView} from './components/ReplaysView';
import {SessionView} from './components/SessionView';
import {SettingsView} from './components/SettingsView';
import {StatsView} from './components/StatsView';
import {computeSessionSummary} from './cv/geometry';
import {
  deleteSessionCascade,
  deleteTargetProfile,
  getAllBenchmarks,
  getAllSessions,
  getAllShots,
  getAllTargetProfiles,
  getLatestSavedCalibration,
  getSettings,
  resetAllShotsPreservingCalibration,
  saveSession,
  saveSettings,
  saveShot,
  saveTargetProfile,
} from './db/indexedDb';
import {OfflineIndicator, PWAInstallButton, useServiceWorkerInit} from './pwa/usePWAInstall';
import {
  AppRoute,
  AppSettings,
  BenchmarkTestRun,
  DEFAULT_SETTINGS,
  DEFAULT_TARGET_PROFILE,
  OfficialCalibration,
  ShootingSession,
  ShotEvent,
  TargetProfile,
} from './types/nerf';

export default function App() {
  useServiceWorkerInit();

  const [route, setRoute] = useState<AppRoute>('home');
  const [replaySessionFilter, setReplaySessionFilter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [targets, setTargets] = useState<TargetProfile[]>([DEFAULT_TARGET_PROFILE]);
  const [sessions, setSessions] = useState<ShootingSession[]>([]);
  const [shots, setShots] = useState<ShotEvent[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkTestRun[]>([]);
  const [activeCalibration, setActiveCalibration] = useState<OfficialCalibration | null>(null);
  const [shotsResetVersion, setShotsResetVersion] = useState<number>(0);

  const loadAll = useCallback(async (hydrateCalibration = false) => {
    const [
      loadedSettings,
      loadedTargets,
      loadedSessions,
      loadedShots,
      loadedBenchmarks,
      loadedCal,
    ] = await Promise.all([
      getSettings(),
      getAllTargetProfiles(),
      getAllSessions(),
      getAllShots(),
      getAllBenchmarks(),
      getLatestSavedCalibration(),
    ]);
    setSettings(loadedSettings);
    setTargets(loadedTargets);
    setSessions(loadedSessions);
    setShots(loadedShots);
    setBenchmarks(loadedBenchmarks);
    setActiveCalibration((prev) => {
      if (!loadedCal) return null;
      return hydrateCalibration ? loadedCal : prev;
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll(true);
  }, [loadAll]);

  const activeTarget =
    targets.find((t) => t.id === settings.activeTargetProfileId) || targets[0] || DEFAULT_TARGET_PROFILE;

  const handleSaveSettings = async (next: AppSettings) => {
    setSettings(next);
    await saveSettings(next);
  };

  const handleSaveTargetProfile = async (profile: TargetProfile) => {
    await saveTargetProfile(profile);
    await loadAll();
  };

  const handleDeleteTargetProfile = async (id: string) => {
    await deleteTargetProfile(id);
    await loadAll();
  };

  const handleUpdateShot = async (updatedShot: ShotEvent) => {
    await saveShot(updatedShot);
    const nextShots = shots.map((s) => (s.id === updatedShot.id ? updatedShot : s));
    setShots(nextShots);

    // Recompute session summary so statistics stay 100% consistent
    const parentSession = sessions.find((s) => s.id === updatedShot.sessionId);
    if (parentSession) {
      const sessionShots = nextShots.filter((s) => s.sessionId === parentSession.id);
      const updatedSession: ShootingSession = {
        ...parentSession,
        summary: computeSessionSummary(sessionShots),
      };
      await saveSession(updatedSession);
      setSessions((prev) => prev.map((s) => (s.id === updatedSession.id ? updatedSession : s)));
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    await deleteSessionCascade(sessionId);
    await loadAll();
  };

  const handleResetAllShots = async () => {
    await resetAllShotsPreservingCalibration();
    setShotsResetVersion((v) => v + 1);
    await loadAll();
  };

  const handleStartNewCalibration = () => {
    setActiveCalibration(null);
    setRoute('session');
  };

  const openReplaysForSession = (sessionId: string) => {
    setReplaySessionFilter(sessionId);
    setRoute('replays');
  };

  return (
    <div className="min-h-screen bg-[#070B14] text-[#F8FAFC] pb-20 md:pb-8">
      {/* Desktop & Mobile Top Navigation Bar (Strict 3-zone contract) */}
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#070B14]/90 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6">
          {/* Zone 1: Single-element brand wordmark */}
          <button
            type="button"
            onClick={() => setRoute('home')}
            className="font-display text-lg font-bold tracking-tight text-[#F8FAFC] whitespace-nowrap shrink-0"
          >
            NERF SCORE
          </button>

          {/* Zone 2: 4 clean single-line navigation links */}
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
            {[
              {id: 'home' as const, label: 'Accueil'},
              {id: 'session' as const, label: 'Nouvelle session'},
              {id: 'replays' as const, label: 'Mes replays'},
              {id: 'stats' as const, label: 'Statistiques'},
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  if (item.id === 'replays') setReplaySessionFilter(null);
                  setRoute(item.id);
                }}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 ${
                  route === item.id
                    ? 'text-[#38BDF8] border-b-2 border-[#38BDF8]'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>

          {/* Zone 3: Settings & PWA install */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:block">
              <PWAInstallButton compact />
            </div>
            <button
              type="button"
              onClick={() => setRoute('settings')}
              className={`inline-flex min-h-[40px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                route === 'settings'
                  ? 'bg-[#4F7CFF] text-white'
                  : 'border border-slate-700 bg-[#0E1525] text-slate-200 hover:border-[#38BDF8]'
              }`}
            >
              <Settings className="h-4 w-4" />
              <span>Paramètres</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content Container */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 md:py-8">
        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {[1, 2, 3].map((n) => (
              <div
                key={n}
                className="h-32 animate-pulse rounded-2xl border border-slate-800 bg-[#0E1525]"
              />
            ))}
          </div>
        ) : (
          <>
            {route === 'home' && (
              <HomeView
                sessions={sessions}
                shots={shots}
                activeTarget={activeTarget}
                onNavigate={setRoute}
                onSelectSessionReplays={openReplaysForSession}
              />
            )}
            {route === 'session' && (
              <SessionView
                settings={settings}
                targets={targets}
                activeTarget={activeTarget}
                savedOfficialCalibration={activeCalibration}
                shotsResetVersion={shotsResetVersion}
                onCalibrationValidated={(cal) => setActiveCalibration(cal)}
                onCalibrationCleared={() => setActiveCalibration(null)}
                onSaveTargetProfile={handleSaveTargetProfile}
                onSessionSaved={loadAll}
                onOpenReplaysForSession={openReplaysForSession}
              />
            )}
            {route === 'replays' && (
              <ReplaysView
                sessions={sessions}
                shots={shots}
                targets={targets}
                initialSessionFilter={replaySessionFilter}
                onUpdateShot={handleUpdateShot}
                onDeleteSession={handleDeleteSession}
              />
            )}
            {route === 'stats' && (
              <StatsView sessions={sessions} shots={shots} activeTarget={activeTarget} />
            )}
            {route === 'settings' && (
              <SettingsView
                settings={settings}
                targets={targets}
                shots={shots}
                benchmarks={benchmarks}
                hasActiveCalibration={Boolean(activeCalibration)}
                onSaveSettings={handleSaveSettings}
                onSaveTarget={handleSaveTargetProfile}
                onDeleteTarget={handleDeleteTargetProfile}
                onResetAllShots={handleResetAllShots}
                onStartNewCalibration={handleStartNewCalibration}
                onRefreshAll={loadAll}
              />
            )}
          </>
        )}
      </main>

      {/* Mobile Bottom Tab Bar (Thumb-zone navigation, <= 15% sticky height) */}
      <nav
        aria-label="Navigation mobile"
        className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-5 items-center border-t border-slate-800 bg-[#070B14]/95 px-1 pb-safe backdrop-blur-md md:hidden"
      >
        {[
          {id: 'home' as const, label: 'Accueil', icon: Home},
          {id: 'session' as const, label: 'Session', icon: Camera},
          {id: 'replays' as const, label: 'Replays', icon: Film},
          {id: 'stats' as const, label: 'Stats', icon: BarChart3},
          {id: 'settings' as const, label: 'Réglages', icon: Settings},
        ].map((item) => {
          const Icon = item.icon;
          const active = route === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'replays') setReplaySessionFilter(null);
                setRoute(item.id);
              }}
              className={`flex min-h-[44px] flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
                active ? 'text-[#38BDF8]' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

      <OfflineIndicator />
    </div>
  );
}
