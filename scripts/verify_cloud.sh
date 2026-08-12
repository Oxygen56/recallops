#!/usr/bin/env bash
set -euo pipefail
umask 077

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
evidence_output="$project_dir/artifacts/evidence/cloud-aws.json"
aws_region="${AWS_REGION:-${REGION:-}}"

for required_name in STACK_NAME; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "$required_name is required." >&2
    exit 2
  fi
done
if [[ -z "$aws_region" ]]; then
  echo "AWS_REGION (or REGION) is required." >&2
  exit 2
fi
for command_name in curl aws node git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done
if [[ "${MCP_EXPECTED:-0}" == "1" ]]; then
  echo "Managed MCP evidence must be captured offline with a temporary key; it is intentionally absent from the public Lambda." >&2
  exit 2
fi

source_commit="$(git -C "$project_dir" rev-parse HEAD)"
source_tree="$(git -C "$project_dir" rev-parse 'HEAD^{tree}')"
dirty_source="$(git -C "$project_dir" status --porcelain=v1 --untracked-files=all | awk 'substr($0, 4) !~ /^artifacts\/evidence\// { print; exit }')"
if [[ -n "$dirty_source" ]]; then
  echo "Refusing to issue cloud evidence for a dirty source tree. Commit source changes first; evidence files may remain uncommitted." >&2
  exit 2
fi

verify_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/recallops-cloud-verify.XXXXXX")"
trap 'rm -rf -- "$verify_tmp_dir"' EXIT
mkdir -p "$(dirname "$evidence_output")"

# Query only stack identity, state, and outputs. Parameters are intentionally excluded
# because DatabaseUrl is a NoEcho secret.
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$aws_region" \
  --query 'Stacks[0].{StackId:StackId,StackName:StackName,StackStatus:StackStatus,Outputs:Outputs}' \
  --output json > "$verify_tmp_dir/stack.json"

STACK_JSON="$verify_tmp_dir/stack.json" RESOLVED_JSON="$verify_tmp_dir/resolved-stack.json" node <<'NODE'
const fs = require("fs");
const stack = JSON.parse(fs.readFileSync(process.env.STACK_JSON, "utf8"));
if (!stack || typeof stack !== "object") throw new Error("CloudFormation stack was not found.");
if (!/^(CREATE|UPDATE)_COMPLETE$/.test(String(stack.StackStatus ?? ""))) {
  throw new Error(`CloudFormation stack is not stable: ${stack.StackStatus ?? "missing"}.`);
}
const outputs = Object.fromEntries((stack.Outputs ?? []).map((item) => [item.OutputKey, item.OutputValue]));
for (const key of ["ApiUrl", "EvidenceBucketName", "FunctionName"]) {
  if (!outputs[key]) throw new Error(`CloudFormation output ${key} is missing.`);
}
fs.writeFileSync(process.env.RESOLVED_JSON, JSON.stringify({
  stackId: stack.StackId,
  stackName: stack.StackName,
  stackStatus: stack.StackStatus,
  apiUrl: String(outputs.ApiUrl).replace(/\/+$/, ""),
  evidenceBucket: outputs.EvidenceBucketName,
  functionName: outputs.FunctionName,
}));
NODE

api_url="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).apiUrl" "$verify_tmp_dir/resolved-stack.json")"
evidence_bucket="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).evidenceBucket" "$verify_tmp_dir/resolved-stack.json")"
function_name="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).functionName" "$verify_tmp_dir/resolved-stack.json")"

if [[ -n "${RECALLOPS_API_URL:-}" && "${RECALLOPS_API_URL%/}" != "$api_url" ]]; then
  echo "RECALLOPS_API_URL does not match the selected CloudFormation stack output." >&2
  exit 2
fi
if [[ -n "${EVIDENCE_BUCKET:-}" && "$EVIDENCE_BUCKET" != "$evidence_bucket" ]]; then
  echo "EVIDENCE_BUCKET does not match the selected CloudFormation stack output." >&2
  exit 2
