#!/usr/bin/env bash
# Run as the ubuntu deployment account on A2/A3/S1/S2/S3.
set -euo pipefail
[[ $(id -un) == ubuntu ]] || { echo 'Run as ubuntu; report a different login account before proceeding.' >&2; exit 1; }
umask 077
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
key_line='from="10.4.4.12",restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBP08R5F8JQD5r18md2w0R0yPMsYQTllj5c1i7HP32UU crawlsystem-a1-deploy'
if ! grep -Fqx -- "$key_line" "$HOME/.ssh/authorized_keys"; then
  printf '\n%s\n' "$key_line" >> "$HOME/.ssh/authorized_keys"
fi
printf 'A1 deployment public key installed for ubuntu. Existing keys preserved.\n'
