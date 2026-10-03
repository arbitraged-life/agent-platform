---
name: markitdown
description: Convert documents to Markdown for downstream analysis using format-aware, version-pinned tooling with explicit OCR, privacy, and verification boundaries.
---

# Document to Markdown Conversion

Use when the desired output is readable Markdown from an existing document. This is a read/convert workflow, not native Office document editing.

## Tool selection

Choose a converter based on the actual file format and document type. Do not infer support from a package name or optional-extra label.

For each converter:
- pin the version used;
- check authoritative format support;
- distinguish text PDFs from scanned/image PDFs;
- treat macro-enabled, legacy binary, and OpenDocument variants as separate formats unless tested.

## Workflow

1. Identify the input format without executing embedded content.
2. Determine whether OCR is required.
3. Convert the smallest necessary input scope.
4. Capture conversion errors explicitly; empty output is not success.
5. Inspect representative headings, tables, lists, links, and ordering in the Markdown.
6. For consequential extraction, compare a sample against the source document.
7. Record the converter/version and any OCR or external-service use.

## OCR and external processing

OCR may add heavyweight dependencies or send content to an external model/service depending on the plugin. Before enabling it, establish where document data will be processed and whether that is acceptable for the source.

Do not silently upload private documents.

## Unsupported formats

When support for a format is uncertain, run a bounded conversion test on a representative sample or report the format as unverified. Do not claim fallback coverage without evidence.

## Safety

Treat source documents as untrusted input. Prefer local conversion with least privilege, no unnecessary network access, and no persistent agent-wide installation during a routine conversion task.
