#!/usr/bin/env python3
"""Six-node TCP bulk transfer and IPv4 ICMP don't-fragment MTU matrix."""
import concurrent.futures,json,subprocess,time
from infra_common import ROOT,k,obj
CODE=r'''
import hashlib,http.server,json,socket,struct,sys,time
DATA=b'crawl-network-check\n'*55000
if len(sys.argv)==1:
 class Handler(http.server.BaseHTTPRequestHandler):
  def do_GET(self):
   self.send_response(200);self.send_header('Content-Length',str(len(DATA)));self.end_headers();self.wfile.write(DATA)
  def log_message(self,*args):pass
 http.server.ThreadingHTTPServer(('0.0.0.0',18080),Handler).serve_forever()
else:
 import urllib.request
 mtu=int(open('/sys/class/net/eth0/mtu').read()); results=[]
 def checksum(data):
  if len(data)%2:data+=b'\0'
  s=sum(struct.unpack('!%dH'%(len(data)//2),data));s=(s>>16)+(s&0xffff);s+=(s>>16);return ~s&0xffff
 for idx,(node,ip) in enumerate(json.loads(sys.argv[1]).items()):
  began=time.monotonic();body=urllib.request.urlopen('http://'+ip+':18080/',timeout=15).read();assert hashlib.sha256(body).digest()==hashlib.sha256(DATA).digest()
  sock=socket.socket(socket.AF_INET,socket.SOCK_RAW,socket.IPPROTO_ICMP);sock.settimeout(3);sock.setsockopt(socket.IPPROTO_IP,10,2)
  ident=4096+idx;payload=b'm'*(mtu-28);head=struct.pack('!BBHHH',8,0,0,ident,1);packet=struct.pack('!BBHHH',8,0,checksum(head+payload),ident,1)+payload
  sock.sendto(packet,(ip,0));ok=False
  until=time.monotonic()+3
  while time.monotonic()<until:
   try:r,peer=sock.recvfrom(65535)
   except socket.timeout:break
   off=(r[0]&15)*4
   if peer[0]==ip and len(r)>=off+8:
    typ,code,cs,rid,seq=struct.unpack('!BBHHH',r[off:off+8])
    if typ==0 and rid==ident and seq==1:ok=True;break
  sock.close();results.append({'target':node,'bytes':len(body),'sha256_match':True,'pod_mtu':mtu,'icmp_df_payload':mtu-28,'icmp_df_success':ok,'seconds':round(time.monotonic()-began,3)})
 print(json.dumps(results))
'''
def main():
 ns='infra-test';nodes=['a1','a2','a3','s1','s2','s3'];created=[]
 k('create','-f','-',data=json.dumps({'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'network-matrix-code','namespace':ns},'data':{'network.py':CODE}}).encode())
 k('create','-f','-',data=json.dumps({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'network-matrix','namespace':ns},'spec':{'podSelector':{'matchLabels':{'app':'network-matrix'}},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{'matchLabels':{'app':'network-matrix'}}}]}]}}).encode())
 try:
  for node in nodes:
   name='network-matrix-'+node
   pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':ns,'labels':{'app':'network-matrix'}},'spec':{'automountServiceAccountToken':False,'restartPolicy':'Never','nodeSelector':{'kubernetes.io/hostname':node},'containers':[{'name':'probe','image':'python:3.14.3-alpine3.23','command':['python','/app/network.py'],'resources':{'requests':{'cpu':'10m','memory':'32Mi'},'limits':{'cpu':'200m','memory':'128Mi'}},'securityContext':{'capabilities':{'add':['NET_RAW']}},'volumeMounts':[{'name':'code','mountPath':'/app','readOnly':True}],'readinessProbe':{'tcpSocket':{'port':18080},'periodSeconds':2}}],'volumes':[{'name':'code','configMap':{'name':'network-matrix-code'}}]}}
   k('create','-f','-',data=json.dumps(pod).encode());created.append(name)
  k('-n',ns,'wait','--for=condition=Ready','pod','-l','app=network-matrix','--timeout=180s',timeout=190)
  pods=obj('-n',ns,'get','pods','-l','app=network-matrix')['items'];ips={p['spec']['nodeSelector']['kubernetes.io/hostname']:p['status']['podIP'] for p in pods}
  def probe(node):
   peers={n:ip for n,ip in ips.items() if n!=node}
   return {'source':node,'results':json.loads(k('-n',ns,'exec','network-matrix-'+node,'--','python','/app/network.py',json.dumps(peers),timeout=90))}
  with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:results=list(ex.map(probe,nodes))
  (ROOT/'reports/pod-network-matrix.json').write_text(json.dumps(results,indent=2))
  checks=[v for r in results for v in r['results']];print(json.dumps({'paths':len(checks),'bulk_transfer_pass':sum(x['sha256_match'] for x in checks),'mtu_df_pass':sum(x['icmp_df_success'] for x in checks),'mtu':sorted(set(x['pod_mtu'] for x in checks))}))
  assert len(checks)==30 and all(x['icmp_df_success'] for x in checks)
 finally:
  for name in created:k('-n',ns,'delete','pod',name,'--wait=false')
  k('-n',ns,'delete','configmap/network-matrix-code','networkpolicy/network-matrix')
if __name__=='__main__':main()
