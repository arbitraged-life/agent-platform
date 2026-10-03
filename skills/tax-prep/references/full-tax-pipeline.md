# Full Tax Pipeline

Use this as an orchestration template; adapt storage and tools to the runtime.

1. **Collect** — inventory W-2, 1099, 1098, K-1, retirement, brokerage, rental/hosting, and prior-year return documents for `TAX_YEAR`.
2. **Normalize** — standardize filenames and separate current-year, related-taxpayer/entity, government/address, and unfiled material.
3. **OCR** — process only image-only documents into a temporary OCR area under `TAX_ROOT`.
4. **Extract** — build a document inventory containing form type, issuer, tax year, and source path. Avoid persisting sensitive field values unless required for the user's requested output.
5. **Reconcile** — check duplicate versions, mismatched year labels, inconsistent issuer names, and missing expected forms.
6. **Analyze** — answer the user's requested tax-preparation questions using the source documents and current authoritative tax guidance when legal/tax rules matter.
7. **Output** — save the final checklist/report to the user's document store.
8. **Clean** — delete temporary OCR, image crops, and text extractions after final outputs are verified.

A completed final return or notice response is a source record and stays with the tax documents; temporary transforms do not.
