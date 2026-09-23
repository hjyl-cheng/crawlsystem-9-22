#!/usr/bin/env python3
"""Generate random, no-newline secrets locally; do not rotate existing secrets implicitly."""
import json,os,secrets,hashlib,subprocess,base64
import xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]; D=ROOT/'secrets'
D.mkdir(exist_ok=True,mode=0o700); D.chmod(0o700)
def run(cmd,**kw):return subprocess.run(cmd,check=True,**kw)
def exists(ns,name):
    x=subprocess.run(['kubectl','-n',ns,'get','secret',name,'--ignore-not-found','-o','name'],capture_output=True,text=True,check=True)
    return bool(x.stdout.strip())
def secret(ns,name,mapping,typ=None):
    if exists(ns,name):
        print(f'{ns}/{name}: already exists, not modified'); return
    cmd=['kubectl','-n',ns,'create','secret','generic',name]
    if typ:cmd+=['--type',typ]
    for key,path in mapping.items():cmd+=['--from-file',f'{key}={path}']
    run(cmd,stdout=subprocess.DEVNULL)
def local(name):
    p=D/(name+'.password')
    if not p.exists():
        p.write_text(secrets.token_hex(32)); p.chmod(0o600)
    return p
# An old cluster with missing/different local credentials is not a new install.
# Stop instead of generating a new password for only some consumers.
checks = [
    ('temporal','db','temporal-login','password','raw'),
    ('temporal','temporal','temporal-db','password','raw'),
    ('dbz','db','dbz-login','password','raw'),
    ('dbz','kafka','dbz-pg-credentials','credentials.properties','properties'),
    ('grafana','monitoring','grafana-admin','admin-password','raw'),
    ('clickhouse','analytics','clickhouse-users','users.xml','sha256'),
]
for name,ns,secret_name,key,form in checks:
    if not exists(ns,secret_name):
        continue
    password_path=D/(name+'.password')
    if not password_path.is_file():
        raise SystemExit(f'STOP: {ns}/{secret_name} exists but local credential is missing. Restore the original secrets directory; do not rotate implicitly.')
    record=json.loads(subprocess.run(['kubectl','-n',ns,'get','secret',secret_name,'-o','json'],capture_output=True,text=True,check=True).stdout)
    raw=base64.b64decode(record.get('data',{}).get(key,''))
    local_value=password_path.read_bytes()
    if form=='properties':
        rows=dict(line.split('=',1) for line in raw.decode().splitlines() if '=' in line)
        matches=rows.get('password','').encode()==local_value
    elif form=='sha256':
        matches=ET.fromstring(raw).findtext('./users/default/password_sha256_hex')==hashlib.sha256(local_value).hexdigest()
    else:
        matches=raw==local_value
    if not matches:
        raise SystemExit(f'STOP: local credential does not match {ns}/{secret_name}. Use an explicit credential recovery/rotation procedure.')
for name in ('temporal','dbz','grafana','clickhouse'):local(name)
for name,user in [('temporal','temporal_svc'),('dbz','dbz_svc')]:
    p=D/(name+'.username');p.write_text(user);p.chmod(0o600)
    secret('db',name+'-login',{'username':p,'password':local(name)},'kubernetes.io/basic-auth')
secret('temporal','temporal-db',{'password':local('temporal')})
secret('monitoring','grafana-admin',{'admin-password':local('grafana')})
p=D/'credentials.properties';p.write_text('password='+local('dbz').read_text()+'\n');p.chmod(0o600)
secret('kafka','dbz-pg-credentials',{'credentials.properties':p})
h=hashlib.sha256(local('clickhouse').read_bytes()).hexdigest()
xml=f"""<clickhouse><users><default><password remove="remove"/><password_sha256_hex>{h}</password_sha256_hex><networks><ip>0.0.0.0/0</ip></networks><profile>crawl</profile><access_management>1</access_management></default></users><profiles><crawl><max_threads>2</max_threads><max_memory_usage>1073741824</max_memory_usage><max_execution_time>60</max_execution_time></crawl></profiles></clickhouse>"""
p=D/'clickhouse-users.xml';p.write_text(xml);p.chmod(0o600)
secret('analytics','clickhouse-users',{'users.xml':p})
print('Secrets created/reused. Never post secrets/, kubeconfig, or cluster tokens in chat.')
