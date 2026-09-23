#!/usr/bin/env bash
# Read-only; does not install, reboot, change firewall, or touch data.
set -uo pipefail
printf '\n== Host / OS / architecture ==\n'; hostname; cat /etc/os-release; uname -m
printf '\n== CPU / memory / swap ==\n'; nproc; free -h; swapon --show
printf '\n== Disks ==\n'; lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS; df -hT; df -i
printf '\n== Network ==\n'; ip -br a; ip route; ss -lntup
printf '\n== Time ==\n'; timedatectl status
printf '\n== Existing runtimes ==\n'
for x in k3s docker containerd psql; do command -v "$x" || true; done
printf '\n== Private connectivity (ICMP failure alone is not proof of no network) ==\n'
for ip in 10.4.4.12 10.4.4.3 10.4.4.17 10.4.4.2 10.4.4.8 10.4.4.5; do
  echo "-- $ip --"; ip route get "$ip"; ping -c 3 -W 2 "$ip" || true
done
printf '\nNo secrets collected; review output before sharing.\n'
