#!/usr/bin/env python3
"""Merge R5 alerts into existing Prometheus without replacing other rules."""
import json,os,subprocess,time
from pathlib import Path
env={**os.environ,'K3S_CONFIG_FILE':'/dev/null'}
def k(*args,data=None):
 result=subprocess.run(['kubectl',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30)
 if result.returncode:raise RuntimeError('Monitoring administration failed')
 return result.stdout
rules=Path('apps/control-api/deploy/r5-alerts.yaml').read_text()
k('-n','monitoring','exec','-i','deployment/prometheus','--','promtool','check','rules','/dev/stdin',data=rules)
cm=json.loads(k('-n','monitoring','get','configmap','prometheus-rules','-o','json'))
cm['data']['r5.yaml']=rules;cm['metadata'].pop('managedFields',None)
k('replace','-f','-',data=json.dumps(cm))
for attempt in range(20):
 try:
  mounted=k('-n','monitoring','exec','deployment/prometheus','--','cat','/etc/prometheus/rules/r5.yaml')
  if mounted==rules:break
 except RuntimeError:pass
 time.sleep(3)
else:raise RuntimeError('Rule projection not updated')
k('-n','monitoring','exec','deployment/prometheus','--','kill','-HUP','1')
print('R5 archive/evidence alerts validated, projected and reloaded')
