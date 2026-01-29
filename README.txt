Spendify – Receipts List OCR Fallback Fix

This ZIP contains a SINGLE change:
- src/api/app.py

What it fixes:
- GET /receipts (list) now applies OCR inference fallback
  when DB fields (payee/date/total/vat) are null and ocrRawKey exists.
- Same logic already used in GET /receipts/{id}
- No DB writes, no schema changes, no SAM changes.

How to apply:
1. Open src/api/app.py
2. Locate function _list_receipts(...)
3. Apply the patch in PATCH.diff (unified diff)

Deploy:
./scripts/deploy_backend.sh dev
