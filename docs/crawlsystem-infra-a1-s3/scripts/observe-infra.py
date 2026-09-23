#!/usr/bin/env python3
"""Five-minute observation, 24h idle followed by 24h bounded synthetic traffic."""
import datetime, fcntl, json, os, subprocess, time, urllib.parse, urllib.request
from pathlib import Path
from infra_common import ROOT, k, obj, pg_primary, sql, forward
STATE=Path('/var/lib/crawlsystem-observation')
METRICS=Path('/var/lib/crawlsystem-metrics/crawl.prom')

def sample_failures(rec):
    """A reachable API alone does not establish replication or synthetic-write health."""
    bad=[]
    cluster=rec.get('cluster',{})
    if rec.get('errors'):bad.append('collector_errors')
    if cluster.get('ready_nodes')!=6 or cluster.get('total_nodes')!=6 or cluster.get('not_ready_pods'):
        bad.append('cluster')
    pg=rec.get('postgres',{});slots=pg.get('logical_slots',[])
    if pg.get('streaming_standbys',0)<1 or not slots or any(not s.get('active') or s.get('wal_status') not in ('reserved','extended') for s in slots):
        bad.append('postgres_replication')
    cdc=rec.get('cdc',{})
    if cdc.get('connector')!='RUNNING' or cdc.get('tasks')!=['RUNNING']:bad.append('cdc')
    mon=rec.get('monitoring',{})
    if not mon.get('targets_total') or mon.get('targets_up')!=mon.get('targets_total'):bad.append('monitoring')
    for name,expected in [('kafka_isr',3),('kafka_replicas',3),('kafka_underreplicated',0)]:
        values=mon.get(name,[])
        if not values or any(float(x['value'][1])!=expected for x in values):bad.append(name)
    backup=rec.get('backup',{})
    if not backup.get('success') or rec['epoch']-backup.get('completed_epoch',0)>30*3600:bad.append('backup')
    if rec.get('phase')=='low-load':
        smoke=rec.get('low_load',{})
        if smoke.get('outbox',{}).get('status')!='PASS' or smoke.get('clickhouse')!='PASS' or smoke.get('temporal')!='PASS':bad.append('synthetic_writes')
    return bad

def http(port,path):
    return json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=15))

