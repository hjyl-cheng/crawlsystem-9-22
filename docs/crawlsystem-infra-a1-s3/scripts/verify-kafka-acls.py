#!/usr/bin/env python3
"""Negative Kafka authorization/authentication checks using existing least-privilege identities."""
import base64,json,subprocess,uuid
from infra_common import ROOT,k,obj
pod='infra-kafka-validation';bootstrap='crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093'
reader=(ROOT/'secrets/infra-reader-config.properties').read_text()
secret=obj('-n','kafka','get','secret','dbz-connect')['data'];password=base64.b64decode(secret['password']).decode()
common='\n'.join(line for line in reader.splitlines() if not line.startswith('sasl.jaas.config='))+'\n'
writer=common+'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="dbz-connect" password="'+password+'";\n'
wrong=common+'sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="infra-reader" password="invalid-'+str(uuid.uuid4())+'";\n'
files={'/tmp/acl-writer.properties':writer,'/tmp/acl-invalid.properties':wrong}
results=[]
try:
 for path,value in files.items():k('-n','kafka','exec','-i',pod,'--','sh','-c','umask 077; cat > '+path,data=value.encode())
 def consumer(config,topic):return ['timeout','45','/opt/kafka/bin/kafka-console-consumer.sh','--bootstrap-server',bootstrap,'--command-config',config,'--topic',topic,'--partition','0','--offset','earliest','--command-property','enable.auto.commit=false','--max-messages','1','--timeout-ms','10000']
 tests=[('reader_cannot_read_connect_internal',consumer('/etc/client/client.properties','dbz-infra-configs'),b'',b'TopicAuthorizationException'),('writer_cannot_read_outbox',consumer('/tmp/acl-writer.properties','infra.outbox.events'),b'',b'TopicAuthorizationException'),('wrong_password_rejected',consumer('/tmp/acl-invalid.properties','infra.outbox.events'),b'',b'SaslAuthenticationException'),('reader_cannot_write_outbox',['timeout','45','/opt/kafka/bin/kafka-console-producer.sh','--bootstrap-server',bootstrap,'--command-config','/etc/client/client.properties','--topic','infra.outbox.events','--sync','--command-property','max.block.ms=10000','--command-property','enable.idempotence=false'],b'{"check":"unauthorized-infrastructure-probe"}\n',b'TopicAuthorizationException')]
 for label,args,data,expected in tests:
  p=subprocess.run(['kubectl','-n','kafka','exec','-i',pod,'--',*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=55)
  ok=expected in p.stdout+p.stderr;results.append({'test':label,'expected_error':expected.decode(),'pass':ok,'process_exit':p.returncode})
  if not ok:
   print('Unexpected failure type in '+label)
   # Do not dump Kafka config/logs: they may include authentication material.
 (ROOT/'reports/kafka-acl-matrix.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2));assert all(r['pass'] for r in results)
finally:
 k('-n','kafka','exec',pod,'--','rm','-f',*files)
