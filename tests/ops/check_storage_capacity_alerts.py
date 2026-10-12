"""Isolated Prometheus rule evaluation; never publish synthetic production metrics."""
import json, os, subprocess, uuid
from pathlib import Path
import yaml
env={**os.environ,'K3S_CONFIG_FILE':'/dev/null','KUBECTL_REMOTE_COMMAND_WEBSOCKETS':'false'}
rules=Path('apps/control-api/deploy/storage-capacity-alerts.yaml').read_text()
metadata={r['alert']:r for g in yaml.safe_load(rules)['groups'] for r in g['rules'] if 'alert' in r}
base={'up{job="minio-cluster"}':1,'up{job="minio-buckets"}':1,
      'minio_usage_last_activity_nano_seconds{job="minio-cluster"}':60000000000,
      'minio_cluster_capacity_usable_free_bytes{job="minio-cluster"}':50,
      'minio_cluster_capacity_usable_total_bytes{job="minio-cluster"}':100}
for bucket in ['crawl-raw','crawl-parsed','crawl-evidence']:
    for metric,value in [('usage_total_bytes',0),('quota_total_bytes',100),('usage_object_total',0)]:
        base['minio_bucket_'+metric+'{job="minio-buckets",bucket="'+bucket+'"}']=value
usage='minio_bucket_usage_total_bytes{job="minio-buckets",bucket="crawl-raw"}'
quota='minio_bucket_quota_total_bytes{job="minio-buckets",bucket="crawl-parsed"}'
cases=[('empty buckets',{},[]),('below warning',{usage:69},[]),
       ('warning boundary',{usage:70},[('CrawlMinioBucketCapacityWarning',{'bucket':'crawl-raw'})]),
       ('below critical',{usage:84},[('CrawlMinioBucketCapacityWarning',{'bucket':'crawl-raw'})]),
       ('critical boundary',{usage:85},[('CrawlMinioBucketCapacityCritical',{'bucket':'crawl-raw'})]),
       ('over quota',{usage:120},[('CrawlMinioBucketCapacityCritical',{'bucket':'crawl-raw'})]),
       ('one scrape stopped',{'up{job="minio-buckets"}':0},[('CrawlMinioMetricsUnavailable',{})]),
       ('missing scrape job',{'up{job="minio-buckets"}':None},[('CrawlMinioMetricsUnavailable',{})]),
       ('missing usage',{usage:None},[('CrawlMinioCapacityMetricsIncomplete',{})]),
       ('zero quota',{quota:0},[('CrawlMinioCapacityMetricsIncomplete',{})]),
       ('old scan',{'minio_usage_last_activity_nano_seconds{job="minio-cluster"}':21601*1e9},[('CrawlMinioUsageScanDelayed',{})]),
       ('disk low',{'minio_cluster_capacity_usable_free_bytes{job="minio-cluster"}':14},[('CrawlMinioDiskCapacityCritical',{})])]
tests=[]
for title,overrides,fired in cases:
    values={**base,**overrides};checks=[]
    for at in ['1m','25m']:
        for name,rule in metadata.items():
            alerts=[]
            if at=='25m':
                for alert,labels in fired:
                    if alert==name:
                        annotations={key:value.replace('{{ $labels.bucket }}',labels.get('bucket','')) for key,value in rule['annotations'].items()}
                        alerts.append({'exp_labels':{**rule['labels'],**labels},'exp_annotations':annotations})
            checks.append({'eval_time':at,'alertname':name,'exp_alerts':alerts})
    tests.append({'name':title,'interval':'1m','input_series':[{'series':key,'values':f'{value}+0x30'} for key,value in values.items() if value is not None],'alert_rule_test':checks})
tests.append({'name':'no targets','interval':'1m','input_series':[],'alert_rule_test':[{'eval_time':'25m','alertname':'CrawlMinioMetricsUnavailable','exp_alerts':[{'exp_labels':metadata['CrawlMinioMetricsUnavailable']['labels'],'exp_annotations':metadata['CrawlMinioMetricsUnavailable']['annotations']}]}]})
directory='/tmp/storage-alert-check-'+uuid.uuid4().hex
def k(args,data=None):
    p=subprocess.run(['kubectl','-n','monitoring','exec','-i','deployment/prometheus','--',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=60)
    if p.returncode:raise RuntimeError(p.stdout+p.stderr)
    return p.stdout
try:
    k(['mkdir','-p',directory])
    for name,content in [('rules.yaml',rules),('test.yaml',yaml.safe_dump({'rule_files':[directory+'/rules.yaml'],'evaluation_interval':'1m','tests':tests},sort_keys=False))]:k(['sh','-c','cat > '+directory+'/'+name],content)
    print(k(['promtool','test','rules',directory+'/test.yaml']).strip())
    print(json.dumps({'rule_scenarios':len(tests),'production_metric_or_notification_writes':0}))
finally:k(['rm','-rf',directory])
