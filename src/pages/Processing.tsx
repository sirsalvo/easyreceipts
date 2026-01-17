import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2 } from "lucide-react";
import { useApiConfig } from "@/contexts/ApiConfigContext";
import { useAuth } from "@/contexts/AuthContext";

// Processing page: polls backend until OCR artifacts are ready, then routes to Review.
// IMPORTANT: always pass sessionToken to API calls, otherwise requests may go out unauthenticated.

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_SECONDS = 180; // UI timeout; backend can be slower but we should stop spamming.

const Processing = () => {
  const { receiptId } = useParams<{ receiptId: string }>();
  const navigate = useNavigate();
  const { config, fetchWithAuth } = useApiConfig();
  const { sessionToken, handleUnauthorized } = useAuth();

  const [statusText, setStatusText] = useState("Processing");
  const [error, setError] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  const startedAtRef = useRef<number>(Date.now());
  const intervalRef = useRef<number | null>(null);

  const stopPolling = () => {
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPolling(false);
  };

  const isDone = (data: any) => {
    // Support multiple backend response shapes (older + current).
    const status = String(data?.status ?? data?.item?.status ?? "").toUpperCase();
    const ocrState = String(data?.ocrState ?? data?.item?.ocrState ?? "").toUpperCase();

    // Old pipeline: status becomes OCR_DONE.
    // Current pipeline: ocrState becomes READY.
    return ocrState === "READY" || status === "OCR_DONE";
  };

  const checkReceiptStatus = async () => {
    if (!receiptId) return;

    const elapsedSeconds = (Date.now() - startedAtRef.current) / 1000;
    if (elapsedSeconds > MAX_POLL_SECONDS) {
      setError(`Timeout: OCR not ready after ${MAX_POLL_SECONDS}s`);
      setStatusText("Processing Failed");
      stopPolling();
      return;
    }

    try {
      const url = `${config.baseUrl}/receipts/${receiptId}`;
      const resp = await fetchWithAuth(
        url,
        {
          method: "GET",
          headers: {
            // keep JSON content-type for consistent API Gateway behavior
            "Content-Type": "application/json",
          },
        },
        sessionToken
      );

      if (resp.status === 401 || resp.status === 403) {
        // Session expired or token not accepted by authorizer.
        handleUnauthorized();
        setError("Unauthorized. Please sign in again from Settings.");
        setStatusText("Processing Failed");
        stopPolling();
        return;
      }

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        const msg = body?.message || `HTTP ${resp.status}`;
        throw new Error(msg);
      }

      const data = await resp.json().catch(() => ({}));

      // Update status for UI
      const status = String(data?.status ?? data?.item?.status ?? "");
      const ocrState = String(data?.ocrState ?? data?.item?.ocrState ?? "");
      if (ocrState) setStatusText(`OCR state: ${ocrState}`);
      else if (status) setStatusText(`Status: ${status}`);

      if (isDone(data)) {
        stopPolling();
        navigate(`/review/${receiptId}`);
      }
    } catch (e: any) {
      console.error("Failed to check status:", e);
      setError(e?.message || "Failed to check status");
      setStatusText("Processing Failed");
      stopPolling();
    }
  };

  useEffect(() => {
    if (!receiptId) return;

    // Kick immediately
    checkReceiptStatus();

    intervalRef.current = window.setInterval(() => {
      if (isPolling) checkReceiptStatus();
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptId]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-background">
      <div className="w-full max-w-md space-y-6">
        <Button variant="ghost" className="mb-4" onClick={() => navigate(-1)}>
          ← Back
        </Button>

        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-xl">Processing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {isPolling && !error && (
              <div className="flex flex-col items-center space-y-3">
                <Loader2 className="h-10 w-10 animate-spin" />
                <p className="font-medium">{statusText}</p>
                <p className="text-sm text-muted-foreground">
                  We&apos;re extracting receipt metadata. This usually takes a few seconds.
                </p>
              </div>
            )}

            {error && (
              <div className="flex flex-col items-center space-y-3">
                <div className="rounded-full p-4 bg-destructive/10">
                  <AlertCircle className="h-10 w-10 text-destructive" />
                </div>
                <p className="font-semibold">Processing Failed</p>
                <p className="text-sm text-destructive">{error}</p>

                <div className="flex gap-3 pt-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setError(null);
                      setStatusText("Processing");
                      setIsPolling(true);
                      startedAtRef.current = Date.now();
                      checkReceiptStatus();
                      if (!intervalRef.current) {
                        intervalRef.current = window.setInterval(() => {
                          checkReceiptStatus();
                        }, POLL_INTERVAL_MS);
                      }
                    }}
                  >
                    Retry
                  </Button>
                  <Button onClick={() => navigate("/upload-image")}>Upload New</Button>
                </div>
              </div>
            )}

            <div className="pt-4 border-t">
              <p className="text-xs text-muted-foreground">Receipt ID: {receiptId}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Processing;
