#!/usr/bin/env python3
"""Use an SSH/kubectl port-forward to localhost:8083 first. Does not mutate an existing connector."""
import json, urllib.request, urllib.error, sys, time
from pathlib import Path
R=Path(__file__).resolve().parents[1]
c=json.loads((R/'examples/infra-outbox-connector.json').read_text())
base='http://127.0.0.1:8083'
try:
    with urllib.request.urlopen(base+'/connectors/'+c['name']+'/config',timeout=15) as x:existing=json.load(x)
    wanted=c['config']
    mismatch={k for k,v in wanted.items() if str(existing.get(k))!=str(v)}
    if mismatch:raise SystemExit('Existing connector differs in keys: '+','.join(sorted(mismatch))+'; review instead of overwriting')
    print('Existing configuration matches; not recreated.')
except urllib.error.HTTPError as e:
    if e.code!=404:raise
    req=urllib.request.Request(base+'/connectors',data=json.dumps(c).encode(),headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req,timeout=30) as x: print('Connector created:', x.status)
# Connect publishes status asynchronously after accepting the connector.
for attempt in range(30):
    try:
        with urllib.request.urlopen(base+'/connectors/'+c['name']+'/status',timeout=15) as x:
            d=json.load(x)
        break
    except urllib.error.HTTPError as e:
        if e.code!=404:raise
        time.sleep(1)
else:
    raise SystemExit('Connector accepted but status did not appear within 30 seconds')
print(json.dumps(d,indent=2))
