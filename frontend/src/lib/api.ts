import { getAuthToken, clearAuthSession, isDevMode } from './auth';
import { toast } from '@/hooks/use-toast';
import { DEFAULT_CONFIG } from './config';

const getBaseUrl = (): string => {
  return localStorage.getItem('spendify_base_url') || DEFAULT_CONFIG.api.baseUrl;
};

export const resetApiConfig = (): void => {
  localStorage.removeItem('spendify_base_url');
};

export const setBaseUrl = (url: string): void => {
  localStorage.setItem('spendify_base_url', url);
};

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
}

export const apiRequest = async <T>(
  endpoint: string,
  options: ApiOptions = {}
): Promise<T> => {
  const baseUrl = getBaseUrl();
  
  if (!baseUrl) {
    throw new Error('API base URL not configured. Please set it in Settings.');
  }

  const token = getAuthToken();
  const devMode = isDevMode();
  
  // In dev mode, skip auth requirement
  if (!token && !devMode) {
    throw new Error('Not authenticated. Please login.');
  }

  const { method = 'GET', body, headers = {} } = options;

  // Build headers - skip auth header in dev mode if no real token
  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };
  
  if (token && token !== 'dev-mode-token') {
    requestHeaders['Authorization'] = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    // Network error - could be CORS, connectivity issue, or a backend error without CORS headers.
    // NON considerarlo automaticamente "session expired": logout solo su 401/403 o invalid_token.
    console.error('Network error during API request:', networkError);

    toast({
      title: 'Network error',
      description: 'Unable to reach the API (CORS / connectivity / server error). Please retry.',
      variant: 'destructive',
    });

    throw new Error('NetworkError when attempting to fetch resource.');
  }

  // Check for token expired in www-authenticate header
  const wwwAuth = response.headers.get('www-authenticate') || '';
  if (wwwAuth.includes('invalid_token') || wwwAuth.includes('token has expired')) {
    if (!devMode) {
      clearAuthSession();
      toast({
        title: 'Session expired',
        description: 'Your token has expired. Please login again.',
        variant: 'destructive',
      });
      window.location.href = '/login';
      throw new Error('Token expired');
    }
  }

  // In dev mode, don't redirect on 401 - show the actual error
  if ((response.status === 401 || response.status === 403) && !devMode) {
    clearAuthSession();
    toast({
      title: 'Session expired',
      description: 'Please login again.',
      variant: 'destructive',
    });
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `API error: ${response.status}`);
  }

  return response.json();
};

export const uploadToPresignedUrl = async (
  presignedUrl: string,
  file: File
): Promise<void> => {
  const response = await fetch(presignedUrl, {
    method: 'PUT',
    body: file,
    headers: {
      'Content-Type': file.type || 'image/*',
    },
  });

  if (!response.ok) {
    throw new Error('Failed to upload file');
  }
};

// Receipt API endpoints
export interface CreateReceiptResponse {
  receiptId: string;
  uploadUrl: string;
}

export interface Receipt {
  receiptId: string;
  id?: string;
  receipt_id?: string;
  status?: string;
  payee?: string;
  date?: string;
  total?: number;
  vat?: number;
  vatRate?: string;
  category?: string;
  categoryId?: string;
  notes?: string;
  imageUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  ynabExportedAt?: string;
}

// ============= Category API (string[] based) =============

export const getCategories = async (): Promise<string[]> => {
  const response = await apiRequest<unknown>('/categories');
  
  // Handle different response formats - extract string array
  if (Array.isArray(response)) {
    // Could be string[] directly or object[]
    if (response.length === 0) return [];
    if (typeof response[0] === 'string') {
      return response as string[];
    }
    // If objects, extract names
    return response.map((item: unknown) => {
      if (typeof item === 'string') return item;
      const obj = item as Record<string, unknown>;
      return (obj.name || obj.category || '') as string;
    }).filter(Boolean);
  }
  
  const obj = response as Record<string, unknown>;
  
  // Check for { categories: string[] } format
  if (Array.isArray(obj.categories)) {
    const arr = obj.categories;
    if (arr.length === 0) return [];
    if (typeof arr[0] === 'string') return arr as string[];
    return arr.map((item: unknown) => {
      if (typeof item === 'string') return item;
      const o = item as Record<string, unknown>;
      return (o.name || o.category || '') as string;
    }).filter(Boolean);
  }
  
  if (Array.isArray(obj.items)) {
    const arr = obj.items;
    if (arr.length === 0) return [];
    if (typeof arr[0] === 'string') return arr as string[];
    return arr.map((item: unknown) => {
      if (typeof item === 'string') return item;
      const o = item as Record<string, unknown>;
      return (o.name || o.category || '') as string;
    }).filter(Boolean);
  }
  
  if (Array.isArray(obj.data)) {
    const arr = obj.data;
    if (arr.length === 0) return [];
    if (typeof arr[0] === 'string') return arr as string[];
    return arr.map((item: unknown) => {
      if (typeof item === 'string') return item;
      const o = item as Record<string, unknown>;
      return (o.name || o.category || '') as string;
    }).filter(Boolean);
  }
  
  return [];
};

// Save entire categories array via PUT
export const saveCategories = async (categories: string[]): Promise<string[]> => {
  // Clean input: trim and filter empty
  const cleaned = categories.map(c => c.trim()).filter(Boolean);
  
  await apiRequest<unknown>('/categories', {
    method: 'PUT',
    body: { categories: cleaned },
  });
  
  return cleaned;
};

