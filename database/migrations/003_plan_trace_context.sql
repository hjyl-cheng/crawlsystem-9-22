-- W3C trace context of the request that created the plan. The dispatcher and the
-- Worker continue the same trace from it across processes and restarts, without
-- changing the frozen Workflow input. Diagnostic only: never used for identity.
ALTER TABLE m1.plans ADD COLUMN trace_context text
  CHECK (trace_context IS NULL OR trace_context ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
