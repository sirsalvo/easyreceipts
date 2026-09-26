import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import {
  YnabAccount,
  YnabPlan,
  YnabStatus,
  disconnectYnab,
  getYnabStatus,
  listYnabAccounts,
  listYnabPlans,
  saveYnabSettings,
  startYnabAuthorization,
  ynabErrorMessage,
} from '@/lib/ynab';

const PRIVACY_URL = 'https://spendifyapp.com/privacy.html';

const YnabSettings = () => {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<YnabStatus | null>(null);
  const [plans, setPlans] = useState<YnabPlan[]>([]);
  const [accounts, setAccounts] = useState<YnabAccount[]>([]);
  const [planId, setPlanId] = useState('');
  const [accountId, setAccountId] = useState('');

  const loadAccounts = useCallback(async (id: string, preferredAccountId?: string | null) => {
    setAccounts([]);
    setAccountId('');
    if (!id) return;
    try {
      const list = await listYnabAccounts(id);
      setAccounts(list);
      if (preferredAccountId && list.some((a) => a.id === preferredAccountId)) {
        setAccountId(preferredAccountId);
      }
    } catch (error) {
      toast({ title: 'YNAB', description: ynabErrorMessage(error), variant: 'destructive' });
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await getYnabStatus();
      setStatus(current);
      if (current.connected) {
        const list = await listYnabPlans();
        setPlans(list);
        const initial = current.planId && list.some((p) => p.id === current.planId) ? current.planId : list[0]?.id ?? '';
        setPlanId(initial);
        await loadAccounts(initial, current.accountId);
      }
    } catch (error) {
      toast({ title: 'YNAB', description: ynabErrorMessage(error), variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [loadAccounts]);

  useEffect(() => {
    load();
  }, [load]);

  const handleConnect = async () => {
    setBusy(true);
    try {
      window.location.href = await startYnabAuthorization();
    } catch (error) {
      toast({ title: 'YNAB', description: ynabErrorMessage(error), variant: 'destructive' });
      setBusy(false);
    }
  };

  const handleSave = async () => {
    setBusy(true);
    try {
      setStatus(await saveYnabSettings(planId, accountId));
      toast({ title: 'Saved', description: 'YNAB plan and account updated' });
    } catch (error) {
      toast({ title: 'YNAB', description: ynabErrorMessage(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect YNAB? Spendify will delete its stored access to your YNAB account.')) return;
    setBusy(true);
    try {
      setStatus(await disconnectYnab());
      setPlans([]);
      setAccounts([]);
      setPlanId('');
      setAccountId('');
      toast({ title: 'Disconnected', description: 'Spendify no longer has access to your YNAB account' });
    } catch (error) {
      toast({ title: 'YNAB', description: ynabErrorMessage(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const unchanged = !!status?.connected && status.planId === planId && status.accountId === accountId;

  return (
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
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !status?.connected ? (
          <>
            <p className="text-sm text-muted-foreground">
              Connect your YNAB account to send receipts as transactions. You sign in on YNAB&apos;s own
              site: Spendify never sees your YNAB password.
            </p>
            <p className="text-sm text-muted-foreground">
              Spendify reads the names of your plans and accounts so you can choose where receipts go, and uses
              the access only to create the transactions you select. Categories are never sent.
            </p>
            <Button onClick={handleConnect} disabled={busy} className="w-full">
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Connect YNAB
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label>Plan</Label>
              <Select
                value={planId}
                onValueChange={(value) => {
                  setPlanId(value);
                  loadAccounts(value);
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select the account for expenses" />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">The account where receipts are recorded.</p>
            </div>
            <Button onClick={handleSave} disabled={busy || !planId || !accountId || unchanged} className="w-full">
              {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save
            </Button>
            <Button onClick={handleDisconnect} disabled={busy} variant="outline" className="w-full">
              Disconnect YNAB
            </Button>
            <p className="text-xs text-muted-foreground">
              Disconnecting deletes the access Spendify stores. You can also revoke it from your YNAB account
              settings.
            </p>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          How your YNAB data is handled:{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">
            Privacy Policy
          </a>
          . Spendify is not affiliated with YNAB.
        </p>
      </CardContent>
    </Card>
  );
};

export default YnabSettings;
