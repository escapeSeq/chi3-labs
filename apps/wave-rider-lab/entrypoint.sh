#!/bin/sh
# PORT is expanded by Caddy from the environment. Keep this wrapper so
# Windows CRLF cannot sneak into the image CMD, and so we log the bind.
set -eu
PORT="${PORT:-8083}"
echo "wave-rider-lab listening on ${PORT} (IPv4 and IPv6)"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
