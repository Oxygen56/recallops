# Evidence matrix

| Claim | Implementation | Local proof | Cloud proof | Submission proof |
| --- | --- | --- | --- | --- |
| CockroachDB is the persistent memory layer | `sql/schema.sql`, `api/src/repository.ts` | 10 API tests + `artifacts/evidence/local-demo.json`; clean GitHub Actions run passed | pending live cluster | pending Devpost receipt |
| Distributed Vector Indexing is queried | `memory_semantic_idx` + tenant-prefixed vector query | `vectorIndexActive=true`; expiry exclusion test | pending live MCP/schema receipt | pending video/demo |
| Managed MCP audits the live ledger | `api/src/mcpAudit.ts`; five-tool read-only allowlist | credential-redaction and fail-closed tests | pending service-account audit | pending video/demo |
| AWS Lambda runs the API | bundled `api/dist/lambda.mjs`; `infra/template.yaml` | Lambda bundle builds (2.7 MB) | pending AWS deployment | pending live URL |
| Amazon S3 stores decision receipts | transactional outbox + `ReceiptPublisher` + private encrypted bucket | local receipt sink and outbox test | pending S3 object receipt | pending video/demo |
| Amazon Bedrock reasoning is bounded | strict JSON schema; reversible low/medium-risk actions only | reasoning boundary integration test | pending model invocation receipt | pending video/demo |
| Idempotent after ambiguous commit | response-loss injection + idempotency-key reconciliation | `faultReturned503`, `commitWasReconciled`, `sameIncidentRecovered` | pending cloud replay | pending video/demo |
| Concurrent approvals remain safe | revision compare-and-set in serializable transaction | one winner / one stale rejection test | pending cloud concurrency run | pending evaluation link |
| Revocation and expiry affect retrieval | status filter, tombstone events, row TTL | revoke/restore and expired-memory tests | pending live ledger proof | pending video/demo |
| Cross-session memory is preserved | session-independent memory IDs and event ledger | `crossSessionMemoryFound=true` | pending cloud session proof | pending video/demo |
| Judge interface is production-built | accessible SSR interface, social card | lint + 2 rendered HTML tests | private owner-only staging succeeded | pending public access |

“Pending” is intentional: source code and local execution are not presented as live-cloud or final-submission evidence.
