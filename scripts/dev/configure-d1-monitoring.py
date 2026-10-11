#!/usr/bin/env python3
"""Update existing R5 thresholds to the configuration gauges, preserving other alert rules."""
import json,os,subprocess,time
from pathlib import Path
env={**os.environ,'K3S_CONFIG_FILE':'/dev/null'}
def k(*args,data=None):
 p=subprocess.run(['kubectl',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30)
 if p.returncode:raise RuntimeError('D1 monitoring administration failed')
 return p.stdout
rules=Path('apps/control-api/deploy/r5-alerts.yaml').read_text()
k('-n','monitoring','exec','-i','deployment/prometheus','--','promtool','check','rules','/dev/stdin',data=rules)
cm=json.loads(k('-n','monitoring','get','configmap','prometheus-rules','-o','json'))
saved=Path('.runtime/d1/previous-prometheus-rules.json')
if not saved.exists():saved.write_text(json.dumps(cm));saved.chmod(0o600)
cm['data']['r5.yaml']=rules;cm['metadata'].pop('managedFields',None)
k('replace','-f','-',data=json.dumps(cm))
for attempt in range(75):
 try:
  if k('-n','monitoring','exec','deployment/prometheus','--','cat','/etc/prometheus/rules/r5.yaml')==rules:break
 except RuntimeError:pass
 time.sleep(2)
else:raise RuntimeError('D1 alert rule projection timed out')
k('-n','monitoring','exec','deployment/prometheus','--','kill','-HUP','1')
print('D1 configurable alert thresholds checked and loaded')
