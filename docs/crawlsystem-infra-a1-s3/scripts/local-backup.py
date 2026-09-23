#!/usr/bin/env python3
"""Daily development backup; root-only A1 and S2 copies. No point-in-time recovery."""
import datetime, fcntl, hashlib, json, os, re, shutil, subprocess, tarfile, time, uuid
from pathlib import Path
from infra_common import ROOT, run, k, obj, pg_primary, sql, clickhouse
BASE=Path('/srv/crawl-backups')

def main():
    if os.geteuid()!=0: raise SystemExit('Run with sudo')
    os.umask(0o077); BASE.mkdir(mode=0o700,exist_ok=True)
    with (BASE/'.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        dest=BASE/(stamp+'.partial'); dest.mkdir()
        primary=pg_primary()
        names=sql(primary,'postgres',"SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname").splitlines()
        metadata={'started_at':stamp,'postgres_primary':primary,'databases':names,'mode':'daily-logical-no-PITR','components':[]}
        metadata['outbox_ids']=sql(primary,'infra_smoke','SELECT id FROM publication.outbox ORDER BY id').splitlines()
        for name in names:
            if not re.fullmatch(r'[a-zA-Z0-9_]+',name): raise ValueError('Unsupported database name')
            with (dest/(name+'.dump')).open('wb') as f:
                k('-n','db','exec',primary,'-c','postgres','--','pg_dump','-U','postgres','-Fc',name,output=f,timeout=600)
        with (dest/'roles.sql').open('wb') as f:
            k('-n','db','exec',primary,'-c','postgres','--','pg_dumpall','-U','postgres','--roles-only',output=f)
        metadata['components'].append('postgres-all-databases-and-roles')
        with clickhouse() as q:
            chname=f'dev-{stamp}.zip'
            # A fresh immutable marker survives concurrent smoke inserts and TTL merges.
            q("CREATE TABLE IF NOT EXISTS infra_smoke.backup_check (id UUID, created_at DateTime DEFAULT now()) ENGINE=MergeTree ORDER BY id")
            metadata['clickhouse_backup_marker']=str(uuid.uuid4())
            q("INSERT INTO infra_smoke.backup_check (id) VALUES ('"+metadata['clickhouse_backup_marker']+"')")
            metadata['clickhouse_tables']=q("SELECT database,name FROM system.tables WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema') AND is_temporary=0 FORMAT JSONEachRow")
            q(f"BACKUP ALL EXCEPT DATABASE system, INFORMATION_SCHEMA, information_schema TO File('/var/lib/clickhouse/backups/{chname}')")
            chpod=obj('-n','analytics','get','pods','-l','app=clickhouse')['items'][0]['metadata']['name']
            with (dest/'clickhouse.zip').open('wb') as f:
                k('-n','analytics','exec',chpod,'--','cat','/var/lib/clickhouse/backups/'+chname,output=f,timeout=600)
            # Delete only this exported archive, never any data directory.
            k('-n','analytics','exec',chpod,'--','rm','--','/var/lib/clickhouse/backups/'+chname)
        metadata['components'].append('clickhouse-native-all-user-databases')
        run(['k3s','etcd-snapshot','save','--name','dev-backup-'+stamp],timeout=180)
        snapshots=list(Path('/var/lib/rancher/k3s/server/db/snapshots').glob('dev-backup-'+stamp+'-*'))
        if len(snapshots)!=1: raise RuntimeError('Snapshot not found uniquely')
        shutil.copyfile(snapshots[0],dest/'etcd.snapshot')
        shutil.copyfile('/var/lib/rancher/k3s/server/token',dest/'server-token')
        with tarfile.open(dest/'recovery-config.tar.gz','w:gz') as t:
            for name in ['manifests','values','nodes','scripts','systemd','secrets','sql','examples','requirements-infra.txt','versions.lock.json','inventory.json','storage-plan.json','OPERATIONS.md','DEPLOYMENT-CHECKLIST.md','reports/ACCESS.md','reports/SSH-ACCESS.md']:
                path=ROOT/name
                if path.exists(): t.add(path,arcname='bundle/'+name)
            for path in ['/etc/rancher/k3s','/etc/systemd/system/crawlsystem-host-firewall.service','/etc/nftables.d']:
                if Path(path).exists(): t.add(path,arcname=path.lstrip('/'))
        with (dest/'kubernetes-secrets.json').open('wb') as f: k('get','secrets','-A','-o','json',output=f)
        # SQLite backup API yields a consistent Grafana DB while Grafana stays online.
        pv=obj('get','pv')['items']
        gp=next(x['spec']['local']['path'] for x in pv if x['spec'].get('claimRef',{}).get('name')=='grafana-data')
        remote="import sqlite3,tempfile,os,sys; s=sqlite3.connect('file:"+gp+"/grafana.db?mode=ro',uri=True); f=tempfile.NamedTemporaryFile(delete=False); f.close(); d=sqlite3.connect(f.name); s.backup(d); d.close(); s.close(); sys.stdout.buffer.write(open(f.name,'rb').read()); os.unlink(f.name)"
        import shlex
        ssh=['sudo','-u','ubuntu','ssh','-o','BatchMode=yes','-o','ConnectTimeout=10']
        with (dest/'grafana.db').open('wb') as f: run(ssh+['crawl-a3','sudo -n python3 -c '+shlex.quote(remote)],output=f)
        metadata['components']+=['etcd-snapshot-and-token','kubernetes-secrets','configuration','grafana-sqlite']
        metadata['finished_at']=datetime.datetime.now(datetime.timezone.utc).isoformat()
        (dest/'metadata.json').write_text(json.dumps(metadata,indent=2))
        hashes={p.name:hashlib.file_digest(p.open('rb'),'sha256').hexdigest() for p in dest.iterdir() if p.is_file()}
        (dest/'SHA256SUMS').write_text(''.join(f'{h}  {n}\n' for n,h in sorted(hashes.items())))
        run(ssh+['crawl-s2',f'sudo -n install -d -m 700 /srv/crawl-backups/{stamp}.partial'])
        # The remote destination is newly created, root-owned, and contains no preexisting data.
        with tempfile_archive(dest) as archive:
            with archive.open('rb') as source:
                p=subprocess.run(ssh+['crawl-s2',f'sudo -n tar --no-same-owner -xf - -C /srv/crawl-backups/{stamp}.partial'],stdin=source,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,timeout=600)
                if p.returncode: raise RuntimeError('Cross-node copy failed')
        run(ssh+['crawl-s2',f'sudo -n sh -c '+shlex.quote(f'cd /srv/crawl-backups/{stamp}.partial && sha256sum -c SHA256SUMS >/dev/null && mv /srv/crawl-backups/{stamp}.partial /srv/crawl-backups/{stamp}')])
        dest.rename(BASE/stamp)
        (BASE/'latest.json').write_text(json.dumps({'backup':stamp,'success':True,'cross_node':'s2','completed_epoch':time.time(),'bytes':sum(p.stat().st_size for p in (BASE/stamp).iterdir())},indent=2))
        # Retain seven completed backups; partial failures are retained for diagnosis.
        completed=sorted(p for p in BASE.iterdir() if re.fullmatch(r'\d{8}T\d{6}Z',p.name))
        for p in completed[:-7]: shutil.rmtree(p)
        retention="import pathlib,re,shutil; p=pathlib.Path('/srv/crawl-backups'); a=sorted(x for x in p.iterdir() if re.fullmatch(r'\\d{8}T\\d{6}Z',x.name)); [shutil.rmtree(x) for x in a[:-7]]"
        run(ssh+['crawl-s2','sudo -n python3 -c '+shlex.quote(retention)])
        # Also bound on-demand K3s snapshots made by this job (built-in timer has separate retention).
        for p in sorted(Path('/var/lib/rancher/k3s/server/db/snapshots').glob('dev-backup-*'))[:-7]: p.unlink()
        print(json.dumps({'backup':stamp,'success':True,'cross_node_checksum':'PASS','components':metadata['components']}))

import contextlib,tempfile
@contextlib.contextmanager
def tempfile_archive(dest):
    fd,path=tempfile.mkstemp(dir=BASE,suffix='.tar'); os.close(fd); path=Path(path)
    try:
        with tarfile.open(path,'w') as t:
            for p in dest.iterdir(): t.add(p,arcname=p.name)
        yield path
    finally: path.unlink(missing_ok=True)

if __name__=='__main__': main()
