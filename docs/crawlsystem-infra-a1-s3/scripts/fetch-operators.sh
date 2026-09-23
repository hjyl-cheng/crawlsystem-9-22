#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
mkdir -p vendor
get() { curl -fL --retry 3 "$2" -o "vendor/$1.yaml.tmp"; mv "vendor/$1.yaml.tmp" "vendor/$1.yaml"; }
get cert-manager https://github.com/cert-manager/cert-manager/releases/download/v1.21.2/cert-manager.yaml
get cnpg https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.30/releases/cnpg-1.30.0.yaml
get barman https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.0/manifest.yaml
get strimzi https://github.com/strimzi/strimzi-kafka-operator/releases/download/1.2.0/strimzi-cluster-operator-1.2.0.yaml
get keda https://github.com/kedacore/keda/releases/download/v2.20.2/keda-2.20.2.yaml
sha256sum vendor/*.yaml > vendor/downloaded-SHA256SUMS
python3 scripts/prepare-operators.py
