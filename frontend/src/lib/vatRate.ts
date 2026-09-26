// VAT rates differ by country (20% in the UK and France, 19% in Germany, 21% in
// Spain and the Netherlands, 22% in Italy, 7.7% in Switzerland...). A detected
// rate is therefore never mapped onto a fixed list: keep what the receipt says.

export const COMMON_VAT_RATES = [
  '0', '4', '5', '6', '7', '8', '9', '10', '12', '13', '14', '15',
  '19', '20', '21', '22', '23', '24', '25', '27',
];

// Rate coming from OCR or from saved data ("22", "A 20.00%", 19.98, 0) -> "22", "20", "20", "0".
// Rounded to one decimal: the backend infers a rate from total and VAT when the
// receipt does not print one, and that calculation carries cent-rounding noise.
export const parseVatRate = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '';

  let rate: number;
  if (typeof value === 'number') {
    rate = value;
  } else if (typeof value === 'string') {
    const match = value.replace(',', '.').match(/(\d+(?:\.\d+)?)/);
    if (!match) return '';
    rate = parseFloat(match[1]);
  } else {
    return '';
  }

  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return '';
  return String(Math.round(rate * 10) / 10);
};

// What the user typed in the form -> the value to store, or null if it is not a rate.
export const normalizeVatRateInput = (raw: string): string | null => {
  const cleaned = raw.trim().replace(',', '.').replace(/%$/, '').trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const rate = parseFloat(cleaned);
  if (rate > 100) return null;
  return String(rate);
};
