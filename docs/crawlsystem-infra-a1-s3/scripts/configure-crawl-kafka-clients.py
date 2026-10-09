#!/usr/bin/env python3
"""Give each collection-pipeline service its Kafka credentials (plan R1).

Strimzi owns the SCRAM passwords (KafkaUser secrets in `kafka`) and the cluster CA. This copies,
for each service, username / password / ca.crt into a secret `kafka-<user>` in the service's
namespace. Values are never printed. Re-run after a password or cluster-CA renewal: the copies
are replaced from Strimzi's current secrets.
"""
import base64, json, subprocess

CLIENTS = [('crawl-worker', 'crawler'), ('crawl-parser', 'crawler'), ('crawl-sink-pg', 'ingest'), ('crawl-sink-ch', 'analytics')]

def read(ns: str, name: str, key: str) -> str:
    d = json.loads(subprocess.check_output(['kubectl', '-n', ns, 'get', 'secret', name, '-o', 'json']))
    return base64.b64decode(d['data'][key]).decode()

ca = read('kafka', 'crawler-kafka-cluster-ca-cert', 'ca.crt')
for user, ns in CLIENTS:
    password = read('kafka', user, 'password')
    manifest = {'apiVersion': 'v1', 'kind': 'Secret', 'type': 'Opaque',
                'metadata': {'name': f'kafka-{user}', 'namespace': ns, 'labels': {'app.kubernetes.io/part-of': 'crawl-pipeline'}},
                'stringData': {'username': user, 'password': password, 'ca.crt': ca,
                               'bootstrap': 'crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local:9093'}}
    subprocess.run(['kubectl', 'apply', '-f', '-'], input=json.dumps(manifest).encode(), check=True, stdout=subprocess.DEVNULL)
    print(f'{ns}/kafka-{user}: updated')
