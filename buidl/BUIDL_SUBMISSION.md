# RecallOps BUIDL submission

## One-line pitch

RecallOps is a reversible supply-chain incident agent whose CockroachDB memory survives retries, concurrent operators, revoked evidence, expiry, and shift changes.

## Problem and solution

Operational teams lose context when one shift cannot reconstruct the last decision, a timed-out retry duplicates work, or stale evidence keeps influencing automation. RecallOps stores state, semantic memory, provenance, proposed actions, application-append-only hash-linked events, and receipt delivery in one durable contract. Every action is reversible and requires human approval.

## Demo

- Local: `./scripts/verify_local.sh`
- Live URL: pending public cloud verification
- Video: pending public upload

## Architecture

CockroachDB is the persistent memory layer. Distributed Vector Indexing powers tenant-prefixed recall; RecallOps constrains Managed MCP audit calls with a client-enforced read-only allowlist. The implemented AWS path targets Lambda for the API, S3 for decision receipts, and optional Bedrock for schema-bounded reversible proposals. Live AWS receipts remain pending. See `reports/architecture.md`.

## Evidence

- The full API/database suite passed live against CockroachDB Cloud v26.2.5.
- The live operational memory gate passed 10/10 in 30.395 seconds and verified zero evaluation rows remained after cleanup.
- RecallOps verified its client-enforced allowlist across all eight advertised Managed MCP read tools and all five project-required checks; the temporary audit key was deleted afterward.
- The full server-rendered interface/accessibility suite passed.
- The full end-to-end failure suite passed.
- Secret scan found no committed credential pattern.
- Full claim boundaries: `reports/evidence-matrix.md`.

## Judging rubric mapping

- Memory design: provenance, admission, expiry, revocation, restoration, cross-session recall, and hash-linked events.
- Technical implementation: serializable transactions, idempotency, revision checks, vector index, outbox, MCP boundary.
- Real-world impact: prevents duplicate holds, premature reroutes, and handoff context loss.
- Product readiness: interactive fault injection, approval/undo, health evidence, least privilege, deterministic fallback.
- Originality: proves recovery and governed forgetting instead of presenting chat history as memory.
