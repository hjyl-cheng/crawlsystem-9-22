"""Snapshot-consistent restore evidence. Only counts and hashes leave PostgreSQL."""
import contextlib
import json
import re
import selectors
import subprocess
import tempfile

from infra_common import k, STREAM_KEEPALIVE

BUSINESS_DATABASES = ('crawlsystem_m1_main_test', 'crawlsystem_business_main')


def snapshot_sql(snapshot=None):
    if snapshot is not None and not re.fullmatch(r'[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+', snapshot):
        raise ValueError('Invalid PostgreSQL snapshot')
    transaction = 'CREATE TEMP TABLE restore_checks (name text PRIMARY KEY, rows bigint, digest text); BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'
    if snapshot:
        transaction += " SET TRANSACTION SNAPSHOT '" + snapshot + "';"
    return transaction + """
SET LOCAL statement_timeout = '120s';
SET LOCAL timezone = 'UTC';
DO $check$
DECLARE t record;
BEGIN
  FOR t IN SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
    ORDER BY n.nspname,c.relname
  LOOP
    -- Native record hashes avoid serializing gigabytes of legacy JSON twice.
    -- Two seeds and numeric sums retain duplicates with bounded memory. File
    -- integrity remains protected separately by SHA256; restore uses PG 18.6.
    EXECUTE format('INSERT INTO pg_temp.restore_checks SELECT %L, count(*),
      md5(coalesce(sum(hash_record_extended(r,0))::text, ''0'')||'':''||
          coalesce(sum(hash_record_extended(r,1))::text, ''0'')) FROM %I.%I r',
      t.nspname||'.'||t.relname, t.nspname, t.relname);
  END LOOP;
END $check$;
WITH definitions AS (
 SELECT 'column' kind, n.nspname||'.'||c.relname||'.'||row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum) name,
   jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
     a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid))::text definition
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','p','v','m','S','f')
   AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'relation', n.nspname||'.'||c.relname,
   jsonb_build_array(c.relkind,c.relrowsecurity,c.relforcerowsecurity,
     pg_get_userbyid(c.relowner),c.relacl,c.reloptions,
     CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid) ELSE NULL END)::text
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p','v','m','S','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'constraint', n.nspname||'.'||c.relname||'.'||s.conname,pg_get_constraintdef(s.oid)
 FROM pg_constraint s JOIN pg_class c ON c.oid=s.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'index', schemaname||'.'||indexname,indexdef FROM pg_indexes
 WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'trigger',n.nspname||'.'||c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid)
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'function',n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',pg_get_functiondef(p.oid)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE p.prokind IN ('f','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
   AND n.nspname !~ '^pg_(toast|temp)'
 UNION ALL
 SELECT 'schema',nspname,jsonb_build_array(pg_get_userbyid(nspowner),nspacl)::text FROM pg_namespace
 WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname !~ '^pg_(toast|temp)'
)
SELECT jsonb_build_object('row_digest','postgres18-record-sums-v1','schema_digest_format','logical-columns-v1','tables',
  (SELECT coalesce(jsonb_object_agg(name,jsonb_build_object('rows',rows,'digest',digest)), '{}'::jsonb) FROM restore_checks),
  'schema_digest',(SELECT md5(coalesce(string_agg(kind||':'||name||':'||definition,E'\\n' ORDER BY kind,name),'')) FROM definitions));
ROLLBACK;
"""


def fingerprint(pod, database, namespace='db', snapshot=None):
    return json.loads(k('-n', namespace, 'exec', '-i', pod, '-c', 'postgres', '--',
                        'bash', '-uc', STREAM_KEEPALIVE, 'snapshot-check',
                        'psql', '-XqAt', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1',
                        data=snapshot_sql(snapshot).encode(), timeout=240))


@contextlib.contextmanager
def exported_snapshot(pod, database, namespace='db'):
    # Keep this transaction alive until both pg_dump and fingerprints finish.
    # Closing the pipe also ends the transaction on timeout or interruption.
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(['kubectl', '-n', namespace, 'exec', '-i', pod, '-c', 'postgres', '--',
                                 'bash', '-uc', STREAM_KEEPALIVE, 'snapshot-export',
                                 'psql', '-XqAt', '-U', 'postgres', '-d', database,
                                 '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=errors)
        try:
            proc.stdin.write(b'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n')
            proc.stdin.flush()
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ)
                if not selector.select(30):
                    raise TimeoutError('Snapshot export timed out')
            snapshot = proc.stdout.readline().decode().strip()
            if not re.fullmatch(r'[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+', snapshot):
                raise RuntimeError('Snapshot export failed')
            yield snapshot
        finally:
            if proc.poll() is None:
                try:
                    proc.communicate(b'ROLLBACK;\n', timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
