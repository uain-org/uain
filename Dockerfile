# Base images are pinned by digest (security review IN-12, 15 November 2026): the
# ones production's running images were built from, read from their build
# provenance. node:22-bookworm-slim is Node 22.23.5; nginx-unprivileged is 1.30.6.
# A new base is a reviewed change to these lines.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# The commit this image is built from, served at /build.json so the live site
# can be matched to a release (ops/docs/build-id.mjs). Pass it with
# `--build-arg UAIN_SOURCE_COMMIT=<sha>`; without it /build.json says null.
ARG UAIN_SOURCE_COMMIT=""
RUN npm run build:web && test -f dist/client/index.html && test -s dist/client/build.json
# /worker/ serves the final signed release (0.15.0) of the retired UAIN Client,
# as frozen copies in public/worker/, so installed clients update once and learn
# they are retired. check:worker verifies them as a client would
# (ops/ci-scope/verify-worker-bundle.mjs): signature, pinned key, every hash.
RUN npm run check:worker && test -s dist/client/worker/follow.mjs \
    && test -s dist/client/worker/manifest.json && test -s dist/client/worker/manifest.sig

# Precompress everything gzip_static can serve. Level 9 here beats the level 5
# nginx would manage per request and costs nothing at request time, leaving the
# container's one CPU to the pilot.
#
# This belongs in the build stage. Doing it in the runtime stage means switching
# to root inside nginx-unprivileged, which leaves root-owned state behind and
# the container will not start — it took the site down once already.
RUN set -eu; \
    find dist/client -type f -size +1k \
      \( -name '*.js' -o -name '*.css' -o -name '*.json' \
         -o -name '*.svg' -o -name '*.html' -o -name '*.txt' \) \
      -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \; ; \
    test -s dist/client/index.html.gz; \
    chmod -R a+rX dist/client

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03
# A template, filled in at start: the DNS server from /etc/resolv.conf
# (15-local-resolvers) and the copies' name, so one image serves compose and
# k3s (ops/nginx/docker.conf).
ENV NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1 \
    UAIN_PILOT_HOST=pilot
USER root
COPY ops/nginx/docker.conf /etc/nginx/templates/default.conf.template
RUN chmod 0755 /etc/nginx/templates \
    && chmod 0644 /etc/nginx/templates/default.conf.template
USER 101
COPY --from=build /app/dist/client /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
