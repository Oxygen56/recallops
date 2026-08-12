# RecallOps web

Judge-facing interface for RecallOps, the reversible supply-chain incident memory agent.

## Run locally

```bash
npm ci
npm run dev
```

The interface uses `VITE_API_BASE_URL` at build time and otherwise connects to `http://localhost:8787` for local development. A public build must point this variable only to an API deployment with a captured live receipt; the implemented Lambda path is not presented as live until that receipt exists.

## Quality gate

```bash
npm run lint
npm test
```

The test gate builds the production worker and verifies the server-rendered judge experience, accessibility labels, social metadata, and removal of starter content.

The incident form requires a client-side confirmation that every submitted field is synthetic and contains no personal, confidential, or real supply-chain data. **Clear local view** resets only browser UI state; it does not delete shared database evidence. The demo never executes an external supply-chain action automatically.
