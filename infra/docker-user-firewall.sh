#!/bin/sh
# Containers must not be reachable from the public interface.
#
# Docker writes its own NAT/FORWARD rules outside ufw, so `-p 5433:5432`
# exposes the port to the internet despite `ufw default deny incoming`. This does not affect
# session containers (devd binds their ports to the tailnet IP), but everything an agent
# starts inside a session — `docker compose up` with Postgres, Redis, Mailhog.
# Verified 2026-08-11: 11 such containers were listening on 0.0.0.0.
#
# DOCKER-USER is the only chain we may write to that docker does not overwrite.
# We drop only NEW connections coming from the public interface — replies to
# outgoing container traffic are ESTABLISHED, traffic between containers goes over
# docker0 and tailnet access over tailscale0, so the rule catches none of that.
set -eu
IFACE="${PUBLIC_IFACE:-eth0}"
for cmd in iptables ip6tables; do
  # The chain may not exist yet when we are faster than docker after boot.
  "$cmd" -N DOCKER-USER 2>/dev/null || true
  "$cmd" -C DOCKER-USER -i "$IFACE" -m conntrack --ctstate NEW -j DROP 2>/dev/null \
    || "$cmd" -I DOCKER-USER -i "$IFACE" -m conntrack --ctstate NEW -j DROP
done
