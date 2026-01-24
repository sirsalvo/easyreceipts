import { useState, useEffect } from 'react';
import { Smartphone, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { isAuthenticated } from '@/lib/auth';

const A2HS_DISMISSED_KEY = 'spendify_a2hs_dismissed';

type Platform = 'ios' | 'android' | 'other';

const detectPlatform = (): Platform => {
  const ua = navigator.userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  return 'other';
};

const isStandalone = (): boolean => {
  // Check display-mode standalone
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  // Check iOS standalone mode
  if ('standalone' in navigator && (navigator as any).standalone) return true;
  return false;
};

const isMobileDevice = (): boolean => {
  return window.matchMedia('(max-width: 768px)').matches;
};

export const A2HSBanner = () => {
  const [showBanner, setShowBanner] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const [platform, setPlatform] = useState<Platform>('other');

  useEffect(() => {
    // Check all conditions
    const shouldShow =
      isMobileDevice() &&
      !isStandalone() &&
      isAuthenticated() &&
      localStorage.getItem(A2HS_DISMISSED_KEY) !== '1';

    if (shouldShow) {
      setPlatform(detectPlatform());
      setShowBanner(true);
    }
  }, []);

  const handleDismiss = () => {
    localStorage.setItem(A2HS_DISMISSED_KEY, '1');
    setShowBanner(false);
  };

  const handleShowInstructions = () => {
    setShowInstructions(true);
  };

  if (!showBanner) return null;

  return (
    <>
      <div className="flex items-center gap-3 p-3 rounded-lg bg-primary/10 border border-primary/20">
        <Smartphone className="h-5 w-5 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground">
            Add Spendify to your home screen
          </p>
          <p className="text-xs text-muted-foreground">
            Open faster, like a native app.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="default"
            size="sm"
            onClick={handleShowInstructions}
            className="h-7 px-3 text-xs"
          >
            How
          </Button>
          <button
            onClick={handleDismiss}
            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <Sheet open={showInstructions} onOpenChange={setShowInstructions}>
        <SheetContent side="bottom" className="max-h-[60vh]">
          <SheetHeader className="text-left">
            <SheetTitle>Add to Home Screen</SheetTitle>
          </SheetHeader>
          
          <div className="mt-4 space-y-6">
            {/* iOS Instructions */}
            <div className={platform === 'ios' ? 'order-first' : ''}>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                iPhone / iPad (Safari)
              </h3>
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <span className="font-medium text-foreground">1.</span>
                  Open this page in Safari
                </li>
                <li className="flex gap-2">
                  <span className="font-medium text-foreground">2.</span>
                  Tap the Share button
                </li>
                <li className="flex gap-2">
                  <span className="font-medium text-foreground">3.</span>
                  Tap "Add to Home Screen"
                </li>
              </ol>
            </div>

            {/* Android Instructions */}
            <div className={platform === 'android' ? 'order-first' : ''}>
              <h3 className="text-sm font-semibold text-foreground mb-3">
                Android (Chrome)
              </h3>
              <ol className="space-y-2 text-sm text-muted-foreground">
                <li className="flex gap-2">
                  <span className="font-medium text-foreground">1.</span>
                  Tap the menu icon (three dots)
                </li>
                <li className="flex gap-2">
                  <span className="font-medium text-foreground">2.</span>
                  Tap "Add to Home screen"
                </li>
              </ol>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t">
            <Button
              variant="outline"
              onClick={() => setShowInstructions(false)}
              className="w-full"
            >
              Got it
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};