fi

# Persist only the account number in the temporary directory. The public receipt
# contains a one-way hash, never the raw account ID or caller ARN.
aws sts get-caller-identity \
  --region "$aws_region" \
  --query Account \
  --output text > "$verify_tmp_dir/account-id.txt"

# Lambda queries use explicit projections so Environment.Variables (including the
# CockroachDB URL) can never reach stdout, temporary files, or the evidence receipt.
aws lambda get-function \
  --function-name "$function_name" \
  --region "$aws_region" \
  --query 'Configuration.{FunctionName:FunctionName,Runtime:Runtime,Architectures:Architectures,CodeSha256:CodeSha256,LastModified:LastModified,State:State,LastUpdateStatus:LastUpdateStatus,Timeout:Timeout,MemorySize:MemorySize,TracingMode:TracingConfig.Mode}' \
  --output json > "$verify_tmp_dir/lambda.json"
aws lambda get-function-url-config \
  --function-name "$function_name" \
  --region "$aws_region" \
  --query '{FunctionUrl:FunctionUrl,AuthType:AuthType,Cors:Cors,CreationTime:CreationTime,LastModifiedTime:LastModifiedTime}' \
  --output json > "$verify_tmp_dir/function-url.json"

aws s3api get-public-access-block \
  --bucket "$evidence_bucket" \
  --region "$aws_region" \
  --query 'PublicAccessBlockConfiguration.{BlockPublicAcls:BlockPublicAcls,IgnorePublicAcls:IgnorePublicAcls,BlockPublicPolicy:BlockPublicPolicy,RestrictPublicBuckets:RestrictPublicBuckets}' \
  --output json > "$verify_tmp_dir/s3-public-block.json"
aws s3api get-bucket-encryption \
  --bucket "$evidence_bucket" \
  --region "$aws_region" \
  --query 'ServerSideEncryptionConfiguration.Rules[].{SSEAlgorithm:ApplyServerSideEncryptionByDefault.SSEAlgorithm}' \
  --output json > "$verify_tmp_dir/s3-encryption.json"
aws s3api get-bucket-lifecycle-configuration \
  --bucket "$evidence_bucket" \
  --region "$aws_region" \
  --query '{Rules:Rules[].{ID:ID,Status:Status,ExpirationDays:Expiration.Days}}' \
  --output json > "$verify_tmp_dir/s3-lifecycle.json"
aws s3api get-bucket-policy-status \
  --bucket "$evidence_bucket" \
  --region "$aws_region" \
  --query 'PolicyStatus.{IsPublic:IsPublic}' \
  --output json > "$verify_tmp_dir/s3-policy-status.json"

scenario_id="$(node -e 'console.log(crypto.randomUUID())')"
idempotency_key="cloud-fault-$scenario_id"
cors_origin="https://judge.recallops.example"

options_status="$(curl --silent --show-error --max-time 28 \
  --output "$verify_tmp_dir/options.body" \
  --dump-header "$verify_tmp_dir/options.headers" \
  --write-out '%{http_code}' \
  --request OPTIONS "$api_url/v1/incidents" \
  --header "Origin: $cors_origin" \
  --header 'Access-Control-Request-Method: POST' \
  --header 'Access-Control-Request-Headers: content-type,idempotency-key,x-recallops-fault')"
if [[ "$options_status" != "200" && "$options_status" != "204" ]]; then
  echo "CORS preflight failed with HTTP $options_status." >&2
  exit 1
fi

health_status="$(curl --silent --show-error --max-time 28 \
  --output "$verify_tmp_dir/health.json" \
  --dump-header "$verify_tmp_dir/health.headers" \
  --write-out '%{http_code}' \
  --header "Origin: $cors_origin" \
  "$api_url/health")"
