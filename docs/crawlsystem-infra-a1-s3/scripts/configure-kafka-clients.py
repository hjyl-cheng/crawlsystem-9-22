#!/usr/bin/env python3
import base64,json,subprocess
from pathlib import Path
R=Path(__file__).resolve().parents[1];D=R/'secrets';D.mkdir(exist_ok=True,mode=0o700)
def read_secret(name,key):
    d=json.loads(subprocess.check_output(['kubectl','-n','kafka','get','secret',name,'-o','json']))
    return base64.b64decode(d['data'][key]).decode()
def install(name,key,text):
    p=D/(name+'.properties');p.write_text(text);p.chmod(0o600)
    data=subprocess.check_output(['kubectl','-n','kafka','create','secret','generic',name,'--from-file',f'{key}={p}','--dry-run=client','-o','yaml'])
    subprocess.run(['kubectl','apply','-f','-'],input=data,check=True,stdout=subprocess.DEVNULL)
def auth(user,pwd,prefix=''):
    if any(x in pwd for x in ('\n','\r','\\','"')):raise ValueError('Unexpected password format; do not interpolate unsafe JAAS')
    return '\n'.join([prefix+'security.protocol=SASL_SSL',prefix+'sasl.mechanism=SCRAM-SHA-512',prefix+'ssl.truststore.type=PEM',prefix+'ssl.truststore.location=/etc/kafka-ca/ca.crt',prefix+'ssl.endpoint.identification.algorithm=https',prefix+f'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="{user}" password="{pwd}";'])+'\n'
pwd=read_secret('dbz-connect','password')
base="""bootstrap.servers=crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093
group.id=dbz-infra
config.storage.topic=dbz-infra-configs
offset.storage.topic=dbz-infra-offsets
status.storage.topic=dbz-infra-status
config.storage.replication.factor=3
offset.storage.replication.factor=3
status.storage.replication.factor=3
key.converter=org.apache.kafka.connect.storage.StringConverter
value.converter=org.apache.kafka.connect.json.JsonConverter
value.converter.schemas.enable=false
plugin.path=/kafka/connect
listeners=http://0.0.0.0:8083
rest.advertised.host.name=debezium-connect.kafka.svc.cluster.local
config.providers=file
config.providers.file.class=org.apache.kafka.common.config.provider.FileConfigProvider
producer.acks=all
producer.enable.idempotence=true
producer.compression.type=zstd
offset.flush.interval.ms=10000
# Single-worker deployment: do not wait five minutes for a missing worker.
scheduled.rebalance.max.delay.ms=0
task.shutdown.graceful.timeout.ms=30000
worker.sync.timeout.ms=30000
"""
base+=auth('dbz-connect',pwd)+auth('dbz-connect',pwd,'producer.')+auth('dbz-connect',pwd,'consumer.')+auth('dbz-connect',pwd,'admin.')
install('dbz-worker-config','worker.properties',base)
install('infra-reader-config','client.properties',auth('infra-reader',read_secret('infra-reader','password')))
print('Client configs created without printing credentials. Restart Connect after an intentional credential update.')
