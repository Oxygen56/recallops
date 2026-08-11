# RecallOps

**A reversible supply-chain incident agent with durable, auditable memory.**

RecallOps helps an operations lead respond to delays, quality holds, and supplier failures without repeating past mistakes. Every recommendation is backed by a provenance-bearing memory, every external action is proposed before execution, and every mutation is idempotent, revocable, and recoverable after ambiguous failures.

> Hackathon status: active build for the CockroachDB × AWS Agentic Memory Hackathon. The public demo and cloud evidence will be added only after they are verified.

## Why this is different

Most “memory agents” are chat history plus a vector store. RecallOps treats memory as operational state:

- **Transactional memory:** incident state, action proposals, immutable events, and semantic memories commit together in CockroachDB.
- **Distributed retrieval:** a tenant-prefixed CockroachDB vector index retrieves relevant prior incidents without a separate vector database.
- **Safe execution:** the agent proposes reversible actions, records approval, and supports compensation instead of silently changing the world.
- **Failure honesty:** idempotency keys and read-after-timeout reconciliation prevent double actions when a response is lost after commit.
- **Lifecycle controls:** memories carry provenance, expiry, revocation, and restoration events; revoked or expired memories never enter retrieval.
- **Cross-session continuity:** a new session can reconstruct why a prior decision was made from the event ledger and evidence receipts.
- **Bounded model reasoning:** Amazon Bedrock can tailor the decision posture, but its output is schema-checked and limited to reversible, human-approved proposals; the safety playbook remains available as a fail-safe.

## Sponsor technology

- CockroachDB is the system of record and persistent memory layer.
- CockroachDB Distributed Vector Indexing powers semantic recall.
- CockroachDB Cloud Managed MCP is the operator/audit path used to inspect the live schema and memory ledger safely. This integration remains marked unverified until the cloud OAuth flow is completed and runtime receipts are captured.
- AWS Lambda hosts the agent API; Amazon S3 stores tamper-evident decision receipts; Amazon Bedrock provides optional bounded reasoning. The cloud deployment remains marked unverified until an AWS account deployment is completed.

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

The verification gate starts CockroachDB, applies the schema, runs unit and integration tests, executes the complete demo scenario, and writes machine-readable evidence under `artifacts/evidence/`.

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
- cloud verified: a live CockroachDB Cloud/AWS run produced a redacted receipt;
- submitted: Devpost returned a final submission receipt.

See `reports/evidence-matrix.md` for the current state.

## License and disclosures

RecallOps is licensed under Apache-2.0. Third-party dependencies retain their own licenses. See `DISCLOSURES.md` for AI assistance, pre-existing work, generated data, and external service disclosures.
