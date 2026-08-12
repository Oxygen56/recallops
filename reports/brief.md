# Competition brief

## Outcome

Build and submit RecallOps, a judge-ready supply-chain incident memory agent targeting the USD 5,000 first prize.

## Hard gates

- Final submission: 2026-08-19 05:00 Asia/Shanghai.
- Public open-source repository with a visible license and reproducible setup.
- Free functional demo available through 2026-09-16 05:00 Asia/Shanghai.
- Public YouTube or Vimeo demonstration shorter than three minutes.
- CockroachDB is the persistent memory layer and meaningfully uses at least two listed CockroachDB tools.
- Application is deployed on AWS and meaningfully uses at least one AWS service.
- English submission materials; honest disclosure of AI assistance and pre-existing work.

## Product thesis

Supply-chain teams lose time and money when an incident agent remembers recommendations but cannot prove whether a memory is current, who approved an action, or whether a timed-out request already committed. RecallOps makes memory a governed operational system rather than a chat transcript.

## Judge strategy

1. **Agentic Memory Design:** one CockroachDB transaction links incident state, application-append-only hash-linked event, semantic memory, action proposal, provenance, and outbox receipt.
2. **Technological Implementation:** tenant-and-lifecycle-prefixed cosine vector retrieval with live plan proof, serializable retry handling, request-bound idempotency, row-level TTL, and a fail-closed read-only MCP audit path.
3. **Real-World Impact:** prevent duplicate purchase holds, repeated bad reroutes, and context loss between shift handoffs.
4. **Product Readiness:** approval gates, compensation, fault injection, health evidence, least privilege, budget-aware AWS design, and deterministic fallback behavior.
5. **Creativity & Originality:** the demo proves forgetting, revocation, recovery, and cross-session continuity—not merely “RAG over incident notes.”

## Acceptance scenarios

- Same idempotency key submitted 25 times creates one incident and one action set.
- Concurrent analysts cannot approve conflicting actions without a version conflict or retry.
- Revoked and expired memories disappear from semantic retrieval while their audit history remains.
- A fault injected after commit but before response is reconciled without duplicate effects.
- A fresh session retrieves the prior incident, its provenance, and the reason an action was taken.
- CockroachDB vector query plan and live MCP audit are captured as evidence.
- AWS Lambda invocation and S3 decision receipt are captured as evidence.

## Stop conditions

Do not claim cloud deployment, Managed MCP use, online availability, or final submission until a corresponding live receipt exists. Do not enter an AI disclosure field, legal affidavit, paid resource confirmation, or final Devpost submit action without the user at the minimum required step.
