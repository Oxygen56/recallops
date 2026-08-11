#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_dir"
docker compose up -d cockroach

for attempt in $(seq 1 40); do
  if docker compose exec -T cockroach ./cockroach sql --insecure --host=localhost:26257 -e "SELECT 1" >/dev/null 2>&1; then
    echo "CockroachDB is ready on localhost:26257."
    exit 0
  fi
  sleep 1
done

echo "CockroachDB did not become ready within 40 seconds." >&2
exit 1
