#!/usr/bin/env python3
"""Only local syntax/reference checks. Not Helm rendering or API validation."""
from pathlib import Path
import ast,json,re,subprocess,xml.etree.ElementTree as ET
import yaml
R=Path(__file__).resolve().parents[1];errors=[];counts={"yaml_files":0,"objects":0,"python":0,"shell":0,"json":0,"xml":0}
for p in R.rglob('*'):
    if not p.is_file() or {'vendor','secrets','__pycache__','.venv-infra'}.intersection(p.relative_to(R).parts): continue
    try:
        if p.suffix=='.py':ast.parse(p.read_text());counts['python']+=1
        elif p.suffix=='.sh':subprocess.run(['bash','-n',str(p)],check=True,capture_output=True);counts['shell']+=1
        elif p.suffix=='.json':json.loads(p.read_text());counts['json']+=1
        elif p.suffix in ('.yaml','.yml'):
            dd=list(yaml.safe_load_all(p.read_text()));counts['yaml_files']+=1
            for d in dd:
                if not isinstance(d,dict):continue
                if 'apiVersion' in d:counts['objects']+=1
                if d.get('kind')=='ConfigMap':
                    for key,value in d.get('data',{}).items():
                        if key.endswith(('.yaml','.yml')):yaml.safe_load(value)
                        if key.endswith('.xml'):ET.fromstring(value);counts['xml']+=1
    except Exception as e:errors.append(f'{p.relative_to(R)}: {e}')
inv=json.loads((R/'inventory.json').read_text())
for n in inv['nodes']:
    p=R/'nodes'/n['name']/'k3s-config.yaml';d=yaml.safe_load(p.read_text())
    if d['node-ip']!=n['private_ip'] or d['node-name']!=n['name']:errors.append('node mismatch '+n['name'])
    if n['k3s_role']=='agent' and any(k in d for k in ('flannel-backend','cluster-init','cluster-cidr')):errors.append('server option in agent '+n['name'])
md=R/'README.md'
if md.exists():
    text=md.read_text()
    if text.count('```')%2:errors.append('Markdown fence mismatch')
    anchors=re.findall(r'<a id="([^"]+)"',text)
    if len(anchors)!=len(set(anchors)):errors.append('duplicate anchors')
    for a in re.findall(r'\]\(#([^\)]+)\)',text):
        if a not in anchors:errors.append('missing anchor '+a)
    for f in re.findall(r'`((?:scripts|manifests|values|nodes|sql)/[^` ]+)`',text):
        if '*' not in f and not (R/f).exists():errors.append('missing local reference '+f)
report={'status':'PASS_STATIC_ONLY' if not errors else 'FAIL','counts':counts,'errors':errors,
'not_tested':['remote SSH','image pulls','Helm render','CRD server-side dry-run','live TLS','PG/Kafka/Temporal startup','failover','backup restore','actual disk growth','resource and load tests']}
(R/'reports').mkdir(exist_ok=True);(R/'reports'/'static-validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2));raise SystemExit(1 if errors else 0)
