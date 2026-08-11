# Security and abuse boundary

- The demo uses synthetic data only and stores no personal or confidential supply-chain records.
- All operational actions remain proposals until an explicit human approval transition.
- Tenant identifiers participate in primary keys, unique constraints, vector prefixes, and every repository query.
- Idempotency keys and revision checks protect against retries, ambiguous commits, and concurrent approvals.
- Memory provenance, expiry, revocation, restoration, and hash-linked events remain inspectable.
- Managed MCP uses a cluster-scoped service account and a hardcoded read-only tool allowlist. Secrets are never returned by the API.
- The S3 bucket is private, encrypted, blocks public ACLs and policies, denies insecure transport, and expires demo receipts after 45 days.
- Lambda concurrency is capped for the public judge demo. CockroachDB and AWS credentials are supplied only at deployment time and are excluded from source control.
- Bedrock output is schema-checked, limited to reversible low/medium-risk proposals, and cannot mark an action executed. Invalid or unavailable model output falls back safely.

## Known dependency note

The Sites build framework currently pins `image-size@2.0.2`, which has denial-of-service advisories for parsing hostile ICNS/JXL/HEIF files. RecallOps has no image upload or image parsing endpoint, and the dependency is not given user-controlled image bytes. The residual advisory is documented instead of forcing an incompatible framework downgrade.
