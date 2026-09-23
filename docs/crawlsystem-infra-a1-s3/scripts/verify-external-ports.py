#!/usr/bin/env python3
"""Bounded TCP checks through independent Globalping probes, with SSH controls."""
import concurrent.futures, datetime, json, time, urllib.request
from infra_common import ROOT

HOSTS = {'a1':'43.173.68.88','a2':'43.173.68.187','a3':'43.172.94.2',
         's1':'43.172.65.165','s2':'43.159.169.76','s3':'43.172.80.48'}
PORTS = [2379,2380,6443,10250,9100,5432,9092,9093,8083,8443,9440,3000,3100,9090]
BASE = 'https://api.globalping.io/v1/measurements'

def request(url, data=None):
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data else None,
        headers={'Content-Type':'application/json','User-Agent':'crawlsystem-infra-acceptance/1.0'})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)

def measure(node, port, locations):
    row = {'node':node,'address':HOSTS[node],'port':port,'status':'INCONCLUSIVE'}
    try:
        created = request(BASE, {'type':'ping','target':HOSTS[node], 'limit':2,
            'locations':locations,'measurementOptions':{'protocol':'TCP','port':port,'packets':2}})
        row['id'] = created['id']
        for _ in range(30):
            time.sleep(2)
            result = request(BASE+'/'+created['id'])
            if result['status']=='finished':
                row['measurement'] = result
                probes = result['results']
                valid = len(probes)==2 and all(p['result'].get('status')=='finished'
                    and p['result'].get('stats',{}).get('total')==2
                    and p['result'].get('resolvedAddress')==HOSTS[node] for p in probes)
                if valid:
                    received = [p['result']['stats']['rcv'] for p in probes]
                    row['status'] = ('CONTROL_PASS' if all(n>0 for n in received) else 'INCONCLUSIVE') if port==22 else ('OPEN' if any(received) else 'CLOSED_OR_FILTERED')
                break
    except Exception as exc:
        row['error_type'] = type(exc).__name__
    return row

def main():
    report = {'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source':'Globalping independent Singapore/Japan probes; reused probe pair; TCP connect, 2 packets each',
        'scope':'Six specified public IPv4 addresses and 14 sensitive TCP ports only; not an all-port/UDP scan or proof for every source.',
        'results':[], 'status':'RUNNING'}
    path = ROOT/'reports/external-ports.json'
    def save():
        tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(report,indent=2));tmp.replace(path)
    first=measure('a1',22,[{'magic':'Singapore'},{'magic':'Japan'}])
    report['results'].append(first);save()
    if first['status']!='CONTROL_PASS':
        report['status']='INCONCLUSIVE';save();raise RuntimeError('External SSH control failed')
    locations=first['id']
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        tasks=[pool.submit(measure,node,port,locations) for node in HOSTS for port in [22]+PORTS if (node,port)!=('a1',22)]
        for task in concurrent.futures.as_completed(tasks):
            row=task.result();report['results'].append(row);save()
            print(json.dumps({k:row[k] for k in ['node','port','status']}),flush=True)
    controls=[r for r in report['results'] if r['port']==22]
    checks=[r for r in report['results'] if r['port']!=22]
    report['status']='PASS' if len(controls)==6 and all(r['status']=='CONTROL_PASS' for r in controls) and len(checks)==84 and all(r['status']=='CLOSED_OR_FILTERED' for r in checks) else 'REVIEW_REQUIRED'
    report['completed']=datetime.datetime.now(datetime.timezone.utc).isoformat();save()
    print(json.dumps({'status':report['status'],'controls':len(controls),'sensitive_ports':len(checks)}))
    if report['status']!='PASS':raise RuntimeError('External acceptance needs review')

if __name__=='__main__':main()
