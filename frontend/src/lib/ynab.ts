// YNAB API integration
import { Receipt } from './api';

const YNAB_BASE_URL = 'https://api.ynab.com/v1';
const YNAB_TOKEN_KEY = 'spendify_ynab_token';
const YNAB_BUDGET_ID_KEY = 'spendify_ynab_budget_id';
const YNAB_ACCOUNT_ID_KEY = 'spendify_ynab_account_id';

export interface YNABConfig {
  token: string;
  budgetId: string;
  accountId: string;
}

export interface YNABBudget {
  id: string;
  name: string;
  last_modified_on: string;
}

export interface YNABTransaction {
  account_id: string;
  date: string;
  amount: number;
  payee_name: string;
  memo: string;
  cleared: string;
  approved: boolean;
}

// Config management
export const saveYNABConfig = (config: Partial<YNABConfig>): void => {
  if (config.token !== undefined) {
    localStorage.setItem(YNAB_TOKEN_KEY, config.token);
  }
  if (config.budgetId !== undefined) {
    localStorage.setItem(YNAB_BUDGET_ID_KEY, config.budgetId);
  }
  if (config.accountId !== undefined) {
    localStorage.setItem(YNAB_ACCOUNT_ID_KEY, config.accountId);
  }
};

export const getYNABConfig = (): YNABConfig => {
  return {
    token: localStorage.getItem(YNAB_TOKEN_KEY) || '',
    budgetId: localStorage.getItem(YNAB_BUDGET_ID_KEY) || 'last-used',
    accountId: localStorage.getItem(YNAB_ACCOUNT_ID_KEY) || '',
  };
};

export const clearYNABConfig = (): void => {
  localStorage.removeItem(YNAB_TOKEN_KEY);
  localStorage.removeItem(YNAB_BUDGET_ID_KEY);
  localStorage.removeItem(YNAB_ACCOUNT_ID_KEY);
};

// API helpers
const ynabFetch = async <T>(
  endpoint: string, 
  token: string, 
  options: RequestInit = {}
): Promise<T> => {
  const response = await fetch(`${YNAB_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errorMessage = errorData?.error?.detail || response.statusText;
    
    switch (response.status) {
      case 401:
        throw new Error('Token YNAB non valido o scaduto');
      case 403:
        throw new Error('Accesso negato. Verifica i permessi del token');
      case 404:
        throw new Error('Risorsa non trovata. Verifica Budget ID e Account ID');
      case 429:
        throw new Error('Troppe richieste. Riprova tra qualche minuto');
      case 500:
      case 502:
      case 503:
        throw new Error('Errore del server YNAB. Riprova più tardi');
      default:
        throw new Error(`Errore YNAB: ${errorMessage}`);
    }
  }

  return response.json();
};

// Get all budgets
export const getYNABBudgets = async (token: string): Promise<YNABBudget[]> => {
  const response = await ynabFetch<{ data: { budgets: YNABBudget[] } }>('/budgets', token);
  return response.data.budgets;
};

// Get the budget ID to use (resolves "last-used" to actual ID)
export const resolveYNABBudgetId = async (token: string, budgetId: string): Promise<string> => {
  if (budgetId !== 'last-used') {
    return budgetId;
  }

  const budgets = await getYNABBudgets(token);
  
  if (budgets.length === 0) {
    throw new Error('Nessun budget trovato nel tuo account YNAB');
  }

  // Find the most recently modified budget
  const sorted = budgets.sort((a, b) => 
    new Date(b.last_modified_on).getTime() - new Date(a.last_modified_on).getTime()
  );

  return sorted[0].id;
};

// Convert receipt to YNAB transaction
export const receiptToYNABTransaction = (
  receipt: Receipt, 
  accountId: string
): YNABTransaction => {
  // YNAB uses milliunits (1 € = 1000 milliunits)
  // Expenses are negative
  const total = parseFloat(String(receipt.total)) || 0;
  const amountInMilliunits = Math.round(total * 1000) * -1; // Negative for expenses

  return {
    account_id: accountId,
    date: receipt.date || new Date().toISOString().split('T')[0],
    amount: amountInMilliunits,
    payee_name: receipt.payee || 'Sconosciuto',
    memo: 'Export Spendify',
    cleared: 'cleared',
    approved: true,
  };
};

// Export receipts to YNAB
export const exportToYNAB = async (
  receipts: Receipt[],
  config: YNABConfig
): Promise<{ success: boolean; count: number; error?: string }> => {
  // Validate config
  if (!config.token) {
    throw new Error('Token YNAB mancante. Configuralo nelle Impostazioni');
  }

  if (!config.accountId) {
    throw new Error('Account ID mancante. Configuralo nelle Impostazioni');
  }

  if (receipts.length === 0) {
    throw new Error('Nessuno scontrino da esportare');
  }

  // Resolve budget ID
  const budgetId = await resolveYNABBudgetId(config.token, config.budgetId);

  // Convert receipts to transactions
  const transactions = receipts.map(receipt => 
    receiptToYNABTransaction(receipt, config.accountId)
  );

  // Send to YNAB
  const response = await ynabFetch<{ data: { transactions: unknown[] } }>(
    `/budgets/${budgetId}/transactions`,
    config.token,
    {
      method: 'POST',
      body: JSON.stringify({ transactions }),
    }
  );

  return {
    success: true,
    count: response.data.transactions.length,
  };
};
