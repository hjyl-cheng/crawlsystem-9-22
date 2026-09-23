#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["versions"]["helm"]["version"])' "$ROOT/versions.lock.json")
[[ $(uname -m) == x86_64 ]] || exit 2
D="$ROOT/vendor/helm"; mkdir -p "$D"; cd "$D"
F=helm-v${VERSION}-linux-amd64.tar.gz
curl -fL --retry 3 "https://get.helm.sh/$F" -o "$F"
curl -fL --retry 3 "https://get.helm.sh/$F.sha256sum" -o "$F.sha256sum"
sha256sum -c "$F.sha256sum"
tar -xzf "$F"
sudo install -m 0755 linux-amd64/helm /usr/local/bin/helm
helm version