if [[ "$health_status" != "200" ]]; then
  echo "Cloud API health failed with HTTP $health_status." >&2
  exit 1
fi
curl --fail --silent --show-error --max-time 28 \
  "$api_url/v1/evidence?tenantId=demo-logistics" > "$verify_tmp_dir/evidence.json"

VERIFY_SCENARIO_ID="$scenario_id" node -e '
process.stdout.write(JSON.stringify({
  tenantId: "demo-logistics",
  supplier: "HarborLine Logistics",
  shipmentRef: `CLOUD-${process.env.VERIFY_SCENARIO_ID.slice(0, 8)}`,
  category: "delay",
  severity: 4,
  summary: "Cloud verification injects a lost response after commit and requires an idempotent recovery.",
  sessionId: "cloud-verification-session",
  actor: "cloud-verification-operator"
}));
' > "$verify_tmp_dir/command.json"

fault_status="$(curl --silent --show-error --max-time 28 \
  --output "$verify_tmp_dir/fault.json" --write-out '%{http_code}' \
  --request POST "$api_url/v1/incidents" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $idempotency_key" \
  --header 'x-recallops-fault: after-commit' \
  --data-binary "@$verify_tmp_dir/command.json")"
if [[ "$fault_status" != "503" ]]; then
  echo "Expected injected post-commit response loss to return HTTP 503; received $fault_status." >&2
  exit 1
fi

replay_status="$(curl --silent --show-error --max-time 58 \
  --output "$verify_tmp_dir/replay.json" \
  --dump-header "$verify_tmp_dir/replay.headers" \
  --write-out '%{http_code}' \
  --request POST "$api_url/v1/incidents" \
  --header "Origin: $cors_origin" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $idempotency_key" \
  --data-binary "@$verify_tmp_dir/command.json")"
if [[ "$replay_status" != "200" ]]; then
  echo "Cloud idempotent replay failed with HTTP $replay_status." >&2
  exit 1
fi

incident_id="$(VERIFY_JSON="$verify_tmp_dir/replay.json" node -e '
const value = JSON.parse(require("fs").readFileSync(process.env.VERIFY_JSON, "utf8"));
if (!value.incident?.incidentId) throw new Error("Cloud replay did not return an incident ID.");
process.stdout.write(value.incident.incidentId);
')"
receipt_key="decisions/demo-logistics/$incident_id/v1.json"

curl --fail --silent --show-error --max-time 28 \
  "$api_url/v1/incidents/$incident_id/timeline?tenantId=demo-logistics" > "$verify_tmp_dir/timeline.json"
curl --fail --silent --show-error --max-time 115 \
  --request POST "$api_url/v1/evaluations/safety" > "$verify_tmp_dir/evaluation.json"
curl --fail --silent --show-error --max-time 28 \
  --request POST "$api_url/v1/evidence/flush" \
  --header 'content-type: application/json' \
  --data '{"tenantId":"demo-logistics"}' > "$verify_tmp_dir/flush.json"

aws s3api get-object \
  --bucket "$evidence_bucket" \
  --key "$receipt_key" \
  --region "$aws_region" \
  --query '{ETag:ETag,ContentLength:ContentLength,ServerSideEncryption:ServerSideEncryption,Metadata:Metadata}' \
  --output json \
  "$verify_tmp_dir/receipt.json" > "$verify_tmp_dir/s3-object.json"

aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/$function_name" \
  --region "$aws_region" \
  --query 'logGroups[].{LogGroupName:logGroupName,RetentionInDays:retentionInDays,StoredBytes:storedBytes}' \
  --output json > "$verify_tmp_dir/log-groups.json"

