#!/usr/bin/env python3
"""Read-only final component checks after recovery drills."""
import base64,concurrent.futures,datetime,json,subprocess,urllib.parse,urllib.request
from infra_common import ROOT,obj,k,sql,pg_primary,forward,clickhouse

def main():
 report={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 nodes=obj('get','nodes')['items'];report['nodes_ready']=sum(any(c['type']=='Ready' and c['status']=='True' for c in n['status']['conditions']) for n in nodes)
 pods=obj('get','pods','-A')['items'];report['pods_not_ready']=[p['metadata']['namespace']+'/'+p['metadata']['name'] for p in pods if p['status']['phase']!='Succeeded' and not any(c['type']=='Ready' and c['status']=='True' for c in p['status'].get('conditions',[]))]
 def etcd(node):
  args=['curl','-fsS','http://127.0.0.1:2381/health'] if node=='a1' else ['ssh','-o','BatchMode=yes','crawl-'+node,'curl -fsS http://127.0.0.1:2381/health']
  r=json.loads(subprocess.check_output(args,timeout=15));return node,r
 with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:report['etcd']=dict(ex.map(etcd,['a1','s1','s2']))
 report['pg_primary']=pg_primary();report['pg_standby']=sql(report['pg_primary'],'postgres',"SELECT json_agg(json_build_object('state',state,'sync_state',sync_state)) FROM pg_stat_replication")
 with forward('monitoring','svc/prometheus',9090) as port:
  base=f'http://127.0.0.1:{port}'
  targets=json.load(urllib.request.urlopen(base+'/api/v1/targets'))['data']['activeTargets'];report['prometheus']={'total':len(targets),'up':sum(t['health']=='up' for t in targets)}
  for label,query in [('kafka_isr_min','min(kafka_topic_partition_in_sync_replica)'),('kafka_underreplicated','sum(kafka_server_replicamanager_underreplicatedpartitions)'),('backup_timestamp','crawl_backup_last_success_timestamp_seconds'),('collector_errors','crawl_observation_errors')]:
   rows=json.load(urllib.request.urlopen(base+'/api/v1/query?'+urllib.parse.urlencode({'query':query})))['data']['result'];report[label]=[x['value'][1] for x in rows]
 with forward('monitoring','svc/grafana',3000) as port:
  headers={'Authorization':'Basic '+base64.b64encode(b'admin:'+(ROOT/'secrets/grafana.password').read_bytes().strip()).decode()}
  data=json.load(urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/dashboards/uid/crawl-infrastructure',headers=headers)));report['grafana_dashboard']={'uid':data['dashboard']['uid'],'panels':len(data['dashboard']['panels'])}
 with forward('monitoring','svc/loki',3100) as port:
  report['loki_ready']=urllib.request.urlopen(f'http://127.0.0.1:{port}/ready').status==200
  report['loki_nodes']=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/loki/api/v1/label/node/values'))['data']
 with forward('kafka','svc/debezium-connect',8083) as port:
  r=json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/connectors/infra-outbox/status'));report['cdc']={'connector':r['connector']['state'],'tasks':[t['state'] for t in r['tasks']]}
 with clickhouse() as q:report['clickhouse_version']=q('SELECT version()').strip()
 report['backup_timer']=subprocess.check_output(['systemctl','is-enabled','crawlsystem-backup.timer']).decode().strip()
 report['observation_timer']=subprocess.check_output(['systemctl','is-enabled','crawlsystem-observe.timer']).decode().strip()
 report['pass']=report['nodes_ready']==6 and not report['pods_not_ready'] and all(v.get('health')=='true' for v in report['etcd'].values()) and report['prometheus']['total']==report['prometheus']['up'] and report['kafka_isr_min']==['3'] and report['kafka_underreplicated']==['0'] and report['collector_errors']==['0'] and bool(report['backup_timestamp']) and report['cdc']=={'connector':'RUNNING','tasks':['RUNNING']} and report['loki_ready'] and len(report['loki_nodes'])==6 and any(x['state']=='streaming' and x['sync_state'] in ['sync','quorum'] for x in (json.loads(report['pg_standby']) or []))
 (ROOT/'reports/final-operations-check.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));assert report['pass']
if __name__=='__main__':main()
