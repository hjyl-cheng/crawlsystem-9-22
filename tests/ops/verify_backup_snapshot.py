"""Exercise real SQL evidence inside this drill's disposable PostgreSQL only."""
import importlib.util
import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / 'docs/crawlsystem-infra-a1-s3/scripts'
sys.path.insert(0, str(SCRIPTS))
from backup_checks import exported_snapshot, fingerprint

spec = importlib.util.spec_from_file_location('restore', SCRIPTS / 'verify-local-restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
state = json.loads((restore.STATE / 'state.json').read_text())
assert not state.get('cleaned_at') and restore.owned_namespace(state)
namespace = state['namespace']
db = 'e1_restore_fixture'
restored_db = 'e1_restore_fixture_copy'
restore.pgexec(state, 'createdb', '-U', 'postgres', db)
try:
    restore.pgquery(state, db, "CREATE TABLE public.sample(id integer PRIMARY KEY, obsolete text, value jsonb); ALTER TABLE sample DROP COLUMN obsolete; INSERT INTO sample VALUES(1,'{\"value\":\"first\"}'),(2,'{\"value\":\"second\"}')")
    with exported_snapshot('restore-pg', db, namespace) as snapshot:
        before = fingerprint('restore-pg', db, namespace, snapshot)
        dump = restore.pgexec(state, 'pg_dump', '-U', 'postgres', '-Fc', '--snapshot=' + snapshot, db)
        restore.pgquery(state, db, "UPDATE sample SET value='{\"value\":\"changed\"}' WHERE id=1")
        frozen = fingerprint('restore-pg', db, namespace, snapshot)
        restore.compare_fingerprints(before, frozen)
    restore.pgexec(state, 'createdb', '-U', 'postgres', restored_db)
    restore.pgexec(state, 'pg_restore', '-U', 'postgres', '--exit-on-error', '-d', restored_db, data=dump)
    restore.compare_fingerprints(before, fingerprint('restore-pg', restored_db, namespace))
    changed = fingerprint('restore-pg', db, namespace)
    assert changed['tables']['public.sample']['rows'] == before['tables']['public.sample']['rows']
    try:
        restore.compare_fingerprints(before, changed)
    except RuntimeError as error:
        assert 'content differs' in str(error)
    else:
        raise AssertionError('A same-count data change must be detected')
    restore.pgquery(state, db, 'ALTER TABLE sample ADD COLUMN extra text')
    changed_schema = fingerprint('restore-pg', db, namespace)
    try:
        restore.compare_fingerprints(changed, changed_schema)
    except RuntimeError as error:
        assert 'schema differs' in str(error)
    else:
        raise AssertionError('A schema change must be detected')
    print(json.dumps({'result': 'PASSED', 'snapshot_with_concurrent_write': True,
                      'same_count_content_change_detected': True, 'schema_change_detected': True,
                      'dropped_column_dump_restore_matches': True}))
finally:
    restore.pgexec(state, 'dropdb', '-U', 'postgres', db)
    restore.pgexec(state, 'dropdb', '-U', 'postgres', '--if-exists', restored_db)
