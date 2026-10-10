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
scope_high=768M
scope_max=1G
case "${1:-}" in
  lockfile) command=(npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund) ;;
  install) command=(npm ci --offline --no-audit --no-fund) ;;
  typecheck) heap_mib=1152; scope_high=1280M; scope_max=1536M; command=(node node_modules/typescript/bin/tsc --noEmit) ;;
  unit) command=(node --import tsx --test --test-concurrency=1 packages/contracts/test/*.test.ts packages/feature-clock/test/*.test.ts packages/store/test/*.test.ts packages/http/test/*.test.ts apps/control-api/test/*.test.ts apps/console/tests/*.test.ts packages/execution-client/test/*.test.ts apps/execution-worker/test/*.test.ts apps/proxy-manager/test/*.test.ts) ;;
  execution-build) command=(npm run build:execution) ;;
  images) heap_mib=640; command=(node --import tsx scripts/dev/build-images.ts) ;;
  execution-temporal) command=(npm run test:temporal) ;;
  execution-live) command=(node --env-file=.runtime/main-joint.env --import tsx apps/execution-worker/scripts/live-with-dependencies.ts) ;;
  execution-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-execution-console.ts) ;;
  collection-unit) command=(node --import tsx --test --test-concurrency=1 apps/execution-worker/test/identity.test.ts apps/execution-worker/test/fingerprint.test.ts apps/execution-worker/test/raw-archive.test.ts apps/execution-worker/test/web-scrape.test.ts apps/execution-worker/test/web-collector.test.ts) ;;
  collection-storage) command=(node --import tsx scripts/dev/verify-r2-storage.ts) ;;
  collection-preview) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r2-preview.ts "${@:2}") ;;
  collection-update) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r2-update.ts "${@:2}") ;;
  pipeline-unit) command=(node --import tsx --test --test-concurrency=1 apps/raw-parser/test/*.test.ts packages/http/test/workload.test.ts) ;;
  pipeline-integration) command=(node --env-file=.runtime/r3-test.env --import tsx --test --test-concurrency=1 tests/integration/pipeline.test.ts) ;;
  analytics-integration) command=(node --env-file=.runtime/r3-test.env --import tsx --test --test-concurrency=1 tests/integration/failure-analytics.test.ts) ;;
  analytics-unit) command=(node --import tsx --test --test-concurrency=1 apps/raw-parser/test/failure.test.ts) ;;
  analytics-clickhouse) command=(node --import tsx scripts/dev/verify-r5-clickhouse.ts) ;;
  analytics-preview) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r5-preview.ts "${@:2}") ;;
  analytics-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r5-browser.ts) ;;
  pipeline-replay) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r3-replay.ts) ;;
  pipeline-preview) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r3-preview.ts "${@:2}") ;;
  pipeline-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r3-browser.ts) ;;
  discovery-preview) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r4-preview.ts "${@:2}") ;;
  discovery-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r4-browser.ts) ;;
  automation-runtime) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/r6-runtime.ts "${@:2}") ;;
  automation-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r6-browser.ts) ;;
  automation-integration) command=(node --env-file=.runtime/r3-test.env --import tsx --test --test-concurrency=1 tests/integration/query-runs.test.ts tests/integration/discovery-about.test.ts) ;;
  automation-deploy) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/deploy-r6-fixes.ts) ;;
  automation-recovery) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r6-recovery.ts "${@:2}") ;;
  pipeline-roles) command=(node --env-file=.runtime/r3-test.env --import tsx scripts/dev/verify-r3-roles.ts) ;;
  collection-parity) command=(node --import tsx scripts/dev/verify-r2-parity.ts) ;;
  collection-browser) command=(node --env-file=.runtime/main.env --import tsx scripts/dev/verify-r2-browser.ts) ;;
  fingerprint-gateway)
    command=(env LD_LIBRARY_PATH=.runtime/profile-agent/python/usr/local/lib PYTHONPATH=apps/fingerprint-gateway:.runtime/fingerprint-gateway/site PYTHONDONTWRITEBYTECODE=1 .runtime/profile-agent/python/usr/local/bin/python3.12 -m unittest discover -s apps/fingerprint-gateway/tests)
    ;;
  build-console) heap_mib=512; command=(npm run build:console) ;;
  browser) command=(npm run test:browser -- "${@:2}") ;;
  # Python Profile Agent with the pinned interpreter, wheels and verified model bundle (prepared on first use).
  profile-agent)
    command=(bash -c 'node --import tsx scripts/dev/profile-agent-runtime.ts >/dev/null && p=.runtime/profile-agent &&
      LD_LIBRARY_PATH="$p/python/usr/local/lib" PYTHONPATH="apps/profile-agent:$p/site" PYTHONDONTWRITEBYTECODE=1 PROFILE_MODEL_MANIFEST="$p/models/manifest.json" \
      "$p/python/usr/local/bin/python3.12" -W "ignore:\`load_model\`" -m unittest discover -s apps/profile-agent/tests "$@"' profile-agent "${@:2}")
    ;;
  integration)
    command=(node "--env-file=${M1_CHECK_ENV_FILE:-.runtime/r3-test.env}" --import tsx --test --test-concurrency=1 tests/integration/*.test.ts)
    ;;
  *) echo 'Usage: bash scripts/dev/check-safe.sh lockfile|install|typecheck|unit|build-console|browser|integration|profile-agent|execution-build|images|execution-temporal|execution-live|execution-browser' >&2; exit 64 ;;
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
  --property=MemoryAccounting=yes --property=MemoryHigh="$scope_high" --property=MemoryMax="$scope_max" \
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
