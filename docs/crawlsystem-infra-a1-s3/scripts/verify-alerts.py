#!/usr/bin/env python3
"""Exercise Prometheus rule -> Alertmanager -> persistent local webhook journal."""
import argparse,datetime,json,time,urllib.request,uuid
from infra_common import ROOT,k,obj,forward

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--dingtalk',action='store_true');args=parser.parse_args()
 acceptance_id=str(uuid.uuid4())
 name='prometheus-rules';original=obj('-n','monitoring','get','configmap',name)['data']
 import yaml
 data=dict(original);data['acceptance.yaml']=yaml.safe_dump({'groups':[{'name':'acceptance','interval':'5s','rules':[{'alert':'InfraAcceptanceTest','expr':'vector(1)','labels':{'severity':'info','purpose':'infrastructure-acceptance','acceptance_id':acceptance_id},'annotations':{'summary':'Infrastructure alert pipeline acceptance test'}}]}]})
 k('-n','monitoring','patch','configmap',name,'--type=merge','-p',json.dumps({'data':data}))
 report={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'external_delivery':False,'acceptance_id':acceptance_id}
 try:
  # A rollout immediately mounts this exact configuration and avoids projection delay.
  k('-n','monitoring','rollout','restart','deployment/prometheus')
  k('-n','monitoring','rollout','status','deployment/prometheus','--timeout=120s')
  def wait_journal(state):
   for _ in range(48):
    try:
     lines=k('-n','monitoring','exec','deploy/alert-journal','--','cat','/data/journal/alerts.jsonl').decode().splitlines()
     matches=[json.loads(s) for s in lines if acceptance_id in s]
     if any(m['status']==state for m in matches):return True
    except RuntimeError:pass
    time.sleep(5)
   raise RuntimeError('Local alert '+state+' not recorded')
  def wait_dingtalk(state):
   for _ in range(48):
    lines=k('-n','monitoring','logs','deploy/alert-dingtalk','--since=15m').decode().splitlines()
    for line in lines:
     try:delivery=json.loads(line)
     except ValueError:continue
     if delivery.get('delivered') and delivery.get('status')==state and acceptance_id in delivery.get('test_ids',[]):return
    time.sleep(5)
   raise RuntimeError('DingTalk did not accept '+state+' notification')
  wait_journal('firing');report['firing']='PASS'
  if args.dingtalk:wait_dingtalk('firing');report['dingtalk_firing']='PASS'
 finally:
  k('-n','monitoring','patch','configmap',name,'--type=json','-p',json.dumps([{'op':'remove','path':'/data/acceptance.yaml'}]))
  k('-n','monitoring','rollout','restart','deployment/prometheus')
  k('-n','monitoring','rollout','status','deployment/prometheus','--timeout=120s')
 wait_journal('resolved');report['resolved']='PASS';report['completed']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if args.dingtalk:
  wait_dingtalk('resolved');report.update(dingtalk_resolved='PASS',external_delivery=True,delivery_evidence='DingTalk API errcode=0 for firing and resolved; does not establish human reading')
 name='alert-dingtalk-pipeline.json' if args.dingtalk else 'alert-pipeline.json'
 (ROOT/'reports'/name).write_text(json.dumps(report,indent=2));print(json.dumps(report))
if __name__=='__main__':main()
