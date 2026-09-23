#!/usr/bin/env python3
import json,urllib.request,urllib.error,datetime
from pathlib import Path
R=Path(__file__).resolve().parents[1]
projects={'k3s':('k3s-io/k3s',None),'helm':('helm/helm','v'),'cloudnativepg':('cloudnative-pg/cloudnative-pg','v'),'cert_manager':('cert-manager/cert-manager','v'),'strimzi':('strimzi/strimzi-kafka-operator',''),'temporal':('temporalio/temporal','v'),'temporal_ui':('temporalio/ui','v'),'keda':('kedacore/keda','v'),'barman_plugin':('cloudnative-pg/plugin-barman-cloud','v'),'loki':('grafana/loki','v'),'alloy':('grafana/alloy','v')}
lock=json.loads((R/'versions.lock.json').read_text()); out={};bad=False
for key,(repo,prefix) in projects.items():
    ver=lock['versions'][key]['version'];tag=ver if prefix is None else prefix+ver
    url=f'https://api.github.com/repos/{repo}/releases/tags/{tag}'
    try:
        req=urllib.request.Request(url,headers={'User-Agent':'crawl-infra-version-check','Accept':'application/vnd.github+json'})
        with urllib.request.urlopen(req,timeout=20) as x:d=json.load(x)
        good=not d['draft'] and not d['prerelease'] and d['tag_name']==tag
        out[key]={'tag':tag,'release_ok':good,'url':d['html_url'],'published_at':d['published_at']}
        bad|=not good
    except Exception as e:out[key]={'tag':tag,'release_ok':False,'error':str(e)};bad=True
(R/'reports').mkdir(exist_ok=True)
(R/'reports'/'release-check.json').write_text(json.dumps(out,indent=2))
for k,x in out.items():print(k,x['tag'],x['release_ok'])
print('PostgreSQL/Kafka/ClickHouse versions and registry tags must ALSO be checked against official pages and pulled on target nodes.')
raise SystemExit(1 if bad else 0)
