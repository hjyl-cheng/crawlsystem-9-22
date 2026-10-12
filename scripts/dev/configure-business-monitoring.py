"""Validate and merge business rules into the existing monitoring service."""
import json, os, subprocess, time
from pathlib import Path

env = {**os.environ, 'K3S_CONFIG_FILE': '/dev/null', 'KUBECTL_REMOTE_COMMAND_WEBSOCKETS': 'false'}
runtime = Path('.runtime/finish'); runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
def k(*args, data=None):
    p = subprocess.run(['kubectl', *args], input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
    if p.returncode: raise RuntimeError('Business monitoring administration failed')
    return p.stdout
rules = Path('apps/control-api/deploy/business-alerts.yaml').read_text()
k('-n', 'monitoring', 'exec', '-i', 'deployment/prometheus', '--', 'promtool', 'check', 'rules', '/dev/stdin', data=rules)
cm = json.loads(k('-n', 'monitoring', 'get', 'configmap', 'prometheus-rules', '-o', 'json'))
saved = runtime / 'previous-prometheus-rules.json'
if not saved.exists(): saved.write_text(json.dumps(cm)); saved.chmod(0o600)
cm['data']['business.yaml'] = rules; cm['metadata'].pop('managedFields', None)
k('replace', '-f', '-', data=json.dumps(cm))
for attempt in range(60):
    try:
        if k('-n', 'monitoring', 'exec', 'deployment/prometheus', '--', 'cat', '/etc/prometheus/rules/business.yaml') == rules: break
    except RuntimeError:
        pass  # A new rule file appears only after Kubernetes refreshes the volume.
    time.sleep(2)
else: raise RuntimeError('Business rule projection timed out')
k('-n', 'monitoring', 'exec', 'deployment/prometheus', '--', 'kill', '-HUP', '1')
print('Eight business alerts validated, projected and reloaded')
