# Generated public runtime map

Generated from tracked `runtime/` modules and import statements by
`scripts/generate_architecture.py`. Edges mean a statically resolved source
import, not a deployed connection. Dynamic imports are not inferred. The
[editable Excalidraw overview](../diagrams/runtime-map.excalidraw) has the
domain-level view.

## Entrypoints and runtime domains

```mermaid
flowchart LR
    n7bd73af6e87b["execution-router · 2 modules"]
    n9c19a3627351["observability · 7 modules"]
    n32e7ed6cdff6["purity · 1 module"]
    n01df474dbb88["review · 5 modules"]
    n4a661beb6fbb["review-remediation · 8 modules"]
    n19517bea1b62["router.mjs"]
    n38f6ac63ddc7["config.mjs"]
    nd323e1ead360["efficiency.mjs"]
    n1f888e0f8326["platform-release.py"]
    ncffe4be23975["remediate.mjs"]
    nb91948079ab2["review.py"]
    n2d120f700d9d["stream_verdict.py"]
    n19517bea1b62 --> n7bd73af6e87b
    n38f6ac63ddc7 --> n9c19a3627351
    nd323e1ead360 --> n9c19a3627351
    ncffe4be23975 --> n4a661beb6fbb
    nb91948079ab2 --> n01df474dbb88
```

## Module imports

```mermaid
flowchart LR
    nbc694c06e291["execution-router/dispatch.mjs"]
    n9c9afc1d96c7["execution-router/policy.mjs"]
    nb151b4519cc4["observability/delivery.mjs"]
    n7a11a1a5705b["observability/efficiency.mjs"]
    n0d8c448ef934["observability/evidence.mjs"]
    n01a7e41980e8["observability/opik.mjs"]
    ncdde7e6e7b87["observability/outbox.mjs"]
    nf818e6e35111["observability/posthog.mjs"]
    n25811c0ba240["observability/records.mjs"]
    n33582fb5ddbf["purity/purity_checker.py"]
    nc1cbbaf022d9["review-remediation/controller.mjs"]
    n28c071e340fa["review-remediation/executor.mjs"]
    n9392ae582333["review-remediation/extract-archive.py"]
    n9e6a4073f832["review-remediation/github.mjs"]
    n0d00ac8d8399["review-remediation/inference-proxy.mjs"]
    n78c4c332a831["review-remediation/policy.mjs"]
    n8d04660a360b["review-remediation/route.mjs"]
    n51eba66320f9["review-remediation/sandbox.mjs"]
    n31c6e6d4410d["review/core.py"]
    n1a9226bef363["review/engine.py"]
    na79047b37d38["review/github.py"]
    nf8c8796f944d["review/policy.py"]
    n87c20c5a1086["review/transport.py"]
    nbc694c06e291 --> n9c9afc1d96c7
    nb151b4519cc4 --> n0d8c448ef934
    n7a11a1a5705b --> n0d8c448ef934
    n7a11a1a5705b --> n25811c0ba240
    n0d8c448ef934 --> n25811c0ba240
    n01a7e41980e8 --> nb151b4519cc4
    n01a7e41980e8 --> n0d8c448ef934
    n01a7e41980e8 --> n25811c0ba240
    ncdde7e6e7b87 --> n0d8c448ef934
    nf818e6e35111 --> nb151b4519cc4
    nf818e6e35111 --> n0d8c448ef934
    nf818e6e35111 --> n25811c0ba240
    nc1cbbaf022d9 --> n9e6a4073f832
    nc1cbbaf022d9 --> n78c4c332a831
    n28c071e340fa --> n51eba66320f9
    n8d04660a360b --> n78c4c332a831
    n1a9226bef363 --> n31c6e6d4410d
    n1a9226bef363 --> n87c20c5a1086
    na79047b37d38 --> n87c20c5a1086
```

The generated views show source structure only. See
[architecture and ownership](../architecture.md) for the release and
consumer boundary, and the domain guides for behavior.
