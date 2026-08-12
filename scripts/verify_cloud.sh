#!/usr/bin/env bash
set -euo pipefail

for required_name in RECALLOPS_API_URL EVIDENCE_BUCKET; do
  if [[ -z "${!required_name:-}" ]]; then
    echo "$required_name is required." >&2
    exit 2
  fi
done
for command_name in curl aws node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 2
  fi
done

api_url="${RECALLOPS_API_URL%/}"
verify_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/recallops-cloud-verify.XXXXXX")"
trap 'rm -rf -- "$verify_tmp_dir"' EXIT
scenario_id="$(node -e 'console.log(crypto.randomUUID())')"
idempotency_key="cloud-fault-$scenario_id"

curl --fail --silent --show-error "$api_url/health" > "$verify_tmp_dir/health.json"
curl --fail --silent --show-error "$api_url/v1/evidence?tenantId=demo-logistics" > "$verify_tmp_dir/evidence.json"
curl --fail --silent --show-error --request POST "$api_url/v1/demo/reset" > "$verify_tmp_dir/reset.json"

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

curl --fail --silent --show-error --max-time 58 \
  --request POST "$api_url/v1/incidents" \
  --header 'content-type: application/json' \
  --header "idempotency-key: $idempotency_key" \
  --data-binary "@$verify_tmp_dir/command.json" > "$verify_tmp_dir/replay.json"

curl --fail --silent --show-error --max-time 115 \
  --request POST "$api_url/v1/evaluations/safety" > "$verify_tmp_dir/evaluation.json"

curl --fail --silent --show-error --max-time 28 \
  --request POST "$api_url/v1/evidence/flush" \
  --header 'content-type: application/json' \
  --data '{"tenantId":"demo-logistics"}' > "$verify_tmp_dir/flush.json"

incident_id="$(VERIFY_JSON="$verify_tmp_dir/replay.json" node -e '
const value = JSON.parse(require("fs").readFileSync(process.env.VERIFY_JSON, "utf8"));
if (!value.incident?.incidentId) throw new Error("Cloud replay did not return an incident ID.");
process.stdout.write(value.incident.incidentId);
')"
receipt_key="decisions/demo-logistics/$incident_id/v1.json"
aws s3api head-object --bucket "$EVIDENCE_BUCKET" --key "$receipt_key" > "$verify_tmp_dir/s3-head.json"

if [[ "${MCP_EXPECTED:-0}" == "1" ]]; then
  curl --fail --silent --show-error --max-time 28 \
    --request POST "$api_url/v1/mcp/audit" > "$verify_tmp_dir/mcp.json"
fi

VERIFY_DIR="$verify_tmp_dir" \
VERIFY_FAULT_STATUS="$fault_status" \
VERIFY_RECEIPT_KEY="$receipt_key" \
VERIFY_BEDROCK_EXPECTED="${BEDROCK_EXPECTED:-0}" \
VERIFY_MCP_EXPECTED="${MCP_EXPECTED:-0}" \
node <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.env.VERIFY_DIR;
const load = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const health = load("health.json");
const evidence = load("evidence.json");
const reset = load("reset.json");
const fault = load("fault.json");
const replay = load("replay.json");
const evaluation = load("evaluation.json");
const flush = load("flush.json");
const s3 = load("s3-head.json");

if (health.status !== "ok") throw new Error("Cloud API health failed.");
if (health.awsReceiptSink !== "amazon-s3") throw new Error("Amazon S3 receipt sink is not active.");
if (reset.status !== "reset" || reset.tenantId !== "demo-logistics") throw new Error("Demo reset failed.");
if (!String(evidence.vectorIndex).includes("active")) throw new Error("Vector index is not present.");
if (process.env.VERIFY_FAULT_STATUS !== "503") throw new Error("Lost-response fault did not return 503.");
if (!replay.idempotentReplay || replay.incident?.incidentId !== fault.committedIncidentId) {
  throw new Error("Cloud replay did not reconcile the committed incident.");
}
if (evaluation.total !== 10 || evaluation.passed !== 10 ||
    !evaluation.checks?.every((check) => check.passed === true)) {
  throw new Error(`Operational memory gate failed: ${evaluation.passed}/${evaluation.total}.`);
}
if (!evaluation.cleanupVerified || evaluation.remainingRowsAfterCleanup !== 0) {
  throw new Error("Evaluation tenant cleanup was not verified.");
}
if (evaluation.vectorIndex !== "memory_semantic_idx:cosine-vector-search") {
  throw new Error("Cosine distributed vector plan was not verified.");
}
if (flush.failed !== 0 || flush.published < 1) throw new Error("S3 receipt publication failed.");
if (s3.ServerSideEncryption !== "AES256" || s3.Metadata?.schema !== "recallops-receipt-v1") {
  throw new Error("S3 receipt encryption or schema metadata is missing.");
}
const reasoningProvider = replay.memory?.provenance?.reasoningProvider;
if (process.env.VERIFY_BEDROCK_EXPECTED === "1" && reasoningProvider !== "amazon-bedrock") {
  throw new Error(`Bedrock was expected but provider was ${reasoningProvider ?? "missing"}.`);
}
let mcp;
if (process.env.VERIFY_MCP_EXPECTED === "1") {
  mcp = load("mcp.json");
  if (!mcp.verified || mcp.failedRequiredTools?.length !== 0) {
    throw new Error(`Managed MCP audit failed: ${(mcp.failedRequiredTools ?? []).join(", ")}.`);
  }
}

console.log(JSON.stringify({
  status: "verified",
  verifiedAt: new Date().toISOString(),
  incidentId: replay.incident.incidentId,
  faultRecovery: "http-503-then-idempotent-replay",
  operationalMemoryGate: `${evaluation.passed}/${evaluation.total}`,
  cleanupRows: evaluation.remainingRowsAfterCleanup,
  vectorIndex: evaluation.vectorIndex,
  databaseVersion: evaluation.databaseVersion,
  receiptKey: process.env.VERIFY_RECEIPT_KEY,
  receiptEncryption: s3.ServerSideEncryption,
  reasoningProvider,
  managedMcp: mcp ? "verified" : "not-requested"
}, null, 2));
NODE
