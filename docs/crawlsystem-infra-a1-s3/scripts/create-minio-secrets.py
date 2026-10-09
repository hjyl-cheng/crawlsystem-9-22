#!/usr/bin/env python3
"""MinIO credentials (plan R1): root, one user per service, and copies for the consumers.

Random values are generated once into secrets/ (git-ignored, 0600) and never printed. Existing
Kubernetes secrets are left untouched, like create-secrets.py: rotating means deleting both the
local file and the secrets on purpose, then re-running this script and the minio-setup Job.
"""
import secrets, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]; D = ROOT / 'secrets'
D.mkdir(exist_ok=True, mode=0o700); D.chmod(0o700)

def local(name: str, nbytes: int = 32) -> Path:
    p = D / f'{name}.secret'
    if not p.exists():
        p.write_text(secrets.token_hex(nbytes)); p.chmod(0o600)
    return p

def exists(ns: str, name: str) -> bool:
    out = subprocess.run(['kubectl', '-n', ns, 'get', 'secret', name, '--ignore-not-found', '-o', 'name'], capture_output=True, text=True, check=True)
    return bool(out.stdout.strip())

def secret(ns: str, name: str, files: dict[str, Path]) -> None:
    if exists(ns, name):
        print(f'{ns}/{name}: already exists, not modified'); return
    cmd = ['kubectl', '-n', ns, 'create', 'secret', 'generic', name]
    for key, path in files.items(): cmd += ['--from-file', f'{key}={path}']
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL)
    print(f'{ns}/{name}: created')

with tempfile.TemporaryDirectory() as tmp:
    user = Path(tmp) / 'user'; user.write_text('crawl-root')
    secret('storage', 'minio-root', {'user': user, 'password': local('minio-root')})
    # The setup Job reads every service user's secret key; each consumer gets only its own.
    roles = {role: local(f'minio-{role}') for role in ('worker', 'parser', 'reader')}
    secret('storage', 'minio-users', roles)
    for role, ns in (('worker', 'crawler'), ('parser', 'crawler'), ('reader', 'control')):
        access = Path(tmp) / f'access-{role}'; access.write_text(f'crawl-{role}')
        secret(ns, f'minio-crawl-{role}', {'access_key': access, 'secret_key': roles[role]})
