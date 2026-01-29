Spendify OCR Normalization Fix

This patch restores OCR normalization in the OCR Lambda.

What it does:
- Reads Textract ExpenseDocuments
- Extracts payee, total, date, vat, vatRate
- Writes normalized fields into the receipts DynamoDB item
- Updates status to OCR_DONE

Files to replace:
- src/ocr/app.py

Deploy:
./scripts/deploy_backend.sh dev