// Normalize receipt to ensure receiptId is always set and common fields are mapped
const normalizeReceipt = (receipt: Record<string, unknown>): Receipt => {
  const id = (receipt.receiptId || receipt.id || receipt.receipt_id) as string;

  // Map common alias keys coming from backend
  const payee = (receipt.payee ?? receipt.merchant ?? receipt.vendor) as string | undefined;
  const date = (receipt.date ?? receipt.receipt_date ?? receipt.receiptDate) as string | undefined;
  const total = (receipt.total ?? receipt.total_amount ?? receipt.amount ?? receipt.grandTotal) as number | undefined;
  const vat = (receipt.vat ?? receipt.vat_amount ?? receipt.tax ?? receipt.taxAmount) as number | undefined;
  const vatRate = (receipt.vatRate ?? receipt.vat_rate ?? receipt.taxRate ?? receipt.tax_rate) as string | undefined;
  const ynabExportedAt = (receipt.ynabExportedAt ?? receipt.ynab_exported_at) as string | undefined;

  return {
    ...receipt,
    receiptId: id,
    ...(payee !== undefined ? { payee } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(vat !== undefined ? { vat } : {}),
    ...(vatRate !== undefined ? { vatRate } : {}),
    ...(ynabExportedAt !== undefined ? { ynabExportedAt } : {}),
  } as Receipt;
};

export const createReceipt = async (): Promise<CreateReceiptResponse> => {
  return apiRequest<CreateReceiptResponse>('/receipts', { method: 'POST' });
};

export interface GetReceiptsOptions {
  offset?: number;
  limit?: number;
}

export interface GetReceiptsResponse {
  receipts: Receipt[];
  total: number;
  hasMore: boolean;
}

export const getReceipts = async (options: GetReceiptsOptions = {}): Promise<GetReceiptsResponse> => {
  const { offset = 0, limit = 20 } = options;
  const queryParams = new URLSearchParams({
    offset: offset.toString(),
    limit: limit.toString(),
  });
  
  const response = await apiRequest<unknown>(`/receipts?${queryParams}`);
  console.log('GET /receipts response:', response);
  
  let receiptsArray: Record<string, unknown>[] = [];
  let total = 0;
  
  // Handle different response formats
  if (Array.isArray(response)) {
    receiptsArray = response as Record<string, unknown>[];
    total = receiptsArray.length;
  } else {
    // Try common wrapper formats
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.receipts)) {
      receiptsArray = obj.receipts as Record<string, unknown>[];
    } else if (Array.isArray(obj.items)) {
      receiptsArray = obj.items as Record<string, unknown>[];
    } else if (Array.isArray(obj.data)) {
      receiptsArray = obj.data as Record<string, unknown>[];
    } else {
      console.warn('Unexpected receipts response format:', response);
      return { receipts: [], total: 0, hasMore: false };
    }
    // Extract total from response if available
    total = (obj.total ?? obj.count ?? obj.totalCount ?? receiptsArray.length) as number;
  }
  
  // Normalize each receipt to ensure receiptId is set
  const receipts = receiptsArray.map(normalizeReceipt);
  const hasMore = offset + receipts.length < total;
  
  return { receipts, total, hasMore };
};

export const getReceipt = async (receiptId: string): Promise<unknown> => {
  return apiRequest<unknown>(`/receipts/${receiptId}`);
};

export interface UpdateReceiptPayload {
  status?: 'DRAFT' | 'CONFIRMED';
  payee?: string;
  date?: string;
  total?: number;
  vat?: number;
  vatRate?: string;
  category?: string | null;
  notes?: string;
  ynabExportedAt?: string;
}

export const updateReceipt = async (
  receiptId: string,
  payload: UpdateReceiptPayload
): Promise<unknown> => {
  // Some backends expect snake_case keys; send both to be safe.
  const body: Record<string, unknown> = {
    ...payload,
  };
  
  if (payload.vatRate !== undefined) body.vat_rate = payload.vatRate;
  if (payload.vat !== undefined) body.vat_amount = payload.vat;
  if (payload.total !== undefined) body.total_amount = payload.total;
  if (payload.date !== undefined) body.receipt_date = payload.date;
  if (payload.payee !== undefined) body.merchant = payload.payee;
  if (payload.ynabExportedAt !== undefined) body.ynab_exported_at = payload.ynabExportedAt;
  // Category is a simple string - send it as "category"
  if (payload.category !== undefined) body.category = payload.category;

  return apiRequest<unknown>(`/receipts/${receiptId}`, {
    method: 'PUT',
    body,
  });
};

// ============= User Status & Billing API =============

export interface UserStatusResponse {
  status: 'trial' | 'active' | 'expired';
  daysRemaining?: number;
}

export const getUserStatus = async (): Promise<UserStatusResponse> => {
  return apiRequest<UserStatusResponse>('/me');
};

export interface CheckoutResponse {
  url: string;
}

export const createCheckoutSession = async (): Promise<CheckoutResponse> => {
  return apiRequest<CheckoutResponse>('/billing/checkout', { method: 'POST' });
};

export interface PortalResponse {
  url: string;
}

export const createBillingPortal = async (): Promise<PortalResponse> => {
  return apiRequest<PortalResponse>('/billing/portal', { method: 'POST' });
};

// Delete receipt (only drafts can be deleted)
export const deleteReceipt = async (receiptId: string): Promise<void> => {
  await apiRequest<void>(`/receipts/${receiptId}`, { method: 'DELETE' });
};