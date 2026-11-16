#!/usr/bin/env bash
# Isolated nginx probe: real records beat static files, missing records stay 404.
set -euo pipefail
checkout=${1:-$(git rev-parse --show-toplevel)}
probe="uain-seo-route-$$"
fixture=$(mktemp -d)
cleanup() { docker rm -f "$probe" >/dev/null 2>&1 || true; rm -rf "$fixture"; }
trap cleanup EXIT
chmod 755 "$fixture"
cat > "$fixture/upstream.conf" <<'NGINX'
server {
 listen 8787;
 location = /network/directory/kestrel { return 200 'current native kestrel fixture'; }
 location = /network/directory/known { return 200 'verified member fixture'; }
 location = /network/projects/known.svg { return 200 'verified project fixture'; }
 location = /records/projects { return 200 'live catalogue fixture'; }
 location / { return 404 'missing public record'; }
}
NGINX
printf '# Joining the United AI Network\n' > "$fixture/access-guide.md"
chmod 644 "$fixture/upstream.conf" "$fixture/access-guide.md"
docker run --rm -d --name "$probe" --memory 128m --cpus 0.5 \
 -e UAIN_PILOT_HOST=127.0.0.1 -e NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
 -v "$checkout/ops/nginx/docker.conf:/etc/nginx/templates/default.conf.template:ro" \
 -v "$fixture/upstream.conf:/etc/nginx/conf.d/upstream.conf:ro" \
 -v "$fixture/access-guide.md:/usr/share/nginx/html/access-guide.md:ro" \
 -p 127.0.0.1::8080 nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 >/dev/null
port=$(docker port "$probe" 8080/tcp | sed 's/.*://')
base="http://127.0.0.1:$port"
for attempt in $(seq 1 20); do curl -fsS "$base/records/projects" > "$fixture/body" 2>/dev/null && break; sleep 1; done
grep -q 'live catalogue fixture' "$fixture/body"
curl -fsS "$base/network/directory/kestrel" | grep -q 'current native kestrel fixture'
curl -fsS "$base/network/directory/known" | grep -q 'verified member fixture'
curl -fsS "$base/network/projects/known.svg" | grep -q 'verified project fixture'
test "$(curl -sS -o /dev/null -w '%{http_code}' "$base/network/directory/missing")" = 404
for path in /for-ai/ /network/projects/known/ /project/known; do
 test "$(curl -sS -D "$fixture/headers" -o /dev/null -w '%{http_code}' "$base$path")" = 308
 grep -qi '^location: /' "$fixture/headers"
done
curl -fsS -H 'Accept: text/markdown' "$base/" | grep -q 'Joining the United AI Network'
echo 'SEO_NGINX_ROUTING_OK: catalogues, records, image-like IDs, missing records, aliases, slashes and current Markdown'
