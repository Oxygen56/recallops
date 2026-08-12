# RecallOps

[![RecallOps verification](https://github.com/Oxygen56/recallops/actions/workflows/ci.yml/badge.svg)](https://github.com/Oxygen56/recallops/actions/workflows/ci.yml)

**The incident agent that never duplicates a retried decision—and can prove why.**

RecallOps helps an operations lead respond to delays, quality holds, and supplier failures without repeating past mistakes. Every recommendation is backed by a provenance-bearing memory, every external action is proposed before execution, and incident, action, and memory-lifecycle mutations are request-bound, idempotent, and recoverable after ambiguous failures.

> Hackathon status: CockroachDB Cloud and Managed MCP are live-verified. AWS deployment and the public integrated demo remain pending account authorization and live receipts.

## Why this is different

Most “memory agents” are chat history plus a vector store. RecallOps treats memory as operational state:

- **Transactional memory:** incident state, action proposals, application-append-only hash-linked events, and semantic memories commit together in CockroachDB.
- **Distributed retrieval:** a tenant-and-lifecycle-prefixed CockroachDB cosine vector index retrieves relevant prior incidents without a separate vector database; the live gate verifies the physical query plan.
- **Safe execution:** the agent proposes reversible actions, records approval, and supports compensation instead of silently changing the world.
- **Failure honesty:** idempotency keys and read-after-timeout reconciliation prevent double actions when a response is lost after commit.
- **Lifecycle controls:** memories carry provenance, expiry, revocation, and restoration events; revoked or expired memories never enter retrieval.
- **Cross-session continuity:** a new session can reconstruct why a prior decision was made from the event ledger and evidence receipts.
- **Bounded model reasoning:** the optional implemented Amazon Bedrock adapter is designed to tailor the decision posture, while schema checks limit accepted output to reversible, human-approved proposals; the safety playbook remains available as a fail-safe. A live Bedrock invocation remains unverified.
- **Live operational memory gate:** one click exercises a fresh isolated application tenant in CockroachDB across lost responses, racing approvals, compensation, revocation, restoration, expiry, tenant-prefix separation, audit integrity, and the real cosine vector plan.

## Sponsor technology

- CockroachDB is the system of record and persistent memory layer.
- CockroachDB Distributed Vector Indexing powers semantic recall.
- RecallOps audits CockroachDB Cloud Managed MCP through a client-enforced allowlist of eight read tools. All eight advertised tools and all five project-required checks were live-verified against the Basic cluster; the temporary audit key was deleted afterward. This is an application-client boundary, not a claim that the credential or MCP server is intrinsically read-only.
- The implemented AWS path targets Lambda for the agent API and encrypted Amazon S3 objects for decision receipts; Amazon Bedrock is an optional bounded-reasoning adapter. None of these AWS paths is marked live until corresponding account receipts are captured.

## Live operational memory safety gate

| Failure class | Live proof |
| --- | --- |
| Lost response after commit | same key recovers the committed incident; database counts remain one incident, one memory, one action set, and one creation event |
| Racing operators | exactly one approval wins; the loser is specifically rejected as a stale revision; the ledger contains one approval event |
| Human control | an approved proposal can be recorded as compensated at the next revision |
| Memory lifecycle | a new session recalls the prior decision; revoked and expired rows do not influence recall; restoration is visible |
| Isolation and integrity | a shadow-tenant sentinel is excluded, the payload plus audit-metadata hash chain recomputes, and `EXPLAIN` shows `memory_semantic_idx` executing a cosine vector search |

Run it with `cd api && npm run evaluate`. The JSON receipt is written to `artifacts/evidence/safety-evaluation.json`.

## Local quick start

Requirements: Docker, Node.js 22+, npm.

```bash
cp .env.example .env
./scripts/db_up.sh
cd api && npm install && npm run migrate && npm test
npm run dev
```

In another terminal:

```bash
cd web && npm install && npm run dev
```

The API defaults to `http://localhost:8787`; the web app prints its own local URL.

## Verification

```bash
./scripts/verify_local.sh
```

The verification gate starts CockroachDB, applies the schema, runs the full unit and integration suite, executes the complete demo scenario, and writes machine-readable evidence under `artifacts/evidence/`.

Run only the judge-facing operational memory gate:

```bash
cd api && npm run evaluate
```

This creates fresh UUID evaluation tenants, executes the ten database-backed checks, verifies the cosine vector plan, then audits deletion across every evaluation table. The latest cloud run passed 10/10 in 30.395 seconds on CockroachDB Cloud v26.2.5, with cleanup verified and zero rows remaining. Machine-readable receipts are `artifacts/evidence/safety-evaluation.json`, `artifacts/evidence/mcp-audit.json`, and `artifacts/evidence/cloud-cockroachdb.json`.

## Repository map

- `api/` — agent engine, CockroachDB repository, AWS receipt sink, HTTP/Lambda entrypoints
- `sql/` — CockroachDB schema, vector index, TTL, and audit invariants
- `web/` — judge-facing product interface
- `infra/` — AWS SAM deployment template and least-privilege policy
- `tests/` — cross-service and failure-recovery tests
- `reports/` — competition brief, architecture, evaluation, and evidence boundaries
- `buidl/` — final Devpost package and submission copy

## Evidence boundaries

Source code and local tests are not cloud proof. Claims in this README are intentionally separated:

- implemented: the code path exists;
- locally verified: a reproducible local test produced a receipt;
- CockroachDB Cloud verified: a live database or Managed MCP run produced a redacted receipt;
- AWS cloud verified: a live Lambda invocation or S3/Bedrock operation produced a redacted receipt;
- submitted: Devpost returned a final submission receipt.

See `reports/evidence-matrix.md` for the current state.

## License and disclosures

RecallOps is licensed under Apache-2.0. Third-party dependencies retain their own licenses. See `DISCLOSURES.md` for AI assistance, pre-existing work, generated data, and external service disclosures.
