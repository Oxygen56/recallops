# RecallOps architecture

```mermaid
flowchart LR
    U["Operations lead"] --> W["RecallOps web app"]
    W --> L["AWS Lambda agent API"]
    L --> E["Incident decision engine"]
    E --> C[("CockroachDB Cloud")]
    C --> V["Distributed vector index"]
    C --> T["Serializable state + event ledger"]
    E --> O["Transactional outbox"]
    O --> S["Amazon S3 evidence receipts"]
    E --> B["Amazon Bedrock bounded reasoning"]
    M["Managed MCP operator audit"] --> C
    J["Judge / operator"] --> M
```

## Memory contract

Each accepted incident command writes these facts atomically:

1. the current incident projection and revision;
2. an application-append-only event with a previous-hash link;
3. a provenance-bearing semantic memory and embedding;
4. zero or more action proposals requiring explicit approval;
5. an outbox record for an AWS evidence receipt.

The response is derived only after commit. If the response is lost, replaying the same idempotency key returns the original aggregate and does not duplicate actions.

## Safety model

- Tenant scope and active lifecycle state are exact vector-index prefix columns; expiry is applied after an indexed candidate search.
- Retrieval excludes revoked or expired memories at query time; TTL later removes eligible rows.
- Action execution uses compare-and-set revision checks and records a compensating transition for undo.
- External side effects use an outbox and stable receipt key.
- Demo data is synthetic and contains no personal or commercially sensitive information.
- The public demo accepts only the configured synthetic tenant and enforces database-backed hourly quotas. This is an application boundary, not database row-level security. The shared demo reset is not a multi-user isolation boundary and must be disabled or protected before public launch.
- Managed MCP audit uses a temporary cluster-scoped credential, while RecallOps enforces a read-only client allowlist and never calls write tools. The temporary key is deleted after evidence capture.
- Bedrock output is accepted only when it matches a strict schema: one to three reversible, low/medium-risk proposals. No model output can mark an action executed.

## Failure model

- serialization failure: retry the whole transaction with bounded exponential backoff;
- ambiguous response after commit: reconcile by idempotency key;
- S3 unavailable: retain outbox record and retry without blocking the committed decision;
- embedding provider unavailable: use deterministic local embedding and mark provider in provenance;
- Bedrock unavailable or malformed: use the deterministic safety playbook and record the fallback in provenance;
- stale concurrent approval: reject with expected/actual revision evidence;
- revoked memory: retain tombstone and event history, remove it from future recommendations.
