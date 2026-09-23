#!/usr/bin/env python3
"""Bound host journal disk use on all six nodes without changing workload logging."""
import concurrent.futures,json,subprocess
from infra_common import ROOT
config=b'[Journal]\nSystemMaxUse=256M\nRuntimeMaxUse=64M\nSystemKeepFree=2G\nMaxRetentionSec=7day\n'
command="install -d -m 755 /etc/systemd/journald.conf.d && cat > /etc/systemd/journald.conf.d/90-crawlsystem.conf && systemctl restart systemd-journald && systemctl is-active systemd-journald"
def install(node):
 args=['sudo','-n','sh','-c',command] if node=='a1' else ['ssh','-o','BatchMode=yes','-o','ConnectTimeout=5','crawl-'+node,'sudo -n sh -c '+__import__('shlex').quote(command)]
 p=subprocess.run(args,input=config,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
 return {'node':node,'success':p.returncode==0 and p.stdout.strip()==b'active'}
if __name__=='__main__':
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:results=list(ex.map(install,['a1','a2','a3','s1','s2','s3']))
 (ROOT/'reports/host-journal-limits.json').write_text(json.dumps(results,indent=2));print(json.dumps(results));assert all(x['success'] for x in results)
