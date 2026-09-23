#!/usr/bin/env python3
"""Patch only operator placement/resources and Strimzi namespace, never CRDs."""
from pathlib import Path
import yaml
ROOT=Path(__file__).resolve().parents[1]
for name in ('cert-manager','cnpg','barman','strimzi','keda'):
    source=ROOT/'vendor'/f'{name}.yaml'
    # Empty trailing documents must not become "--- null", which kubectl rejects.
    data=[d for d in yaml.safe_load_all(source.read_text()) if d is not None]
    for d in data:
        if not isinstance(d,dict): continue
        if name=='strimzi':
            meta=d.setdefault('metadata',{})
            # The release bundle leaves namespaced objects without a namespace.
            # Set it explicitly so plain kubectl apply cannot put them in default.
            if d.get('kind') in ('Deployment','ServiceAccount','RoleBinding','ConfigMap') and not meta.get('namespace'):
                meta['namespace']='kafka'
            if meta.get('namespace') in ('myproject','default','strimzi'): meta['namespace']='kafka'
            if d.get('kind')=='Namespace' and meta.get('name') in ('myproject','strimzi'): meta['name']='kafka'
            for sub in d.get('subjects',[]):
                if sub.get('namespace') in ('myproject','default','strimzi'): sub['namespace']='kafka'
        if d.get('kind')!='Deployment': continue
        spec=d['spec']['template']['spec']
        spec.setdefault('nodeSelector',{})['kubernetes.io/hostname']='a1'
        for c in spec['containers']:
            c['resources']={'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'500m','memory':'512Mi'}}
    (ROOT/'vendor'/f'{name}.prepared.yaml').write_text(yaml.safe_dump_all(data,sort_keys=False))
print('Prepared operator YAML. Review diff before server-side dry-run/apply.')
