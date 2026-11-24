import React, {useEffect, useState} from 'react';
import {Download, Share, WifiOff, X} from 'lucide-react';
import {registerSW} from 'virtual:pwa-register';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{outcome: 'accepted' | 'dismissed'; platform: string}>;
}

export function useServiceWorkerInit() {
  useEffect(() => {
    registerSW({immediate: true});
  }, []);
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as {standalone?: boolean}).standalone === true;
    setIsInstalled(isStandalone);

    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const {outcome} = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: !!deferredPrompt,
    isInstalled,
    isIOS,
    install,
  };
}

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return isOnline;
}

export const PWAInstallButton: React.FC<{compact?: boolean}> = ({compact = false}) => {
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-[#4F7CFF]/50 bg-[#4F7CFF]/15 px-3.5 py-2 text-xs font-semibold text-[#F8FAFC] transition-colors hover:bg-[#4F7CFF]/25 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-[#38BDF8]"
      >
        <Download className="h-4 w-4 text-[#38BDF8]" />
        {compact ? 'Installer' : 'Installer l’app'}
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3.5 py-2 text-xs font-medium text-[#F8FAFC] transition-colors hover:border-[#38BDF8]/60 whitespace-nowrap shrink-0"
        >
          <Share className="h-4 w-4 text-[#38BDF8]" />
          Installer sur iOS
        </button>
        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
            <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#0E1525] p-6 text-[#F8FAFC]">
              <div className="flex items-center justify-between">
                <h3 className="font-display text-lg font-semibold">Installer NERF SCORE sur iOS</h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Fermer"
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <ol className="mt-4 space-y-2.5 text-sm text-slate-300">
                <li>1. Touchez le bouton <strong>Partager</strong> dans Safari.</li>
                <li>2. Faites défiler et sélectionnez <strong>Sur l’écran d’accueil</strong>.</li>
                <li>3. Confirmez avec <strong>Ajouter</strong> pour utiliser NERF SCORE hors ligne.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full min-h-[44px] rounded-xl bg-[#4F7CFF] py-2.5 text-sm font-semibold text-white hover:bg-[#3E6AE8]"
              >
                Compris
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-20 left-4 z-40 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-[#0E1525]/95 px-3 py-2 text-xs font-medium text-amber-300 backdrop-blur-md md:bottom-4"
    >
      <WifiOff className="h-3.5 w-3.5 text-amber-400" />
      <span>Mode hors ligne actif — Analyse locale et IndexedDB opérationnels</span>
    </div>
  );
};
