# RecallOps evaluation

## Release-gate result

- API: 10/10 automated tests passed against CockroachDB v26.2.0.
- Judge interface: lint passed; 2/2 server-rendering and accessibility tests passed.
- Failure scenario: all 7 assertions passed in `artifacts/evidence/local-demo.json`.
- Reproducible run: `full-local-gate-v2` completed successfully through the competition experiment ledger.
- Remote verification: GitHub Actions run `31535068834` passed the full database/API/interface gate on a clean Ubuntu runner.

## What is exercised

| Property | Test oracle |
| --- | --- |
| Ambiguous commit recovery | first response is 503 after commit; same key returns the same incident and action IDs |
| Idempotency | repeated command creates no duplicate aggregate |
| Concurrency | two approvals at revision 1 produce one success and one stale rejection |
| Revocation | revoked memory disappears from recall; restore returns it and writes both lifecycle events |
| Expiry | expired memory is excluded before physical TTL deletion |
| Cross-session continuity | a second shift retrieves the first shift's admitted memory |
| Evidence durability | transactional outbox flushes stable receipts without blocking the committed decision |
| Vector usage | the named distributed index is active and vector recall returns prior outcomes |
| Model boundary | model-derived action remains `proposed`, reversible, and human-approved |
| MCP boundary | only the five named read-only tools can execute; credentials never enter results |

## Limits

The current evidence is local. It does not yet prove CockroachDB Cloud latency, a live Managed MCP response, Bedrock invocation, S3 persistence, AWS Lambda availability, or public judge access. Those cells remain pending until redacted cloud receipts are captured.
