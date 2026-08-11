# RecallOps BUIDL submission

## One-line pitch

RecallOps is a reversible supply-chain incident agent whose CockroachDB memory survives retries, concurrent operators, revoked evidence, expiry, and shift changes.

## Problem and solution

Operational teams lose context when one shift cannot reconstruct the last decision, a timed-out retry duplicates work, or stale evidence keeps influencing automation. RecallOps stores state, semantic memory, provenance, proposed actions, immutable events, and receipt delivery in one durable contract. Every action is reversible and requires human approval.

## Demo

- Local: `./scripts/verify_local.sh`
- Live URL: pending public cloud verification
- Video: pending public upload

## Architecture

CockroachDB is the persistent memory layer. Distributed Vector Indexing powers tenant-prefixed recall; Managed MCP provides a read-only cloud audit. AWS Lambda runs the API, S3 stores decision receipts, and Bedrock optionally generates schema-bounded reversible proposals. See `reports/architecture.md`.

## Evidence

- 10 API/database tests passed against CockroachDB v26.2.0.
- 2 server-rendered interface/accessibility tests passed.
- 7 end-to-end failure assertions passed.
- Secret scan found no committed credential pattern.
- Full claim boundaries: `reports/evidence-matrix.md`.

## Judging rubric mapping

- Memory design: provenance, admission, expiry, revocation, restoration, cross-session recall, immutable events.
- Technical implementation: serializable transactions, idempotency, revision checks, vector index, outbox, MCP boundary.
- Real-world impact: prevents duplicate holds, premature reroutes, and handoff context loss.
- Product readiness: interactive fault injection, approval/undo, health evidence, least privilege, deterministic fallback.
- Originality: proves recovery and governed forgetting instead of presenting chat history as memory.
