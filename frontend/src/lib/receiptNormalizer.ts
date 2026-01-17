// Robust receipt response normalizer
// Handles various API response shapes and field locations

export interface NormalizedReceipt {
  id: string;
  status: string;
  imageUrl?: string;
  date: string;
  total: number | null;
  payee: string;
  vat: number | null;
  vatRate: string;
  category: string;
  notes: string;
}

// Helper to safely get nested value
const getNestedValue = (obj: unknown, ...paths: string[]): unknown => {
  for (const path of paths) {
    const keys = path.split('.');
    let value: unknown = obj;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = (value as Record<string, unknown>)[key];
      } else {
        value = undefined;
        break;
      }
    }
    
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
};

// Helper to parse number
const parseNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  if (typeof value === 'string') {
    const num = parseFloat(value.replace(',', '.'));
    return isNaN(num) ? null : num;
  }
  return null;
};

// Helper to format date to YYYY-MM-DD
const formatDate = (value: unknown): string => {
  if (!value) return '';
  
  if (typeof value === 'string') {
    // Handle DD-MM-YYYY format (European)
    const ddmmyyyy = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (ddmmyyyy) {
      const [, day, month, year] = ddmmyyyy;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    
    // Handle DD/MM/YYYY format
    const ddmmyyyySlash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (ddmmyyyySlash) {
      const [, day, month, year] = ddmmyyyySlash;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    
    // Check if already in YYYY-MM-DD format
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return value;
    }
    
    // Try to parse other date formats
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }
  
  return '';
};

// Helper to extract VAT rate percentage from string like "A 22.00%"
const parseVatRate = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    // If it's already a clean number string (from saved data), return as-is
    if (/^\d+$/.test(value.trim())) {
      return value.trim();
    }
    // Extract number from strings like "A 22.00%" or "22%"
    const match = value.match(/(\d+(?:\.\d+)?)\s*%?/);
    if (match) {
      const rate = parseFloat(match[1]);
      // Round to nearest common rate
      if (rate <= 2) return '0';
      if (rate <= 4.5) return '4';
      if (rate <= 7) return '5';
      if (rate <= 15) return '10';
      return '22';
    }
  }
  return '';
};

export const normalizeReceiptResponse = (response: unknown): NormalizedReceipt => {
  // Handle array responses - take first item
  let data: unknown = response;
  if (Array.isArray(response) && response.length > 0) {
    data = response[0];
  }

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid receipt response');
  }

  const obj = data as Record<string, unknown>;

  // Extract ID
  const id = (getNestedValue(obj, 'id', 'receiptId', '_id') as string) || '';

  // Extract status
  const status = (getNestedValue(obj, 'status', 'receiptStatus') as string) || 'PENDING';

  // Extract image URL - check multiple locations
  const imageUrl = (getNestedValue(
    obj,
    'artifacts.processedUrl',
    'artifacts.processed_url',
    'artifacts.originalUrl',
    'artifacts.original_url',
    'imageUrl',
    'image_url',
    'url'
  ) as string) || undefined;

  // Get extracted/OCR fields - check ocr.summary.fields first (AWS Textract format)
  const ocrSummaryFields = getNestedValue(obj, 'ocr.summary.fields') as Record<string, unknown> | undefined;
  
  const extractedFields = ocrSummaryFields || (getNestedValue(
    obj,
    'extracted',
    'ocr.fields',
    'ocr',
    'ocrData',
    'ocrResult',
    'fields',
    'data',
    'artifacts.ocr',
    'artifacts.ocrData',
    'artifacts.extracted'
  ) as Record<string, unknown> | undefined) || obj;

  // Get confirmed/final fields
  const confirmedFields = getNestedValue(
    obj,
    'confirmed',
    'final',
    'userConfirmed',
    'user_confirmed'
  ) as Record<string, unknown> | undefined;

  // Get draft/user-edited fields (common backend patterns)
  const draftFields = getNestedValue(
    obj,
    'draft',
    'userDraft',
    'user_draft',
    'edited',
    'receipt',
    'receiptData',
    'receipt_data'
  ) as Record<string, unknown> | undefined;

  // Helper to get field value with fallback order:
  // 1) confirmed/final (for CONFIRMED)
  // 2) draft/user-edited (for DRAFT)
  // 3) root (some backends persist edits at top-level)
  // 4) extracted/OCR
  const getField = (fieldName: string, altNames: string[] = []): unknown => {
    const allNames = [fieldName, ...altNames];

    // Confirmed first
    if (confirmedFields) {
      for (const name of allNames) {
        const value = getNestedValue(confirmedFields, name);
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }

    // Draft/user-edited next
    if (draftFields) {
      for (const name of allNames) {
        const value = getNestedValue(draftFields, name);
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }

    // Root object next
    for (const name of allNames) {
      const value = getNestedValue(obj, name);
      if (value !== undefined && value !== null && value !== '') return value;
    }

    // Finally OCR/extracted
    if (extractedFields && extractedFields !== obj) {
      for (const name of allNames) {
        const value = getNestedValue(extractedFields, name);
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }

    return undefined;
  };

  // Extract and normalize fields - include raw field names from API
  const date = formatDate(
    getField('date', ['date_raw', 'receiptDate', 'receipt_date', 'transactionDate', 'purchaseDate'])
  );
  const total = parseNumber(
    getField('total', ['total_raw', 'total_amount', 'amount', 'totalAmount', 'grandTotal'])
  );
  const payee = (getField('payee', ['vendor', 'merchant', 'store', 'storeName']) as string) || '';
  const vat = parseNumber(getField('vat', ['vat_amount', 'tax', 'tax_raw', 'vatAmount', 'taxAmount']));
  const vatRate =
    parseVatRate(getField('vatRate', ['vat_rate', 'vat_rate_raw', 'taxRate', 'tax_rate'])) || '22';
  const category = (getField('category', ['type', 'expenseType', 'expenseCategory']) as string) || 'General';
  const notes = (getField('notes', ['description', 'memo', 'comment']) as string) || '';

  return {
    id,
    status,
    imageUrl,
    date,
    total,
    payee,
    vat,
    vatRate,
    category,
    notes,
  };
};
