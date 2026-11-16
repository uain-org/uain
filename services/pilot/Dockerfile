# Compile TypeScript separately; the runtime image needs only production dependencies.
# The base is pinned by digest (IN-12, 15 November 2026): Node 22.23.5, the base the
# running pilot image was built from (its build provenance). Same in both stages.
FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS build
WORKDIR /app
COPY services/pilot/package.json services/pilot/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/pilot/tsconfig*.json ./
COPY services/pilot/src ./src
RUN npm run typecheck && npm run build

FROM node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# PostgreSQL holds current data; node:sqlite reads the optional legacy import.
RUN node -e 'require("node:sqlite")'

WORKDIR /app
COPY services/pilot/package.json services/pilot/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY services/pilot/scripts/waitlist-export.mjs services/pilot/scripts/donation-interest-export.mjs services/pilot/scripts/archive-test-projects.mjs ./scripts/
# The skill test bank is seeded from inside a container, the only place the
# live store is reachable from (scripts/seed-skill-tests.mjs).
COPY services/pilot/scripts/seed-skill-tests.mjs ./scripts/
# Staging is seeded with the open problems the same way (deploy/k8s/staging).
COPY services/pilot/scripts/seed-open-problems.mjs services/pilot/scripts/open-problems.json ./scripts/
COPY services/pilot/scripts/capture-reset-history.mjs services/pilot/scripts/verify-ledger.mjs ./scripts/
COPY ops/chain/native-rpc-transport.mjs ./native-rpc-transport.mjs
# The commit this image is built from, served at /api/build (src/api/build-id.ts).
# Pass it with `--build-arg UAIN_SOURCE_COMMIT=<sha>`; without it the answer
# says null. Kept after the dependencies so a new commit rebuilds only this.
ARG UAIN_SOURCE_COMMIT=""
COPY ops/docs/build-id.mjs ./scripts/build-id.mjs
RUN node scripts/build-id.mjs uain-pilot /app/build.json

# The store lives on a volume, not in the image, so deploys never erase the
# participant registry or the adoption log.
ENV UAIN_DATA_DIR=/var/lib/uain-pilot \
    HOST=0.0.0.0 \
    PORT=8787 \
    NODE_ENV=production
# Keep public code root-owned and readable regardless of the build-worker umask.
RUN mkdir -p /var/lib/uain-pilot && chown -R node:node /var/lib/uain-pilot \
    && chmod -R a+rX /app

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/api/server.js"]
