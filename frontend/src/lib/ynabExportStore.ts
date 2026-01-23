// Store per tracciare gli scontrini esportati su YNAB
const YNAB_EXPORTS_KEY = 'spendify_ynab_exports';

export interface YNABExportRecord {
  exportedAt: string; // ISO date string
}

type YNABExportsMap = Record<string, YNABExportRecord>;

// Get all export records
export const getYNABExports = (): YNABExportsMap => {
  try {
    const stored = localStorage.getItem(YNAB_EXPORTS_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

// Get export record for a specific receipt
export const getYNABExport = (receiptId: string): YNABExportRecord | null => {
  const exports = getYNABExports();
  return exports[receiptId] || null;
};

// Check if a receipt was exported to YNAB
export const isExportedToYNAB = (receiptId: string): boolean => {
  return getYNABExport(receiptId) !== null;
};

// Mark receipts as exported to YNAB
export const markAsExportedToYNAB = (receiptIds: string[]): void => {
  const exports = getYNABExports();
  const now = new Date().toISOString();
  
  receiptIds.forEach((id) => {
    exports[id] = { exportedAt: now };
  });
  
  localStorage.setItem(YNAB_EXPORTS_KEY, JSON.stringify(exports));
};

// Remove export record (if needed in future)
export const removeYNABExport = (receiptId: string): void => {
  const exports = getYNABExports();
  delete exports[receiptId];
  localStorage.setItem(YNAB_EXPORTS_KEY, JSON.stringify(exports));
};

// Clear all export records
export const clearAllYNABExports = (): void => {
  localStorage.removeItem(YNAB_EXPORTS_KEY);
};
