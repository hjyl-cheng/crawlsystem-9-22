SET default_transaction_read_only = on;
SET statement_timeout = 300000;
COPY (
  SELECT s.query_id, a.level_1, count(DISTINCT c.channel_id) channels
  FROM crawler.channel_candidate_sources s
  JOIN crawler.channel_candidates c USING (candidate_id)
  JOIN LATERAL (
    SELECT jsonb_path_query_first(p.metrics_json, 'strict $.**.channel_categories.value.level_1') #>> '{}' AS level_1
    FROM crawler.agent_profiles p WHERE p.channel_id = c.channel_id AND p.status = 'success' ORDER BY p.updated_at DESC LIMIT 1
  ) a ON a.level_1 IS NOT NULL
  WHERE s.query_id IS NOT NULL
  GROUP BY 1, 2
) TO STDOUT WITH CSV HEADER;
