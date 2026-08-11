#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RECALLOPS_API_URL:-}" ]]; then
  echo "RECALLOPS_API_URL is required." >&2
  exit 2
fi
api_url="${RECALLOPS_API_URL%/}"
health="$(curl --fail --silent --show-error "$api_url/health")"
evidence="$(curl --fail --silent --show-error "$api_url/v1/evidence?tenantId=demo-logistics")"

node -e '
const health = JSON.parse(process.argv[1]);
const evidence = JSON.parse(process.argv[2]);
if (health.status !== "ok") throw new Error("Cloud API health failed");
if (health.awsReceiptSink !== "amazon-s3") throw new Error("S3 sink is not active");
if (!String(evidence.vectorIndex).includes("active")) throw new Error("Vector index is not active");
console.log(JSON.stringify({ status: "verified", verifiedAt: new Date().toISOString(), health, evidence }, null, 2));
' "$health" "$evidence"
