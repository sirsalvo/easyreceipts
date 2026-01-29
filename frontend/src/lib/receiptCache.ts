// Receipt cache to store list data for use in detail views
// The list endpoint returns draft/edited fields, while single receipt endpoint returns OCR data only

import { Receipt } from './api';

// Extended type to include category in cache updates
type CacheUpdate = Partial<Receipt> & { category?: string | null };

let receiptCache: Map<string, Receipt> = new Map();

export const setReceiptsCache = (receipts: Receipt[]): void => {
  receiptCache = new Map();
  receipts.forEach((receipt) => {
    const id = receipt.receiptId || receipt.id || receipt.receipt_id;
    if (id) {
      receiptCache.set(id, receipt);
    }
  });
};

export const getCachedReceipt = (receiptId: string): Receipt | undefined => {
  return receiptCache.get(receiptId);
};

export const updateCachedReceipt = (receiptId: string, updates: CacheUpdate): void => {
  const existing = receiptCache.get(receiptId);
  if (existing) {
    receiptCache.set(receiptId, { ...existing, ...updates });
  }
};

export const clearReceiptCache = (): void => {
  receiptCache.clear();
};
