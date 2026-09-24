# Profile Agent

Local-model inference for the AGENT domain (M2 step 5). The Worker reads the Store's
Agent input snapshot (`GET /v1/plans/:id/agent-input`: this plan's channel facts and
target videos with first-page Top comments, plus `input_hash`), posts it here, and
submits the returned ten profile facts bound to that hash. The Store recomputes the
hash on submit and rejects a stale profile (`INPUT_MISMATCH`); the Worker then reads
and profiles again.

```text
POST /v1/profile   AgentInput -> 200 AgentProfile (packages/contracts)
                              -> 422 the input cannot be profiled; do not retry it
GET  /healthz      200 after every active model artifact is verified and loaded
```

The service is stateless and read-only (no database, credentials or cluster token) and
deterministic: the snapshot boundary is the latest observation in the input, never the
wall clock, so a retried call yields the same payload and the same idempotent submission.

## Contents

- `qy_channel_profile/` — the old system's processor, **copied unchanged** from
  `oldsystem/services/local-agent/src/qy_channel_profile` at `2d5af20` (inference modules
  only; training, evaluation, sampling, database repository and CLI are left out).
- `profile_agent/` — adapter (our contracts ⇄ the processor's snapshot and fact shapes) and the HTTP server.
- `model-manifest.json` — the pinned model bundle manifest
  (`agent-free-20260813-v0.5-field-routing-deployment`: fastText language ID, categories
  level 1/2 and channel tags; scikit-learn 1.9.0 pickles). The ~215 MB of artifacts are not
  in this repository; they come from the old system's Git LFS checkout and are verified
  against this manifest by `scripts/dev/profile-agent-runtime.ts`
  (`PROFILE_MODEL_SOURCE` overrides the default `../oldsystem/services/local-agent/models`).
- `requirements.in` / `requirements.lock` — CPython 3.12 (numpy 1.26 is required by
  fasttext-wheel 0.9.2), hash-pinned binary wheels.

## Checks

```bash
npm run check:safe -- profile-agent             # prepares .runtime/profile-agent on first use
UPDATE_GOLDEN=1 npm run check:safe -- profile-agent   # after an intended model/adapter change
```

The tests run with the production base image's interpreter extracted locally. The golden
output `tests/expected-profile.json` is also validated against the TypeScript contracts
by `apps/execution-worker/test/agent.test.ts`.

## Known limits

The bundle itself is marked `production_eligible: false`: audience distributions and the
active-subscriber ratio are uncalibrated public estimates, category and tag models are
weakly supervised and not validated on a manual test set, and creator gender/age/country
use rules and priors because their candidate models missed the quality gate. Each fact
carries that status as its `reason`, and the console shows it. For example, the synthetic
test channel (home bread baking) is classified as Music with low confidence.
