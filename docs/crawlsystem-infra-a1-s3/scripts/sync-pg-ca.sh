#!/usr/bin/env bash
set -euo pipefail
CA=$(kubectl -n db get cluster crawler-pg -o jsonpath='{.status.certificates.serverCASecret}')
[[ -n $CA ]] || { echo 'PG CA not ready'; exit 2; }
ROOT=$(cd "$(dirname "$0")/.." && pwd); mkdir -p "$ROOT/secrets"; chmod 700 "$ROOT/secrets"
kubectl -n db get secret "$CA" -o jsonpath='{.data.ca\.crt}' | base64 -d > "$ROOT/secrets/pg-ca.crt"
openssl x509 -in "$ROOT/secrets/pg-ca.crt" -noout -subject -dates
for ns in temporal kafka infra-test; do
 kubectl -n "$ns" create configmap pg-ca --from-file=ca.crt="$ROOT/secrets/pg-ca.crt" --dry-run=client -o yaml | kubectl apply -f -
done
echo 'Public CA copied; no CA private key copied. Repeat after planned CA rotation and restart dependent workloads as required.'
