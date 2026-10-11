#!/usr/bin/env python3
"""Phased cross-node restore drill. Use check:safe prepare, then
scripts/dev/finish-e1-restore.py for bounded data/index phases and cleanup.
No business service connects to restored data.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import uuid
from pathlib import Path

from backup_checks import BUSINESS_DATABASES, fingerprint
from infra_common import k, obj, run, STREAM_KEEPALIVE

BASE = Path('/srv/crawl-backups')
STATE = BASE / '.restore-e1'
SSH = ['sudo', '-u', 'ubuntu', 'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'crawl-s2']


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(state):
    path = STATE / 'state.json'
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(path)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def checksum_manifest(path):
    hashes = {}
    for line in path.read_text().splitlines():
        value, name = line.split('  ', 1)
        if not re.fullmatch(r'[a-f0-9]{64}', value) or not re.fullmatch(r'[A-Za-z0-9_.-]+', name):
            raise ValueError('Invalid backup checksum manifest')
        if name in hashes:
            raise ValueError('Duplicate backup file')
        hashes[name] = value
    return hashes


def owned_namespace(state):
    matches = obj('get', 'namespaces', '-l', 'crawlsystem.io/restore-run=' + state['run_id'])['items']
    if not matches:
        return None
    if len(matches) != 1 or matches[0]['metadata']['name'] != state['namespace']:
        raise RuntimeError('Restore namespace ownership mismatch')
    if state.get('namespace_uid') and matches[0]['metadata']['uid'] != state['namespace_uid']:
        raise RuntimeError('Restore namespace UID mismatch')
    return matches[0]


def cleanup(state, wait=True):
    if owned_namespace(state):
        k('delete', 'namespace', state['namespace'], '--wait=' + str(wait).lower(), '--timeout=60s', timeout=65)
    state['cleaned_at'] = now()
    save(state)
    shutil.rmtree(STATE / 'copy', ignore_errors=True)


def resources(namespace):
    pg = {
        'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'restore-pg', 'namespace': namespace},
        'spec': {'automountServiceAccountToken': False, 'restartPolicy': 'Never',
                 'nodeSelector': {'kubernetes.io/hostname': 'a2'},
                 'securityContext': {'runAsUser': 26, 'runAsGroup': 26, 'fsGroup': 26,
                                     'seccompProfile': {'type': 'RuntimeDefault'}},
                 'containers': [{'name': 'postgres', 'image': 'ghcr.io/cloudnative-pg/postgresql:18.6',
                     'securityContext': {'allowPrivilegeEscalation': False, 'capabilities': {'drop': ['ALL']}},
                     'command': ['bash', '-ec', "/usr/lib/postgresql/18/bin/initdb -D /restore/pg --auth-local=trust --auth-host=reject >/dev/null; exec /usr/lib/postgresql/18/bin/postgres -D /restore/pg -k /restore -c listen_addresses='' -c wal_level=logical -c max_wal_size=1GB"],
                     'env': [{'name': 'PGHOST', 'value': '/restore'}],
                     'resources': {'requests': {'cpu': '50m', 'memory': '128Mi', 'ephemeral-storage': '1Gi'},
                                   'limits': {'cpu': '1', 'memory': '768Mi', 'ephemeral-storage': '20Gi'}},
                     'volumeMounts': [{'name': 'data', 'mountPath': '/restore'}],
                     'readinessProbe': {'exec': {'command': ['pg_isready', '-h', '/restore']}, 'periodSeconds': 2}}],
                 'volumes': [{'name': 'data', 'emptyDir': {'sizeLimit': '20Gi'}}]}}
    config = '''<clickhouse><path>/restore/data/</path><tmp_path>/restore/tmp/</tmp_path>
<user_files_path>/restore/user_files/</user_files_path><format_schema_path>/restore/format_schemas/</format_schema_path>
<listen_host>127.0.0.1</listen_host><tcp_port>9000</tcp_port><max_server_memory_usage>800000000</max_server_memory_usage>
<logger><level>warning</level><console>true</console></logger><users><default><password></password>
<networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota></default></users>
<profiles><default><max_memory_usage>500000000</max_memory_usage></default></profiles><quotas><default/></quotas>
<backups><allowed_path>/restore/</allowed_path></backups></clickhouse>'''
    ch = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': 'restore-ch', 'namespace': namespace},
          'spec': {'automountServiceAccountToken': False, 'restartPolicy': 'Never',
                   'nodeSelector': {'kubernetes.io/hostname': 'a2'},
                   'containers': [{'name': 'clickhouse', 'image': 'clickhouse/clickhouse-server:26.8.10.6',
                       'command': ['clickhouse-server', '--config-file=/config/config.xml'],
                       'resources': {'requests': {'cpu': '50m', 'memory': '256Mi'},
                                     'limits': {'cpu': '500m', 'memory': '1Gi', 'ephemeral-storage': '3Gi'}},
                       'volumeMounts': [{'name': 'data', 'mountPath': '/restore'}, {'name': 'config', 'mountPath': '/config'}],
                       'readinessProbe': {'exec': {'command': ['clickhouse-client', '--query', 'SELECT 1']}, 'periodSeconds': 3}}],
                   'volumes': [{'name': 'data', 'emptyDir': {'sizeLimit': '3Gi'}},
                               {'name': 'config', 'configMap': {'name': 'restore-ch-config'}}]}}
    return [
        {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy',
         'metadata': {'name': 'deny-all', 'namespace': namespace},
         'spec': {'podSelector': {}, 'policyTypes': ['Ingress', 'Egress'], 'ingress': [], 'egress': []}},
        {'apiVersion': 'v1', 'kind': 'ConfigMap', 'metadata': {'name': 'restore-ch-config', 'namespace': namespace},
         'data': {'config.xml': config}}, pg, ch]


def prepare(resume_verified=False):
    previous = None
    if (STATE / 'state.json').exists():
        previous = json.loads((STATE / 'state.json').read_text())
        if not previous.get('cleaned_at'):
            raise RuntimeError('Clean up the previous restore drill first')
    STATE.mkdir(mode=0o700, exist_ok=True)
    latest = json.loads((BASE / 'latest.json').read_text())
    stamp = latest['backup']
    if not latest['success'] or not re.fullmatch(r'\d{8}T\d{6}Z', stamp):
        raise RuntimeError('No successful backup')
    source = BASE / stamp
    hashes = checksum_manifest(source / 'SHA256SUMS')
    for name, value in hashes.items():
        if digest(source / name) != value:
            raise RuntimeError('Source checksum mismatch')
    state = {'run_id': uuid.uuid4().hex, 'backup': stamp, 'started_at': now(), 'tests': {}, 'databases_restored': {}}
    state['namespace'] = 'infra-restore-e1-' + state['run_id'][:12]
    save(state)
    copy = STATE / 'copy'
    copy.mkdir(mode=0o700)
    run(SSH + ['sudo -n sh -c ' + shlex.quote(f'cd /srv/crawl-backups/{stamp} && sha256sum -c SHA256SUMS >/dev/null')])
    for name in ['metadata.json', 'SHA256SUMS', 'roles.sql', 'clickhouse.zip', 'etcd.snapshot', 'grafana.db'] + sorted(n for n in hashes if n.endswith('.dump')):
        with (copy / name).open('wb') as stream:
            run(SSH + ['sudo -n cat ' + shlex.quote(str(source / name))], output=stream, timeout=120)
        expected_hash = digest(source / name) if name == 'SHA256SUMS' else hashes[name]
        if digest(copy / name) != expected_hash:
            raise RuntimeError('Remote download checksum mismatch')
    metadata = json.loads((copy / 'metadata.json').read_text())
    if metadata.get('verification_version') != 2 or not set(BUSINESS_DATABASES).issubset(metadata.get('postgres_verification', {})):
        raise RuntimeError('Backup has no snapshot-consistent business evidence')
    if not all(re.fullmatch(r'[A-Za-z0-9_]+', db) for db in metadata['databases']):
        raise RuntimeError('Invalid database name')
    state['metadata'] = metadata
    state['backup_manifest_sha256'] = digest(source / 'SHA256SUMS')
    if resume_verified:
        if not previous or previous['backup'] != stamp or previous.get('metadata') != metadata:
            raise RuntimeError('Verified checkpoints belong to a different backup')
        old_manifest = previous.get('backup_manifest_sha256')
        if old_manifest:
            if old_manifest != state['backup_manifest_sha256']:
                raise RuntimeError('Backup changed since previous verification')
        else:
            # Compatibility with this drill's initial state: completed backup
            # files are immutable, and must predate the prior verification.
            previous_start = datetime.datetime.fromisoformat(previous['started_at']).timestamp()
            if any(path.stat().st_mtime > previous_start for path in source.iterdir()):
                raise RuntimeError('Backup files changed since previous verification')
        for db, evidence in previous['databases_restored'].items():
            if db not in metadata['databases'] or evidence['status'] != 'PASS':
                raise RuntimeError('Invalid restore checkpoint')
            state['databases_restored'][db] = {**evidence, 'verification_run': evidence.get('verification_run', previous['run_id']),
                                              'archive_sha256': digest(source / (db + '.dump'))}
        state['resumed_verified_databases'] = list(state['databases_restored'])
    state['tests']['local_checksums'] = 'PASS'
    state['tests']['cross_node_download_checksums'] = 'PASS'
    save(state)
    namespace = {'apiVersion': 'v1', 'kind': 'Namespace',
                 'metadata': {'name': state['namespace'], 'labels': {'crawlsystem.io/restore-run': state['run_id']}}}
    k('create', '-f', '-', data=json.dumps(namespace).encode())
    state['namespace_uid'] = obj('get', 'namespace', state['namespace'])['metadata']['uid']
    save(state)
    k('create', '-f', '-', data=json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': resources(state['namespace'])}).encode())
    k('-n', state['namespace'], 'wait', '--for=condition=Ready', 'pod/restore-pg', 'pod/restore-ch', '--timeout=120s', timeout=130)
    state['tests']['isolation'] = {'status': 'PASS', 'network': 'deny-all', 'service_account_token': False,
                                   'postgres_tcp': False, 'clickhouse_loopback_only': True}
    save(state)


def pgexec(state, *args, data=None):
    return k('-n', state['namespace'], 'exec', '-i', 'restore-pg', '-c', 'postgres', '--', *args, data=data, timeout=240)


def pgquery(state, db, query):
    return pgexec(state, 'psql', '-XqAt', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', data=query.encode()).decode().strip()


def restore_archive(state, db, sections, use_list=None):
    # Keep diagnostics root-only: pg_restore errors can include COPY row data.
    archive = '/restore/input-' + db + '.dump'
    if db not in state.get('archives_staged', []):
        pod = obj('-n', state['namespace'], 'get', 'pod', 'restore-pg')
        if pod['spec'].get('nodeName') != 'a2' or not any(v['name'] == 'data' and 'emptyDir' in v for v in pod['spec']['volumes']):
            raise RuntimeError('Unexpected restore pod storage or node')
        pod_uid = str(uuid.UUID(pod['metadata']['uid']))
        volume = '/var/lib/kubelet/pods/' + pod_uid + '/volumes/kubernetes.io~empty-dir/data'
        expected_hash = digest(STATE / 'copy' / (db + '.dump'))
        # Large stdin streams through kubectl can hang after all bytes arrive.
        # Administrative SSH writes only this owned pod's disposable emptyDir;
        # no hostPath, service, network access, or production storage is added.
        stage = '''import hashlib,os,pathlib,sys
base=pathlib.Path(sys.argv[1]); name=sys.argv[2]; expected=sys.argv[3]
if not base.is_dir() or base.is_symlink(): raise SystemExit('Restore volume is unavailable')
path=base/name
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
digest=hashlib.sha256()
with os.fdopen(fd,'wb') as dest:
    while block:=sys.stdin.buffer.read(1024*1024):
        dest.write(block); digest.update(block)
if digest.hexdigest()!=expected: raise SystemExit('Restore archive checksum mismatch')
os.chown(path,26,26)
'''
        remote = 'sudo -n python3 -c ' + shlex.quote(stage) + ' ' + shlex.quote(volume) + ' ' + shlex.quote('input-' + db + '.dump') + ' ' + shlex.quote(expected_hash)
        with (STATE / 'copy' / (db + '.dump')).open('rb') as stream, (STATE / 'last-restore-error.log').open('wb') as errors:
            result = subprocess.run(['sudo', '-u', 'ubuntu', 'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'crawl-a2', remote],
                                    stdin=stream, stdout=subprocess.DEVNULL, stderr=errors, timeout=120)
        if result.returncode:
            raise RuntimeError('PostgreSQL archive staging failed')
        actual_hash = k('-n', state['namespace'], 'exec', 'restore-pg', '--', 'sha256sum', archive).decode().split()[0]
        if actual_hash != expected_hash:
            raise RuntimeError('Staged PostgreSQL archive checksum mismatch')
        state.setdefault('archives_staged', []).append(db)
        save(state)
    with (STATE / 'last-restore-error.log').open('wb') as errors:
        options = ['--use-list=/restore/post-data.list'] if use_list is not None else []
        if use_list is not None:
            pgexec(state, 'bash', '-ec', 'cat > /restore/post-data.list', data=use_list.encode())
        result = subprocess.run(['kubectl', '-n', state['namespace'], 'exec', 'restore-pg', '-c', 'postgres', '--',
                                 'env', 'PGOPTIONS=-c maintenance_work_mem=256MB -c max_parallel_maintenance_workers=0',
                                 'bash', '-uc', STREAM_KEEPALIVE, 'restore-archive',
                                 'pg_restore', '-U', 'postgres', '--exit-on-error',
                                 *['--section=' + section for section in sections], *options, '-d', db, archive],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=errors, timeout=240)
    if result.returncode:
        raise RuntimeError('PostgreSQL archive restore failed; root-only diagnostics retained')


def compare_fingerprints(expected, actual):
    if expected.get('row_digest') != actual.get('row_digest'):
        raise RuntimeError('Database fingerprint algorithm differs')
    if expected.get('schema_digest_format') != actual.get('schema_digest_format'):
        raise RuntimeError('Database schema fingerprint format differs')
    if actual['schema_digest'] != expected['schema_digest']:
        raise RuntimeError('Restored database schema differs from backup snapshot')
    if set(actual['tables']) != set(expected['tables']):
        raise RuntimeError('Restored database table coverage differs')
    for name, facts in expected['tables'].items():
        if actual['tables'][name] != facts:
            raise RuntimeError('Restored table count or content differs: ' + name)


def postgres_data(state, db):
    if db not in state['metadata']['databases'] or db in state['databases_restored']:
        raise RuntimeError('Invalid or already restored database')
    if db in state.get('databases_loaded', []):
        raise RuntimeError('Database data is already loaded')
    if not state.get('roles_restored'):
        roles = (STATE / 'copy/roles.sql').read_text()
        roles = re.sub(r'^CREATE ROLE postgres;\n', '', roles, flags=re.M)
        pgexec(state, 'psql', '-Xq', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', data=roles.encode())
        state['roles_restored'] = True
        save(state)
    state['in_progress_database'] = db
    save(state)
    if db != 'postgres':
        pgexec(state, 'createdb', '-U', 'postgres', db)
    restore_archive(state, db, ['pre-data', 'data'])
    state.setdefault('databases_loaded', []).append(db)
    state.pop('in_progress_database', None)
    save(state)


def post_data_batches(lines):
    batches, current = [], []
    for line in lines.splitlines():
        if not re.match(r'^\d+;', line):
            continue
        # This million-row legacy table has 17 expensive indexes. Give each
        # object its own bounded phase instead of timing out the whole restore.
        if 'creator_search_current' in line or re.search(r'\bidx_creator_search_(?!live)', line):
            if current:
                batches.append(current)
                current = []
            batches.append([line])
        else:
            current.append(line)
            if len(current) == 20:
                batches.append(current)
                current = []
    if current:
        batches.append(current)
    return batches


def postgres_indexes(state, db):
    if db not in state.get('databases_loaded', []) or db in state['databases_restored']:
        raise RuntimeError('Database data must be loaded before restoring indexes')
    progress = state.setdefault('post_data_batches', {}).get(db)
    if progress is None:
        lines = pgexec(state, 'pg_restore', '--list', '--section=post-data', '/restore/input-' + db + '.dump').decode()
        progress = {'batches': post_data_batches(lines), 'completed': 0}
        state['post_data_batches'][db] = progress
        save(state)
    if progress['completed'] >= len(progress['batches']):
        raise RuntimeError('All database indexes are already restored')
    restore_archive(state, db, ['post-data'], '\n'.join(progress['batches'][progress['completed']]) + '\n')
    progress['completed'] += 1
    save(state)
    print(json.dumps({'database': db, 'index_batches_completed': progress['completed'], 'index_batches_total': len(progress['batches'])}))


def postgres(state, db):
    if db not in state['metadata']['databases'] or db in state['databases_restored']:
        raise RuntimeError('Invalid or already restored database')
    if db not in state.get('databases_loaded', []):
        postgres_data(state, db)
    progress = state.get('post_data_batches', {}).get(db)
    if progress is not None:
        if progress['completed'] != len(progress['batches']):
            raise RuntimeError('Database indexes are not completely restored')
    elif db == BUSINESS_DATABASES[1]:
        raise RuntimeError('Restore legacy business indexes in bounded batches first')
    else:
        restore_archive(state, db, ['post-data'])
    count = int(pgquery(state, db, "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"))
    evidence = {'status': 'PASS', 'table_count': count, 'verification_run': state['run_id'],
                'archive_sha256': digest(STATE / 'copy' / (db + '.dump')), 'verified_at': now()}
    expected = state['metadata']['postgres_verification'].get(db)
    if expected:
        actual = fingerprint('restore-pg', db, namespace=state['namespace'])
        compare_fingerprints(expected, actual)
        evidence['snapshot_tables_verified'] = len(actual['tables'])
        evidence['schema_digest'] = actual['schema_digest']
        evidence['rows'] = {name: facts['rows'] for name, facts in actual['tables'].items()}
    if db == BUSINESS_DATABASES[0]:
        migrations = json.loads(pgquery(state, db, 'SELECT json_agg(m ORDER BY version) FROM (SELECT version,checksum FROM m1.migrations) m'))
        files = Path(__file__).resolve().parents[3] / 'database/migrations'
        expected_migrations = [{'version': int(path.name[:3]), 'checksum': digest(path)} for path in sorted(files.glob('*.sql'))
                               if int(path.name[:3]) <= migrations[-1]['version']]
        if migrations != expected_migrations:
            raise RuntimeError('Restored schema migration checksums differ from application')
        evidence['schema_version'] = migrations[-1]['version']
        evidence['settings_versions'] = json.loads(pgquery(state, db, "SELECT json_agg(json_build_object('workspace',workspace_id,'version',version) ORDER BY workspace_id) FROM control.runtime_settings"))
    elif db == BUSINESS_DATABASES[1]:
        legacy_count = int(pgquery(state, db, "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','publication','raw_crawler','result')"))
        if legacy_count != 64:
            raise RuntimeError('Legacy business database must retain 64 tables')
        evidence['legacy_table_count'] = legacy_count
    elif db in ('temporal', 'temporal_visibility') and count < 1:
        raise RuntimeError('Temporal database is empty')
    elif db == 'infra_smoke':
        ids = pgquery(state, db, 'SELECT id FROM publication.outbox ORDER BY id').splitlines()
        if not set(state['metadata']['outbox_ids']).issubset(ids):
            raise RuntimeError('Prebackup outbox evidence missing')
    state['databases_restored'][db] = evidence
    state.pop('in_progress_database', None)
    save(state)


def clickhouse(state):
    def query(text):
        return k('-n', state['namespace'], 'exec', 'restore-ch', '--', 'clickhouse-client', '--query', text, timeout=120).decode().strip()
    with (STATE / 'copy/clickhouse.zip').open('rb') as stream:
        result = subprocess.run(['kubectl', '-n', state['namespace'], 'exec', '-i', 'restore-ch', '--',
                                 'sh', '-c', 'cat > /restore/clickhouse.zip'],
                                stdin=stream, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
    if result.returncode:
        raise RuntimeError('ClickHouse archive copy failed')
    query("RESTORE ALL FROM File('/restore/clickhouse.zip')")
    tables = query("SELECT database,name FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') AND is_temporary=0 FORMAT JSONEachRow")
    if sorted(tables.splitlines()) != sorted(state['metadata']['clickhouse_tables'].splitlines()):
        raise RuntimeError('ClickHouse table coverage differs')
    marker = state['metadata']['clickhouse_backup_marker']
    uuid.UUID(marker)
    if query("SELECT count() FROM infra_smoke.backup_check WHERE id='" + marker + "'") != '1':
        raise RuntimeError('ClickHouse backup marker missing')
    state['tests']['clickhouse'] = {'status': 'PASS', 'native_restore': True, 'tables_match': True,
                                    'backup_marker_present': True, 'smoke_rows': int(query('SELECT count() FROM infra_smoke.connectivity'))}
    save(state)


def finish(state):
    if set(state['databases_restored']) != set(state['metadata']['databases']) or 'clickhouse' not in state['tests']:
        raise RuntimeError('Restore verification is incomplete')
    with sqlite3.connect('file:' + str(STATE / 'copy/grafana.db') + '?mode=ro', uri=True) as connection:
        if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError('Grafana database integrity check failed')
    state['tests']['grafana_sqlite'] = 'PASS'
    snapshot = STATE / 'copy/etcd.snapshot'
    status = json.loads(run(['/usr/local/bin/etcdutl', 'snapshot', 'status', str(snapshot), '-w', 'json']))
    target = STATE / 'copy/etcd-restored'
    run(['/usr/local/bin/etcdutl', 'snapshot', 'restore', str(snapshot), '--data-dir', str(target), '--name', 'isolated-restore',
         '--initial-cluster', 'isolated-restore=http://127.0.0.1:12380', '--initial-advertise-peer-urls', 'http://127.0.0.1:12380'], timeout=120)
    if not (target / 'member/snap/db').stat().st_size:
        raise RuntimeError('Offline etcd restore failed')
    state['tests']['etcd'] = {'status': 'PASS', 'snapshot_status': status, 'offline_restore': True, 'live_cluster_reset': False}
    state['completed_at'] = now()
    save(state)
    cleanup(state)
    report = {key: value for key, value in state.items() if key not in ('metadata', 'namespace_uid', 'post_data_batches')}
    report['result'] = 'PASSED'
    (BASE / 'restore-latest.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'postgres-data', 'postgres-indexes', 'postgres', 'clickhouse', 'finish', 'cleanup'])
    parser.add_argument('database', nargs='?')
    parser.add_argument('--resume-verified', action='store_true', help='Reuse completed database proofs for the same immutable backup after failed resources were cleaned up')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo')
    def interrupted(signum, frame):
        raise KeyboardInterrupt('Restore drill interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    os.umask(0o077)
    with (BASE / '.restore-e1.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        prior_run = json.loads((STATE / 'state.json').read_text())['run_id'] if (STATE / 'state.json').exists() else None
        try:
            if args.phase == 'prepare':
                prepare(args.resume_verified)
            else:
                state = json.loads((STATE / 'state.json').read_text())
                if args.phase == 'cleanup':
                    cleanup(state)
                else:
                    if state.get('cleaned_at') or not owned_namespace(state):
                        raise RuntimeError('Restore resources are unavailable')
                    if args.phase == 'postgres-data':
                        postgres_data(state, args.database)
                    elif args.phase == 'postgres-indexes':
                        postgres_indexes(state, args.database)
                    elif args.phase == 'postgres':
                        postgres(state, args.database)
                    elif args.phase == 'clickhouse':
                        clickhouse(state)
                    else:
                        finish(state)
        except (Exception, KeyboardInterrupt):
            if (STATE / 'state.json').exists():
                state = json.loads((STATE / 'state.json').read_text())
                if args.phase != 'prepare' or state['run_id'] != prior_run:
                    state['failed_at'] = now()
                    save(state)
                    cleanup(state, wait=False)
            raise
        if args.phase != 'finish':
            print(json.dumps({'phase': args.phase, 'database': args.database, 'result': 'PASSED'}))


if __name__ == '__main__':
    main()
