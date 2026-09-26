import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { toast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import { completeYnabAuthorization, ynabErrorMessage } from '@/lib/ynab';

// Landing page of the YNAB authorization redirect (/ynab/callback).
const YnabCallback = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  // A code can be used once: guard against React running the effect twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const providerError = params.get('error');
    const code = params.get('code');
    const state = params.get('state');

    if (providerError) {
      setError(
        providerError === 'access_denied'
          ? 'You cancelled the YNAB authorization.'
          : `YNAB returned an error (${providerError}).`
      );
      return;
    }
    if (!code || !state) {
      setError('The YNAB authorization data is missing. Start the connection again.');
      return;
    }

    completeYnabAuthorization(code, state)
      .then(() => {
        toast({ title: 'YNAB connected', description: 'Now choose the plan and account for your receipts.' });
        navigate('/settings', { replace: true });
      })
      .catch((e) => setError(ynabErrorMessage(e)));
  }, [params, navigate]);

  return (
    <MobileLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4">
        {error ? (
          <Card className="w-full">
            <CardContent className="pt-6 space-y-4">
              <p className="text-sm">{error}</p>
              <Button onClick={() => navigate('/settings', { replace: true })} className="w-full">
                Back to Settings
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">Connecting to YNAB...</p>
          </>
        )}
      </div>
    </MobileLayout>
  );
};

export default YnabCallback;
