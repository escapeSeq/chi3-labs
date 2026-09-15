#!/bin/sh
# Normalize lab upstreams before Caddy parses the Caddyfile.
# Railway private DNS is <service>.railway.internal. ${{service.PORT}} is empty
# unless PORT is a real service variable, which produces host: and then 502s.
set -eu

default_upstream() {
  name="$1"
  port="$2"
  if [ -n "${RAILWAY_ENVIRONMENT:-}" ]; then
    printf '%s.railway.internal:%s' "$name" "$port"
  else
    printf '%s:%s' "$name" "$port"
  fi
}

normalize_upstream() {
  raw="${1:-}"
  name="$2"
  port="$3"
  raw="${raw#http://}"
  raw="${raw#https://}"
  case "$raw" in
    *:|'')
      raw="${raw%:}"
      ;;
  esac
  if [ -z "$raw" ]; then
    default_upstream "$name" "$port"
    return
  fi
  case "$raw" in
    *:*)
      printf '%s' "$raw"
      ;;
    *)
      printf '%s:%s' "$raw" "$port"
      ;;
  esac
}

export ANALOG_UPSTREAM
export HANDWRITING_UPSTREAM
export DOGFIGHT_UPSTREAM
export WAVE_UPSTREAM
export SWARM_UPSTREAM
ANALOG_UPSTREAM="$(normalize_upstream "${ANALOG_UPSTREAM:-}" analog-chi3-lab 8080)"
HANDWRITING_UPSTREAM="$(normalize_upstream "${HANDWRITING_UPSTREAM:-}" handwriting-ai-lab 8081)"
DOGFIGHT_UPSTREAM="$(normalize_upstream "${DOGFIGHT_UPSTREAM:-}" dogfight-ai-lab 8082)"
WAVE_UPSTREAM="$(normalize_upstream "${WAVE_UPSTREAM:-}" wave-rider-lab 8080)"
SWARM_UPSTREAM="$(normalize_upstream "${SWARM_UPSTREAM:-}" swarm-memory-lab 8083)"

echo "chi3-labs proxy upstreams:"
echo "  analog      ${ANALOG_UPSTREAM}"
echo "  handwriting ${HANDWRITING_UPSTREAM}"
echo "  dogfight    ${DOGFIGHT_UPSTREAM}"
echo "  swarm       ${SWARM_UPSTREAM}"
echo "  waves       ${WAVE_UPSTREAM}"

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
