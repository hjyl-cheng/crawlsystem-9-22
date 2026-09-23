#!/usr/bin/env bash
set -euo pipefail
R=$(cd "$(dirname "$0")/.." && pwd); D="$R/reports/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$D"
kubectl version -o yaml > "$D/kubernetes-version.yaml"
kubectl get nodes -o wide > "$D/nodes.txt"
kubectl get pods -A -o wide > "$D/pods.txt"
kubectl get pods -A -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("namespace\tpod\tcontainer\timageID"); [(print("\t".join([p["metadata"]["namespace"],p["metadata"]["name"],c["name"],c.get("imageID","NOT_READY")]))) for p in d["items"] for c in p.get("status",{}).get("containerStatuses",[])]' > "$D/images.tsv"
kubectl get pv > "$D/pv.txt"; kubectl get pvc -A > "$D/pvc.txt"
kubectl top nodes > "$D/resources.txt" || true
printf 'Report saved to %s (no secrets exported)\n' "$D"
