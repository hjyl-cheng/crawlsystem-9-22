"""Scope deletion to successful raw paths in m1-main; remove upload-age raw expiry."""
import base64, json, os, secrets, subprocess, sys, uuid
from pathlib import Path
root=Path('.runtime/raw-retention');root.mkdir(parents=True,exist_ok=True,mode=0o700)
env={**os.environ,'K3S_CONFIG_FILE':'/dev/null','KUBECTL_REMOTE_COMMAND_WEBSOCKETS':'false'}
def k(*args,data=None):
    p=subprocess.run(['kubectl',*args],input=data,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=30)
    if p.returncode:raise RuntimeError('Raw retention administration failed')
    return p.stdout
def save(name,value):
    file=root/(name+'.json');file.write_text(json.dumps(value,indent=2)+'\n');file.chmod(0o600)
def minio(script):
    prefix='''set -eu
umask 077
export MC_CONFIG_DIR=/tmp/retention-'''+uuid.uuid4().hex+'''
trap 'rm -rf "$MC_CONFIG_DIR"' EXIT
mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1
'''
    return k('-n','storage','exec','-i','deployment/minio','--','sh',data=prefix+script)
def audit():
    rows=[json.loads(line) for line in minio('''mc ilm export local/crawl-raw --json || true
mc ilm export local/crawl-parsed
mc ilm export local/crawl-evidence
''').splitlines() if line.strip()]
    assert len(rows)==3
    for row in rows[1:]:assert len(row['Rules'])==1 and row['Rules'][0]['Expiration']['Days']==90 and row['Rules'][0]['Status']=='Enabled'
    return rows
def credentials():
    policy={'Version':'2012-10-17','Statement':[
      {'Effect':'Allow','Action':['s3:GetObject','s3:DeleteObject'],'Resource':['arn:aws:s3:::crawl-raw/v1/m1-main/*','arn:aws:s3:::crawl-raw/search/v1/m1-main/*']},
      {'Effect':'Allow','Action':['s3:GetObject'],'Resource':['arn:aws:s3:::crawl-parsed/v1/m1-main/*']}]}
    existing=json.loads(k('-n','analytics','get','secrets','-o','json'))['items']
    old=next((s for s in existing if s['metadata']['name']=='minio-raw-retention'),None)
    password=base64.b64decode(old['data']['secret_key']).decode() if old else secrets.token_hex(32)
    # Password enters the Pod via stdin, never via command arguments or output.
    script="RETENTION_PASSWORD='"+password+"'\ncat > \"$MC_CONFIG_DIR/policy.json\" <<'POLICY'\n"+json.dumps(policy)+"\nPOLICY\n"+'''
mc admin policy create local raw-retention "$MC_CONFIG_DIR/policy.json" >/dev/null 2>&1
mc admin user add local raw-retention "$RETENTION_PASSWORD" >/dev/null 2>&1
mc admin policy attach local raw-retention --user raw-retention >/dev/null 2>&1
'''
    minio(script)
    secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':'minio-raw-retention','namespace':'analytics'},'type':'Opaque','stringData':{'access_key':'raw-retention','secret_key':password}}
    k('apply','-f','-',data=json.dumps(secret))
    save('policy',policy);print(json.dumps({'account':'raw-retention','workspace':'m1-main','raw_success_delete_only':True,'parsed_read_only':True,'evidence_access':False}))
def disable_expiry():
    before=audit()
    rules=before[0].get('Rules')
    assert rules==[] or 'NoSuchLifecycleConfiguration' in json.dumps(before[0]) or (len(rules)==1 and rules[0]['Status']=='Enabled' and rules[0]['Expiration']['Days']==14 and not rules[0].get('Filter') and not rules[0].get('Prefix'))
    if not (root/'lifecycle-before.json').exists():save('lifecycle-before',before)
    minio('mc ilm rm --all --force local/crawl-raw >/dev/null 2>&1\n')
    after=audit()
    raw=after[0]
    assert raw.get('Rules')==[] or 'NoSuchLifecycleConfiguration' in json.dumps(raw)
    assert after[1:]==before[1:]
    save('lifecycle-after',{'raw':raw,'parsed':after[1],'evidence':after[2],'raw_upload_age_expiry_disabled':True,'minio_restarted':False})
    print(json.dumps({'raw_upload_age_expiry_disabled':True,'parsed_days':90,'evidence_days':90,'minio_restarted':False}))
try:
    if sys.argv[1]=='credentials':credentials()
    elif sys.argv[1]=='disable-expiry':disable_expiry()
    else:raise ValueError('Usage: configure-raw-retention credentials|disable-expiry')
except Exception as e:
    print(json.dumps({'result':'FAILED','error':type(e).__name__}));sys.exit(1)
