-- Give the new control table the same service grants as the existing import queue.
DO $$
DECLARE permission record;
BEGIN
 FOR permission IN SELECT grantee,privilege_type FROM information_schema.role_table_grants
   WHERE table_schema='control' AND table_name='channel_imports' AND grantee<>'PUBLIC' LOOP
  EXECUTE format('GRANT %s ON control.handle_resolutions TO %I',permission.privilege_type,permission.grantee);
 END LOOP;
END $$;
