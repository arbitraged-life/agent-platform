# Receipt Organizer

## Goal

Turn receipts and transaction evidence into a traceable expense ledger without losing the link to the original document.

## Procedure

1. OCR image-only receipts into disposable working files.
2. Extract date, vendor, amount, currency, and any explicit business-purpose text.
3. Assign a tentative tax/accounting category only when supported by the document and user context.
4. Reconcile against bank/card statements when available to find duplicate or missing evidence.
5. Keep uncertain items in `Needs clarification` rather than guessing.
6. Produce a ledger with source filename/path for every row.
7. Verify totals programmatically before presenting them.

For multi-currency items, retain the original amount and currency. Add a converted amount only with an identified exchange-rate source/date or another user-approved method.

Do not encode jurisdiction-specific deductibility percentages as timeless rules; verify current guidance for the relevant tax year before applying them.
