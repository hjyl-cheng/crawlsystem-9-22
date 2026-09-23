#!/usr/bin/env python3
"""Controlled CDC pause/resume and CNPG switchover after verified backups."""
import datetime,importlib.util,json,time,urllib.request
from infra_common import ROOT,k,obj,sql,pg_primary,forward
spec=importlib.util.spec_from_file_location('infra_smoke',ROOT/'scripts/infra-smoke.py');smoke=importlib.util.module_from_spec(spec);spec.loader.exec_module(smoke)

def main():
 restored=json.loads((ROOT/'reports/local-restore.json').read_text());assert all(v=='PASS' or isinstance(v,dict) and v.get('status')=='PASS' for v in restored['tests'].values())
 result={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'tests':{}}
 with forward('kafka','svc/debezium-connect',8083) as port:
  base=f'http://127.0.0.1:{port}/connectors/infra-outbox'
  def call(path='',method='GET'):
   with urllib.request.urlopen(urllib.request.Request(base+path,method=method),timeout=10) as r:
    raw=r.read();return json.loads(raw) if raw else None
  def state(expected,seconds=120):
   end=time.monotonic()+seconds
   while time.monotonic()<end:
    r=call('/status')
    if r['connector']['state']==expected and len(r['tasks'])==1 and all(x['state']==expected for x in r['tasks']):return
    time.sleep(2)
   raise RuntimeError('Connector state timeout: '+expected)
  state('RUNNING')
  before=smoke.insert_event('before-pause')
  call('/pause','PUT')
  try:
   state('PAUSED');during=smoke.insert_event('during-pause')
  finally:call('/resume','PUT')
  state('RUNNING');result['tests']['cdc_pause_resume']=smoke.consume_events([before,during])
  (ROOT/'reports/failover-validation.json').write_text(json.dumps(result,indent=2))
  old=pg_primary();target='crawler-pg-2' if old=='crawler-pg-1' else 'crawler-pg-1'
  slot=sql(target,'postgres',"SELECT synced AND failover AND invalidation_reason IS NULL FROM pg_replication_slots WHERE slot_name='infra_outbox_slot'")
  assert slot=='t','Standby failover slot not ready'
  before_switch=smoke.insert_event('before-switchover');start=time.monotonic()
  # Same status fields as CNPG 1.30 kubectl plugin Promote implementation.
  status={'targetPrimary':target,'targetPrimaryTimestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'phase':'Switchover in progress','phaseReason':'Infrastructure acceptance switchover to '+target}
  k('-n','db','patch','cluster','crawler-pg','--subresource=status','--type=merge','-p',json.dumps({'status':status}))
  for _ in range(90):
   cluster=obj('-n','db','get','cluster','crawler-pg')
   if cluster['status'].get('currentPrimary')==target and cluster['status'].get('readyInstances')==2 and cluster['status'].get('phase')=='Cluster in healthy state':break
   time.sleep(2)
  else:raise RuntimeError('PG switchover did not return healthy')
  seconds=round(time.monotonic()-start,2);state('RUNNING',180)
  after=smoke.insert_event('after-switchover')
  consumed=smoke.consume_events([before_switch,after],240)
  standby=sql(target,'postgres',"SELECT count(*) FROM pg_stat_replication WHERE state='streaming' AND sync_state IN ('sync','quorum')")
  assert standby=='1'
  result['tests']['postgres_switchover']={'status':'PASS','old_primary':old,'new_primary':target,'healthy_after_seconds':seconds,'synchronous_standby':True,'events':consumed}
 result['completed']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 (ROOT/'reports/failover-validation.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
