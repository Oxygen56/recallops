# Devpost submission draft

## Project name

RecallOps

## Tagline

Memory that knows when to act — and when to forget.

## Short description

RecallOps is a reversible supply-chain incident agent whose memory survives retries, concurrent operators, revoked evidence, expiry, and shift changes. CockroachDB stores the operational state, semantic memory, and immutable decision ledger together; AWS runs the agent and preserves decision receipts.

## Inspiration

Supply-chain teams do not mainly fail because they lack another chatbot. They fail when one shift cannot reconstruct why the previous shift acted, a retry creates duplicate work, stale evidence keeps influencing decisions, or an automated recommendation quietly becomes an irreversible action. We built RecallOps to make memory an operational contract instead of chat history.

## What it does

An operator submits a delay, quality, capacity, or compliance incident. RecallOps retrieves relevant active memories, proposes bounded reversible actions, and atomically stores the incident, admitted memory, proposals, provenance, event, and receipt outbox. The judge can deliberately lose the response after commit, retry safely, approve or compensate an action from another session, revoke and restore memory, and inspect the hash-linked timeline.

## How we built it

- CockroachDB is the persistent memory system of record.
- Distributed Vector Indexing performs tenant-prefixed semantic recall.
- CockroachDB Cloud Managed MCP provides a read-only operator audit of the live schema and ledger.
- AWS Lambda runs the API, Amazon S3 stores stable evidence receipts, and Amazon Bedrock optionally tailors schema-bounded reversible proposals.
- A serializable transaction, idempotency keys, revision checks, a transactional outbox, row-level TTL, and lifecycle events make failure and forgetting testable.

## Challenges

The hardest part was treating the moment after a successful commit but before a successful response as normal, not exceptional. The same idempotency key must reconcile to the original incident, action IDs, memory, and receipt. We also had to separate revocation from deletion so future recall forgets immediately while the audit history remains explainable.

## Accomplishments

- Ambiguous-commit recovery returns the exact committed decision without duplicates.
- Concurrent approval produces one winner and one explicit stale-revision rejection.
- Revoked and expired memories are excluded from retrieval.
- Cross-session recall reconstructs prior outcomes and provenance.
- Model output remains reversible and human-approved; the system fails safely without the model.
- Local release gate: 10 API tests, 2 rendered-interface tests, and 7 end-to-end failure assertions.

## What we learned

Agentic memory is a consistency and lifecycle problem as much as a retrieval problem. Vector similarity becomes trustworthy only when tenancy, provenance, expiry, revocation, concurrency, and recovery share the same durable contract.

## What's next

Add policy-specific approval roles, cryptographic receipt export, evaluation on a larger synthetic incident benchmark, and organization-specific memory admission rules.

## Links to insert after verification

- Live demo: `[PUBLIC_URL_PENDING]`
- Source: `[PUBLIC_REPOSITORY_PENDING]`
- Video: `[PUBLIC_VIDEO_PENDING]`

## Technology tags

CockroachDB, Distributed Vector Indexing, Managed MCP, AWS Lambda, Amazon S3, Amazon Bedrock, TypeScript, Hono, React, agentic memory, supply chain
