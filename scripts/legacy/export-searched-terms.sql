SET default_transaction_read_only = on;
SET statement_timeout = 300000;
COPY (
  WITH pages AS (
    SELECT query_id, count(*) pages, count(*) FILTER (WHERE status='done') done_pages, min(created_at) first_run, max(updated_at) last_run
    FROM crawler.query_pages WHERE query_id IS NOT NULL GROUP BY 1),
  found AS (
    SELECT s.query_id, count(DISTINCT s.candidate_id) candidates,
      count(DISTINCT s.candidate_id) FILTER (WHERE c.status='accepted') accepted,
      count(DISTINCT s.candidate_id) FILTER (WHERE c.status='existing') existing
    FROM crawler.channel_candidate_sources s JOIN crawler.channel_candidates c USING (candidate_id)
    WHERE s.query_id IS NOT NULL GROUP BY 1)
  SELECT t.query_id, t.query_text, coalesce(t.language,'') language, p.pages, p.done_pages, coalesce(f.candidates,0), coalesce(f.accepted,0), coalesce(f.existing,0), p.first_run, p.last_run
  FROM pages p JOIN crawler.query_terms t USING (query_id) LEFT JOIN found f USING (query_id)
) TO STDOUT WITH CSV HEADER;
