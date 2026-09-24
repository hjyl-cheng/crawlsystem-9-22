#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0

# Share the execution worktree's lock: no overlapping heavy checks on this host.
# Only this transient scope is limited; user slices and infrastructure are untouched.
exec 9>/tmp/crawlsystem-execution-check.lock
flock -n 9 || { echo 'Another crawler check is running; retry after it finishes.' >&2; exit 75; }
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$task_dir"
available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
if (( available_kib < 2621440 )); then
  echo 'Refusing check: less than 2.5 GiB available host memory.' >&2
  exit 75
fi

heap_mib=384
case "${1:-}" in
  lockfile) command=(npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund) ;;
  install) command=(npm ci --offline --no-audit --no-fund) ;;
  typecheck) heap_mib=800; command=(node node_modules/typescript/bin/tsc --noEmit) ;;
  unit) command=(node --import tsx --test --test-concurrency=1 packages/contracts/test/*.test.ts packages/http/test/*.test.ts apps/control-api/test/*.test.ts apps/console/tests/*.test.ts packages/execution-client/test/*.test.ts apps/execution-worker/test/*.test.ts) ;;
  execution-build) command=(npm run build:execution) ;;
  images) heap_mib=640; command=(node --import tsx scripts/dev/build-images.ts) ;;
  execution-temporal) command=(npm run test:temporal) ;;
  execution-live) command=(node --env-file=.runtime/main-joint.env --import tsx apps/execution-worker/scripts/live-with-dependencies.ts) ;;
  execution-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-execution-console.ts) ;;
  build-console) heap_mib=512; command=(npm run build:console) ;;
  browser) command=(npm run test:browser) ;;
  integration)
    command=(node "--env-file=${M1_CHECK_ENV_FILE:-.runtime/main.env}" --import tsx --test --test-concurrency=1 tests/integration/*.test.ts)
    ;;
  *) echo 'Usage: bash scripts/dev/check-safe.sh lockfile|install|typecheck|unit|build-console|browser|integration|execution-build|images|execution-temporal|execution-live|execution-browser' >&2; exit 64 ;;
esac

unit="crawlsystem-main-check-$$"
mkdir -p .runtime/main-checks
chmod 700 .runtime/main-checks
metrics=".runtime/main-checks/${1}-$$.tsv"
printf 'unix_seconds\tavailable_kib\tscope_memory_bytes\n' > "$metrics"
cleanup() { systemctl --user stop "$unit.scope" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Fail if the resource boundary cannot be established. A V8 heap cap alone does
# not cover browser children, native SDK allocations or other subprocesses.
systemd-run --user --scope --quiet --unit="$unit" \
  --property=MemoryAccounting=yes --property=MemoryHigh=768M --property=MemoryMax=1G \
  --property=MemorySwapMax=256M --property=CPUQuota=150% --property=TasksMax=256 \
  env NODE_OPTIONS="--max-old-space-size=$heap_mib" PG_POOL_MAX=2 \
  timeout --signal=TERM --kill-after=10s 300s "${command[@]}" &
runner=$!
while kill -0 "$runner" 2>/dev/null; do
  available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  used="$(systemctl --user show "$unit.scope" --property=MemoryCurrent --value 2>/dev/null || true)"
  printf '%s\t%s\t%s\n' "$(date +%s)" "$available_kib" "$used" >> "$metrics"
  if (( available_kib < 1572864 )); then
    echo 'Stopping this check: host available memory fell below 1.5 GiB.' >&2
    cleanup
    wait "$runner" || true
    exit 75
  fi
  sleep 1
done
wait "$runner"
