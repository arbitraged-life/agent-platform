---
name: officecli
description: Create or edit DOCX, XLSX, and PPTX files with a version-pinned Office document CLI, explicit structural read-back, bounded host changes, and visual verification when available.
---

# Native Office Document Editing

Use when the task requires creating or modifying Office files rather than merely extracting text to Markdown.

## Preconditions

Before use:
1. confirm the requested format is supported by the selected CLI version;
2. pin the package or binary version;
3. inspect installation behavior, including native binary downloads and runtime dependencies;
4. avoid global installation when an isolated or project-scoped invocation is practical.

Do not run vendor “install into all agents” helpers as part of an ordinary document task.

## Editing workflow

1. Work on the requested file or an explicit copy.
2. Inspect the existing document structure before changing it.
3. Make the smallest structural edit necessary.
4. Read the modified element back through the document model or structured output.
5. Save/close any resident editing session so changes are flushed.
6. Re-open or re-read the file to verify persistence.
7. When rendering is available, visually inspect layout-sensitive changes.

## Format-specific verification

- DOCX: verify paragraph/table/image structure and text ordering.
- XLSX: verify sheets, cell/range values, formulas, and intended formatting.
- PPTX: verify slide order, shape/text content, geometry, and theme-sensitive layout.

Do not assume element names or paths are identical across formats; use the installed version's help/reference.

## Safety

Treat Office files as untrusted structured archives. Avoid executing embedded macros or external content. Keep network access limited to explicit installation or user-requested operations.

Persistent agent configuration, background watchers, and host-wide integration require separate user intent from the document edit itself.
