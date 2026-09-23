#!/usr/bin/env python3
"""Alertmanager webhook -> DingTalk. Secrets are mounted files, never logged."""
import base64, hashlib, hmac, http.server, json, os, time, urllib.parse, urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get('DINGTALK_CONFIG', '/etc/dingtalk/config.json'))

def signed_url(webhook, secret, timestamp):
    if not secret:
        return webhook
    signature = base64.b64encode(hmac.new(secret.encode(), f'{timestamp}\n{secret}'.encode(), hashlib.sha256).digest()).decode()
    return webhook + '&' + urllib.parse.urlencode({'timestamp':timestamp, 'sign':signature})

def config():
    data=json.loads(CONFIG.read_text())
    url=urllib.parse.urlsplit(data['webhook'])
    if url.scheme!='https' or url.netloc!='oapi.dingtalk.com' or url.path!='/robot/send' or not urllib.parse.parse_qs(url.query).get('access_token'):
        raise ValueError('Unsupported DingTalk webhook')
    return data

def message(payload, keyword):
    status=payload.get('status')
    if status not in ('firing','resolved') or not isinstance(payload.get('alerts'),list) or not payload['alerts']:
        raise ValueError('Invalid Alertmanager payload')
    title=f'{keyword} 基础设施告警' + ('恢复' if status=='resolved' else '触发')
    lines=[f'### {title}']
    # Restrict fields to avoid forwarding arbitrary annotations or credentials.
    for alert in payload['alerts'][:10]:
        labels=alert.get('labels',{})
        lines.append('- '+ ' / '.join(str(labels.get(k,'-'))[:120].replace('\n',' ') for k in ('alertname','severity','node')))
    if len(payload['alerts'])>10:lines.append(f'另有 {len(payload["alerts"])-10} 条告警。')
    return {'msgtype':'markdown','markdown':{'title':title,'text':'\n\n'.join(lines)}}

def deliver(payload):
    settings=config()
    data=message(payload,settings.get('keyword','爬虫基础设施'))
    url=signed_url(settings['webhook'],settings.get('secret',''),str(int(time.time()*1000)))
    request=urllib.request.Request(url,data=json.dumps(data,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request,timeout=12) as response:
        result=json.load(response)
    if result.get('errcode')!=0:
        raise RuntimeError('DingTalk rejected notification')
    print(json.dumps({'delivered':True,'status':payload['status'],
        'alerts':[a.get('labels',{}).get('alertname') for a in payload['alerts']],
        'test_ids':[a.get('labels',{}).get('acceptance_id') for a in payload['alerts']]}),flush=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            config();status=200 if self.path=='/health' else 404
        except Exception:status=503
        self.send_response(status);self.end_headers()
    def do_POST(self):
        try:
            size=int(self.headers.get('Content-Length','0'))
            if self.path!='/alerts' or not 0<size<=1048576:
                self.send_response(400);self.end_headers();return
            payload=json.loads(self.rfile.read(size))
            deliver(payload)
            status=200
        except Exception:
            # Alertmanager retries; HTTP 200 with a DingTalk errcode is not success.
            status=502
        self.send_response(status);self.end_headers()
    def log_message(self,*args):pass

if __name__=='__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0',8080),Handler).serve_forever()