VERIFY_DIR="$verify_tmp_dir" \
VERIFY_OUTPUT="$evidence_output" \
VERIFY_REGION="$aws_region" \
VERIFY_SOURCE_COMMIT="$source_commit" \
VERIFY_SOURCE_TREE="$source_tree" \
VERIFY_OPTIONS_STATUS="$options_status" \
VERIFY_HEALTH_STATUS="$health_status" \
VERIFY_REPLAY_STATUS="$replay_status" \
VERIFY_FAULT_STATUS="$fault_status" \
VERIFY_RECEIPT_KEY="$receipt_key" \
VERIFY_BEDROCK_EXPECTED="${BEDROCK_EXPECTED:-0}" \
node <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const root = process.env.VERIFY_DIR;
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizeUrl = (value) => String(value ?? "").replace(/\/+$/, "");
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
};
const canonicalJson = (value) => JSON.stringify(stable(value));
const headerValues = (name) => {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  const headers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(key, [...(headers.get(key) ?? []), value]);
  }
  return headers;
};
const requireSingleOrigin = (name) => {
  const headers = headerValues(name);
  const origins = headers.get("access-control-allow-origin") ?? [];
  if (origins.length !== 1 || origins[0] !== "*") {
    throw new Error(`${name} must contain exactly one Access-Control-Allow-Origin: * header.`);
  }
  return headers;
};

const stack = load("resolved-stack.json");
const lambda = load("lambda.json");
const functionUrl = load("function-url.json");
const publicBlock = load("s3-public-block.json");
const bucketEncryption = load("s3-encryption.json");
const lifecycle = load("s3-lifecycle.json");
const policyStatus = load("s3-policy-status.json");
const logs = load("log-groups.json");
const health = load("health.json");
const evidence = load("evidence.json");
const fault = load("fault.json");
const replay = load("replay.json");
const timeline = load("timeline.json");
const evaluation = load("evaluation.json");
const flush = load("flush.json");
const s3Object = load("s3-object.json");
const receipt = load("receipt.json");

if (lambda.FunctionName !== stack.functionName) throw new Error("Lambda function does not match the stack output.");
if (lambda.Runtime !== "nodejs22.x") throw new Error(`Unexpected Lambda runtime: ${lambda.Runtime}.`);
if (!Array.isArray(lambda.Architectures) || lambda.Architectures.length !== 1 || lambda.Architectures[0] !== "arm64") {
  throw new Error("Lambda architecture is not the expected arm64 singleton.");
}
if (!lambda.CodeSha256 || lambda.State !== "Active" || lambda.LastUpdateStatus !== "Successful") {
  throw new Error("Lambda code identity or deployment state is not verified.");
}
if (Number(lambda.Timeout) < 90 || Number(lambda.MemorySize) !== 512 || lambda.TracingMode !== "PassThrough") {
  throw new Error("Lambda timeout, memory, or tracing configuration does not match the bounded deployment.");
}
if (functionUrl.AuthType !== "NONE" || normalizeUrl(functionUrl.FunctionUrl) !== stack.apiUrl) {
  throw new Error("Lambda Function URL does not match the unauthenticated stack output.");
}
if (functionUrl.Cors && Object.keys(functionUrl.Cors).length > 0) {
  throw new Error("Lambda Function URL CORS must be unset so the application is the single CORS layer.");
}

if (!["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"].every((key) => publicBlock[key] === true)) {
  throw new Error("S3 public access block is incomplete.");
}
if (!Array.isArray(bucketEncryption) || !bucketEncryption.some((rule) => rule.SSEAlgorithm === "AES256")) {
  throw new Error("S3 default AES256 encryption is missing.");
}
const expiryRule = lifecycle.Rules?.find((rule) => rule.ID === "expire-demo-receipts");
if (!expiryRule || expiryRule.Status !== "Enabled" || Number(expiryRule.ExpirationDays) !== 45) {
  throw new Error("S3 45-day receipt lifecycle is missing.");
}
if (policyStatus.IsPublic !== false) throw new Error("S3 bucket policy is public.");
const logGroup = logs.find((item) => item.LogGroupName === `/aws/lambda/${stack.functionName}`);
if (!logGroup || Number(logGroup.RetentionInDays) !== 30) throw new Error("CloudWatch log retention is not 30 days.");

