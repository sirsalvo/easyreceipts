import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import {
  isAuthenticated,
  clearAuthSession,
} from '@/lib/auth';
import YnabSettings from '@/components/YnabSettings';
import { createCheckoutSession, createBillingPortal, getUserStatus } from '@/lib/api';
import { useUserStatus } from '@/hooks/useUserStatus';
import { setUserState } from '@/lib/userStore';
import { Settings as SettingsIcon, LogOut, ArrowLeft, CreditCard, Loader2 } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';
import CategoriesSettings from '@/components/CategoriesSettings';

type ActivationState = 'idle' | 'activating' | 'success' | 'timeout' | 'error';

const Settings = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [authenticated, setAuthenticated] = useState(false);
  const { status, fetchStatus } = useUserStatus();
  const [billingLoading, setBillingLoading] = useState(false);
  const [activationState, setActivationState] = useState<ActivationState>('idle');
  
  // Track if we've already handled the billing param to prevent re-runs
  const billingHandledRef = useRef(false);
  

  // Clean URL without reload
  const cleanUrl = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('billing');
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Polling for subscription activation
  const pollForActivation = useCallback(async () => {
    const MAX_ATTEMPTS = 6;
    const INTERVAL_MS = 1000;
    
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const data = await getUserStatus();
        if (data.status === 'active') {
          // Update global store
          setUserState({
            status: data.status,
            daysRemaining: data.daysRemaining ?? null,
            loading: false,
          });
          setActivationState('success');
          cleanUrl();
          return true;
        }
      } catch (error) {
        console.error('Poll attempt failed:', error);
      }
      
      // Wait before next attempt (except on last attempt)
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
      }
    }
    
    // Max attempts reached without success
    setActivationState('timeout');
    cleanUrl();
    return false;
  }, [cleanUrl]);

  useEffect(() => {
    setAuthenticated(isAuthenticated());
  }, []);

  // Handle Stripe redirect separately to control polling
  useEffect(() => {
    if (billingHandledRef.current) return;
    
    const billingResult = searchParams.get('billing');
    
    if (billingResult === 'success') {
      billingHandledRef.current = true;
      setActivationState('activating');
      
      // Start polling
      pollForActivation().catch((error) => {
        console.error('Polling error:', error);
        setActivationState('error');
        cleanUrl();
      });
    } else if (billingResult === 'cancel') {
      billingHandledRef.current = true;
      toast({
        title: 'Checkout canceled',
        description: 'You can activate your subscription anytime.',
      });
      cleanUrl();
    }
  }, [searchParams, pollForActivation, cleanUrl]);

  const handleLogout = () => {
    clearAuthSession();
    setAuthenticated(false);
    toast({
      title: 'Logged out',
      description: 'You have been logged out successfully',
    });
    navigate('/login');
  };

  const handleActivateSubscription = async () => {
    setBillingLoading(true);
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
      setBillingLoading(false);
    }
  };

  const handleManageBilling = async () => {
    setBillingLoading(true);
    try {
      const { url } = await createBillingPortal();
      window.location.href = url;
    } catch (error) {
      console.error('Portal error:', error);
      toast({
        title: 'Error',
        description: 'Something went wrong. Please try again later.',
        variant: 'destructive',
      });
      setBillingLoading(false);
    }
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

        {/* Billing Section */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              <CardTitle className="text-base font-medium">Billing</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Activating state - polling in progress */}
            {activationState === 'activating' && (
              <>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Activating subscription…</span>
                </div>
                <Button disabled className="w-full">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Manage billing
                </Button>
              </>
            )}
            
            {/* Success state or already active */}
            {(activationState === 'success' || (activationState === 'idle' && status === 'active')) && (
              <>
                <p className="text-sm text-muted-foreground">
                  Your subscription is active.
                </p>
                <Button
                  onClick={handleManageBilling}
                  disabled={billingLoading}
                  className="w-full"
                >
                  {billingLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Manage billing
                </Button>
              </>
            )}
            
            {/* Timeout state - couldn't confirm */}
            {activationState === 'timeout' && (
              <>
                <p className="text-sm text-amber-600">
                  We couldn't confirm the subscription yet. Please refresh in a few seconds.
                </p>
                <Button
                  onClick={handleManageBilling}
                  disabled={billingLoading}
                  className="w-full"
                >
                  {billingLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Manage billing
                </Button>
              </>
            )}
            
            {/* Error state */}
            {activationState === 'error' && (
              <>
                <p className="text-sm text-destructive">
                  Something went wrong. Please try again.
                </p>
                <Button
                  onClick={() => {
                    setActivationState('idle');
                    fetchStatus();
                  }}
                  variant="outline"
                  className="w-full"
                >
                  Retry
                </Button>
              </>
            )}
            
            {/* Idle state - not active */}
            {activationState === 'idle' && status !== 'active' && (
              <>
                <p className="text-sm text-muted-foreground">
                  You are currently on the free trial.
                </p>
                <Button
                  onClick={handleActivateSubscription}
                  disabled={billingLoading}
                  className="w-full"
                >
                  {billingLoading ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : null}
                  Activate subscription
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Categories */}
        <CategoriesSettings />

        {/* YNAB */}
        <YnabSettings />

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