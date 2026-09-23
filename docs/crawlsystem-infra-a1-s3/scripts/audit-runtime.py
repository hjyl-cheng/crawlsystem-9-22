#!/usr/bin/env python3
"""Record exact running images and scan bounded logs for known service passwords."""
import base64,concurrent.futures,datetime,json,subprocess
from infra_common import ROOT,obj,k

def main():
 pods=obj('get','pods','-A')['items'];secrets=obj('get','secrets','-A')['items'];values=set()
 for secret in secrets:
  for name,data in secret.get('data',{}).items():
   if 'password' in name.lower():
    value=base64.b64decode(data).strip()
    if len(value)>=10:values.add(value)
 for path in (ROOT/'secrets').glob('*.password'):
  value=path.read_bytes().strip()
  if len(value)>=10:values.add(value)
 images=[];jobs=[]
 for pod in pods:
  for c in pod['spec']['containers']:
   name=pod['metadata']['namespace']+'/'+pod['metadata']['name']+'/'+c['name'];jobs.append((pod['metadata']['namespace'],pod['metadata']['name'],c['name']))
   status=next((x for x in pod['status'].get('containerStatuses',[]) if x['name']==c['name']),{})
   images.append({'container':name,'image':c['image'],'imageID':status.get('imageID'),'tag_is_latest':c['image'].endswith(':latest') or ':' not in c['image'].split('/')[-1],'ready':status.get('ready')})
 def logs(job):
  ns,pod,container=job
  p=subprocess.run(['kubectl','-n',ns,'logs',pod,'-c',container,'--since=2h','--tail=3000','--limit-bytes=524288'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
  return {'container':'/'.join(job),'bytes_scanned':len(p.stdout),'available':p.returncode==0,'known_password_found':any(v in p.stdout for v in values)}
 with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:results=list(ex.map(logs,jobs))
 reports=[]
 for p in (ROOT/'reports').rglob('*'):
  if p.is_file() and p.stat().st_size<10*1024*1024:
   data=p.read_bytes()
   if any(v in data for v in values):reports.append(str(p.relative_to(ROOT)))
 report={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'images':images,'logs':results,'reports_containing_known_passwords':reports,'scope':'Exact-match scan for known generated service passwords, bounded current-container logs; not a full sensitive-data or vulnerability audit.'}
 (ROOT/'reports/runtime-audit.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'images':len(images),'unpinned_tags':sum(i['tag_is_latest'] for i in images),'missing_image_ids':sum(not i['imageID'] for i in images),'logs_checked':sum(x['available'] for x in results),'password_hits':sum(x['known_password_found'] for x in results),'report_password_hits':len(reports)}))
 assert not reports and not any(x['known_password_found'] for x in results)
if __name__=='__main__':main()
