#!/usr/bin/env python3
"""Generate local alert recording and provisioned operations dashboard."""
from pathlib import Path
import json,yaml
R=Path(__file__).resolve().parents[1]
code='''import http.server,json,logging,logging.handlers,os
os.makedirs('/data/journal',exist_ok=True)
logger=logging.getLogger('alerts');logger.setLevel(logging.INFO)
handler=logging.handlers.RotatingFileHandler('/data/journal/alerts.jsonl',maxBytes=16*1024*1024,backupCount=3)
logger.addHandler(handler)
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200 if self.path=='/health' else 404);self.end_headers()
 def do_POST(self):
  size=int(self.headers.get('Content-Length','0'))
  if self.path!='/alerts' or size>1048576:self.send_response(400);self.end_headers();return
  try:
   data=json.loads(self.rfile.read(size));logger.info(json.dumps(data));handler.flush()
   self.send_response(200);self.end_headers()
  except Exception:self.send_response(400);self.end_headers()
 def log_message(self,*args):pass
http.server.ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
'''
resources=[{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'alert-journal-code','namespace':'monitoring'},'data':{'server.py':code}},
{'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':'alert-journal','namespace':'monitoring'},'spec':{'replicas':1,'strategy':{'type':'Recreate'},'selector':{'matchLabels':{'app':'alert-journal'}},'template':{'metadata':{'labels':{'app':'alert-journal'}},'spec':{'automountServiceAccountToken':False,'nodeSelector':{'kubernetes.io/hostname':'a3'},'securityContext':{'runAsUser':65534,'runAsGroup':65534,'fsGroup':65534},'containers':[{'name':'journal','image':'python:3.14.3-alpine3.23','command':['python','/app/server.py'],'ports':[{'containerPort':8080}],'resources':{'requests':{'cpu':'10m','memory':'24Mi'},'limits':{'cpu':'100m','memory':'64Mi'}},'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'code','mountPath':'/app','readOnly':True},{'name':'data','mountPath':'/data'}],'readinessProbe':{'httpGet':{'path':'/health','port':8080}}}],'volumes':[{'name':'code','configMap':{'name':'alert-journal-code'}},{'name':'data','persistentVolumeClaim':{'claimName':'alertmanager-data'}}]}}}},
{'apiVersion':'v1','kind':'Service','metadata':{'name':'alert-journal','namespace':'monitoring'},'spec':{'selector':{'app':'alert-journal'},'ports':[{'name':'http','port':8080,'targetPort':8080}]}},
{'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'alert-journal','namespace':'monitoring'},'spec':{'podSelector':{'matchLabels':{'app':'alert-journal'}},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{'matchLabels':{'app':'alertmanager'}}}],'ports':[{'protocol':'TCP','port':8080}]}]}}]
(R/'manifests/53-alert-journal.yaml').write_text(yaml.safe_dump_all(resources,sort_keys=False))
p=R/'manifests/50-monitoring.yaml';docs=list(yaml.safe_load_all(p.read_text()));cm=next(x for x in docs if x['metadata']['name']=='alertmanager-config')
previous_alert_config=yaml.safe_load(cm['data']['alertmanager.yaml'])
cm['data']['alertmanager.yaml']=yaml.safe_dump({'route':{'receiver':'local-journal','group_by':['alertname','node'],'group_wait':'15s','group_interval':'5m','repeat_interval':'4h','routes':[{'matchers':['alertname="InfraAcceptanceTest"'],'receiver':'local-journal','group_wait':'1s','group_interval':'10s','repeat_interval':'1h'}]},'receivers':[{'name':'local-journal','webhook_configs':[{'url':'http://alert-journal.monitoring.svc.cluster.local:8080/alerts','send_resolved':True}]}]},sort_keys=False)
# Preserve an already configured DingTalk receiver on regeneration.
previous_webhooks=[w for r in previous_alert_config.get('receivers',[]) if r['name']=='local-journal' for w in r.get('webhook_configs',[]) if w.get('url')=='http://alert-dingtalk.monitoring.svc.cluster.local:8080/alerts']
if previous_webhooks:
 alert_config=yaml.safe_load(cm['data']['alertmanager.yaml']);alert_config['receivers'][0]['webhook_configs'].extend(previous_webhooks)
 cm['data']['alertmanager.yaml']=yaml.safe_dump(alert_config,sort_keys=False)
# A durable dashboard uses only provisioned Prometheus/Loki datasources.
panels=[]
for idx,(title,expr,unit) in enumerate([
 ('节点 Ready 数','crawl_nodes_ready','short'),('监控目标在线比例','sum(up) / count(up)','percentunit'),('最近成功备份距今','time() - crawl_backup_last_success_timestamp_seconds','s'),('CDC 运行状态','crawl_cdc_running','short'),
 ('节点可用内存','node_memory_MemAvailable_bytes','bytes'),('节点磁盘可用空间','node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}','bytes'),('PG 复制槽滞留','crawl_pg_slot_retained_bytes','bytes'),('Kafka 不同步分区','kafka_server_replicamanager_underreplicatedpartitions','short'),('Kafka 消费积压','kafka_consumergroup_lag','short'),('节点 CPU 使用率','1 - avg by(instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))','percentunit'),('巡检错误数','crawl_observation_errors','short'),('PG 同步备库数','crawl_pg_streaming_standbys','short')]):
 panels.append({'id':idx+1,'title':title,'type':'stat' if idx<4 else 'timeseries','gridPos':{'h':6,'w':6 if idx<4 else 12,'x':(idx%4)*6 if idx<4 else ((idx-4)%2)*12,'y':0 if idx<4 else 6+((idx-4)//2)*6},'datasource':{'type':'prometheus','uid':'prometheus'},'targets':[{'refId':'A','expr':expr,'legendFormat':'{{instance}} {{topic}}'}],'fieldConfig':{'defaults':{'unit':unit},'overrides':[]}})
dashboard={'uid':'crawl-infrastructure','title':'Crawl 基础设施','schemaVersion':39,'version':1,'refresh':'30s','time':{'from':'now-6h','to':'now'},'panels':panels,'tags':['infrastructure','development']}
cm_dash={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'grafana-dashboards','namespace':'monitoring'},'data':{'infrastructure.json':json.dumps(dashboard,ensure_ascii=False)}}
cm_provider={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'grafana-dashboard-provider','namespace':'monitoring'},'data':{'provider.yaml':yaml.safe_dump({'apiVersion':1,'providers':[{'name':'infrastructure','orgId':1,'folder':'Infrastructure','type':'file','disableDeletion':True,'editable':False,'options':{'path':'/var/lib/grafana-dashboards'}}]})}}
(R/'manifests/54-grafana-dashboards.yaml').write_text(yaml.safe_dump_all([cm_dash,cm_provider],sort_keys=False,allow_unicode=True))
g=next(x for x in docs if x['kind']=='Deployment' and x['metadata']['name']=='grafana')['spec']['template']['spec']
for name,mount,cmname in [('dashboards','/var/lib/grafana-dashboards','grafana-dashboards'),('dashboard-provider','/etc/grafana/provisioning/dashboards','grafana-dashboard-provider')]:
 if not any(v['name']==name for v in g['volumes']):
  g['volumes'].append({'name':name,'configMap':{'name':cmname}});g['containers'][0]['volumeMounts'].append({'name':name,'mountPath':mount,'readOnly':True})
p.write_text(yaml.safe_dump_all(docs,sort_keys=False,allow_unicode=True))
