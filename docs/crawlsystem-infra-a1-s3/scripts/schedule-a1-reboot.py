#!/usr/bin/env python3
"""Arm the tested independent observer and schedule exactly one A1 reboot."""
import datetime, json, os, re, subprocess, time
from pathlib import Path
from infra_common import ROOT

STATE=Path('/var/lib/crawlsystem-a1-reboot')

def run(args,timeout=40):
    result=subprocess.run(args,capture_output=True,timeout=timeout)
    if result.returncode:raise RuntimeError('Acceptance orchestration command failed')
    return result.stdout.decode().strip()

def ssh(command):
    return run(['sudo','-u','ubuntu','ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','crawl-s1',command])

def main():
    if os.geteuid()!=0:raise RuntimeError('Run as root')
    os.umask(0o077);STATE.mkdir(mode=0o700,exist_ok=True)
    if any((STATE/f).exists() for f in ['pending.json','completed.json','failed.json']):
        raise RuntimeError('An A1 drill already exists; inspect its report before another run')
    external=json.loads((ROOT/'reports/external-ports.json').read_text())
    if external['status']!='PASS':raise RuntimeError('External acceptance not complete')
    run(['systemctl','is-enabled','crawlsystem-a1-complete.service'])
    run(['systemctl','is-active','k3s.service','crawlsystem-host-firewall.service','crawlsystem-backup.timer'])
    backup=json.loads(Path('/srv/crawl-backups/latest.json').read_text())
    if not backup.get('success') or time.time()-backup['completed_epoch']>3600:
        raise RuntimeError('A recent successful backup is required')
    old=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    ssh('sudo -n systemd-run --unit=crawlsystem-a1-observer --property=RuntimeMaxSec=1800 /usr/bin/python3 /home/ubuntu/crawlsystem-infra-a1-s3/scripts/verify-a1-from-s1.py')
    try:
        for _ in range(24):
            try:r=json.loads(ssh('sudo -n cat /var/lib/crawlsystem-a1-reboot/report.json'))
            except Exception:time.sleep(5);continue
            if r['status']=='FAIL':raise RuntimeError('S1 preflight failed')
            if r['status']=='ARMED' and r.get('old_boot_id')==old:break
            time.sleep(5)
        else:raise RuntimeError('Independent observer did not arm')
        pending={'old_boot_id':old,'observer':'s1','requested':datetime.datetime.now(datetime.timezone.utc).isoformat(),'delay_seconds':180}
        (STATE/'pending.json').write_text(json.dumps(pending,indent=2))
        run(['systemctl','stop','crawlsystem-observe.timer'])
        run(['systemctl','stop','crawlsystem-observe.service'],timeout=320)
        run(['systemd-run','--unit=crawlsystem-a1-reboot-trigger','--on-active=180s','/usr/bin/systemctl','reboot'])
        report={'status':'SCHEDULED','node':'a1',**pending,'expected_not_before':datetime.datetime.fromtimestamp(time.time()+180,datetime.timezone.utc).isoformat()}
        p=ROOT/'reports/a1-reboot-validation.json';p.write_text(json.dumps(report,indent=2));p.chmod(0o644)
        checklist=ROOT/'DEPLOYMENT-CHECKLIST.md'
        text=re.sub(r'^\| INFRA-29 \|.*$', '| INFRA-29 | N-1及逐节点重启恢复边界 | PARTIAL | S1/S2/S3/A2/A3整机重启已通过；A1已安排延时重启，S1独立观察器已ARMED，开机续验将自动更新；当前结果见reports/a1-reboot-validation.json |',checklist.read_text(),flags=re.M)
        checklist.write_text(text)
        print(json.dumps(report))
    except Exception:
        subprocess.run(['systemctl','stop','crawlsystem-a1-reboot-trigger.timer'],capture_output=True)
        if (STATE/'pending.json').exists():(STATE/'pending.json').unlink()
        subprocess.run(['systemctl','start','crawlsystem-observe.timer'],capture_output=True)
        try:ssh('sudo -n systemctl stop crawlsystem-a1-observer.service')
        except Exception:pass
        raise

if __name__=='__main__':main()
