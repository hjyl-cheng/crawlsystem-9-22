#!/usr/bin/env bash
# Fresh installation only. Token must be transferred securely for joining nodes.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=${1:?Usage: sudo bash scripts/install-k3s-node.sh a1}
[[ $EUID -eq 0 ]] || { echo 'sudo is required'; exit 1; }
[[ $NODE =~ ^(a[123]|s[123])$ ]] || exit 2
[[ $(uname -m) == x86_64 ]] || { echo 'This package targets amd64 only'; exit 2; }
[[ ! -e /var/lib/rancher/k3s/server/db && ! -e /etc/systemd/system/k3s.service && ! -e /etc/systemd/system/k3s-agent.service ]] || {
 echo 'Existing K3s detected. This is not an upgrade/reset script.' >&2; exit 2;
}
EXPECTED=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["private_ip"])' "$ROOT/nodes/$NODE/identity.json")
ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fx "$EXPECTED" >/dev/null || {
 echo "Expected private IP $EXPECTED not assigned to this host" >&2; exit 2;
}
[[ -z $(swapon --show --noheadings) ]] || { echo 'Review and disable swap before installing'; exit 2; }
if [[ $NODE != a1 && ! -s /etc/rancher/k3s/cluster-token ]]; then
  echo 'Securely install A1 full server token before running this script'; exit 2
fi
modprobe wireguard; modprobe br_netfilter; modprobe overlay
read -r -p "Type INSTALL-$NODE after preflight and cloud firewall checks: " answer
[[ $answer == "INSTALL-$NODE" ]] || exit 2
VERSION=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["versions"]["k3s"]["version"])' "$ROOT/versions.lock.json")
ENCODED=${VERSION/+/%2B}; D=/var/cache/crawl-infra/k3s-$VERSION
mkdir -p "$D"; cd "$D"
curl -fL --retry 3 "https://github.com/k3s-io/k3s/releases/download/$ENCODED/k3s" -o k3s
curl -fL --retry 3 "https://github.com/k3s-io/k3s/releases/download/$ENCODED/sha256sum-amd64.txt" -o SHA256SUMS
awk '$2=="k3s" || $2=="./k3s" {print}' SHA256SUMS > k3s.sha256
[[ -s k3s.sha256 ]] || { echo 'No checksum for k3s'; exit 2; }
sha256sum -c k3s.sha256
curl -fL --retry 3 "https://raw.githubusercontent.com/k3s-io/k3s/$ENCODED/install.sh" -o install.sh
install -m 0755 k3s /usr/local/bin/k3s
install -d -m 0700 /etc/rancher/k3s
[[ ! -e /etc/rancher/k3s/config.yaml ]] || { echo 'config.yaml exists; inspect it first'; exit 2; }
install -m 0600 "$ROOT/nodes/$NODE/k3s-config.yaml" /etc/rancher/k3s/config.yaml
if [[ $NODE == a1 ]]; then
  [[ -e /etc/rancher/k3s/cluster-token ]] || (umask 077; openssl rand -hex 32 > /etc/rancher/k3s/cluster-token)
else
  [[ -s /etc/rancher/k3s/cluster-token ]] || { echo 'Securely install A1 full server token first'; exit 2; }
fi
chmod 0600 /etc/rancher/k3s/cluster-token
case "$NODE" in a1|s1|s2) MODE=server;; *) MODE=agent;; esac
env INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_EXEC="$MODE" sh install.sh
systemctl --no-pager --full status "k3s$( [[ $MODE == agent ]] && printf -- '-agent' || true )" || true
