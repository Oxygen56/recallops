#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

if [[ "${DEPLOY_CONFIRM:-}" != "recallops-aws" ]]; then
  echo "Refusing cloud write. Set DEPLOY_CONFIRM=recallops-aws after reviewing account and cost." >&2
  exit 2
fi
for command_name in aws sam; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required and must point to CockroachDB Cloud." >&2
  exit 2
fi

aws sts get-caller-identity >/dev/null
(
  cd "$project_dir/api"
  npm ci
  npm run build
)
sam validate --lint --template-file "$project_dir/infra/template.yaml"
sam deploy \
  --template-file "$project_dir/infra/template.yaml" \
  --stack-name "${STACK_NAME:-recallops-demo}" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM \
  --confirm-changeset \
  --region "${AWS_REGION:-us-east-1}" \
  --parameter-overrides \
    "DatabaseUrl=$DATABASE_URL" \
    "McpClusterId=${MCP_CLUSTER_ID:-}" \
    "McpServiceAccountApiKey=${MCP_SERVICE_ACCOUNT_API_KEY:-}" \
    "BedrockModelId=${BEDROCK_MODEL_ID:-amazon.nova-lite-v1:0}"
