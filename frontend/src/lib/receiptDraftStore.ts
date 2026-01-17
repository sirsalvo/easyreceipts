// Local draft overrides persisted in localStorage.
// This protects the UX when the backend single-receipt endpoint doesn't reflect saved draft fields.

import type { Receipt, UpdateReceiptPayload } from "@/lib/api";

type DraftOverride = Partial<Pick<Receipt, "payee" | "date" | "total" | "vat" | "vatRate" | "category" | "notes" | "status">>;

const STORAGE_KEY = "spendify_draft_overrides";

const readAll = (): Record<string, DraftOverride> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, DraftOverride>;
  } catch {
    return {};
  }
};

const writeAll = (data: Record<string, DraftOverride>) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // ignore (storage full / disabled)
  }
};

export const getDraftOverride = (receiptId: string): DraftOverride | undefined => {
  const all = readAll();
  return all[receiptId];
};

export const setDraftOverride = (receiptId: string, payload: UpdateReceiptPayload): void => {
  const all = readAll();
  all[receiptId] = {
    status: payload.status,
    payee: payload.payee,
    date: payload.date,
    total: payload.total,
    vat: payload.vat,
    vatRate: payload.vatRate,
    category: payload.category,
    notes: payload.notes,
  };
  writeAll(all);
};

export const clearDraftOverride = (receiptId: string): void => {
  const all = readAll();
  if (receiptId in all) {
    delete all[receiptId];
    writeAll(all);
  }
};
