"""Synthetic rule evaluation only: no production metrics or notification writes."""
import json, os, subprocess, uuid
from pathlib import Path
import yaml
env={**os.environ,'K3S_CONFIG_FILE':'/dev/null','KUBECTL_REMOTE_COMMAND_WEBSOCKETS':'false'}
rules=Path('apps/control-api/deploy/business-alerts.yaml').read_text()
metadata={r['alert']:r for g in yaml.safe_load(rules)['groups'] for r in g['rules']}
base={'up{job="crawlsystem-control-preview",pod="a"}':1,'up{job="crawlsystem-control-preview",pod="b"}':1,
 'm1_oldest_intent_seconds{state="PENDING"}':0,'m1_overdue_plans{state="ACTIVE"}':0,
 'm1_pipeline_oldest_pending_seconds{state="PENDING"}':0,'m1_delivery_oldest_pending_seconds{state="PENDING"}':0,
 'm1_delivery_failed{state="FAILED"}':0,'m1_real_active_plans{state="ACTIVE"}':0,
 'm1_ready_workers{state="RUNNING"}':0,'m1_healthy_proxies{state="HEALTHY"}':0}
cases=[('idle',{},[]),('one control replica down',{'up{job="crawlsystem-control-preview",pod="a"}':0},[]),
 ('normal pipeline wait',{'m1_pipeline_oldest_pending_seconds{state="PENDING"}':599},[]),
 ('intent backlog',{'m1_oldest_intent_seconds{state="PENDING"}':301},['CrawlIntentDispatchDelayed']),
 ('overdue task',{'m1_overdue_plans{state="ACTIVE"}':1},['CrawlPlansPastDeadline']),
 ('pipeline stuck',{'m1_pipeline_oldest_pending_seconds{state="PENDING"}':601},['CrawlPipelineIngestionDelayed']),
 ('delivery delayed',{'m1_delivery_oldest_pending_seconds{state="PENDING"}':601},['CrawlDeliveryDelayed']),
 ('delivery failed',{'m1_delivery_failed{state="FAILED"}':1},['CrawlDeliveryFailed']),
 ('no worker with work',{'m1_real_active_plans{state="ACTIVE"}':1},['CrawlNoReadyWorker']),
 ('no proxy with work',{'m1_real_active_plans{state="ACTIVE"}':1,'m1_ready_workers{state="RUNNING"}':2},['CrawlNoHealthyProxy']),
 ('both replicas down',{'up{job="crawlsystem-control-preview",pod="a"}':0,'up{job="crawlsystem-control-preview",pod="b"}':0},['CrawlControlMetricsUnavailable'])]
tests=[]
for title,overrides,fired in cases:
 values={**base,**overrides}; checks=[]
 for at in ['1m','15m']:
  for name,r in metadata.items():
   checks.append({'eval_time':at,'alertname':name,'exp_alerts':[{'exp_labels':r['labels'],'exp_annotations':r['annotations']}] if at=='15m' and name in fired else []})
 tests.append({'name':title,'interval':'1m','input_series':[{'series':k,'values':f'{v}+0x20'} for k,v in values.items()],'alert_rule_test':checks})
tests.append({'name':'missing targets','interval':'1m','input_series':[],'alert_rule_test':[{'eval_time':'10m','alertname':'CrawlControlMetricsUnavailable','exp_alerts':[{'exp_labels':metadata['CrawlControlMetricsUnavailable']['labels'],'exp_annotations':metadata['CrawlControlMetricsUnavailable']['annotations']}]}]})
directory='/tmp/crawl-alert-check-'+uuid.uuid4().hex
def k(args,data=None):
 p=subprocess.run(['kubectl','-n','monitoring','exec','-i','deployment/prometheus','--',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=60)
 if p.returncode: raise RuntimeError(p.stdout+p.stderr)
 return p.stdout
try:
 k(['mkdir','-p',directory])
 for name,content in [('business.yaml',rules),('test.yaml',yaml.safe_dump({'rule_files':[directory+'/business.yaml'],'evaluation_interval':'1m','tests':tests},sort_keys=False))]:k(['sh','-c','cat > '+directory+'/'+name],content)
 print(k(['promtool','test','rules',directory+'/test.yaml']).strip())
 print(json.dumps({'rule_scenarios':len(tests),'production_notification_writes':0}))
finally:k(['rm','-rf',directory])
