#!/usr/bin/env python3
"""Install R5 scoped credentials, CH schema and Kafka ACLs. Never print secret values."""
import base64, hashlib, json, os, secrets, subprocess, sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'docs/crawlsystem-infra-a1-s3/scripts'))
from infra_common import k,obj,clickhouse
import infra_common
if not (infra_common.ROOT/'secrets/clickhouse.password').exists():
 infra_common.ROOT=Path('/home/ubuntu/workspace/newcrawsystem/docs/crawlsystem-infra-a1-s3')
D=ROOT/'.runtime/r5';D.mkdir(exist_ok=True,mode=0o700)
def credential(name):
 p=D/(name+'.password')
 if not p.exists():p.write_text(secrets.token_hex(32));p.chmod(0o600)
 return p.read_text().strip()
def secret(ns,name,data):
 k('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'Secret','metadata':{'namespace':ns,'name':name},'type':'Opaque','stringData':data}).encode())
ca=base64.b64decode(obj('-n','analytics','get','secret','clickhouse-tls')['data']['ca.crt']).decode()
with clickhouse() as q:
 for sql in (ROOT/'database/clickhouse/r5.sql').read_text().split(';'):
  if sql.strip():q(sql)
 for user,ns in [('crawl_writer','analytics'),('crawl_reader','control')]:
  password=credential(user)
  q(f"CREATE USER IF NOT EXISTS {user} IDENTIFIED WITH sha256_password BY '{password}'")
  q(f"GRANT SELECT ON crawl.* TO {user}")
  q(f"GRANT SELECT ON system.parts TO {user}")
  if user=='crawl_writer':q(f"GRANT INSERT ON crawl.* TO {user}")
  secret(ns,'clickhouse-r5',{'username':user,'password':password,'ca.crt':ca})
print('ClickHouse schema and separate read/write accounts configured')
acls=[]
for name,operations in [('ops.events',['Read','Write','Describe']),('dlq.parse',['Read','Describe']),('dlq.sink',['Read','Describe']),('crawl.raw',['Write','Describe']),('crawl.step',['Write','Describe'])]:
 acls.append({'resource':{'type':'topic','name':name,'patternType':'literal'},'operations':operations,'host':'*'})
acls.extend([{'resource':{'type':'group','name':'crawl-sink-ch','patternType':'literal'},'operations':['Read'],'host':'*'},
 {'resource':{'type':'cluster'},'operations':['IdempotentWrite'],'host':'*'}])
resource={'apiVersion':'kafka.strimzi.io/v1','kind':'KafkaUser','metadata':{'name':'crawl-sink-ch','namespace':'kafka','labels':{'strimzi.io/cluster':'crawler-kafka'}},
 'spec':{'authentication':{'type':'scram-sha-512'},'authorization':{'type':'simple','acls':acls}}}
k('apply','-f','-',data=json.dumps(resource).encode())
k('-n','kafka','wait','--for=condition=Ready','kafkauser/crawl-sink-ch','--timeout=90s')
current=obj('-n','kafka','get','secret','crawl-sink-ch')['data']
kafka_ca=obj('-n','kafka','get','secret','crawler-kafka-cluster-ca-cert')['data']['ca.crt']
secret('analytics','kafka-crawl-sink-ch',{'username':'crawl-sink-ch','password':base64.b64decode(current['password']).decode(),
 'ca.crt':base64.b64decode(kafka_ca).decode(),'bootstrap':'crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093'})
print('Kafka telemetry, DLQ and replay ACLs configured')
# A distinct MinIO user can read raw and preserve evidence. It cannot write raw or parsed.
minio_password=credential('minio_analytics')
secret('storage','minio-r5-analytics',{'access_key':'crawl-analytics','secret_key':minio_password})
secret('analytics','minio-crawl-analytics',{'access_key':'crawl-analytics','secret_key':minio_password})
policy={'Version':'2012-10-17','Statement':[{'Effect':'Allow','Action':['s3:GetObject'],'Resource':['arn:aws:s3:::crawl-raw/*']},
 {'Effect':'Allow','Action':['s3:GetObject','s3:PutObject'],'Resource':['arn:aws:s3:::crawl-evidence/*']}]}
script='''set -eu
export MC_CONFIG_DIR=/tmp/mc
mc alias set local http://minio.storage.svc.cluster.local:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
mc admin policy create local crawl-analytics /config/policy.json >/dev/null 2>&1
mc admin user add local crawl-analytics "$ANALYTICS_PASSWORD" >/dev/null 2>&1
mc admin policy attach local crawl-analytics --user crawl-analytics >/dev/null 2>&1
echo 'analytics evidence policy configured'
'''
k('apply','-f','-',data=json.dumps({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'minio-r5-setup','namespace':'storage'},'data':{'setup.sh':script,'policy.json':json.dumps(policy)}}).encode())
job={'apiVersion':'batch/v1','kind':'Job','metadata':{'name':'minio-r5-setup','namespace':'storage'},'spec':{'backoffLimit':1,'activeDeadlineSeconds':90,'template':{'metadata':{'labels':{'app.kubernetes.io/name':'minio-setup'}},'spec':{
 'restartPolicy':'Never','automountServiceAccountToken':False,'nodeSelector':{'kubernetes.io/hostname':'a1'},'securityContext':{'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000},
 'containers':[{'name':'setup','image':'minio/minio:RELEASE.2025-07-23T15-54-02Z','imagePullPolicy':'Never','command':['/bin/sh','/config/setup.sh'],
  'env':[{'name':name,'valueFrom':{'secretKeyRef':{'name':secret_name,'key':key}}} for name,secret_name,key in [('MINIO_ROOT_USER','minio-root','user'),('MINIO_ROOT_PASSWORD','minio-root','password'),('ANALYTICS_PASSWORD','minio-r5-analytics','secret_key')]],
  'resources':{'requests':{'cpu':'20m','memory':'32Mi'},'limits':{'cpu':'200m','memory':'128Mi'}},'volumeMounts':[{'name':'config','mountPath':'/config','readOnly':True},{'name':'tmp','mountPath':'/tmp'}]}],
 'volumes':[{'name':'config','configMap':{'name':'minio-r5-setup'}},{'name':'tmp','emptyDir':{'sizeLimit':'16Mi'}}]}}}}
k('-n','storage','delete','job','minio-r5-setup','--ignore-not-found')
k('apply','-f','-',data=json.dumps(job).encode());k('-n','storage','wait','--for=condition=complete','job/minio-r5-setup','--timeout=90s')
reader=obj('-n','control','get','secret','minio-crawl-reader')['data']
secret('control','minio-crawl-evidence-reader',{key:base64.b64decode(value).decode() for key,value in reader.items()})
print('Evidence access configured with a dedicated retention account')
# Measure actual Loki disk use on its node before increasing the retention window.
volume=obj('get','pv',obj('-n','monitoring','get','pvc','loki-data')['spec']['volumeName'])
path=volume['spec']['local']['path']
usage=int(subprocess.check_output(['ssh','crawl-a2','sudo','-n','du','-sk',path],stderr=subprocess.DEVNULL).decode().split()[0])*1024
capacity=5*1024**3
if usage*(7/3)>capacity*.8:raise RuntimeError('Loki needs additional capacity before extending retention')
config=obj('-n','monitoring','get','configmap','loki-config')
config['data']['loki.yaml']=config['data']['loki.yaml'].replace('retention_period: 72h','retention_period: 168h')
k('apply','-f','-',data=json.dumps(config).encode())
k('-n','monitoring','rollout','restart','deployment/loki')
(D/'loki-capacity.json').write_text(json.dumps({'bytes':usage,'capacity_bytes':capacity,'projected_7d_bytes':int(usage*7/3),'retention_days':7,'measured_at':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()},indent=2))
print(f'Loki capacity checked: {usage} bytes / {capacity} bytes; retention set to seven days')
