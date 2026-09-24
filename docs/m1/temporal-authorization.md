# Temporal namespace authorization

Updated: 2026-09-24. Closes the runtime-access audit finding that any certificate issued by the Temporal CA could read the other namespace (`runtime-access.json`, `other_namespace_describe: ALLOWED`).

## Design

- Temporal enables the default JWT claim mapper and authorizer (`values/temporal.yaml` → `server.config.authorization`). The public frontend (7233) accepts only requests with `Authorization: Bearer <JWT>`, and the `permissions` claim decides namespace and role, for example `crawlsystem-m1-main:write`.
- The ES256 signing key is `.runtime/temporal-jwt/signing.pem` (ignored by Git), stored only in the Secret `control/temporal-jwt-signing`. Temporal reads just the public key from ConfigMap `temporal/temporal-jwks` via `file://`, refreshed once a minute, and never calls Control. Key ID = the first 16 characters of the public key's SHA-256.
- Clients use their ServiceAccount token to call `POST /v1/workload/temporal-token` on Control. After TokenReview, Control issues a 15-minute token according to `TEMPORAL_WORKLOAD_PERMISSIONS`. Clients refresh at half-life and switch via `setApiKey`:

| ServiceAccount | Permissions | Purpose |
| --- | --- | --- |
| `crawler/execution-worker` | `crawlsystem-m1-main:read`, `:worker` | poll and complete tasks; cannot start or cancel Workflows |
| `control/intent-dispatcher` | `crawlsystem-m1-main:write` | start, verify history, cancel |

  Control never issues `system:*` or `admin` permissions. Tokens with a mismatched permission format are rejected both at issuance and by the contract.
- Temporal's own worker service, admintools and the UI go through **internal-frontend** (7236, no authorization). The `temporal-internal` NetworkPolicy opens 7236/6936 only to the `temporal` namespace. The UI has no per-user JWT and is only reachable in-cluster; public access would require separate OIDC.
- Local tools: `node --import tsx scripts/dev/temporal-token.ts <file> <ns>:<role>` mints a 1-hour token, used with `TEMPORAL_API_KEY_FILE`. Only `read/write/worker` can be minted.

## Local verification (temporal-server 1.32.0, SQLite, same config)

- No token: `PERMISSION_DENIED`; an `m1:write` token can describe/start/cancel in m1, but describing or starting in `crawlsystem`, or listing namespaces, is denied.
- Expired tokens are rejected at connect time; switching to another namespace's token via `setApiKey` takes effect immediately.
- A Worker with only `worker` cannot pass the startup namespace check; `read`+`worker` polls normally. `createWorkflowStarter`'s idempotent start and cancel pass with a `write` token.
- After the JWKS changes, new keys only take effect with `refreshInterval` configured (the cluster config sets 1m).

## Order of operations

1. `deploy-preview.ts`: publish the signing key and JWKS, and make the dispatcher and Worker start sending tokens. Before authorization is enabled Temporal ignores tokens, so this step has no effect on the service.
2. `node --env-file=.runtime/main.env --import tsx scripts/dev/temporal-authz.ts enable`: preflight (JWKS exists, both clients configured to send tokens, clean tree) → apply `temporal-internal` → `helm upgrade` → verify that no token and cross-namespace requests are denied. It records the pre-upgrade revision.
3. Rollback: `... temporal-authz.ts rollback` (helm rollback to the recorded revision).

Impact:
- The Helm upgrade restarts Temporal on a1 (single replica); Workflow state is durable and resumes after the restart.
- It adds an internal-frontend Pod. `temporal_svc` has a 45-connection limit; there are currently 6 actual connections, and the worst-case total pool configuration would exceed it, so this needs monitoring.
- Other `crawlsystem` namespace clients (the infra smoke/observer) need a `crawlsystem:write` token or must go through internal-frontend.

Key rotation: generate a new `signing.pem` and rename the old file to `previous.pem`, then redeploy (both public keys are published in the JWKS). Once all old tokens have expired (≤15 minutes), delete `previous.pem` and redeploy.
