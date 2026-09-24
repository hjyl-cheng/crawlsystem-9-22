#!/usr/bin/env python3
"""Bounded infrastructure probes only; creates no crawler business objects."""
import json, os, subprocess, time, uuid
from infra_common import ROOT, k, pg_primary, sql, clickhouse, forward

def insert_event(tag):
    marker=str(uuid.uuid4())
    sql(pg_primary(),'infra_smoke',"SET statement_timeout='30s'; INSERT INTO publication.outbox(id,aggregatetype,aggregateid,type,payload) VALUES ('"+marker+"','infra','"+marker+"','infra-check','"+json.dumps({'check':tag,'id':marker})+"'::jsonb);")
    return marker

def consume_events(markers, timeout=180):
    # Explicit partition assignment makes retries independent of committed group offsets.
    deadline=time.monotonic()+timeout; found=set()
    while time.monotonic()<deadline:
        for partition in range(3):
            args=['kubectl','-n','kafka','exec','infra-kafka-validation','--','timeout','80','/opt/kafka/bin/kafka-console-consumer.sh','--bootstrap-server','crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093','--command-config','/etc/client/client.properties','--topic','infra.outbox.events','--partition',str(partition),'--offset','earliest','--command-property','enable.auto.commit=false','--formatter-property','print.headers=true','--timeout-ms','15000']
            p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
            if p.returncode != 0: raise RuntimeError('Kafka validation consumer process failed')
            for marker in markers:
                if marker.encode() in p.stdout: found.add(marker)
            if found==set(markers): return {'status':'PASS','ids':sorted(found)}
        time.sleep(2)
    raise RuntimeError('CDC consumer did not receive all expected event IDs')

def main():
    marker=insert_event('scheduled-infrastructure')
    result={'outbox':consume_events([marker])}
    with clickhouse() as q:
        q(f"INSERT INTO infra_smoke.connectivity (id) VALUES ('{marker}')")
        assert q(f"SELECT count() FROM infra_smoke.connectivity WHERE id='{marker}'").strip()=='1'
        result['clickhouse']='PASS'
    # With namespace authorization enabled (docs/m1/temporal-authorization.md) the public
    # frontend requires a JWT; this host-side admin check uses the internal-frontend instead.
    internal=json.loads(k('-n','temporal','get','svc','-o','json'))['items']
    internal=any(item['metadata']['name']=='temporal-internal-frontend' for item in internal)
    service,remote,domain=('svc/temporal-internal-frontend',7236,'temporal-internode.temporal.svc') if internal else ('svc/temporal-frontend',7233,'temporal-frontend.temporal.svc.cluster.local')
    with forward('temporal',service,remote) as port:
        env=dict(os.environ,TEMPORAL_ADDRESS=f'127.0.0.1:{port}',TEMPORAL_TLS_DOMAIN=domain)
        p=subprocess.run([str(ROOT/'.venv-infra/bin/python'),str(ROOT/'examples/temporal-smoke.py')],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
        if p.returncode or b'INFRA_OK:A1-S3' not in p.stdout: raise RuntimeError('Temporal workflow smoke failed')
        result['temporal']='PASS'
    print(json.dumps(result))
if __name__=='__main__':main()
