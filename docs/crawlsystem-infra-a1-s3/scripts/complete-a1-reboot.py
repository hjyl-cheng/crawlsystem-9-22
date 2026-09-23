#!/usr/bin/env python3
"""Boot continuation: retrieve independent S1 evidence, smoke-test, restart observation."""
import datetime, fcntl, json, os, re, shutil, subprocess, time, urllib.request
from pathlib import Path
from infra_common import ROOT

STATE=Path('/var/lib/crawlsystem-a1-reboot')
OBS=Path('/var/lib/crawlsystem-observation')

def systemctl(*args):
    return subprocess.run(['systemctl',*args],check=True,capture_output=True,timeout=320)

def remote_report():
    result=subprocess.run(['sudo','-u','ubuntu','ssh','-o','BatchMode=yes','-o','ConnectTimeout=5',
        'crawl-s1','sudo -n cat /var/lib/crawlsystem-a1-reboot/report.json'],capture_output=True,timeout=20)
    if result.returncode:raise RuntimeError('S1 observer not reachable')
    return json.loads(result.stdout)

def current_boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def main():
    os.umask(0o077)
    pending=STATE/'pending.json'
    if not pending.exists():return
    expected=json.loads(pending.read_text())
    boot=current_boot_id()
    # The unit may be checked on the old boot; that must not consume the request.
    if boot==expected['old_boot_id']:
        print('Waiting for an actual new boot');return
    report={'node':'a1','started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'RUNNING'}
    path=ROOT/'reports/a1-reboot-validation.json'
    def save():
        tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(report,indent=2));tmp.chmod(0o644);tmp.replace(path)
    save();systemctl('stop','crawlsystem-observe.timer');systemctl('stop','crawlsystem-observe.service')
    try:
        deadline=time.monotonic()+1500
        while time.monotonic()<deadline:
            try:r=remote_report()
            except Exception:time.sleep(5);continue
            if r.get('old_boot_id')!=expected['old_boot_id']:
                raise RuntimeError('S1 report does not match requested boot')
            if r['status']=='FAIL':raise RuntimeError('Independent S1 observer failed')
            if r['status']=='PASS':break
            time.sleep(5)
        else:raise RuntimeError('Independent observer timed out')
        if r.get('new_boot_id')!=boot:raise RuntimeError('New boot evidence mismatch')
        report['independent_observer']=r
        systemctl('is-active','k3s.service','crawlsystem-host-firewall.service','crawlsystem-backup.timer')
        with urllib.request.urlopen('http://127.0.0.1:2381/health',timeout=10) as response:
            etcd=json.load(response)
        if etcd.get('health') not in (True,'true'):raise RuntimeError('A1 etcd unhealthy after reboot')
        report['a1_etcd_health']=True
        smoke=subprocess.run(['/usr/bin/python3',str(ROOT/'scripts/infra-smoke.py')],capture_output=True,timeout=360)
        if smoke.returncode:raise RuntimeError('Post-reboot end-to-end checks failed')
        report['post_reboot_smoke']=json.loads(smoke.stdout)
        # Keep the earlier samples intact as drill-era evidence, then run two fresh 24h phases.
        with (OBS/'lock').open('w') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX)
            archive=OBS/'archives'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            archive.mkdir(parents=True,mode=0o700)
            for name in ('started.json','samples.jsonl'):
                if (OBS/name).exists():shutil.move(str(OBS/name),str(archive/name))
            shutil.copy2(ROOT/'reports/observation-latest.json',archive/'observation-latest.json')
            report['previous_observation_archive']=str(archive)
        systemctl('start','crawlsystem-observe.timer')
        systemctl('start','crawlsystem-observe.service')
        report.update(status='PASS',boot_id_changed=True,host_firewall_and_k3s_active=True,
                      completed=datetime.datetime.now(datetime.timezone.utc).isoformat())
        save()
        combined_path=ROOT/'reports/node-reboot-validation.json'
        combined=json.loads(combined_path.read_text());combined['a1']='PASS: independent S1 observer plus A1 boot continuation'
        combined['nodes']=[x for x in combined['nodes'] if x['node']!='a1']+[report]
        combined_path.write_text(json.dumps(combined,indent=2))
        checklist=ROOT/'DEPLOYMENT-CHECKLIST.md'
        text=checklist.read_text()
        text=re.sub(r'^\| INFRA-29 \|.*$', '| INFRA-29 | N-1及逐节点重启恢复边界 | PASS | 六台整机重启均已验证；A1由S1独立观测boot ID变化、服务恢复及前后CDC事件，启动后验证CH与Temporal；见reports/a1-reboot-validation.json；不代表零中断 |',text,flags=re.M)
        checklist.write_text(text)
        progress=ROOT/'reports/DEPLOYMENT-PROGRESS.md'
        content=progress.read_text().replace('3. A1完整操作系统重启：独立S1观察器和A1开机续验已准备，状态以reports/a1-reboot-validation.json为准。','A1完整操作系统重启已通过：S1独立观测，启动后自动验证；见reports/a1-reboot-validation.json。')
        content=content.replace('A1完整操作系统重启未执行。','A1完整操作系统重启随后通过，见reports/a1-reboot-validation.json。')
        progress.write_text(content)
        operations=ROOT/'OPERATIONS.md'
        text=operations.read_text().replace('A1 重启验收当前以 reports/a1-reboot-validation.json 为准，尚未标记通过。','A1 重启验收已通过；独立 S1 观测及启动后检查证据见 reports/a1-reboot-validation.json。')
        operations.write_text(text)
        pending.rename(STATE/'completed.json')
    except Exception as exc:
        report.update(status='FAIL',error_type=type(exc).__name__,completed=datetime.datetime.now(datetime.timezone.utc).isoformat());save()
        pending.rename(STATE/'failed.json')
        raise
    finally:
        systemctl('start','crawlsystem-observe.timer')

if __name__=='__main__':main()
