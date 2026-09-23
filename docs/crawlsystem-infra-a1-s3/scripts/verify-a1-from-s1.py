#!/usr/bin/env python3
"""Run on S1 via systemd. Observe one A1 reboot without depending on A1 tools."""
import datetime, importlib.util, json, os, time
from pathlib import Path
os.environ['KUBECONFIG']='/etc/rancher/k3s/k3s.yaml'
from infra_common import ROOT, obj

STATE=Path('/var/lib/crawlsystem-a1-reboot')

def main():
    os.umask(0o077);STATE.mkdir(mode=0o700,exist_ok=True)
    spec=importlib.util.spec_from_file_location('reboots',ROOT/'scripts/verify-node-reboots.py')
    checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
    report={'observer':'s1','started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'PREPARING'}
    def save():
        tmp=STATE/'report.tmp';tmp.write_text(json.dumps(report,indent=2));tmp.replace(STATE/'report.json')
    save()
    try:
        if not checks.health():raise RuntimeError('Cluster unhealthy before drill')
        old=obj('get','node','a1')['status']['nodeInfo']['bootID']
        before=checks.smoke.insert_event('before-reboot-a1')
        report.update(status='ARMED',old_boot_id=old,before_event=before);save()
        started=time.monotonic();deadline=started+1500;changed_at=None;observed_not_ready=False
        while time.monotonic()<deadline:
            try:
                node=obj('get','node','a1');new=node['status']['nodeInfo']['bootID']
                observed_not_ready |= not any(c['type']=='Ready' and c['status']=='True' for c in node['status']['conditions'])
                if new!=old:
                    if changed_at is None:changed_at=time.monotonic()
                    if checks.health():break
            except Exception:pass
            time.sleep(5)
        else:raise RuntimeError('A1 reboot/recovery deadline exceeded')
        report.update(new_boot_id=new,boot_id_changed=True,observed_not_ready=observed_not_ready,
                      observer_elapsed_until_ready_seconds=round(time.monotonic()-started,2),
                      new_boot_seen_until_ready_seconds=round(time.monotonic()-changed_at,2))
        after=checks.smoke.insert_event('after-reboot-a1')
        report['events']=checks.smoke.consume_events([before,after],240)
        report['status']='PASS'
    except Exception as exc:
        report.update(status='FAIL',error_type=type(exc).__name__)
        raise
    finally:
        report['completed']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()

if __name__=='__main__':main()
