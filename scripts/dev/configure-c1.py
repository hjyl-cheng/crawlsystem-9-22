#!/usr/bin/env python3
"""Provision only the C1 delivery topics, identities and connector; never print credentials."""
import base64,json,subprocess,urllib.request,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def k(*args,data=None):
 return subprocess.check_output(['kubectl',*args],input=data,stderr=subprocess.DEVNULL)
def obj(*args):return json.loads(k(*args,'-o','json'))
def apply(o):k('apply','-f','-',data=json.dumps(o).encode())
def secret(ns,name,data):apply({'apiVersion':'v1','kind':'Secret','metadata':{'namespace':ns,'name':name},'type':'Opaque','stringData':data})
for topic in ['business.delivery','business.receipts','dlq.delivery','business-heartbeat.c1']:
 apply({'apiVersion':'kafka.strimzi.io/v1','kind':'KafkaTopic','metadata':{'namespace':'kafka','name':topic,'labels':{'strimzi.io/cluster':'crawler-kafka'}},'spec':{'topicName':topic,'partitions':3,'replicas':3,'config':{'retention.ms':604800000,'max.message.bytes':4194304,'min.insync.replicas':2}}})
 k('-n','kafka','wait','--for=condition=Ready','kafkatopic/'+topic,'--timeout=90s')
for name,ns,permissions in [
 ('business-sink','ingest',{'business.delivery':['Read','Describe'],'business.receipts':['Write','Describe'],'dlq.delivery':['Write','Describe']}),
 ('delivery-receipts','control',{'business.receipts':['Read','Describe']})]:
 acls=[{'resource':{'type':'topic','name':t,'patternType':'literal'},'operations':ops,'host':'*'} for t,ops in permissions.items()]
 acls.append({'resource':{'type':'group','name':name,'patternType':'literal'},'operations':['Read'],'host':'*'})
 if name=='business-sink':acls.append({'resource':{'type':'cluster'},'operations':['IdempotentWrite'],'host':'*'})
 apply({'apiVersion':'kafka.strimzi.io/v1','kind':'KafkaUser','metadata':{'namespace':'kafka','name':name,'labels':{'strimzi.io/cluster':'crawler-kafka'}},'spec':{'authentication':{'type':'scram-sha-512'},'authorization':{'type':'simple','acls':acls}}})
 k('-n','kafka','wait','--for=condition=Ready','kafkauser/'+name,'--timeout=90s')
 d=obj('-n','kafka','get','secret',name)['data'];ca=obj('-n','kafka','get','secret','crawler-kafka-cluster-ca-cert')['data']['ca.crt']
 secret(ns,'kafka-'+name,{'username':name,'password':base64.b64decode(d['password']).decode(),'ca.crt':base64.b64decode(ca).decode(),'bootstrap':'crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093'})
connect_user=obj('-n','kafka','get','kafkauser','dbz-connect')
for topic in ['business.delivery','business-heartbeat.c1']:
 acl={'resource':{'type':'topic','name':topic,'patternType':'literal'},'operations':['Write','Describe'],'host':'*'}
 if acl not in connect_user['spec']['authorization']['acls']:connect_user['spec']['authorization']['acls'].append(acl)
apply(connect_user)
k('-n','kafka','wait','--for=condition=Ready','kafkauser/dbz-connect','--timeout=90s')
# Existing infrastructure connector and its credential mounts remain present.
deployment=obj('-n','kafka','get','deployment','debezium-connect');spec=deployment['spec']['template']['spec']
if not any(v['name']=='c1-pg' for v in spec['volumes']):
 spec['volumes'].append({'name':'c1-pg','secret':{'secretName':'c1-cdc-pg'}})
 spec['containers'][0]['volumeMounts'].append({'name':'c1-pg','mountPath':'/etc/c1-pg','readOnly':True})
 apply(deployment)
k('-n','kafka','rollout','status','deployment/debezium-connect','--timeout=180s')
for ns in ['db','kafka']:
 ports=[5432] if ns=='db' else [9093]
 apply({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'namespace':ns,'name':'c1-delivery-access'},'spec':{'podSelector':{},'policyTypes':['Ingress'],'ingress':[{'from':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':n}},'podSelector':{'matchLabels':{'app.kubernetes.io/name':app}}} for n,app in [('ingest','business-sink'),('control','delivery-receipts')]],'ports':[{'port':p,'protocol':'TCP'} for p in ports]}]}})
host=obj('-n','kafka','get','service','debezium-connect')['spec']['clusterIP']
config={
 'connector.class':'io.debezium.connector.postgresql.PostgresConnector','tasks.max':'1',
 'database.hostname':'crawler-pg-rw.db.svc.cluster.local','database.port':'5432','database.user':'crawlsystem_c1_cdc','database.password':'${file:/etc/c1-pg/credentials.properties:password}',
 'database.dbname':'crawlsystem_m1_main_test','database.sslmode':'verify-full','database.sslrootcert':'/etc/pg-ca/ca.crt','plugin.name':'pgoutput','slot.name':'c1_delivery_slot','slot.failover':'true','publication.name':'c1_publication','publication.autocreate.mode':'disabled',
 'topic.prefix':'c1','table.include.list':'delivery.outbox','snapshot.mode':'initial','tombstones.on.delete':'false',
 'transforms':'outbox','transforms.outbox.type':'io.debezium.transforms.outbox.EventRouter','transforms.outbox.route.by.field':'aggregatetype','transforms.outbox.route.topic.replacement':'business.delivery','transforms.outbox.table.expand.json.payload':'true',
 'predicates':'outboxTable','predicates.outboxTable.type':'org.apache.kafka.connect.transforms.predicates.TopicNameMatches','predicates.outboxTable.pattern':r'^c1\.delivery\.outbox$', 'transforms.outbox.predicate':'outboxTable',
 'heartbeat.interval.ms':'60000','topic.heartbeat.prefix':'business-heartbeat','heartbeat.action.query':'INSERT INTO delivery.heartbeat(id,beat_at) VALUES(1,now()) ON CONFLICT(id) DO UPDATE SET beat_at=EXCLUDED.beat_at',
 'key.converter':'org.apache.kafka.connect.storage.StringConverter','value.converter':'org.apache.kafka.connect.json.JsonConverter','value.converter.schemas.enable':'false'}
k('-n','kafka','exec','-i','deployment/debezium-connect','--','curl','--fail','--silent','--show-error','--max-time','30','-X','PUT','-H','Content-Type: application/json','--data-binary','@-','http://127.0.0.1:8083/connectors/c1-delivery/config',data=json.dumps(config).encode())
(ROOT/'.runtime/c1/connector-config.json').write_text(json.dumps(config,indent=2))
print('C1 Kafka topics, scoped identities, network access and Debezium connector configured')
