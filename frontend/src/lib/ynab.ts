// YNAB integration (OAuth). The browser never holds a YNAB token: the backend
// stores it encrypted and makes every call to YNAB. This file only talks to
// the Spendify API.
import { apiRequest } from './api';

export interface YnabStatus {
  connected: boolean;
  planId?: string | null;
  planName?: string | null;
  accountId?: string | null;
  accountName?: string | null;
}

export interface YnabPlan {
  id: string;
  name: string;
}

export interface YnabAccount {
  id: string;
  name: string;
  type: string;
}

export interface YnabExportIssue {
  receiptId: string;
  reason: string;
}

export interface YnabExportResult {
  created: number;
  duplicates: number;
  skipped: YnabExportIssue[];
  failed: YnabExportIssue[];
  exportedAt: string;
  exportedIds: string[];
}

export class YnabApiError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// apiRequest throws the raw response body as the error message.
const toYnabError = (error: unknown): Error => {
  if (!(error instanceof Error)) return new YnabApiError('unknown', 'Unknown error');
  try {
    const parsed = JSON.parse(error.message);
    if (parsed && typeof parsed.error === 'string') {
      return new YnabApiError(parsed.error, typeof parsed.message === 'string' ? parsed.message : parsed.error);
    }
  } catch {
    // not a JSON body: keep the original error
  }
  return error;
};

const call = async <T>(endpoint: string, options?: Parameters<typeof apiRequest>[1]): Promise<T> => {
  try {
    return await apiRequest<T>(endpoint, options);
  } catch (error) {
    throw toYnabError(error);
  }
};

// Earlier versions asked for a Personal Access Token and kept it in this
// browser. YNAB does not allow that, so remove any leftover copy.
export const clearLegacyYnabStorage = (): void => {
  try {
    ['spendify_ynab_token', 'spendify_ynab_budget_id', 'spendify_ynab_account_id', 'spendify_ynab_exports'].forEach(
      (key) => localStorage.removeItem(key)
    );
  } catch {
    // storage unavailable (private mode): nothing to clean
  }
};

export const getYnabStatus = () => call<YnabStatus>('/ynab/status');

export const startYnabAuthorization = async (): Promise<string> => {
  const { authorizeUrl } = await call<{ authorizeUrl: string }>('/ynab/oauth/start', { method: 'POST' });
  return authorizeUrl;
};

export const completeYnabAuthorization = (code: string, state: string) =>
  call<YnabStatus>('/ynab/oauth/callback', { method: 'POST', body: { code, state } });

export const listYnabPlans = async (): Promise<YnabPlan[]> =>
  (await call<{ plans: YnabPlan[] }>('/ynab/plans')).plans;

export const listYnabAccounts = async (planId: string): Promise<YnabAccount[]> =>
  (await call<{ accounts: YnabAccount[] }>(`/ynab/accounts?planId=${encodeURIComponent(planId)}`)).accounts;

export const saveYnabSettings = (planId: string, accountId: string) =>
  call<YnabStatus>('/ynab/settings', { method: 'PUT', body: { planId, accountId } });

export const disconnectYnab = () => call<YnabStatus>('/ynab/connection', { method: 'DELETE' });

export const exportToYnab = (receiptIds: string[]) =>
  call<YnabExportResult>('/ynab/export', { method: 'POST', body: { receiptIds } });

export const isYnabReady = (status: YnabStatus | null | undefined): boolean =>
  !!status?.connected && !!status.planId && !!status.accountId;

const ERROR_MESSAGES: Record<string, string> = {
  ynab_reconnect_required: 'YNAB access expired or was revoked. Reconnect YNAB in Settings.',
  ynab_not_connected: 'YNAB is not connected. Connect it in Settings.',
  ynab_not_configured: 'Choose a YNAB plan and account in Settings first.',
  ynab_rate_limited: 'YNAB is limiting requests right now. Try again in a few minutes.',
  ynab_unreachable: 'Could not reach YNAB. Try again.',
  ynab_unavailable: 'YNAB is temporarily unavailable. Try again.',
  invalid_state: 'The YNAB authorization expired. Start the connection again.',
  ynab_token_rejected: 'YNAB did not accept the authorization. Start the connection again.',
  too_many_receipts: 'Too many receipts at once. Select fewer and try again.',
};

export const ynabErrorMessage = (error: unknown): string => {
  if (error instanceof YnabApiError) return ERROR_MESSAGES[error.code] ?? error.message;
  return error instanceof Error ? error.message : 'An error occurred';
};

const SKIP_REASONS: Record<string, string> = {
  invalid_amount: 'missing or invalid amount',
  invalid_date: 'missing or invalid date',
  already_exported: 'already sent to YNAB',
  not_found: 'receipt not found',
};

// One line for a toast: what was created and what was left out, and why.
export const summarizeYnabExport = (result: YnabExportResult): string => {
  const parts: string[] = [];
  if (result.created) parts.push(`${result.created} transaction(s) created in YNAB`);
  if (result.duplicates) parts.push(`${result.duplicates} already in YNAB`);
  if (result.skipped.length) {
    const reasons = Array.from(new Set(result.skipped.map((s) => SKIP_REASONS[s.reason] ?? s.reason)));
    parts.push(`${result.skipped.length} skipped (${reasons.join(', ')})`);
  }
  if (result.failed.length) parts.push(`${result.failed.length} failed`);
  return parts.join(' · ') || 'Nothing to export';
};
