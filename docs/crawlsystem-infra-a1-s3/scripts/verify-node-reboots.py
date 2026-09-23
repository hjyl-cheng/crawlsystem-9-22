#!/usr/bin/env python3
"""Sequential reboot recovery checks for remote nodes. Never reboots this controller A1."""
import datetime,importlib.util,json,subprocess,time,urllib.request
from infra_common import ROOT,k,obj,pg_primary,sql,forward
spec=importlib.util.spec_from_file_location('infra_smoke',ROOT/'scripts/infra-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)

def ssh(node,command,timeout=20):
 p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=4','-o','ConnectionAttempts=1','crawl-'+node,command],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)
 if p.returncode:raise RuntimeError('SSH unavailable: '+node)
 return p.stdout.decode().strip()

def health():
 cluster=obj('-n','db','get','cluster','crawler-pg')['status']
 if cluster.get('readyInstances')!=2 or cluster.get('phase')!='Cluster in healthy state':return False
 kafka=obj('-n','kafka','get','kafka','crawler-kafka')
 if not any(c['type']=='Ready' and c['status']=='True' for c in kafka['status']['conditions']):return False
 nodes=obj('get','nodes')['items']
 if len(nodes)!=6:return False
 if not all(any(c['type']=='Ready' and c['status']=='True' for c in n['status']['conditions']) for n in nodes):return False
 pods=obj('get','pods','-A')['items']
 if any(p['status']['phase'] not in ['Succeeded'] and not p['metadata'].get('deletionTimestamp') and not any(c['type']=='Ready' and c['status']=='True' for c in p['status'].get('conditions',[])) for p in pods):return False
 with forward('kafka','svc/debezium-connect',8083) as port:
  r=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/connectors/infra-outbox/status',timeout=10))
  if r['connector']['state']!='RUNNING' or len(r['tasks'])!=1 or r['tasks'][0]['state']!='RUNNING':return False
 return True

def main():
 assert (ROOT/'reports/local-restore.json').exists()
 assert json.loads((ROOT/'reports/failover-validation.json').read_text())['tests']['postgres_switchover']['status']=='PASS'
 report={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'nodes':[],'a1':'NOT_RUN: active administration host; kernel reboot requires independent execution path','limits':'Two-PG strict synchronous writes can block while either database node is unavailable; ClickHouse and monitoring are single-node services.'}
 import sys
 if '--resume' in sys.argv and (ROOT/'reports/node-reboot-validation.json').exists():
  report=json.loads((ROOT/'reports/node-reboot-validation.json').read_text())
 completed={r['node'] for r in report['nodes'] if r.get('status')=='PASS'}
 for node in ['s1','s2','s3','a2','a3']:
  if node in completed: continue
  assert health(),'Cluster unhealthy before reboot; stop'
  old=ssh(node,'cat /proc/sys/kernel/random/boot_id')
  marker=smoke.insert_event('before-reboot-'+node)
  print('REBOOT_START '+node,flush=True);began=time.monotonic()
  ssh(node,'sudo -n systemd-run --unit=crawl-reboot-acceptance --on-active=5s /usr/bin/systemctl reboot')
  new=old;last_error=None
  for _ in range(120):
   time.sleep(5)
   try:
    new=ssh(node,'cat /proc/sys/kernel/random/boot_id')
    if new!=old and health():break
   except (RuntimeError,subprocess.TimeoutExpired,OSError,KeyError):pass
  else:raise RuntimeError('Node recovery timeout: '+node)
  recovered=round(time.monotonic()-began,2)
  after=smoke.insert_event('after-reboot-'+node);events=smoke.consume_events([marker,after],240)
  service='k3s' if node in ['s1','s2'] else 'k3s-agent'
  status=ssh(node,f'systemctl is-active {service} crawlsystem-host-firewall.service')
  assert status.splitlines()==['active','active']
  row={'node':node,'status':'PASS','boot_id_changed':new!=old,'all_workloads_ready_seconds':recovered,'events':events,'host_firewall_and_k3s_active':True}
  report['nodes'].append(row);(ROOT/'reports/node-reboot-validation.json').write_text(json.dumps(report,indent=2));print('REBOOT_PASS '+node+' '+str(recovered)+'s',flush=True)
 report['completed']=datetime.datetime.now(datetime.timezone.utc).isoformat();(ROOT/'reports/node-reboot-validation.json').write_text(json.dumps(report,indent=2))
if __name__=='__main__':main()
