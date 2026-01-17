import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { isAuthenticated, getCognitoLoginUrl } from '@/lib/auth';
import { LogIn, Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import appIcon from '@/assets/app-icon.png';

const Login = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) {
      navigate('/');
    }
  }, [navigate]);

  const handleLogin = async () => {
    setLoading(true);
    
    const loginUrl = await getCognitoLoginUrl();
    
    if (!loginUrl) {
      toast({
        title: 'Error',
        description: 'Cognito configuration not available',
        variant: 'destructive',
      });
      setLoading(false);
      return;
    }
    
    // Direct redirect in the same window (PWA compatible)
    window.location.href = loginUrl;
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo and Title */}
        <div className="text-center space-y-4">
          <img 
            src={appIcon} 
            alt="Spendify" 
            className="w-20 h-20 rounded-2xl mx-auto"
          />
          <div>
            <h1 className="text-2xl font-bold">Spendify</h1>
            <p className="text-muted-foreground">Scan & Manage</p>
          </div>
        </div>

        {/* Login Card */}
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Welcome</CardTitle>
            <CardDescription>
              Sign in to manage your receipts
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              onClick={handleLogin} 
              className="w-full" 
              size="lg"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="h-5 w-5 mr-2 animate-spin" />
              ) : (
                <LogIn className="h-5 w-5 mr-2" />
              )}
              Sign In
            </Button>
          </CardContent>
        </Card>

        {/* Features */}
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">With Spendify you can:</p>
          <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
            <div className="p-3 rounded-lg bg-muted/30">
              <span className="block font-medium text-foreground">📸</span>
              Scan
            </div>
            <div className="p-3 rounded-lg bg-muted/30">
              <span className="block font-medium text-foreground">✏️</span>
              Edit
            </div>
            <div className="p-3 rounded-lg bg-muted/30">
              <span className="block font-medium text-foreground">📤</span>
              Export
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