const optionsHeaders = requireSingleOrigin("options.headers");
requireSingleOrigin("health.headers");
requireSingleOrigin("replay.headers");
const allowedMethods = (optionsHeaders.get("access-control-allow-methods") ?? []).join(",").toLowerCase();
for (const method of ["get", "post", "options"]) {
  if (!allowedMethods.split(",").map((item) => item.trim()).includes(method)) throw new Error(`CORS preflight omitted ${method.toUpperCase()}.`);
}
const allowedHeaders = (optionsHeaders.get("access-control-allow-headers") ?? []).join(",").toLowerCase();
for (const header of ["content-type", "idempotency-key", "x-recallops-fault"]) {
  if (!allowedHeaders.split(",").map((item) => item.trim()).includes(header)) throw new Error(`CORS preflight omitted ${header}.`);
}

if (Number(process.env.VERIFY_OPTIONS_STATUS) !== 204 && Number(process.env.VERIFY_OPTIONS_STATUS) !== 200) {
  throw new Error("CORS preflight status failed.");
}
if (Number(process.env.VERIFY_HEALTH_STATUS) !== 200 || health.status !== "ok") throw new Error("Cloud API health failed.");
if (health.source?.commit !== process.env.VERIFY_SOURCE_COMMIT || health.source?.tree !== process.env.VERIFY_SOURCE_TREE) {
  throw new Error("Cloud API source identity does not match the verified Git commit and tree.");
}
if (health.awsReceiptSink !== "amazon-s3") throw new Error("Amazon S3 receipt sink is not active.");
if (!String(evidence.vectorIndex).includes("active")) throw new Error("Vector index is not present.");
if (process.env.VERIFY_FAULT_STATUS !== "503") throw new Error("Lost-response fault did not return 503.");
if (process.env.VERIFY_REPLAY_STATUS !== "200" || !replay.idempotentReplay || replay.incident?.incidentId !== fault.committedIncidentId) {
  throw new Error("Cloud replay did not reconcile the committed incident.");
}
if (evaluation.total !== 10 || evaluation.passed !== 10 || !evaluation.checks?.every((check) => check.passed === true)) {
  throw new Error(`Operational memory gate failed: ${evaluation.passed}/${evaluation.total}.`);
}
if (!evaluation.cleanupVerified || evaluation.remainingRowsAfterCleanup !== 0) {
  throw new Error("Evaluation tenant cleanup was not verified.");
}
if (evaluation.vectorIndex !== "memory_semantic_idx:cosine-vector-search") {
  throw new Error("Cosine distributed vector plan was not verified.");
}
if (flush.failed !== 0 || flush.published < 1) throw new Error("S3 receipt publication failed.");

if (s3Object.ServerSideEncryption !== "AES256" || s3Object.Metadata?.schema !== "recallops-receipt-v1") {
  throw new Error("S3 receipt encryption or schema metadata is missing.");
}
if (receipt.schema !== "recallops.decision-receipt.v1" || receipt.incident?.incidentId !== replay.incident.incidentId) {
  throw new Error("Downloaded S3 receipt does not match the replayed incident.");
}
const receiptEvent = timeline.events?.find((event) => event.eventId === receipt.event?.id);
if (!receiptEvent || receiptEvent.eventHash !== receipt.event.hash || receiptEvent.previousHash !== receipt.event.previousHash) {
  throw new Error("Downloaded S3 receipt does not match the CockroachDB timeline event.");
}
const recomputedEventHash = hash(canonicalJson({
  tenantId: "demo-logistics",
  aggregateId: receiptEvent.aggregateId,
  version: receiptEvent.version,
  eventType: receiptEvent.eventType,
  payload: receiptEvent.payload,
  previousHash: receiptEvent.previousHash,
  actor: receiptEvent.actor,
  sessionId: receiptEvent.sessionId,
  idempotencyKey: receiptEvent.idempotencyKey,
}));
if (recomputedEventHash !== receiptEvent.eventHash) throw new Error("Receipt event hash did not recompute.");

