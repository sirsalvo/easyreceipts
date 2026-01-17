import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { toast } from '@/hooks/use-toast';
import { getReceipt } from '@/lib/api';
import { normalizeReceiptResponse } from '@/lib/receiptNormalizer';
import { Loader2, FileCheck, AlertCircle, RotateCcw } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';

const Processing = () => {
  const navigate = useNavigate();
  const { receiptId } = useParams<{ receiptId: string }>();
  const [status, setStatus] = useState<'processing' | 'ready' | 'error'>('processing');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const maxPolls = 30; // 30 * 2s = 60 seconds max

  useEffect(() => {
    if (!receiptId) {
      navigate('/upload');
      return;
    }

    const checkStatus = async () => {
      try {
        const response = await getReceipt(receiptId);
        const normalized = normalizeReceiptResponse(response);

        // Simulate progress based on poll count
        const newProgress = Math.min(90, (pollCount / maxPolls) * 100);
        setProgress(newProgress);

        // Check if processing is complete
        if (
          normalized.status === 'READY' ||
          normalized.status === 'EXTRACTED' ||
          normalized.status === 'PENDING_REVIEW' ||
          normalized.status === 'DRAFT' ||
          normalized.payee || // If we have extracted data, consider it ready
          normalized.total !== null
        ) {
          setProgress(100);
          setStatus('ready');
          return;
        }

        // Continue polling if not max polls
        if (pollCount < maxPolls) {
          setPollCount((prev) => prev + 1);
        } else {
          // Timeout - still navigate to review
          setProgress(100);
          setStatus('ready');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred');
        setStatus('error');
      }
    };

    if (status === 'processing') {
      const timer = setTimeout(checkStatus, 2000);
      return () => clearTimeout(timer);
    }
  }, [receiptId, pollCount, status, navigate]);

  useEffect(() => {
    if (status === 'ready') {
      // Auto-navigate to review after a brief delay
      const timer = setTimeout(() => {
        navigate(`/review/${receiptId}`);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [status, receiptId, navigate]);

  const handleRetry = () => {
    setStatus('processing');
    setProgress(0);
    setPollCount(0);
    setError(null);
  };

  return (
    <MobileLayout>
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-4">
        <Card className="w-full max-w-sm">
          <CardContent className="p-8 space-y-6 text-center">
            {status === 'processing' && (
              <>
                <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                  <Loader2 className="h-10 w-10 text-primary animate-spin" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold">Processing Receipt</h2>
                  <p className="text-sm text-muted-foreground">
                    Extracting data from your receipt...
                  </p>
                </div>
                <div className="space-y-2">
                  <Progress value={progress} className="h-2" />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(progress)}% complete
                  </p>
                </div>
              </>
            )}

            {status === 'ready' && (
              <>
                <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
                  <FileCheck className="h-10 w-10 text-primary" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold">Processing Complete</h2>
                  <p className="text-sm text-muted-foreground">
                    Redirecting to review...
                  </p>
                </div>
                <Progress value={100} className="h-2" />
              </>
            )}

            {status === 'error' && (
              <>
                <div className="mx-auto w-20 h-20 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle className="h-10 w-10 text-destructive" />
                </div>
                <div className="space-y-2">
                  <h2 className="text-xl font-semibold">Processing Failed</h2>
                  <p className="text-sm text-muted-foreground">{error}</p>
                </div>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => navigate('/upload')} className="flex-1">
                    Back
                  </Button>
                  <Button onClick={handleRetry} className="flex-1">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Retry
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </MobileLayout>
  );
};

export default Processing;
