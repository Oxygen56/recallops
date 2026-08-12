# Security and abuse boundary

AWS controls below describe the implemented SAM template and verification gates. They are not claimed as live account controls until an AWS deployment receipt is captured.

- Seed data and project-owned evidence are synthetic. The public demo UI must be labeled accordingly, and visitors must not enter personal or confidential supply-chain data; public rows require a retention cleanup before launch.
- All operational actions remain proposals until an explicit human approval transition.
- Tenant identifiers participate in primary keys, unique constraints, vector prefixes, and every repository query.
- Idempotency keys and revision checks protect against retries, ambiguous commits, and concurrent approvals.
- Memory provenance, expiry, revocation, restoration, and hash-linked events remain inspectable.
- RecallOps accesses Managed MCP with a cluster-scoped credential and enforces the current eight-tool read-only allowlist in its client. Five project-critical reads, including `explain_query`, must return successful and semantically valid responses before the audit is marked verified; secrets and raw query results are never returned by the public API. This does not claim that the credential or MCP server is intrinsically read-only.
- The SAM template configures a private encrypted S3 bucket, blocks public ACLs and policies, denies insecure transport, and expires demo receipts after 45 days.
- The public API is restricted to the synthetic demo tenant. Database-backed hourly quotas cover every write/evaluation/audit path, and a CockroachDB lease prevents parallel safety gates across Lambda instances. Lambda concurrency is capped. Public launch still requires protected destructive endpoints and account-level throttling.
- Schema migration uses an administrator connection only during deployment. Lambda must connect as `recallops_runtime`, whose admin membership is revoked and whose grants are limited to the eight RecallOps tables. Deployment rejects root/admin users, non-cloud hosts, TLS modes weaker than `verify-full`, and local certificate paths; deployment verification must also re-audit the live runtime grants.
- CockroachDB and AWS credentials are supplied only at deployment time and are excluded from source control. Bedrock is opt-in so an accidental deployment cannot create model-inference spend.
- Bedrock output is schema-checked, limited to reversible low/medium-risk proposals, and cannot mark an action executed. Invalid or unavailable model output falls back safely.

## Known dependency note

The Sites build framework currently pins `image-size@2.0.2`, which has denial-of-service advisories for parsing hostile ICNS/JXL/HEIF files. RecallOps has no image upload or image parsing endpoint, and the dependency is not given user-controlled image bytes. The residual advisory is documented instead of forcing an incompatible framework downgrade.
