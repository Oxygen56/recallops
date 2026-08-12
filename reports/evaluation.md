# RecallOps evaluation

## Release-gate result

- API/database: 16/16 automated tests passed live against CockroachDB Cloud v26.2.5; the final machine-recorded cloud run completed in 226.511 seconds in `artifacts/evidence/api-cloud-tests.json`.
- Judge interface: lint passed; 2/2 server-rendering and accessibility tests passed.
- Live operational memory gate: 10/10 checks passed on CockroachDB Cloud in 49.668 seconds in `artifacts/evidence/safety-evaluation.json`; cleanup was verified across every evaluation table with zero rows remaining.
- Managed MCP: RecallOps's client-enforced allowlist invoked all eight advertised read tools successfully; all five project-required checks passed in `artifacts/evidence/mcp-audit.json`, and the temporary API key was deleted. This is a verified client boundary, not a claim that the credential or server is intrinsically read-only.
- Source identity: all three live CockroachDB receipts bind to commit `66783df3ec0c612b6add7d76699592c30284b66e` and tree `26fa676cb58b2d77ee15d7137d2ece0d38cbbfb5`.
- Remote verification: source commit `66783df3ec0c612b6add7d76699592c30284b66e` passed the public GitHub Actions release gate.

## What is exercised

| Property | Test oracle |
| --- | --- |
| Ambiguous commit recovery | first response is 503 after commit; same key returns the same incident and action IDs |
| Idempotency | repeated command and concurrent identical action retries return the same result; key reuse for a different request is rejected |
| Concurrency | two approvals at revision 1 produce one success, one explicit stale-revision rejection, revision 2, and one approval event |
| Revocation | revoked memory disappears from recall; restore returns it and writes both lifecycle events |
| Expiry | expired memory is excluded before physical TTL deletion |
| Cross-session continuity | a second shift retrieves the first shift's admitted memory |
| Evidence durability | transactional outbox flushes stable receipts without blocking the committed decision |
| Vector usage | schema uses `vector_cosine_ops`; `EXPLAIN` shows a vector-search node on `memory_semantic_idx` |
| Model boundary | model-derived action remains `proposed`, reversible, and human-approved |
| MCP boundary | the RecallOps client can invoke only its eight currently documented read-tool allowlist entries; five project-critical tools must verify; credentials and query results never enter public results |
| Tenant-prefix separation | a perfect-match sentinel in a shadow tenant cannot appear in the evaluated tenant's vector recall; this is not claimed as authentication or row-level security |
| Hash-chain integrity | every ordered event hash is recomputed from canonical payload, actor, session, idempotency key, and prior hash |

## Ten-check operational memory gate

The judge interface can launch the same evaluation through `POST /v1/evaluations/safety`. It does not display a hard-coded score: the API creates fresh state, executes the ten checks, measures runtime, returns per-check proof, and returns success only after cleanup is verified.

## Limits

CockroachDB Cloud, the cosine vector plan, and Managed MCP are now live-proven. This evidence does not yet prove Bedrock invocation, S3 persistence, AWS Lambda availability, or public judge access. Those cells remain pending until AWS account authorization and corresponding receipts exist.
