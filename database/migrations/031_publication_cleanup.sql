-- Keep a full day of acknowledged CDC rows for recovery; cleanup cannot remove pending deliveries.
CREATE FUNCTION delivery.cleanup_outbox(batch_size integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE removed integer;
BEGIN
 IF batch_size<1 OR batch_size>500 THEN RAISE EXCEPTION 'invalid cleanup batch';END IF;
 WITH expired AS (
  SELECT o.id FROM delivery.outbox o JOIN delivery.records r ON r.delivery_id=o.delivery_id
  WHERE r.status='DELIVERED' AND o.created_at<clock_timestamp()-interval '1 day'
  ORDER BY o.created_at LIMIT batch_size FOR UPDATE OF o SKIP LOCKED
 ) DELETE FROM delivery.outbox o USING expired e WHERE o.id=e.id;
 GET DIAGNOSTICS removed=ROW_COUNT;RETURN removed;
END $$;
REVOKE ALL ON FUNCTION delivery.cleanup_outbox(integer) FROM PUBLIC;
