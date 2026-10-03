---
name: tax-prep
description: Use when organizing, OCRing, reconciling, or auditing a tax-document package; checking for missing forms; categorizing receipts; or building a repeatable tax-preparation workflow from source documents. Keep taxpayer data outside the repository and treat generated OCR/extraction files as disposable working state.
---

# Tax Prep

## Boundary

This skill contains reusable workflow logic only. Never commit taxpayer names, addresses, account numbers, tax IDs, returns, W-2/1099 contents, scanned notices, generated OCR text, or machine-specific paths.

Keep source documents in the user's document store. Use a runtime-provided `TAX_ROOT` for working files and delete disposable OCR/extraction artifacts when the task is complete.

## Inputs

- `TAX_YEAR` — target filing year.
- `TAX_ROOT` — runtime folder containing source tax documents.
- Optional prior-year return for expected-form comparison.
- Optional receipts, bank/card statements, and tax-authority notices.

## Workflow

1. Inventory source documents by year and taxpayer/entity.
2. OCR only files that are not already text-searchable.
3. Extract form type, issuer/payer, tax year, and document date without copying sensitive values into repository state.
4. Compare the current-year inventory with the prior-year return and prior-year source list to identify potentially missing forms.
5. Reconcile duplicate documents and conflicting versions before analysis.
6. Categorize receipts and expenses only when requested, preserving an evidence link to the source document.
7. Produce reports back into `TAX_ROOT` or another user-owned document store, never into this repository.
8. Remove disposable working files after the final artifacts are verified.

## Naming

Prefer stable document names such as `YYYY - <form/document> - <issuer or role>.<ext>`.

Do not rename a document based on guessed content. Put uncertain scans in an explicit unfiled/needs-review location.

## Safety and validation

- Treat OCR and extraction as untrusted until checked against the original document.
- Do not infer a missing form solely because one existed last year; verify whether the source was active and whether reporting thresholds applied.
- For tax-law conclusions, verify against current authoritative guidance for the relevant jurisdiction and tax year.
- Do not upload sensitive tax documents to third-party services unless the user explicitly chose that workflow.

## References

- `references/full-tax-pipeline.md`
- `references/missing-forms-checker.md`
- `references/receipt-organizer.md`
