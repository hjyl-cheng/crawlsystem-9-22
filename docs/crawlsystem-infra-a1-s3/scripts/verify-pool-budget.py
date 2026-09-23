#!/usr/bin/env python3
import base64,concurrent.futures,json,shlex,subprocess,time
from infra_common import ROOT,k,obj,pg_primary,sql
primary=pg_primary();password=base64.b64decode(obj('-n','db','get','secret','crawler-pg-app')['data']['password']);ca=(ROOT/'secrets/pg-ca.crt').read_bytes()
command='''set -eu; umask 077; d=$(mktemp -d); trap 'rm -rf "$d"' EXIT; IFS= read -r PGPASSWORD; export PGPASSWORD; cat > "$d/ca.crt"; printf 'SELECT pg_sleep(0.2);\n' > "$d/probe.sql"; export PGSSLMODE=verify-full PGSSLROOTCERT="$d/ca.crt"; pgbench -n -h crawler-pg-pool.db.svc.cluster.local -U crawler_owner -d crawler -c 64 -j 4 -t 4 -f "$d/probe.sql"'''
with concurrent.futures.ThreadPoolExecutor() as ex:
 future=ex.submit(subprocess.run,['kubectl','-n','db','exec','-i',primary,'-c','postgres','--','bash','-c',command],input=password+b'\n'+ca,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
 peak_total=0;peak_owner=0
 while not future.done():
  row=sql(primary,'postgres',"SELECT count(*) || ',' || count(*) FILTER (WHERE usename='crawler_owner' AND backend_type='client backend') FROM pg_stat_activity").split(',');peak_total=max(peak_total,int(row[0]));peak_owner=max(peak_owner,int(row[1]));time.sleep(.2)
 p=future.result()
report={'clients':64,'transactions_expected':256,'exit_code':p.returncode,'peak_pg_processes':peak_total,'peak_owner_connections':peak_owner,'pool_database_budget':30,'pg_max_connections':100,'output':p.stdout.decode(),'pass':p.returncode==0 and peak_owner<=30 and '256/256' in p.stdout.decode()}
(ROOT/'reports/pool-budget.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2));assert report['pass']
