#!/usr/bin/env bash
set -euo pipefail
[[ ${EUID} -eq 0 ]] || { echo "Run with sudo" >&2; exit 1; }
if [[ -d "/srv/crawl-data/kafka" ]] && [[ -n "$(find "/srv/crawl-data/kafka" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Non-empty directory, no ownership change: /srv/crawl-data/kafka"
else install -d -m 0750 "/srv/crawl-data/kafka"; python3 -c 'import os,sys; os.chown(sys.argv[1],int(sys.argv[2]),int(sys.argv[3]))' "/srv/crawl-data/kafka" 1001 0; fi
df -h / /srv 2>/dev/null || df -h /
