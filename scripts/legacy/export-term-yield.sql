SET default_transaction_read_only = on;
SET statement_timeout = 300000;
COPY (
  SELECT s.query_id,
    count(DISTINCT s.candidate_id) FILTER (WHERE c.status IN ('queued','discovered')) AS new_candidates,
    count(DISTINCT s.candidate_id) FILTER (WHERE c.status IN ('queued','discovered') AND c.search_subscriber_count >= 1000) AS new_qualified,
    count(DISTINCT s.candidate_id) FILTER (WHERE c.status IN ('queued','discovered') AND c.search_subscriber_count IS NULL) AS new_unknown
  FROM crawler.channel_candidate_sources s JOIN crawler.channel_candidates c USING (candidate_id)
  WHERE s.query_id IS NOT NULL GROUP BY 1
) TO STDOUT WITH CSV HEADER;
