-- Additive control metadata; existing business tables and migration checksums stay intact.
ALTER TABLE control.channel_imports
  ADD COLUMN auto_retry_count integer NOT NULL DEFAULT 0 CHECK (auto_retry_count BETWEEN 0 AND 3),
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN retry_blocked_reason text,
  ADD COLUMN last_failure_code text;
CREATE INDEX channel_imports_retry ON control.channel_imports(workspace_id,retry_at)
  WHERE state='failed' AND retry_at IS NOT NULL;

-- Classify only the current failed import's terminal event. Cancelled, ignored and
-- unknown historical failures remain manual. Admission rechecks eligibility under locks.
WITH current_failure AS (
  SELECT i.workspace_id,i.channel_id,p.status,e.data->>'error_code' AS code,
    EXISTS(SELECT 1 FROM control.failures f WHERE (f.plan_id=p.plan_id OR f.retry_plan_id=p.plan_id) AND f.state='IGNORED') AS ignored
  FROM control.channel_imports i LEFT JOIN control.plans p ON p.plan_id=i.plan_id
  LEFT JOIN LATERAL (SELECT data FROM control.events WHERE plan_id=p.plan_id AND data->>'kind'='FAILED' ORDER BY created_at DESC,event_id DESC LIMIT 1) e ON true
  WHERE i.state='failed'
)
UPDATE control.channel_imports i SET last_failure_code=f.code,
  retry_blocked_reason=CASE WHEN f.status='CANCELLED' THEN 'cancelled' WHEN f.ignored THEN 'ignored'
    WHEN f.status='FAILED' AND f.code IN ('UNAVAILABLE','INTERNAL_ERROR','BUDGET_EXHAUSTED') THEN NULL ELSE 'non_retryable' END,
  retry_at=CASE WHEN f.status='FAILED' AND NOT f.ignored AND f.code IN ('UNAVAILABLE','INTERNAL_ERROR','BUDGET_EXHAUSTED') THEN clock_timestamp()+interval '5 minutes' END
FROM current_failure f WHERE i.workspace_id=f.workspace_id AND i.channel_id=f.channel_id;
