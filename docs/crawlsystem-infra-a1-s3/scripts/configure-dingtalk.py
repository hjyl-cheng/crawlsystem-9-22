#!/usr/bin/env python3
"""Prepare manifest; --apply requires secrets/dingtalk.json and deploys routing."""
import argparse, base64, importlib.util, json, os, yaml
from infra_common import ROOT, k, obj

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    app='alert-dingtalk'
    resources=[{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':app+'-code','namespace':'monitoring'},'data':{'server.py':(ROOT/'scripts/dingtalk-webhook.py').read_text()}},
      {'apiVersion':'apps/v1','kind':'Deployment','metadata':{'name':app,'namespace':'monitoring'},'spec':{'replicas':1,'selector':{'matchLabels':{'app':app}},'template':{'metadata':{'labels':{'app':app}},'spec':{'automountServiceAccountToken':False,'nodeSelector':{'kubernetes.io/hostname':'a3'},'securityContext':{'runAsUser':65534,'runAsGroup':65534,'fsGroup':65534},'containers':[{'name':'webhook','image':'python:3.14.3-alpine3.23','command':['python','-B','/app/server.py'],'ports':[{'containerPort':8080}],'resources':{'requests':{'cpu':'10m','memory':'24Mi'},'limits':{'cpu':'100m','memory':'64Mi'}},'securityContext':{'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}},'volumeMounts':[{'name':'code','mountPath':'/app','readOnly':True},{'name':'config','mountPath':'/etc/dingtalk','readOnly':True}],'readinessProbe':{'httpGet':{'path':'/health','port':8080}},'livenessProbe':{'tcpSocket':{'port':8080}}}],'volumes':[{'name':'code','configMap':{'name':app+'-code'}},{'name':'config','secret':{'secretName':app,'defaultMode':288}}]}}}},
      {'apiVersion':'v1','kind':'Service','metadata':{'name':app,'namespace':'monitoring'},'spec':{'selector':{'app':app},'ports':[{'port':8080,'targetPort':8080}]}},
      {'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':app,'namespace':'monitoring'},'spec':{'podSelector':{'matchLabels':{'app':app}},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{'matchLabels':{'app':'alertmanager'}}}],'ports':[{'protocol':'TCP','port':8080}]}]}}]
    manifest=ROOT/'examples/55-alert-dingtalk.NOT_APPLY.yaml'
    manifest.write_text(yaml.safe_dump_all(resources,sort_keys=False,allow_unicode=True))
    if not args.apply:
        print('Manifest prepared; awaiting robot credentials');return
    path=ROOT/'secrets/dingtalk.json'
    if path.stat().st_mode & 0o077:raise RuntimeError('DingTalk config must be private, mode 600')
    os.environ['DINGTALK_CONFIG']=str(path)
    spec=importlib.util.spec_from_file_location('dingtalk',ROOT/'scripts/dingtalk-webhook.py');adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter);adapter.config()
    secret={'apiVersion':'v1','kind':'Secret','metadata':{'name':app,'namespace':'monitoring'},'type':'Opaque','data':{'config.json':base64.b64encode(path.read_bytes()).decode()}}
    k('apply','-f','-',data=json.dumps(secret).encode());k('apply','-f',str(manifest))
    k('-n','monitoring','rollout','status','deployment/'+app,'--timeout=120s')
    cm=obj('-n','monitoring','get','configmap','alertmanager-config');config=yaml.safe_load(cm['data']['alertmanager.yaml'])
    receiver=next(r for r in config['receivers'] if r['name']=='local-journal')
    url='http://alert-dingtalk.monitoring.svc.cluster.local:8080/alerts'
    if not any(w.get('url')==url for w in receiver['webhook_configs']):receiver['webhook_configs'].append({'url':url,'send_resolved':True})
    text=yaml.safe_dump(config,sort_keys=False)
    k('-n','monitoring','patch','configmap','alertmanager-config','--type=merge','-p',json.dumps({'data':{'alertmanager.yaml':text}}))
    p=ROOT/'manifests/50-monitoring.yaml';docs=list(yaml.safe_load_all(p.read_text()))
    next(d for d in docs if d['metadata']['name']=='alertmanager-config')['data']['alertmanager.yaml']=text
    p.write_text(yaml.safe_dump_all(docs,sort_keys=False,allow_unicode=True))
    (ROOT/'manifests/55-alert-dingtalk.yaml').write_text(manifest.read_text())
    k('-n','monitoring','rollout','restart','deployment/alertmanager');k('-n','monitoring','rollout','status','deployment/alertmanager','--timeout=120s')
    print('DingTalk routing enabled; delivery acceptance still required')

if __name__=='__main__':main()
