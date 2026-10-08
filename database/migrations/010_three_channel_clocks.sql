-- Three clocks per managed channel, as in 24.8 §7: About, Video, Agent. The Video clock follows
-- new-video discovery and carries refresh_due_at, from which a Video run also refreshes the recent
-- videos' counts (previously a separate REFRESH clock). DISCOVERY rows become VIDEO with the
-- REFRESH row's next time as refresh_due_at; REFRESH rows go.
-- Transitional: the check still admits DISCOVERY/REFRESH so a build from before this change keeps
-- settling plans until it is replaced; newer builds read and write only ABOUT/VIDEO/AGENT.
ALTER TABLE m1.channel_clocks ADD COLUMN refresh_due_at timestamptz;
ALTER TABLE m1.channel_clocks DROP CONSTRAINT channel_clocks_clock_check,
  ADD CONSTRAINT channel_clocks_clock_check CHECK (clock IN ('ABOUT','VIDEO','AGENT','DISCOVERY','REFRESH'));
UPDATE m1.channel_clocks d SET clock='VIDEO', refresh_due_at=coalesce(
    (SELECT coalesce(r.retry_at, r.due_at) FROM m1.channel_clocks r WHERE r.workspace_id=d.workspace_id AND r.channel_id=d.channel_id AND r.clock='REFRESH'),
    d.due_at + interval '14 days')
  WHERE d.clock='DISCOVERY';
DELETE FROM m1.channel_clocks WHERE clock='REFRESH';
