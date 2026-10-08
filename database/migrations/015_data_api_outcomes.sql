-- Which Data API endpoint each permitted request called and, when it failed, why; read by the
-- console's Data API page. Additive only, so the build running during the rollout keeps working.
ALTER TABLE m1.data_api_permits ADD COLUMN endpoint text CHECK (endpoint IN ('channels','playlistItems','videos'));
ALTER TABLE m1.data_api_permits ADD COLUMN failure text CHECK (failure IN ('quota','forbidden','not_found','invalid','unavailable'));
ALTER TABLE m1.data_api_permits ADD COLUMN failed_at timestamptz;
CREATE INDEX data_api_permits_recent ON m1.data_api_permits(workspace_id, granted_at DESC);
