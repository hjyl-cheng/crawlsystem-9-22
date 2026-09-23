#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }
if [[ -d "/srv/crawl-data/pg" ]] && [[ -n "$(find "/srv/crawl-data/pg" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/pg"
else install -d -m 0750 "/srv/crawl-data/pg"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/pg" 26 26; fi
if [[ -d "/srv/crawl-data/prometheus" ]] && [[ -n "$(find "/srv/crawl-data/prometheus" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/prometheus"
else install -d -m 0750 "/srv/crawl-data/prometheus"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/prometheus" 65534 65534; fi
if [[ -d "/srv/crawl-data/grafana" ]] && [[ -n "$(find "/srv/crawl-data/grafana" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/grafana"
else install -d -m 0750 "/srv/crawl-data/grafana"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/grafana" 472 472; fi
if [[ -d "/srv/crawl-data/alertmanager" ]] && [[ -n "$(find "/srv/crawl-data/alertmanager" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/alertmanager"
else install -d -m 0750 "/srv/crawl-data/alertmanager"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/alertmanager" 65534 65534; fi
df -h / /srv 2>/dev/null || df -h /
