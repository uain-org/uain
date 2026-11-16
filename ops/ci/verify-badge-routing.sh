#!/usr/bin/env bash
# Isolated nginx integration probe: SVG API routes must beat static image rules.
set -euo pipefail
checkout=${1:-$(git rev-parse --show-toplevel)}
probe="uain-badge-route-$$"
fixture=$(mktemp -d)
cleanup() { docker rm -f "$probe" >/dev/null 2>&1 || true; rm -rf "$fixture"; }
trap cleanup EXIT
chmod 755 "$fixture"
cat > "$fixture/upstream.conf" <<'NGINX'
server {
    listen 8787;
    location = /api/badges/demo.svg {
        default_type image/svg+xml;
        add_header Cache-Control "public, max-age=60";
        return 200 '<svg xmlns="http://www.w3.org/2000/svg"><title>badge fixture</title></svg>';
    }
    location / { add_header Cache-Control "no-store" always; return 404; }
}
NGINX
echo '<svg xmlns="http://www.w3.org/2000/svg"><title>static fixture</title></svg>' > "$fixture/ordinary.svg"
chmod 644 "$fixture/upstream.conf" "$fixture/ordinary.svg"
docker run --rm -d --name "$probe" --memory 128m --cpus 0.5 \
  -e UAIN_PILOT_HOST=127.0.0.1 -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
  -v "$checkout/ops/nginx/docker.conf:/etc/nginx/templates/default.conf.template:ro" \
  -v "$fixture/upstream.conf:/etc/nginx/conf.d/upstream.conf:ro" \
  -v "$fixture/ordinary.svg:/usr/share/nginx/html/ordinary.svg:ro" \
  -p 127.0.0.1::8080 nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 >/dev/null
port=$(docker port "$probe" 8080/tcp | sed 's/.*://')
for attempt in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$port/api/badges/demo.svg" -D "$fixture/headers" -o "$fixture/body" 2>/dev/null && break
  sleep 1
done
grep -q 'badge fixture' "$fixture/body"
grep -qi 'content-type: image/svg+xml' "$fixture/headers"
grep -qi 'cache-control: public, max-age=60' "$fixture/headers"
code=$(curl -sS "http://127.0.0.1:$port/api/badges/missing.svg" -D "$fixture/headers" -o /dev/null -w '%{http_code}')
test "$code" = 404
grep -qi 'cache-control: no-store' "$fixture/headers"
# Ordinary images retain the static image route, not the API fixture.
code=$(curl -sS "http://127.0.0.1:$port/ordinary.svg" -D "$fixture/headers" -o "$fixture/body" -w '%{http_code}')
test "$code" = 200
grep -q 'static fixture' "$fixture/body"
grep -qi 'max-age=2592000' "$fixture/headers"
echo 'BADGE_NGINX_ROUTING_OK: SVG API, unknown badge and static image routes'
