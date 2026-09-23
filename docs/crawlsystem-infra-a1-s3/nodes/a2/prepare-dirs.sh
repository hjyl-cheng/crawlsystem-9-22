#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }
if [[ -d "/srv/crawl-data/pg" ]] && [[ -n "$(find "/srv/crawl-data/pg" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/pg"
else install -d -m 0750 "/srv/crawl-data/pg"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/pg" 26 26; fi
if [[ -d "/srv/crawl-data/loki" ]] && [[ -n "$(find "/srv/crawl-data/loki" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/loki"
else install -d -m 0750 "/srv/crawl-data/loki"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/loki" 10001 10001; fi
df -h / /srv 2>/dev/null || df -h /
