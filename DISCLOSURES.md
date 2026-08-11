# Disclosures

## AI assistance

OpenAI Codex was used as the primary engineering assistant for research, architecture, implementation, testing, documentation, and submission preparation. The entrant directed the product goal and is responsible for reviewing, validating, and submitting the final work. AI output is not treated as evidence until independently executed or checked.

## Pre-existing work

No pre-existing entrant project code is incorporated. The competition workspace template and standard open-source dependencies are generic tooling, not prior product functionality. RecallOps product code is being created during the submission period.

## Third-party software

Dependencies are used under their respective licenses and will be listed in the locked dependency manifests. CockroachDB documentation and the CockroachDB Agent Skills repository inform implementation but are not claimed as entrant-authored work.

## Data

The demonstration uses synthetic suppliers, shipments, incidents, and outcomes created for this project. No confidential supply-chain or personal data is included.

## Models

The baseline uses a deterministic local 64-dimensional embedding and deterministic safety playbooks so the demo can fail safely without paid model access. The cloud configuration can use Amazon Bedrock (`amazon.nova-lite-v1:0`) to tailor a synopsis and reversible action proposals. Bedrock output is schema-checked, cannot execute actions, and falls back to the safety playbook on failure. A live-model claim will be added only after a verified invocation receipt exists.
