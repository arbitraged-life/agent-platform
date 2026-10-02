---
name: evaluating-new-projects
description: Evaluate a candidate repository, library, service, or developer tool with comparable evidence, isolated execution, explicit adoption criteria, and no host-side installation by default.
---

# Evaluating New Projects

Use when deciding whether a specific candidate project should be adopted, replace an
incumbent, extend an existing workflow, or be rejected/deferred.

A project description, popularity metric, benchmark claim, or vendor comparison is not
enough for an adoption decision.

## 1. Define the decision

State the capability being evaluated and the incumbent/baseline, if any. Choose comparable
criteria before testing—for example correctness, latency, resource use, token/cost impact,
integration effort, privacy boundary, maintenance burden, or supported formats.

Do not add criteria after seeing results merely to favor a preferred outcome.

## 2. Establish provenance and operating boundary

Identify the authoritative project source, license, release/version tested, installation
surface, external services contacted, and data/credential requirements. Treat README claims
as claims until independently observed.

If safe evaluation requires production credentials, private data, or destructive access,
defer that portion rather than weakening the boundary.

## 3. Run an isolated spike

Exercise the candidate on a bounded representative sample. Prefer an ephemeral sandbox,
container, temporary environment, or otherwise reversible isolation when installing
untrusted third-party code. Do not install a candidate globally on the host merely to
evaluate it.

Use the same inputs and measurement method for candidate and baseline. Cover multiple modes
when the adoption claim spans multiple modes; do not generalize from one successful format
or backend to all advertised behavior.

Record actual observed results and failures. If a candidate has no executable interface,
perform a bounded direct validation of the reference/data it provides instead of inventing
performance evidence.

## 4. Decide from evidence

Use one explicit disposition:

- **Adopt** — useful net-new capability with acceptable measured behavior.
- **Replace** — measurably better for the tested scope with no unacceptable regression.
- **Extend** — valuable as a component of an existing capability rather than a replacement.
- **Reject: redundant** — the incumbent already covers the tested need.
- **Reject: no demonstrated gain** — the claimed improvement did not reproduce.
- **Defer** — evidence cannot yet be obtained safely or a required trust/provenance check is
  unresolved.

A decision applies only to the scope actually tested. Keep an incumbent for untested modes
when replacement evidence is incomplete.

## 5. Adoption boundary

Do not mutate production configuration, remove an incumbent, install persistent services,
or publish a new integration merely because an evaluation succeeded. Make adoption a
separate reviewed change with pinned dependency identity and rollback.

## Report

Return the candidate/version, baseline, criteria, test setup, observed measurements,
limitations, disposition, and the smallest next change justified by the evidence. Separate
measured facts from project/vendor claims.
