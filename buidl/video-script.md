# Three-minute demo script

Target runtime: 2:45. Spoken language: English. Show the live product, not slides, until the final architecture shot.

## 0:00–0:18 — Problem

“Supply-chain incidents cross shifts, systems, and retries. Chat history is not operational memory. RecallOps remembers the decision, proves recovery, and knows when evidence must be forgotten.”

Show the hero and the five live evidence counters.

## 0:18–0:58 — Ambiguous commit

Keep “Inject response loss after commit” enabled and submit the default port-delay incident.

“The transaction commits, but we intentionally lose the response. RecallOps retries with the same idempotency key and reconciles to the exact incident, memory, and action IDs—no duplicate side effect.”

Hold on the RECOVERED banner and the distributed-index ACTIVE badge.

## 0:58–1:28 — Cross-session action safety

Approve the first proposed action.

“The next shift can approve a reversible proposal at the expected revision. A concurrent stale approval is rejected. The model can propose, but it cannot execute or create a high-risk irreversible action.”

Show the state change and the new timeline event.

## 1:28–1:58 — Forgetting and audit

Revoke the admitted memory, then restore it.

“Revocation removes evidence from future vector recall immediately. We preserve the tombstone and hash-linked lifecycle events, so forgetting never means rewriting history. TTL handles later physical cleanup.”

## 1:58–2:25 — Sponsor stack

Scroll to the architecture.

“CockroachDB stores incident state, vector memory, revisions, events, and the outbox in one serializable contract. Distributed Vector Indexing powers recall. Managed MCP audits the live ledger read-only. AWS Lambda runs the API, S3 stores decision receipts, and Bedrock provides bounded reasoning with a deterministic fallback.”

## 2:25–2:45 — Proof and close

Show the test/evidence summary and return to the hero.

“RecallOps passes ten database and API tests, two interface tests, and seven end-to-end failure assertions. Memory that knows when to act—and when to forget.”

End card: RecallOps · public repository · live demo QR · Apache-2.0.
