import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, CreditCard, AlertTriangle } from 'lucide-react';
import { useUserStatus } from '@/hooks/useUserStatus';
import { createCheckoutSession } from '@/lib/api';
import { toast } from '@/hooks/use-toast';

const BillingBanner = () => {
  const { status, daysRemaining, loading } = useUserStatus();
  const [redirecting, setRedirecting] = useState(false);

  const handleActivateSubscription = async () => {
    setRedirecting(true);
    try {
      const { url } = await createCheckoutSession();
      window.location.href = url;
    } catch (error) {
      console.error('Checkout error:', error);
      toast({
        title: 'Error',
        description: 'Something went wrong. Please try again later.',
        variant: 'destructive',
      });
      setRedirecting(false);
    }
  };

  // Don't show banner if loading, active, or no status yet
  if (loading || status === 'active' || status === null) {
    return null;
  }

  const isExpired = status === 'expired';

  return (
    <div
      className={`px-4 py-3 flex items-center justify-between gap-3 ${
        isExpired
          ? 'bg-destructive/10 border-b border-destructive/30'
          : 'bg-amber-500/10 border-b border-amber-500/30'
      }`}
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {isExpired ? (
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
        ) : (
          <CreditCard className="h-4 w-4 text-amber-600 shrink-0" />
        )}
        <span
          className={`text-xs font-medium truncate ${
            isExpired ? 'text-destructive' : 'text-amber-700'
          }`}
        >
          {isExpired
            ? 'Your free trial has ended. Please activate a subscription to continue.'
            : `Free trial: ${daysRemaining} days remaining`}
        </span>
      </div>
      <Button
        size="sm"
        variant={isExpired ? 'destructive' : 'default'}
        onClick={handleActivateSubscription}
        disabled={redirecting}
        className="shrink-0 text-xs h-7 px-2"
      >
        {redirecting ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          'Activate subscription'
        )}
      </Button>
    </div>
  );
};

export default BillingBanner;
