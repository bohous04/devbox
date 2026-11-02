#!/bin/sh
# Shared by setup and the boot-time Docker firewall. PUBLIC_IFACE may list multiple NICs.
public_interfaces() (
  set -f  # split the NIC list on whitespace, never expand filenames
  interfaces=${PUBLIC_IFACE:-}
  if [ -z "$interfaces" ]; then
    interfaces=$( { ip -o -4 route show default; ip -o -6 route show default; } | awk '{for(i=1;i<NF;i++) if($i=="dev") print $(i+1)}' | sort -u)
  fi
  # shellcheck disable=SC2086
  set -- $interfaces
  [ "$#" -gt 0 ] || { echo 'Cannot detect public interfaces; set PUBLIC_IFACE explicitly.' >&2; return 1; }
  for iface do
    case "$iface" in *[!a-zA-Z0-9_.:-]*|lo|tailscale*) echo "Invalid public interface: $iface" >&2; return 1 ;; esac
    ip link show dev "$iface" >/dev/null 2>&1 || { echo "Public interface does not exist: $iface" >&2; return 1; }
  done
  printf '%s\n' "$@"
)
