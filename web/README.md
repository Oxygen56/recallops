# RecallOps web

Judge-facing interface for RecallOps, the reversible supply-chain incident memory agent.

## Run locally

```bash
npm ci
npm run dev
```

The interface uses `VITE_API_BASE_URL` at build time and otherwise connects to `http://localhost:8787` for local development. Public builds must set the variable to the verified Lambda URL.

## Quality gate

```bash
npm run lint
npm test
```

The test gate builds the production worker and verifies the server-rendered judge experience, accessibility labels, social metadata, and removal of starter content.

The demo contains synthetic operational data only. It never executes an external supply-chain action automatically.
