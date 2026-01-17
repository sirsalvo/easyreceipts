import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import {
  isAuthenticated,
  clearAuthSession,
} from '@/lib/auth';
import { getYNABConfig, saveYNABConfig } from '@/lib/ynab';
import { Settings as SettingsIcon, LogOut, ArrowLeft, Eye, EyeOff } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';

const Settings = () => {
  const navigate = useNavigate();
  const [authenticated, setAuthenticated] = useState(false);
  
  // YNAB settings
  const [ynabToken, setYnabToken] = useState('');
  const [ynabBudgetId, setYnabBudgetId] = useState('last-used');
  const [ynabAccountId, setYnabAccountId] = useState('');
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    setAuthenticated(isAuthenticated());

    // Load YNAB config
    const ynabConfig = getYNABConfig();
    setYnabToken(ynabConfig.token);
    setYnabBudgetId(ynabConfig.budgetId);
    setYnabAccountId(ynabConfig.accountId);
  }, []);

  const handleSaveYNABSettings = () => {
    saveYNABConfig({
      token: ynabToken.trim(),
      budgetId: ynabBudgetId.trim() || 'last-used',
      accountId: ynabAccountId.trim(),
    });
    toast({
      title: 'Saved',
      description: 'YNAB configuration updated',
    });
  };

  const handleLogout = () => {
    clearAuthSession();
    setAuthenticated(false);
    toast({
      title: 'Logged out',
      description: 'You have been logged out successfully',
    });
    navigate('/login');
  };

  return (
    <MobileLayout>
      <div className="p-4 space-y-4 pb-24">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">Settings</h1>
          </div>
        </div>

        {/* YNAB Settings */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-blue-500 flex items-center justify-center">
                <span className="text-white text-xs font-bold">Y</span>
              </div>
              <CardTitle className="text-base font-medium">YNAB</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ynabToken">Personal Access Token</Label>
              <div className="flex gap-2">
                <Input
                  id="ynabToken"
                  type={showToken ? 'text' : 'password'}
                  placeholder="Enter your YNAB token"
                  value={ynabToken}
                  onChange={(e) => setYnabToken(e.target.value)}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowToken(!showToken)}
                  className="shrink-0"
                >
                  {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Get it from app.ynab.com → Account Settings → Developer Settings
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ynabBudgetId">Budget ID</Label>
              <Input
                id="ynabBudgetId"
                placeholder="last-used"
                value={ynabBudgetId}
                onChange={(e) => setYnabBudgetId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave "last-used" to use the most recent budget
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ynabAccountId">Account ID</Label>
              <Input
                id="ynabAccountId"
                placeholder="YNAB account ID"
                value={ynabAccountId}
                onChange={(e) => setYnabAccountId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The ID of the account where expenses will be recorded
              </p>
            </div>
            <Button onClick={handleSaveYNABSettings} className="w-full">
              Save YNAB Configuration
            </Button>
          </CardContent>
        </Card>

        {/* Logout */}
        {authenticated && (
          <Card className="border-destructive/30">
            <CardContent className="pt-6">
              <Button
                onClick={handleLogout}
                variant="destructive"
                className="w-full"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Logout
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
      <BottomNavigation />
    </MobileLayout>
  );
};

export default Settings;
