# Skill distribution and discovery

`python3 scripts/skills.py list` emits the release's catalog as JSON. Skill
entrypoints have matching kebab-case names and nonempty descriptions. The catalog
is the authoritative list of included procedures and reference skills; use its
output instead of maintaining a separate count in installation instructions.
The immutable platform release includes their referenced documentation.
Platform-original skills use the repository LICENSE; pinned upstream skills retain their
recorded upstream license and lock evidence. Fresh migration replacements are re-authored
from capability requirements rather than copied from held private source text.

`python3 scripts/skills.py validate` checks the catalog, file inventory, hashes,
license, pinned upstream revision, and declared overlays. `./scripts/validate`
also checks frontmatter/catalog agreement and bundled Markdown references.
Changing upstream content requires an explicit overlay with a rationale and hash;
adding files without updating the inventory fails validation.

The Cloudflare source revision and original file hashes are recorded in
`skills/upstream-lock.json`; its license is retained under `licenses/`. Upstream
updates are explicit dependency changes, not a fetch of current main. Examples
are documentation, not live deployment configuration. Several deliberately
illustrate incorrect code. Runtime credentials and account IDs are supplied by
the consuming environment and are not part of a skill bundle.

Clients consume skill directories from an installed, digest-verified release.
A private frontend overlay may provide local command paths and available tools;
it does not fork the generic instructions. Published plugin bundles are generated
deployments of the pinned source and retain their source revision/digests.

These reference skills assume the capabilities described by each skill. In
particular, web-perf requires Chrome DevTools tracing; a generic browser tool is
not an equivalent replacement. Installing documentation does not install a
runtime, grant tool permissions, or authorize deployment/provider spending.

The migration bundle also includes independently authored generic wrappers for context compression (`headroom`), document-to-Markdown conversion (`markitdown`), and native Office document editing (`officecli`). These skills require pinned tooling, bounded data/installation scope, and explicit verification rather than inheriting historical benchmark claims.

Additional migration skills cover fail-closed cross-language structural verification, permission-bounded prompt refinement, and evidence-linked long-form technical analysis. These are generic policies; repository-specific overlays remain private.

Opt-in behavior policies are also available for terse wording (`caveman`), action-first presentation (`i-have-adhd`), and minimal-change engineering (`ponytail`). They affect presentation or implementation preference only and do not weaken verification or safety requirements.
