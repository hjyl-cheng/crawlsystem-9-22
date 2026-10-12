"""Merge MinIO scrapes and capacity rules; audit retention without deleting objects."""
import hashlib, json, os, subprocess, sys, time, urllib.parse, uuid
from pathlib import Path
import yaml

env={**os.environ,'K3S_CONFIG_FILE':'/dev/null','KUBECTL_REMOTE_COMMAND_WEBSOCKETS':'false'}
root=Path('.runtime/storage-capacity');root.mkdir(parents=True,exist_ok=True,mode=0o700)
def save(name,value,exclusive=False):
    file=root/(name+'.json')
    with file.open('x' if exclusive else 'w') as out: json.dump(value,out,indent=2);out.write('\n')
    file.chmod(0o600)
def k(*args,data=None,timeout=30):
    p=subprocess.run(['kubectl',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=timeout)
    if p.returncode:raise RuntimeError('Storage monitoring administration failed')
    return p.stdout
def prom(path):
    return json.loads(k('-n','monitoring','exec','deployment/prometheus','--','wget','-T','10','-qO-','http://127.0.0.1:9090'+path))
def query(expr):return prom('/api/v1/query?query='+urllib.parse.quote(expr,safe=''))['data']['result']
def lifecycle():
    # The root credentials stay within the existing Pod, with a private temporary
    # mc config removed on exit. No credentials or object contents are returned.
    config='/tmp/capacity-audit-'+uuid.uuid4().hex
    script='''set -eu
umask 077
export MC_CONFIG_DIR="'''+config+'''"
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
mc alias set audit http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
for bucket in crawl-raw crawl-parsed crawl-evidence; do
  mc ilm export "audit/$bucket" --json || true
  mc quota info "audit/$bucket" --json
  mc version info "audit/$bucket" --json
done
'''
    rows=[json.loads(line) for line in k('-n','storage','exec','-i','deployment/minio','--','sh',data=script).splitlines() if line.strip()]
    assert len(rows)==9
    result=[]
    for i,(bucket,days,quota) in enumerate([('crawl-raw',None,60*1024**3),('crawl-parsed',90,15*1024**3),('crawl-evidence',90,5*1024**3)]):
        ilm,limit,version=rows[i*3:i*3+3]
        ilm=ilm.get('config',ilm)
        if bucket=='crawl-raw':
            assert ilm.get('Rules')==[] or 'NoSuchLifecycleConfiguration' in json.dumps(ilm)
        else:
            rules=ilm['Rules'];assert len(rules)==1 and rules[0]['Status']=='Enabled' and rules[0]['Expiration']['Days']==days
            assert not rules[0].get('Filter') and not rules[0].get('Prefix')
        assert limit['status']=='success' and limit['bucket']==bucket and limit['quota']==quota and limit['type']=='hard'
        assert version['status']=='success' and version['versioning']['status']!='Enabled'
        result.append({'bucket':bucket,'expiration_days':days,'retention_rule':'successful_completion_and_ingestion_plus_24h' if bucket=='crawl-raw' else 'upload_age','quota_bytes':quota,'quota_type':'hard','versioning_enabled':False})
    save('lifecycle-current',{'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'rules':result,'objects_deleted_by_audit':0,'actual_expiry_acceptance':'STATE_DRIVEN_RAW_SEPARATELY_VERIFIED'})
    return result
def merge(cm,key,value):
    # Test resourceVersion, then update only this key. Preserve other data and
    # metadata; do not reapply the historical full infrastructure manifest.
    patch=[{'op':'test','path':'/metadata/resourceVersion','value':cm['metadata']['resourceVersion']},{'op':'add','path':'/data/'+key.replace('~','~0').replace('/','~1'),'value':value}]
    k('-n','monitoring','patch','configmap',cm['metadata']['name'],'--type=json','--dry-run=server','-p',json.dumps(patch))
    k('-n','monitoring','patch','configmap',cm['metadata']['name'],'--type=json','-p',json.dumps(patch))
def deploy():
    config=json.loads(k('-n','monitoring','get','configmap','prometheus-config','-o','json'))
    rules=json.loads(k('-n','monitoring','get','configmap','prometheus-rules','-o','json'))
    for name,value in [('previous-prometheus-config',config),('previous-prometheus-rules',rules)]:
        if not (root/(name+'.json')).exists():save(name,value,True)
    current=yaml.safe_load(config['data']['prometheus.yaml'])
    additions=yaml.safe_load(Path('apps/control-api/deploy/storage-capacity-scrapes.yaml').read_text())['scrape_configs']
    names={c['job_name'] for c in additions}
    existing=[c for c in current['scrape_configs'] if c['job_name'] not in names]
    current['scrape_configs']=existing+additions
    content=yaml.safe_dump(current,sort_keys=False)
    capacity=Path('apps/control-api/deploy/storage-capacity-alerts.yaml').read_text()
    temporary='/tmp/storage-config-'+uuid.uuid4().hex+'.yaml'
    try:
        k('-n','monitoring','exec','-i','deployment/prometheus','--','sh','-c','umask 077; cat > '+temporary,data=content)
        k('-n','monitoring','exec','deployment/prometheus','--','promtool','check','config',temporary)
        k('-n','monitoring','exec','-i','deployment/prometheus','--','promtool','check','rules','/dev/stdin',data=capacity)
    finally:k('-n','monitoring','exec','deployment/prometheus','--','rm','-f',temporary)
    lifecycle()  # Refuse publication if live rules or quotas differ from expectations.
    merge(rules,'storage-capacity.yaml',capacity)
    merge(config,'prometheus.yaml',content)
    deadline=time.monotonic()+150
    while time.monotonic()<deadline:
        try:
            config_ok=k('-n','monitoring','exec','deployment/prometheus','--','cat','/etc/prometheus/prometheus.yaml')==content
            rules_ok=k('-n','monitoring','exec','deployment/prometheus','--','cat','/etc/prometheus/rules/storage-capacity.yaml')==capacity
            if config_ok and rules_ok:break
        except RuntimeError:pass
        time.sleep(2)
    else:raise RuntimeError('Storage monitoring projection timed out')
    k('-n','monitoring','exec','deployment/prometheus','--','kill','-HUP','1')
    save('monitoring-deployment',{'at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'previous_job_count':len(existing),'added_jobs':sorted(names),'alert_rules':6,'config_sha256':hashlib.sha256(content.encode()).hexdigest(),'rules_sha256':hashlib.sha256(capacity.encode()).hexdigest(),'minio_restart':False,'prometheus_restart':False})
def verify():
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        if len(query('up{job=~"minio-cluster|minio-buckets"} == 1'))==2 and len(query('minio_bucket_usage_total_bytes{job="minio-buckets"}'))==3:break
        time.sleep(3)
    else:raise RuntimeError('MinIO scrape targets not ready')
    current=yaml.safe_load(json.loads(k('-n','monitoring','get','configmap','prometheus-config','-o','json'))['data']['prometheus.yaml'])
    old=json.loads((root/'previous-prometheus-config.json').read_text());before=yaml.safe_load(old['data']['prometheus.yaml'])
    for job in before['scrape_configs']:
        if job['job_name'] not in ['minio-cluster','minio-buckets']:assert job in current['scrape_configs']
    old_rules=json.loads((root/'previous-prometheus-rules.json').read_text())['data']
    rule_data=json.loads(k('-n','monitoring','get','configmap','prometheus-rules','-o','json'))['data']
    assert all(rule_data[name]==value for name,value in old_rules.items() if name!='storage-capacity.yaml')
    groups=prom('/api/v1/rules')['data']['groups'];group=next(g for g in groups if g['name']=='crawl-storage-capacity')
    assert len(group['rules'])==7 and all(r['health']=='ok' and not r.get('lastError') for r in group['rules'])
    metrics={name:[{'bucket':r['metric'].get('bucket'),'value':float(r['value'][1])} for r in query(expr)] for name,expr in {
        'bucket_bytes':'minio_bucket_usage_total_bytes{job="minio-buckets"}',
        'bucket_quota':'minio_bucket_quota_total_bytes{job="minio-buckets"}',
        'bucket_objects':'minio_bucket_usage_object_total{job="minio-buckets"}',
        'scan_age_seconds':'max(minio_usage_last_activity_nano_seconds{job="minio-cluster"})/1e9',
        'bucket_scans_finished':'max(minio_node_scanner_bucket_scans_finished{job="minio-cluster"})',
        'expiry_scanned_versions':'max(minio_node_ilm_versions_scanned{job="minio-cluster"})',
        'expiry_pending':'max(minio_node_ilm_expiry_pending_tasks{job="minio-cluster"})',
        'disk_free_bytes':'max(minio_cluster_capacity_usable_free_bytes{job="minio-cluster"})',
        'disk_total_bytes':'max(minio_cluster_capacity_usable_total_bytes{job="minio-cluster"})',
    }.items()}
    result={'result':'PASSED','at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'targets_up':2,'rules':[{'name':r['name'],'health':r['health'],'state':r.get('state')} for r in group['rules']],'metrics':metrics,'unrelated_jobs_and_rules_preserved':True,'lifecycle':lifecycle()}
    save('monitoring',result);print(json.dumps({'result':'PASSED','targets_up':2,'alert_rules':6,'unrelated_jobs_and_rules_preserved':True,'lifecycle_buckets':3}))
try:
    mode=sys.argv[1]
    if mode=='deploy':deploy();verify()
    elif mode=='verify':verify()
    else:raise ValueError('Usage: configure-storage-capacity deploy|verify')
except Exception as error:
    save('monitoring-failure',{'phase':sys.argv[1] if len(sys.argv)>1 else None,'error':type(error).__name__})
    print(json.dumps({'result':'FAILED','error':type(error).__name__}));sys.exit(1)
