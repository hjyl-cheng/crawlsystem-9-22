#!/usr/bin/env python3
"""Database authentication and namespace TCP policy matrix."""
import base64,concurrent.futures,json,shlex,subprocess,time
from infra_common import ROOT,k,obj,pg_primary

def main():
 primary=pg_primary();ca=(ROOT/'secrets/pg-ca.crt').read_bytes()
 app=obj('-n','db','get','secret','crawler-pg-app')['data']
 accounts={'crawler_owner':base64.b64decode(app['password']),'temporal_svc':(ROOT/'secrets/temporal.password').read_bytes().strip(),'dbz_svc':(ROOT/'secrets/dbz.password').read_bytes().strip()}
 allowed={'crawler_owner':['crawler','infra_smoke'],'temporal_svc':['temporal','temporal_visibility'],'dbz_svc':['infra_smoke']}
 results=[]
 for role,password in accounts.items():
  for database in ['crawler','infra_smoke','temporal','temporal_visibility']:
   command='umask 077; d=$(mktemp -d); trap \'rm -rf "$d"\' EXIT; IFS= read -r PGPASSWORD; export PGPASSWORD; cat > "$d/ca.crt"; psql '+shlex.quote(f'host=crawler-pg-rw.db.svc.cluster.local user={role} dbname={database} sslmode=verify-full connect_timeout=5')+'" sslrootcert=$d/ca.crt" -XAt -c "SELECT 1"'
   p=subprocess.run(['kubectl','-n','db','exec','-i',primary,'-c','postgres','--','bash','-c',command],input=password+b'\n'+ca,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
   expected=database in allowed[role];ok=(p.returncode==0) if expected else (p.returncode!=0 and b'permission denied for database' in p.stderr)
   results.append({'role':role,'database':database,'expected_allowed':expected,'actual_allowed':p.returncode==0,'pass':ok})
 namespaces=['control','crawler','ingest','proxy','business','infra-test','monitoring']
 targets={'pg':('crawler-pg-rw.db.svc.cluster.local',5432,{'control','ingest'}),'temporal':('temporal-frontend.temporal.svc.cluster.local',7233,{'control','crawler','ingest','business','infra-test'}),'clickhouse':('clickhouse.analytics.svc.cluster.local',8443,{'control','ingest','infra-test'}),'kafka':('crawler-kafka-kafka-bootstrap.kafka.svc.cluster.local',9093,{'business','infra-test','monitoring'}),'connect':('debezium-connect.kafka.svc.cluster.local',8083,set()),'grafana':('grafana.monitoring.svc.cluster.local',3000,{'monitoring'})}
 created=[];network=[]
 try:
  for ns in namespaces:
   pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':'security-probe','namespace':ns},'spec':{'automountServiceAccountToken':False,'restartPolicy':'Never','nodeSelector':{'kubernetes.io/hostname':'a1'},'containers':[{'name':'probe','image':'ghcr.io/cloudnative-pg/postgresql:18.6','command':['bash','-c','sleep 600'],'resources':{'requests':{'cpu':'5m','memory':'16Mi'},'limits':{'cpu':'100m','memory':'64Mi'}}}]}}
   k('create','-f','-',data=json.dumps(pod).encode());created.append(ns)
  for ns in namespaces:k('-n',ns,'wait','--for=condition=Ready','pod/security-probe','--timeout=120s')
  def probe(pair):
   ns,name=pair;host,port,allow=targets[name]
   p=subprocess.run(['kubectl','-n',ns,'exec','security-probe','--','timeout','3','bash','-c',f'exec 3<>/dev/tcp/{host}/{port}'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
   return {'source':ns,'target':name,'expected_allowed':ns in allow,'actual_allowed':p.returncode==0,'pass':(p.returncode==0)==(ns in allow)}
  with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:network=list(ex.map(probe,[(ns,name) for ns in namespaces for name in targets]))
 finally:
  for ns in created:k('-n',ns,'delete','pod/security-probe','--wait=false')
 report={'postgres_authentication':results,'network_policy':network}
 (ROOT/'reports/security-matrix.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'postgres_pass':sum(x['pass'] for x in results),'postgres_total':len(results),'network_pass':sum(x['pass'] for x in network),'network_total':len(network),'failed':[x for x in results+network if not x['pass']]}))
 if not all(x['pass'] for x in results+network):raise SystemExit(1)
if __name__=='__main__':main()