def main():
    os.umask(0o077);STATE.mkdir(mode=0o700,exist_ok=True)
    with (STATE/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        start=STATE/'started.json'
        if not start.exists():start.write_text(json.dumps({'epoch':time.time(),'utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
        age=time.time()-json.loads(start.read_text())['epoch']
        phase='idle' if age<86400 else 'low-load' if age<172800 else 'continuous-monitoring'
        rec={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'epoch':time.time(),'elapsed_hours':round(age/3600,3),'phase':phase,'errors':[]}
        metrics={'crawl_observation_timestamp_seconds':time.time()}
        def check(name,fn):
            try:rec[name]=fn()
            except Exception as e:rec['errors'].append({'check':name,'error':type(e).__name__})
        def cluster():
            nodes=obj('get','nodes')['items'];ready=sum(any(c['type']=='Ready' and c['status']=='True' for c in n['status']['conditions']) for n in nodes)
            pods=obj('get','pods','-A')['items'];bad=[p['metadata']['namespace']+'/'+p['metadata']['name'] for p in pods if p['status']['phase']!='Succeeded' and not p['metadata'].get('deletionTimestamp') and not any(c['type']=='Ready' and c['status']=='True' for c in p['status'].get('conditions',[]))]
            metrics['crawl_nodes_ready']=ready
            metrics['crawl_pods_not_ready']=len(bad)
            return {'ready_nodes':ready,'total_nodes':len(nodes),'not_ready_pods':bad,'restarts':sum(c.get('restartCount',0) for p in pods for c in p['status'].get('containerStatuses',[]))}
        check('cluster',cluster)
        def postgres():
            primary=pg_primary(); rows=sql(primary,'postgres',"SELECT json_build_object('streaming_standbys',(SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND sync_state IN ('sync','quorum')),'logical_slots',(SELECT coalesce(json_agg(json_build_object('name',slot_name,'active',active,'retained_bytes',pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn),'failover',failover,'wal_status',wal_status)),'[]') FROM pg_replication_slots WHERE slot_type='logical'))")
            result=json.loads(rows);metrics['crawl_pg_streaming_standbys']=result['streaming_standbys'];metrics['crawl_pg_slot_retained_bytes']=max([s['retained_bytes'] or 0 for s in result['logical_slots']]+[0]);return result
        check('postgres',postgres)
        def cdc():
            with forward('kafka','svc/debezium-connect',8083) as port:r=http(port,'/connectors/infra-outbox/status')
            running=r['connector']['state']=='RUNNING' and len(r['tasks'])==1 and all(t['state']=='RUNNING' for t in r['tasks']);metrics['crawl_cdc_running']=int(running)
            return {'connector':r['connector']['state'],'tasks':[t['state'] for t in r['tasks']]}
        check('cdc',cdc)
        def prometheus():
            with forward('monitoring','svc/prometheus',9090) as port:
                targets=http(port,'/api/v1/targets')['data']['activeTargets']
                data={'targets_total':len(targets),'targets_up':sum(t['health']=='up' for t in targets),'down_jobs':[t['labels'].get('job') for t in targets if t['health']!='up']}
                for label,expr in {'filesystem_available':'node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"}','memory_available':'node_memory_MemAvailable_bytes','kafka_isr':'kafka_topic_partition_in_sync_replica','kafka_replicas':'kafka_topic_partition_replicas','kafka_underreplicated':'kafka_server_replicamanager_underreplicatedpartitions','cpu_load':'node_load1'}.items():
                    data[label]=http(port,'/api/v1/query?'+urllib.parse.urlencode({'query':expr}))['data']['result']
                metrics['crawl_monitoring_targets_down']=data['targets_total']-data['targets_up']
                return data
        check('monitoring',prometheus)
        def backup():
            r=json.loads(Path('/srv/crawl-backups/latest.json').read_text());metrics['crawl_backup_last_success_timestamp_seconds']=r['completed_epoch']
            p=subprocess.run(['systemctl','is-failed','--quiet','crawlsystem-backup.service']);metrics['crawl_backup_service_failed']=int(p.returncode==0);return r
        check('backup',backup)
        if phase=='low-load':
            def low_load():
                p=subprocess.run(['/usr/bin/python3',str(ROOT/'scripts/infra-smoke.py')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=240)
                if p.returncode:raise RuntimeError('Synthetic smoke failed')
                return json.loads(p.stdout)
            check('low_load',low_load)
        rec['health_failures']=sample_failures(rec)
        metrics['crawl_observation_errors']=len(rec['health_failures'])
        METRICS.parent.mkdir(mode=0o755,exist_ok=True);tmp=METRICS.with_suffix('.tmp');tmp.write_text(''.join(f'{key} {value}\n' for key,value in metrics.items()));tmp.chmod(0o644);tmp.replace(METRICS)
        with (STATE/'samples.jsonl').open('a') as f:f.write(json.dumps(rec)+'\n')
        # Keep detailed samples for 7 days, enough for the full acceptance period.
        raw_history=[json.loads(line) for line in (STATE/'samples.jsonl').read_text().splitlines()]
        history=[x for x in raw_history if x['epoch']>time.time()-7*86400][-2100:]
        if len(history)!=len(raw_history):
            (STATE/'samples.jsonl').write_text(''.join(json.dumps(x)+'\n' for x in history))
        summary={'started':json.loads(start.read_text()),'latest':rec,'phases':{}}
        for p in ['idle','low-load']:
            rows=[r for r in history if r['phase']==p]; start_offset=0 if p=='idle' else 86400
            coverage=(rows[-1]['epoch']-rows[0]['epoch']) if len(rows)>1 else 0
            gaps=max([b['epoch']-a['epoch'] for a,b in zip(rows,rows[1:])]+[0])
            bad=sum(bool(sample_failures(r)) for r in rows)
            summary['phases'][p]={'samples':len(rows),'coverage_hours':round(coverage/3600,3),'max_gap_seconds':round(gaps),'unhealthy_samples':bad,'status':'PASS' if age>=start_offset+86400 and len(rows)>=285 and coverage>=85800 and gaps<=650 and bad==0 else 'WAITING' if age<start_offset else 'RUNNING' if age<start_offset+86400 else 'REVIEW_REQUIRED'}
        summary['disk_growth'] = []
        for capacity_phase in ['idle','low-load']:
            rows=[r for r in history if r['phase']==capacity_phase and 'monitoring' in r]
            if len(rows)<2: continue
            def disks(row):
                return {(x['metric'].get('instance'),x['metric'].get('mountpoint')):float(x['value'][1]) for x in row['monitoring'].get('filesystem_available',[])}
            first,last=disks(rows[0]),disks(rows[-1]);hours=(rows[-1]['epoch']-rows[0]['epoch'])/3600
            for key in first.keys() & last.keys():
                summary['disk_growth'].append({'phase':capacity_phase,'instance':key[0],'mountpoint':key[1],'observed_hours':round(hours,3),'used_bytes_increase':round(first[key]-last[key]),'estimated_bytes_per_hour':round((first[key]-last[key])/hours)})
        report=ROOT/'reports/observation-latest.json' ;report.write_text(json.dumps(summary,indent=2));report.chmod(0o644)
        checklist=ROOT/'DEPLOYMENT-CHECKLIST.md'
        if checklist.exists():
            import re
            text=checklist.read_text()
            for ident,phase_name,label in [('INFRA-27','idle','空载24小时资源和磁盘增长记录'),('INFRA-28','low-load','小负载24小时有效写入/净增长')]:
                item=summary['phases'][phase_name]
                row=f'| {ident} | {label} | {item["status"]} | 自动记录：{item["samples"]} 个样本，覆盖 {item["coverage_hours"]} 小时；reports/observation-latest.json |'
                text=re.sub(r'^\| '+ident+r' \|.*$',lambda m: row,text,flags=re.M)
            checklist.write_text(text)
        print(json.dumps({'phase':phase,'elapsed_hours':rec['elapsed_hours'],'errors':rec['errors'],'phases':summary['phases']}))
if __name__=='__main__':main()
