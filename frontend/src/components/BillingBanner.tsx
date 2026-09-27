import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, CreditCard, AlertTriangle } from 'lucide-react';
import { useUserStatus } from '@/hooks/useUserStatus';
import { createCheckoutSession } from '@/lib/api';
import { toast } from '@/hooks/use-toast';

const BillingBanner = () => {
  const { status, freeTier, loading } = useUserStatus();
  const [redirecting, setRedirecting] = useState(false);

  const handleActivateSubscription = async () => {
    setRedirecting(true);
    try {
      const { url } = await createCheckoutSession();
      window.location.href = url;
    } catch (error) {
      console.error('Checkout error:', error);
      const errorMessage = error instanceof Error ? error.message : '';
      
      // If not a session/auth error, show specific checkout error
      if (!errorMessage.includes('Session expired') && !errorMessage.includes('login')) {
        toast({
          title: 'Checkout error',
          description: 'Unable to start checkout. Please try again or contact support.',
          variant: 'destructive',
        });
        setRedirecting(false);
      }
      // If session expired, api.ts already handles redirect - just reset state
      setRedirecting(false);
    }
  };

  // Don't show banner if loading, active (unlimited), or usage hasn't loaded yet
  if (loading || status === 'active' || !freeTier) {
    return null;
  }

  const quotaUsedUp = freeTier.remaining <= 0;
  const resetDate = new Date(freeTier.resetsAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  return (
    <div
      className={`px-4 py-3 flex items-center justify-between gap-3 ${
        quotaUsedUp
          ? 'bg-destructive/10 border-b border-destructive/30'
          : 'bg-amber-500/10 border-b border-amber-500/30'
      }`}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {quotaUsedUp ? (
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
        ) : (
          <CreditCard className="h-4 w-4 text-amber-600 shrink-0" />
        )}
        <span
          className={`text-xs font-medium truncate ${
            quotaUsedUp ? 'text-destructive' : 'text-amber-700'
          }`}
        >
          {quotaUsedUp
            ? `You've used all ${freeTier.limit} free receipts this month. Resets ${resetDate}.`
            : `Free plan: ${freeTier.used} of ${freeTier.limit} receipts used this month`}
        </span>
      </div>
      <Button
        size="sm"
        variant={quotaUsedUp ? 'destructive' : 'default'}
        onClick={handleActivateSubscription}
        disabled={redirecting}
        className="shrink-0 text-xs h-7 px-2"
      >
        {redirecting ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          'Upgrade'
        )}
      </Button>
    </div>
  );
};

export default BillingBanner;
