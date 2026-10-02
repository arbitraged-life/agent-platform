# Reusable merge coordinator

`.github/workflows/auto-merge-reusable.yml` runs one bounded pass of
`.github/scripts/merge_gate.py`. Consumers pin the workflow to a reviewed commit,
choose their own triggers, and grant the declared repository permissions. The
workflow loads the coordinator from the called workflow's commit.

The default requires exactly one run of `gate-workflow` for the current PR head,
and that run must be successful; additional matching runs are ambiguous even if
they failed. It also requires the configured opt-in `label` and GitHub's
`MERGEABLE` state. Optional
`advisory-workflows` never replace required evidence. `merge-method` selects the
merge strategy. The coordinator rechecks eligibility after fetching evidence and
passes the same head to `gh pr merge --match-head-commit`.

The final head comparison does not make labels or check results atomic with the
merge. Independent required-check protection remains necessary. A successful
fixture test does not establish protection, trusted provider identity, or live
merge acceptance in a consuming repository.

## Provider checks

`provider-enabled` defaults to false. Enabling it replaces the Actions gate with
the complete `provider-required-workflows` list and requires an explicitly trusted
`trusted-publisher-app-id`. Configuration comes from the trusted consumer, not PR
content or whichever checks happen to be green.

Each required `CircleCI / <workflow>` check must be unique, successful, completed,
on the current head, and published by that exact App ID. Its `external_id` must
contain canonical UUIDv4 pipeline/workflow/correlation identifiers, a positive
attempt, and this PR's number. The coordinator validates that envelope; the
consumer's trusted bridge must verify the underlying execution receipt. Arbitrary
commit statuses are not accepted as equivalent evidence.

The scan uses all check runs, up to 1,000 across ten pages. Multi-page scans are
read twice and compared; incomplete, changing, duplicate or untrusted evidence
fails closed. This is still not an atomic snapshot. Provider mode needs its own
identity provisioning and live acceptance before activation.

## Bounds and invocation

Each pass enumerates at most 10,000 open PRs and processes at most `max-prs`
(1–100). The workflow run number rotates the labeled processing window. Standalone
schedulers supply an increasing `--rotation-index` for continued coverage:

```sh
python3 .github/scripts/merge_gate.py \
  --repo owner/repository --gate-workflow ci.yml --label auto-merge \
  --merge-method squash --max-prs 100 --rotation-index 1
```

The command needs Python, GitHub CLI and an appropriately scoped credential.
Individual CLI calls have a 30-second timeout; the reusable job has a 15-minute
limit. There is no internal polling loop or deployed external scheduler. Leave
provider mode disabled to use the Actions gate. Rollback does not require deleting
provider checks, changing repository protection or merging unrelated PRs.

Run the deterministic behavioral suite with:

```sh
python3 -m unittest discover -s .github/scripts -p 'test_merge_gate.py'
```
