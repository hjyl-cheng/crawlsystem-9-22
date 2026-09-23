#!/usr/bin/env python3
"""Archive a maintenance-affected window and start a fresh, real 48h observation."""
import argparse, datetime, fcntl, json, os, shutil, subprocess
from pathlib import Path
from infra_common import ROOT
from importlib.util import spec_from_file_location, module_from_spec

STATE=Path('/var/lib/crawlsystem-observation')

def service(*args):
    subprocess.run(['systemctl',*args],check=True,capture_output=True,timeout=320)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--reason',required=True);args=parser.parse_args()
    if os.geteuid()!=0:raise RuntimeError('Run as root')
    os.umask(0o077)
    # First obtain a fresh health check. Never erase evidence to hide an active fault.
    service('start','crawlsystem-observe.service')
    latest=json.loads((ROOT/'reports/observation-latest.json').read_text())
    spec=spec_from_file_location('observer',ROOT/'scripts/observe-infra.py');observer=module_from_spec(spec);spec.loader.exec_module(observer)
    if observer.sample_failures(latest['latest']):raise RuntimeError('Current health must pass before restarting observation')
    if __import__('time').time()-latest['latest']['epoch']>120:raise RuntimeError('Health sample is stale')
    service('stop','crawlsystem-observe.timer')
    try:
        service('stop','crawlsystem-observe.service')
        with (STATE/'lock').open('w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            archive=STATE/'archives'/(stamp+'-maintenance');archive.mkdir(parents=True,mode=0o700)
            # Copy all evidence before replacing the active start and sample files.
            for name in ('started.json','samples.jsonl'):shutil.copy2(STATE/name,archive/name)
            shutil.copy2(ROOT/'reports/observation-latest.json',archive/'observation-latest.json')
            metadata={'reason':args.reason,'archived':str(archive),'previous_phases':latest['phases'],
                      'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
            (archive/'reason.json').write_text(json.dumps(metadata,indent=2))
            (STATE/'started.json').unlink();(STATE/'samples.jsonl').write_text('')
            report=ROOT/'reports/observation-maintenance-restart.json';report.write_text(json.dumps(metadata,indent=2));report.chmod(0o644)
    finally:service('start','crawlsystem-observe.timer')
    service('start','crawlsystem-observe.service')
    result=json.loads((ROOT/'reports/observation-latest.json').read_text())
    print(json.dumps({'started':result['started'],'phases':result['phases'],'health_failures':result['latest'].get('health_failures')}))

if __name__=='__main__':main()
