import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseAuthCallback, saveAuthSession, exchangeCodeForTokens, getOAuthFlow, verifyState } from '@/lib/auth';
import { toast } from '@/hooks/use-toast';
import { useUserStatus } from '@/hooks/useUserStatus';
import { Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const AuthCallback = () => {
  const navigate = useNavigate();
  const [authStatus, setAuthStatus] = useState('Authenticating...');
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { fetchStatus } = useUserStatus();

  useEffect(() => {
    const handleCallback = async () => {
      const flow = getOAuthFlow();
      const queryParams = new URLSearchParams(window.location.search);
      const hashParams = new URLSearchParams(
        window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
      );

      // Check for errors first (can come from query or hash)
      const errorParam = queryParams.get('error') || hashParams.get('error');
      const errorDescription = queryParams.get('error_description') || hashParams.get('error_description');

      if (errorParam) {
        const errorMsg = errorDescription || `Cognito error: ${errorParam}`;
        setError(errorMsg);
        setErrorDetails(`Error code: ${errorParam}\nDescription: ${errorDescription || 'None provided'}\nFull URL: ${window.location.href}`);
        
        toast({
          title: 'Login failed',
          description: errorMsg,
          variant: 'destructive',
        });
        return;
      }

      // Verify state parameter
      const state = queryParams.get('state') || hashParams.get('state');
      if (state && !verifyState(state)) {
        const msg = 'State mismatch - session may have expired';
        setError(msg);
        setErrorDetails(`Received state: ${state}\nThe login session may have expired.`);
        
        toast({
          title: 'Security error',
          description: msg,
          variant: 'destructive',
        });
        return;
      }

      // Check for authorization code (Authorization Code flow)
      const code = queryParams.get('code');

      if (code && (flow === 'authorization_code' || flow === 'authorization_code_no_pkce')) {
        setAuthStatus('Completing authentication...');
        const result = await exchangeCodeForTokens(code);

        if (result.session) {
          saveAuthSession(result.session);
          
          // Fetch user status immediately after login
          await fetchStatus();
          
          toast({
            title: 'Login successful',
            description: 'Authentication completed successfully',
          });
          
          window.history.replaceState(null, '', window.location.pathname);
          navigate('/');
          return;
        }

        const errorMsg = result.error || 'Error during authorization code exchange';
        setError(errorMsg);
        setErrorDetails(`Code: ${code.substring(0, 20)}...\nError: ${result.error}\nFull URL: ${window.location.href}`);
        
        toast({
          title: 'Login failed',
          description: errorMsg,
          variant: 'destructive',
        });
        return;
      }

      // Check for tokens in hash (Implicit flow)
      const session = parseAuthCallback();

      if (session) {
        saveAuthSession(session);
        
        // Fetch user status immediately after login
        await fetchStatus();
        
        toast({
          title: 'Login successful',
          description: 'Authentication completed successfully',
        });
        
        window.history.replaceState(null, '', window.location.pathname);
        navigate('/');
        return;
      }

      // No valid response found
      const msg = 'No authentication data received. Please check your configuration.';
      setError(msg);
      setErrorDetails(`Flow: ${flow}\nURL: ${window.location.href}\nHash: ${window.location.hash}\nSearch: ${window.location.search}`);
      
      toast({
        title: 'Login failed',
        description: msg,
        variant: 'destructive',
      });
    };

    handleCallback();
  }, [navigate, fetchStatus]);

  const handleCopyDetails = async () => {
    if (errorDetails) {
      await navigator.clipboard.writeText(errorDetails);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleGoToSettings = () => {
    navigate('/settings');
  };

  const handleRetryLogin = () => {
    navigate('/login');
  };

  if (error) {
    return (
      <MobileLayout>
        <div className="p-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                Authentication failed
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>

              {errorDetails && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Debug details:</p>
                  <pre className="text-xs bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap">
                    {errorDetails}
                  </pre>
                  <Button variant="outline" size="sm" onClick={handleCopyDetails}>
                    {copied ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                    Copy details
                  </Button>
                </div>
              )}

              <div className="flex flex-col gap-2">
                <Button onClick={handleRetryLogin} className="w-full">
                  Retry login
                </Button>
                <Button variant="outline" onClick={handleGoToSettings} className="w-full">
                  Go to settings
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </MobileLayout>
    );
  }

  return (
    <MobileLayout>
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">{authStatus}</p>
      </div>
    </MobileLayout>
  );
};

export default AuthCallback;
