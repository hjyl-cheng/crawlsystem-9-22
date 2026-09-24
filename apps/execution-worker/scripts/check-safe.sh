#!/usr/bin/env bash
set -euo pipefail
ulimit -c 0

# One heavy check at a time across execution sessions. This does not change any
# persistent user slice, infrastructure unit, swap setting, or OOM daemon.
exec 9>/tmp/crawlsystem-execution-check.lock
flock -n 9 || { echo 'Another execution check is running; wait for it to finish.' >&2; exit 75; }
task_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$task_dir"
available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
if (( available_kib < 2621440 )); then
  echo 'Refusing heavy check: less than 2.5 GiB available host memory.' >&2
  exit 75
fi
node_command=(node)
heap_mib=384
if [[ -n "${EXECUTION_ENV_FILE:-}" ]]; then node_command+=("--env-file=$EXECUTION_ENV_FILE"); fi
case "${1:-}" in
  typecheck) heap_mib=512; command=(node node_modules/typescript/bin/tsc --noEmit --project apps/execution-worker/tsconfig.json) ;;
  build) command=(node --import tsx apps/execution-worker/scripts/build.ts) ;;
  unit) command=(node --import tsx --test --test-concurrency=1 packages/execution-client/test/*.test.ts apps/execution-worker/test/*.test.ts) ;;
  contracts) command=(node --import tsx --test --test-concurrency=1 packages/contracts/test/*.test.ts) ;;
  temporal) command=("${node_command[@]}" --import tsx --test --test-concurrency=1 apps/execution-worker/test/temporal.integration.ts) ;;
  live) command=("${node_command[@]}" --import tsx apps/execution-worker/scripts/live-acceptance.ts) ;;
  live-local) command=("${node_command[@]}" --import tsx apps/execution-worker/scripts/live-with-dependencies.ts) ;;
  *) echo 'Usage: bash apps/execution-worker/scripts/check-safe.sh typecheck|build|unit|contracts|temporal|live|live-local' >&2; exit 64 ;;
esac
unit="crawlsystem-execution-check-$$"
mkdir -p .runtime/execution-checks
chmod 700 .runtime/execution-checks
metrics=".runtime/execution-checks/${1}-$$.tsv"
printf 'unix_seconds\tavailable_kib\tscope_memory_bytes\n' > "$metrics"
cleanup() { systemctl --user stop "$unit.scope" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# A scope encloses the compiler, native SDK, test server, and every child Worker.
# Fail closed if systemd resource accounting is unavailable; no unbounded fallback.
systemd-run --user --scope --quiet --unit="$unit" \
  --property=MemoryAccounting=yes --property=MemoryHigh=768M --property=MemoryMax=1G \
  --property=MemorySwapMax=256M --property=CPUQuota=150% --property=TasksMax=256 \
  env NODE_OPTIONS="--max-old-space-size=$heap_mib" \
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
