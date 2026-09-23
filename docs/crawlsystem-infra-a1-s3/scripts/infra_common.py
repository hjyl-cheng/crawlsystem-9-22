"""Local administration helpers. Never emit command inputs or authentication headers."""
import base64, contextlib, http.client, json, os, socket, ssl, subprocess, time
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
os.environ['K3S_CONFIG_FILE'] = '/dev/null'
os.environ.setdefault('KUBECONFIG', '/home/ubuntu/.kube/config')

def run(args, data=None, output=None, timeout=180):
    p = subprocess.run(args, input=data, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if p.returncode:
        # Callers may process secrets; never include stderr or full argv in exceptions.
        raise RuntimeError(f'{args[0]} failed with exit {p.returncode}')
    return p.stdout

def k(*args, **kw):
    return run(['kubectl', *args], **kw)

def obj(*args):
    return json.loads(k(*args, '-o', 'json'))

@contextlib.contextmanager
def forward(namespace, service, remote):
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    proc = subprocess.Popen(['kubectl', '-n', namespace, 'port-forward', '--address=127.0.0.1', service, f'{port}:{remote}'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            if proc.poll() is not None: raise RuntimeError('port-forward exited')
            try:
                with socket.create_connection(('127.0.0.1', port), .2): break
            except OSError: time.sleep(.1)
        else: raise TimeoutError('port-forward startup')
        yield port
    finally:
        proc.terminate()
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()

@contextlib.contextmanager
def clickhouse():
    ca = obj('-n', 'analytics', 'get', 'secret', 'clickhouse-tls')['data']['ca.crt']
    ctx = ssl.create_default_context(cadata=base64.b64decode(ca).decode())
    headers = {'Authorization': 'Basic ' + base64.b64encode(b'default:' + (ROOT/'secrets/clickhouse.password').read_bytes().strip()).decode()}
    with forward('analytics', 'svc/clickhouse', 8443) as port:
        class Connection(http.client.HTTPSConnection):
            def connect(self):
                self.sock = ctx.wrap_socket(socket.create_connection(('127.0.0.1', port), 120), server_hostname=self.host)
        def query(sql):
            c = Connection('clickhouse.analytics.svc.cluster.local', context=ctx, timeout=120)
            try:
                c.request('POST', '/', body=sql.encode(), headers=headers)
                r=c.getresponse(); body=r.read()
                if r.status != 200: raise RuntimeError(f'ClickHouse HTTP {r.status}: {body[:120].decode(errors="replace")}')
                return body.decode()
            finally: c.close()
        yield query

def pg_primary(): return obj('-n','db','get','cluster','crawler-pg')['status']['currentPrimary']
def sql(pod, database, query, namespace='db'):
    return k('-n',namespace,'exec','-i',pod,'-c','postgres','--','psql','-XAt','-U','postgres','-d',database,'-v','ON_ERROR_STOP=1',data=query.encode()).decode().strip()
