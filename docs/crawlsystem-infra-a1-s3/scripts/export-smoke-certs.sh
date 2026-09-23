#!/usr/bin/env bash
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); D="$R/secrets/temporal-smoke"
umask 077; mkdir -p "$D"; chmod 700 "$D"
for key in ca.crt tls.crt tls.key; do
  kubectl -n temporal get secret temporal-smoke-client -o json | python3 -c 'import json,base64,sys; d=json.load(sys.stdin); sys.stdout.buffer.write(base64.b64decode(d["data"][sys.argv[1]]))' "$key" > "$D/$key"
  chmod 600 "$D/$key"
done
echo 'Smoke certificates written locally. Do not share secrets/.'
