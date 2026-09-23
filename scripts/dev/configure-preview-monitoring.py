"""Validate and merge one job into existing Prometheus; no deployment recreation."""
import json, os, pathlib, subprocess, sys, time
import yaml
ENV = {**os.environ, 'K3S_CONFIG_FILE': '/dev/null'}
def run(args, **kwargs):
    return subprocess.run(['kubectl', *args], env=ENV, text=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, **kwargs).stdout
cm=json.loads(run(['-n','monitoring','get','configmap','prometheus-config','-o','json']))
config=yaml.safe_load(cm['data']['prometheus.yaml'])
job=yaml.safe_load(pathlib.Path('apps/control-api/deploy/prometheus-job.yaml').read_text())
config['scrape_configs']=[x for x in config['scrape_configs'] if x['job_name'] != job['job_name']]+[job]
rendered=yaml.safe_dump(config,sort_keys=False)
print(run(['-n','monitoring','exec','-i','deployment/prometheus','--','promtool','check','config','/dev/stdin'],input=rendered).strip())
if '--apply' not in sys.argv:
    print('Validated only; pass --apply to merge and reload the existing configuration.')
    raise SystemExit(0)
pathlib.Path('.runtime/prometheus-config-before.json').write_text(json.dumps(cm))
cm['data']['prometheus.yaml']=rendered
cm['metadata'].pop('managedFields',None)
run(['replace','-f','-'],input=json.dumps(cm)) # resourceVersion rejects concurrent edits
for attempt in range(12):
    mounted=run(['-n','monitoring','exec','deployment/prometheus','--','cat','/etc/prometheus/prometheus.yaml'])
    if mounted==rendered: break
    time.sleep(3)
else: raise SystemExit('Config saved; projected volume not updated within 36s. Do not claim reload succeeded.')
run(['-n','monitoring','exec','deployment/prometheus','--','kill','-HUP','1'])
print('Merged preview scrape job and sent SIGHUP; query targets to verify both replicas are up.')
