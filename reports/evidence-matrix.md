# Evidence matrix

| Claim | Implementation | Local proof | Cloud proof | Submission proof |
| --- | --- | --- | --- | --- |
| CockroachDB is the persistent memory layer | `sql/schema.sql`, `api/src/repository.ts` | 14 API/database tests + `artifacts/evidence/local-demo.json` | v26.2.5 Basic cluster; 14/14 live tests; `cloud-cockroachdb.json` | pending Devpost receipt |
| Distributed Vector Indexing is queried | cosine `memory_semantic_idx` with tenant + active-status prefixes | local `EXPLAIN` gate proves `vector search`; expiry exclusion test | live 10/10 gate proves the named cosine vector-search plan | pending video/demo |
| Managed MCP audits the live ledger through a client-enforced allowlist | `api/src/mcpAudit.ts`; eight permitted read tools; five required checks | credential-redaction, argument fail-closed, and required-tool tests | 8/8 advertised reads and 5/5 required checks verified; temporary key deleted | pending video/demo |
| AWS Lambda deployment path | cold-load-verified CommonJS bundle `api/dist/handler.cjs`; `infra/template.yaml` | bundle loads and exports a handler | pending AWS deployment | pending live URL |
| Amazon S3 receipt-sink path | transactional outbox + `ReceiptPublisher` + private encrypted bucket | local receipt sink and outbox test | pending S3 object receipt | pending video/demo |
| Optional Amazon Bedrock adapter is bounded | strict JSON schema; reversible low/medium-risk actions only | reasoning boundary integration test | pending model invocation receipt | pending video/demo |
| Idempotent after ambiguous commit | response-loss injection + request-bound idempotency reconciliation | actual HTTP 503 then replay; database row counts prove no duplicate aggregate or event | live gate: fault=true, replay=true, singular row counts | pending video/demo |
| Concurrent approvals remain safe | revision compare-and-set in serializable transaction | one winner / one stale rejection test | live gate: one winner, explicit stale loser, revision 2, one event | pending evaluation link |
| Revocation and expiry affect retrieval | status filter, tombstone events, row TTL | revoke/restore and expired-memory tests | live gate verifies revoke/restore and expired-sentinel exclusion | pending video/demo |
| Cross-session memory is preserved | session-independent memory IDs and event ledger | `crossSessionMemoryFound=true` | live gate recalls prior decision in a new session | pending video/demo |
| Judge interface is production-built | accessible SSR interface, social card | lint + 2 rendered HTML tests | private owner-only staging succeeded | pending public access |
| Operational memory safety is measured live | `api/src/safetyEval.ts`; `/v1/evaluations/safety`; judge UI scorecard | 10/10 locally; cleanup verified with zero rows | 10/10 in 30.395 s on v26.2.5; cleanup zero; `safety-evaluation.json` | pending video/demo |

“Pending” is intentional: source code and local execution are not presented as live-cloud or final-submission evidence.
