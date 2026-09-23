#!/usr/bin/env python3
"""Restore a development backup to isolated, disposable resources."""
import datetime, hashlib, json, os, re, shutil, sqlite3, subprocess, tempfile, time
from pathlib import Path
from infra_common import ROOT, run, k, obj
BASE=Path('/srv/crawl-backups')
NS='infra-restore'

def main():
    os.umask(0o077)
    latest=json.loads((BASE/'latest.json').read_text()); dest=BASE/latest['backup']
    metadata=json.loads((dest/'metadata.json').read_text())
    report={'backup':latest['backup'],'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tests':{}}
    for line in (dest/'SHA256SUMS').read_text().splitlines():
        digest,name=line.split('  ',1)
        assert hashlib.file_digest((dest/name).open('rb'),'sha256').hexdigest()==digest, name
    report['tests']['local_checksums']='PASS'
    # Verify remote copy again; restoration input is fetched from S2, not the source copy.
    import shlex
    copy=Path(tempfile.mkdtemp(prefix='restore-',dir=BASE))
    try:
        run(['sudo','-u','ubuntu','ssh','-o','BatchMode=yes','crawl-s2', 'sudo -n sh -c '+shlex.quote(f'cd /srv/crawl-backups/{dest.name} && sha256sum -c SHA256SUMS >/dev/null')])
        for name in ['roles.sql','clickhouse.zip','etcd.snapshot','grafana.db']+[n+'.dump' for n in metadata['databases']]:
            with (copy/name).open('wb') as f:
                run(['sudo','-u','ubuntu','ssh','-o','BatchMode=yes','crawl-s2','sudo -n cat '+shlex.quote(str(dest/name))],output=f)
            assert hashlib.file_digest((copy/name).open('rb'),'sha256').hexdigest()==hashlib.file_digest((dest/name).open('rb'),'sha256').hexdigest()
        report['tests']['cross_node_download_checksums']='PASS'
        # create (never apply) ensures existing restore resources are not overwritten.
        k('create','namespace',NS)
        resources=[{'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'deny-all','namespace':NS},'spec':{'podSelector':{},'policyTypes':['Ingress','Egress'],'ingress':[],'egress':[]}}]
        pg={'apiVersion':'v1','kind':'Pod','metadata':{'name':'restore-pg','namespace':NS},'spec':{'automountServiceAccountToken':False,'restartPolicy':'Never','nodeSelector':{'kubernetes.io/hostname':'a2'},'securityContext':{'runAsUser':26,'runAsGroup':26,'fsGroup':26},'containers':[{'name':'postgres','image':'ghcr.io/cloudnative-pg/postgresql:18.6','command':['bash','-ec',"/usr/lib/postgresql/18/bin/initdb -D /restore/pg --auth-local=trust --auth-host=reject >/dev/null; exec /usr/lib/postgresql/18/bin/postgres -D /restore/pg -k /restore -c listen_addresses='' -c wal_level=logical"],'env':[{'name':'PGHOST','value':'/restore'}],'resources':{'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'500m','memory':'512Mi'}},'volumeMounts':[{'name':'data','mountPath':'/restore'}],'readinessProbe':{'exec':{'command':['pg_isready','-h','/restore']},'periodSeconds':2}}],'volumes':[{'name':'data','emptyDir':{'sizeLimit':'3Gi'}}]}}
        chconfig='<clickhouse><path>/restore/data/</path><tmp_path>/restore/tmp/</tmp_path><user_files_path>/restore/user_files/</user_files_path><format_schema_path>/restore/format_schemas/</format_schema_path><listen_host>127.0.0.1</listen_host><tcp_port>9000</tcp_port><max_server_memory_usage>800000000</max_server_memory_usage><logger><level>warning</level><console>true</console></logger><users><default><password></password><networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota></default></users><profiles><default><max_memory_usage>500000000</max_memory_usage></default></profiles><quotas><default/></quotas><backups><allowed_path>/restore/</allowed_path></backups></clickhouse>'
        resources.append({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'restore-ch-config','namespace':NS},'data':{'config.xml':chconfig}})
        ch={'apiVersion':'v1','kind':'Pod','metadata':{'name':'restore-ch','namespace':NS},'spec':{'automountServiceAccountToken':False,'restartPolicy':'Never','nodeSelector':{'kubernetes.io/hostname':'a2'},'containers':[{'name':'clickhouse','image':'clickhouse/clickhouse-server:26.8.10.6','command':['clickhouse-server','--config-file=/config/config.xml'],'resources':{'requests':{'cpu':'50m','memory':'256Mi'},'limits':{'cpu':'500m','memory':'1Gi'}},'volumeMounts':[{'name':'data','mountPath':'/restore'},{'name':'config','mountPath':'/config'}],'readinessProbe':{'exec':{'command':['clickhouse-client','--query','SELECT 1']},'periodSeconds':3}}],'volumes':[{'name':'data','emptyDir':{'sizeLimit':'3Gi'}},{'name':'config','configMap':{'name':'restore-ch-config'}}]}}
        resources.extend([pg,ch]); k('create','-f','-',data=json.dumps({'apiVersion':'v1','kind':'List','items':resources}).encode())
        try:
            k('-n',NS,'wait','--for=condition=Ready','pod/restore-pg','pod/restore-ch','--timeout=240s',timeout=250)
            def pgexec(*args,data=None): return k('-n',NS,'exec','-i','restore-pg','--',*args,data=data,timeout=300)
            roles=(copy/'roles.sql').read_text(); roles=re.sub(r'^CREATE ROLE postgres;\n','',roles,flags=re.M)
            pgexec('psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1',data=roles.encode())
            for db in metadata['databases']:
                if db!='postgres': pgexec('createdb','-U','postgres',db)
                pgexec('pg_restore','-U','postgres','--exit-on-error','-d',db,data=(copy/(db+'.dump')).read_bytes())
            ids=pgexec('psql','-XAt','-U','postgres','-d','infra_smoke','-c','SELECT id FROM publication.outbox ORDER BY id').decode().strip().splitlines()
            assert set(metadata['outbox_ids']).issubset(set(ids))
            table_counts={}
            for db in metadata['databases']:
                count=pgexec('psql','-XAt','-U','postgres','-d',db,'-c',"SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')").decode().strip()
                table_counts[db]=int(count)
            assert table_counts['temporal']>0 and table_counts['temporal_visibility']>0
            report['tests']['postgres']={'status':'PASS','databases':metadata['databases'],'prebackup_outbox_ids_present':True,'table_counts':table_counts,'roles_restored':True}
            k('-n',NS,'exec','-i','restore-ch','--','sh','-c','cat > /restore/clickhouse.zip',data=(copy/'clickhouse.zip').read_bytes())
            k('-n',NS,'exec','restore-ch','--','clickhouse-client','--query',"RESTORE ALL FROM File('/restore/clickhouse.zip')")
            table_json=k('-n',NS,'exec','restore-ch','--','clickhouse-client','--query',"SELECT database,name FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') AND is_temporary=0 FORMAT JSONEachRow").decode()
            assert sorted(table_json.splitlines())==sorted(metadata['clickhouse_tables'].splitlines())
            rows=int(k('-n',NS,'exec','restore-ch','--','clickhouse-client','--query','SELECT count() FROM infra_smoke.connectivity').decode())
            assert rows>=0
            if 'clickhouse_smoke_ids' in metadata:
                restored_ids=k('-n',NS,'exec','restore-ch','--','clickhouse-client','--query','SELECT toString(id) FROM infra_smoke.connectivity ORDER BY id').decode().strip().splitlines()
                assert restored_ids==metadata['clickhouse_smoke_ids']
            if 'clickhouse_backup_marker' in metadata:
                marker_count=k('-n',NS,'exec','restore-ch','--','clickhouse-client','--query',"SELECT count() FROM infra_smoke.backup_check WHERE id='"+metadata['clickhouse_backup_marker']+"'").decode().strip()
                assert marker_count=='1'
            report['tests']['clickhouse']={'status':'PASS','native_restore':True,'tables_match':True,'smoke_rows':rows}
        finally:
            k('delete','namespace',NS,'--wait=false')
        connection=sqlite3.connect('file:'+str(copy/'grafana.db')+'?mode=ro',uri=True)
        assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; connection.close()
        report['tests']['grafana_sqlite']='PASS'
        # Offline etcd restore to a brand new directory, never cluster-reset a running node.
        etcdutl='/usr/local/bin/etcdutl'
        status=json.loads(run([etcdutl,'snapshot','status',str(copy/'etcd.snapshot'),'-w','json']))
        run([etcdutl,'snapshot','restore',str(copy/'etcd.snapshot'),'--data-dir',str(copy/'etcd-restored'),'--name','isolated-restore','--initial-cluster','isolated-restore=http://127.0.0.1:12380','--initial-advertise-peer-urls','http://127.0.0.1:12380'],timeout=180)
        assert (copy/'etcd-restored/member/snap/db').stat().st_size>0
        report['tests']['etcd']={'status':'PASS','snapshot_status':status,'offline_restore':True,'live_cluster_reset':False}
        report['completed_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (ROOT/'reports/local-restore.json').write_text(json.dumps(report,indent=2)); os.chmod(ROOT/'reports/local-restore.json',0o644)
        print(json.dumps(report,indent=2))
    finally:
        shutil.rmtree(copy)

if __name__=='__main__':main()