const reasoningProvider = replay.memory?.provenance?.reasoningProvider;
if (process.env.VERIFY_BEDROCK_EXPECTED === "1" && reasoningProvider !== "amazon-bedrock") {
  throw new Error(`Bedrock was expected but provider was ${reasoningProvider ?? "missing"}.`);
}

const accountId = fs.readFileSync(path.join(root, "account-id.txt"), "utf8").trim();
const stackIdSuffix = String(stack.stackId).split("/").at(-1).slice(-12);
const receiptBody = fs.readFileSync(path.join(root, "receipt.json"));
const result = {
  schema: "recallops.cloud-aws-evidence.v1",
  verifiedAt: new Date().toISOString(),
  sourceCommit: process.env.VERIFY_SOURCE_COMMIT,
  sourceTree: process.env.VERIFY_SOURCE_TREE,
  sourceWorktreeCleanExceptEvidence: true,
  stackSuffix: stackIdSuffix,
  aws: {
    accountIdSha256Prefix: hash(accountId).slice(0, 12),
    region: process.env.VERIFY_REGION,
    stack: { idSuffix: stackIdSuffix, status: stack.stackStatus },
    lambda: {
      functionNameSha256Prefix: hash(stack.functionName).slice(0, 12),
      runtime: lambda.Runtime,
      architectures: lambda.Architectures,
      codeSha256: lambda.CodeSha256,
      lastModified: lambda.LastModified,
      state: lambda.State,
      lastUpdateStatus: lambda.LastUpdateStatus,
      timeoutSeconds: Number(lambda.Timeout),
      memoryMb: Number(lambda.MemorySize),
      tracingMode: lambda.TracingMode,
    },
    functionUrl: { url: stack.apiUrl, authType: functionUrl.AuthType, corsLayer: "application-only" },
    s3: {
      bucketNameSha256Prefix: hash(stack.evidenceBucket).slice(0, 12),
      publicAccessBlocked: true,
      bucketPolicyPublic: false,
      defaultEncryption: "AES256",
      receiptExpirationDays: 45,
      receipt: {
        key: process.env.VERIFY_RECEIPT_KEY,
        etag: s3Object.ETag,
        contentLength: Number(s3Object.ContentLength),
        encryption: s3Object.ServerSideEncryption,
        bodySha256: hash(receiptBody),
        schema: receipt.schema,
        incidentId: receipt.incident.incidentId,
        eventId: receipt.event.id,
        eventHash: receipt.event.hash,
      },
    },
    cloudWatchLogs: { retentionDays: Number(logGroup.RetentionInDays) },
  },
  application: {
    deployedSource: health.source,
    cors: {
      optionsStatus: Number(process.env.VERIFY_OPTIONS_STATUS),
      getStatus: Number(process.env.VERIFY_HEALTH_STATUS),
      postStatus: Number(process.env.VERIFY_REPLAY_STATUS),
      accessControlAllowOrigin: "*",
      singleHeaderPerResponse: true,
    },
    faultRecovery: "http-503-then-idempotent-replay",
    operationalMemoryGate: `${evaluation.passed}/${evaluation.total}`,
    cleanupRows: evaluation.remainingRowsAfterCleanup,
    vectorIndex: evaluation.vectorIndex,
    databaseVersion: evaluation.databaseVersion,
    reasoningProvider,
    managedMcp: "offline-evidence-only",
  },
};
fs.writeFileSync(process.env.VERIFY_OUTPUT, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(process.env.VERIFY_OUTPUT, 0o600);
NODE

echo "AWS verification passed. Evidence: $evidence_output"
