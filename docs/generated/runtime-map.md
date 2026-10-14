# Generated public runtime map

Generated from tracked `runtime/` modules and import statements by
`scripts/generate_architecture.py`. Edges mean a statically resolved source
import, not a deployed connection. Dynamic imports are not inferred. The
[editable Excalidraw overview](../diagrams/runtime-map.excalidraw) has the
domain-level view.

## Entrypoints and runtime domains

```mermaid
flowchart LR
    n3b3bd3ff01d6["execution-router · 2 modules"]
    n6691ff7ae175["observability · 7 modules"]
    n6b46c59d409d["purity · 1 module"]
    nbd9463690bd1["review · 5 modules"]
    nd8c919fe5f7d["review-remediation · 8 modules"]
    n94f99a9490f5["router.mjs"]
    n4269fc639fb8["config.mjs"]
    n6b60423d3b7f["efficiency.mjs"]
    nfe02331e31be["platform-release.py"]
    nc30b1a71b638["remediate.mjs"]
    n8b14b415a924["review.py"]
    n9c5498235c75["stream_verdict.py"]
    n94f99a9490f5 --> n3b3bd3ff01d6
    n4269fc639fb8 --> n6691ff7ae175
    n6b60423d3b7f --> n6691ff7ae175
    nc30b1a71b638 --> nd8c919fe5f7d
    n8b14b415a924 --> nbd9463690bd1
```

## Module imports

```mermaid
flowchart LR
    nc6119b3e11ec["execution-router/dispatch.mjs"]
    n7d83f63c67ca["execution-router/policy.mjs"]
    n6d7798d3734d["observability/delivery.mjs"]
    n9f2a6560098a["observability/efficiency.mjs"]
    n0de2f3f4ce1a["observability/evidence.mjs"]
    n4d8b77f09fbd["observability/opik.mjs"]
    ne68346c600cb["observability/outbox.mjs"]
    n2e277b9cdbe2["observability/posthog.mjs"]
    naf8e142b8748["observability/records.mjs"]
    n2c96340cda5e["purity/purity_checker.py"]
    n1dd1d7c7d1fc["review-remediation/controller.mjs"]
    ndc2ef34d7308["review-remediation/executor.mjs"]
    nc69330eaac30["review-remediation/extract-archive.py"]
    nd1f7354a8562["review-remediation/github.mjs"]
    n8308efa8c6f0["review-remediation/inference-proxy.mjs"]
    n1c84274e6b0d["review-remediation/policy.mjs"]
    n5e86f97aa95c["review-remediation/route.mjs"]
    n7b23a7f6c181["review-remediation/sandbox.mjs"]
    n24375535721f["review/core.py"]
    n1efe283c0030["review/engine.py"]
    nbda559628a9a["review/github.py"]
    nf4725de15231["review/policy.py"]
    n70562998125a["review/transport.py"]
    nc6119b3e11ec --> n7d83f63c67ca
    n6d7798d3734d --> n0de2f3f4ce1a
    n9f2a6560098a --> n0de2f3f4ce1a
    n9f2a6560098a --> naf8e142b8748
    n0de2f3f4ce1a --> naf8e142b8748
    n4d8b77f09fbd --> n6d7798d3734d
    n4d8b77f09fbd --> n0de2f3f4ce1a
    n4d8b77f09fbd --> naf8e142b8748
    ne68346c600cb --> n0de2f3f4ce1a
    n2e277b9cdbe2 --> n6d7798d3734d
    n2e277b9cdbe2 --> n0de2f3f4ce1a
    n2e277b9cdbe2 --> naf8e142b8748
    n1dd1d7c7d1fc --> nd1f7354a8562
    n1dd1d7c7d1fc --> n1c84274e6b0d
    ndc2ef34d7308 --> n7b23a7f6c181
    n5e86f97aa95c --> n1c84274e6b0d
    n1efe283c0030 --> n24375535721f
    n1efe283c0030 --> n70562998125a
    nbda559628a9a --> n70562998125a
```

The generated views show source structure only. See
[architecture and ownership](../architecture.md) for the release and
consumer boundary, and the domain guides for behavior.
