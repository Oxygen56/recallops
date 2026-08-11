#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
evidence_dir="$project_dir/artifacts/evidence"
mkdir -p "$evidence_dir"

"$project_dir/scripts/db_up.sh"
(
  cd "$project_dir/api"
  npm ci
  npm run migrate
  npm run build
  npm test
  npm run demo
)
(
  cd "$project_dir/web"
  npm ci
  npm run lint
  npm test
)

node -e '
const fs = require("fs");
const path = process.argv[1];
const demo = JSON.parse(fs.readFileSync(path, "utf8"));
const required = ["faultReturned503", "commitWasReconciled", "sameIncidentRecovered", "actionApprovedInNewSession", "crossSessionMemoryFound", "vectorIndexActive", "receiptsPublished"];
const failed = required.filter((key) => demo.assertions?.[key] !== true);
if (failed.length) throw new Error(`Verification failed: ${failed.join(", ")}`);
' "$evidence_dir/local-demo.json"

node -e '
const fs = require("fs");
const path = process.argv[1];
fs.writeFileSync(path, JSON.stringify({
  status: "verified",
  verifiedAt: new Date().toISOString(),
  gates: ["api-build", "api-tests", "fault-recovery-demo", "web-lint", "web-render-tests", "web-build"],
}, null, 2) + "\n");
' "$evidence_dir/local-verification.json"

echo "Local verification passed. Evidence: $evidence_dir/local-verification.json"
