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
if [[ -n "${MCP_SERVICE_ACCOUNT_API_KEY:-}${MCP_CLUSTER_ID:-}" ]]; then
  echo "Refusing to place a cluster-operator MCP credential in the public Lambda environment. Run MCP evidence capture offline with a temporary key." >&2
  exit 2
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required and must be the least-privileged CockroachDB Cloud runtime URL." >&2
  exit 2
fi
if [[ ! "${EXPECTED_AWS_ACCOUNT_ID:-}" =~ ^[0-9]{12}$ ]]; then
  echo "EXPECTED_AWS_ACCOUNT_ID must be the exact 12-digit account reviewed for this deployment." >&2
  exit 2
fi

source_commit="$(git -C "$project_dir" rev-parse HEAD)"
source_tree="$(git -C "$project_dir" rev-parse 'HEAD^{tree}')"
dirty_source="$(git -C "$project_dir" status --porcelain=v1 --untracked-files=all | awk 'substr($0, 4) !~ /^artifacts\/evidence\// { print; exit }')"
if [[ -n "$dirty_source" ]]; then
  echo "Refusing to deploy a dirty source tree. Commit source changes first; evidence files may remain uncommitted." >&2
  exit 2
fi

DATABASE_URL="$DATABASE_URL" node <<'NODE'
const raw = process.env.DATABASE_URL;
let url;
try {
  url = new URL(raw);
} catch {
  throw new Error("DATABASE_URL is not a valid URL.");
}
if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
  throw new Error("DATABASE_URL must use postgresql://.");
}
if (!url.hostname.endsWith(".cockroachlabs.cloud")) {
  throw new Error("DATABASE_URL must point to a CockroachDB Cloud hostname.");
}
if (decodeURIComponent(url.username) !== "recallops_runtime") {
  throw new Error("DATABASE_URL must use the least-privileged recallops_runtime SQL user.");
}
if (url.pathname !== "/recallops") {
  throw new Error("DATABASE_URL must select the recallops database.");
}
if (url.searchParams.get("sslmode") !== "verify-full") {
  throw new Error("DATABASE_URL must set sslmode=verify-full.");
}
if (url.searchParams.has("sslrootcert")) {
  throw new Error("Remove sslrootcert from DATABASE_URL; Lambda cannot use a local certificate path.");
}
if (decodeURIComponent(url.password).length < 20) {
  throw new Error("DATABASE_URL password must contain at least 20 characters.");
}
NODE

current_account_id="$(aws sts get-caller-identity --query Account --output text)"
if [[ "$current_account_id" != "$EXPECTED_AWS_ACCOUNT_ID" ]]; then
  echo "AWS account mismatch. Refusing to deploy outside the explicitly reviewed account." >&2
  exit 2
fi
available_concurrency="$(aws lambda get-account-settings \
  --region "${AWS_REGION:-us-east-1}" \
  --query 'AccountLimit.UnreservedConcurrentExecutions' \
  --output text)"
if [[ ! "$available_concurrency" =~ ^[0-9]+$ || "$available_concurrency" -lt 102 ]]; then
  echo "AWS account cannot safely reserve two Lambda executions without reducing the 100 unreserved minimum." >&2
  exit 2
fi
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
    "BedrockModelId=${BEDROCK_MODEL_ID:-}" \
    "SourceCommit=$source_commit" \
    "SourceTree=$source_tree"
