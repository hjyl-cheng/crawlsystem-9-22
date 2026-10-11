#!/usr/bin/env python3
"""Resume a prepared drill, running each expensive phase through check:safe."""
import json
import os
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
os.umask(0o077)
logs = ROOT / '.runtime/e1'
logs.mkdir(mode=0o700, exist_ok=True)


def state():
    result = subprocess.run(['sudo', 'python3', '-c',
                             "import pathlib; print(pathlib.Path('/srv/crawl-backups/.restore-e1/state.json').read_text())"],
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def check(name, *args):
    with (logs / (name + '.log')).open('wb') as log:
        result = subprocess.run(['npm', 'run', 'check:safe', '--', *args], stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError('Restore phase failed: ' + name + '; see private log')
    print(name + ': PASSED', flush=True)


current = state()
if current.get('cleaned_at'):
    raise SystemExit('Prepare a new restore drill first')
for db in sorted(current['metadata']['databases'], key=lambda name: (name != 'crawlsystem_m1_main_test', name == 'crawlsystem_business_main', name)):
    if not re.fullmatch(r'[A-Za-z0-9_]+', db):
        raise SystemExit('Invalid database name')
    current = state()
    if db in current['databases_restored']:
        continue
    if db == 'crawlsystem_business_main':
        if db not in current.get('databases_loaded', []):
            check('business-data', 'backup-restore', 'postgres-data', db)
        while True:
            progress = state().get('post_data_batches', {}).get(db)
            if progress and progress['completed'] == len(progress['batches']):
                break
            batch = progress['completed'] if progress else 0
            check('business-indexes-' + str(batch), 'backup-restore', 'postgres-indexes', db)
    check('postgres-' + db, 'backup-restore', 'postgres', db)
check('snapshot-test', 'backup-snapshot-test')
check('clickhouse', 'backup-restore', 'clickhouse')
check('finish', 'backup-restore', 'finish')
print('Cross-node restore drill: PASSED', flush=True)
