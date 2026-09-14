#!/bin/sh
# Bind nginx to PORT on IPv4 and IPv6. Railway private networking is IPv6;
# healthchecks and Docker Compose still use IPv4.
set -eu
PORT="${PORT:-8083}"
sed -i "s/listen \[::\]:80;/listen [::]:${PORT};/" /etc/nginx/nginx.conf
sed -i "s/listen 80;/listen ${PORT};/" /etc/nginx/nginx.conf
exec nginx -g "daemon off;"
