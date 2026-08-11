# RecallOps web

Judge-facing interface for RecallOps, the reversible supply-chain incident memory agent.

## Run locally

```bash
npm ci
npm run dev
```

The interface uses `NEXT_PUBLIC_API_BASE_URL` when configured and otherwise connects to `http://localhost:8787`.

## Quality gate

```bash
npm run lint
npm test
```

The test gate builds the production worker and verifies the server-rendered judge experience, accessibility labels, social metadata, and removal of starter content.

The demo contains synthetic operational data only. It never executes an external supply-chain action automatically.
