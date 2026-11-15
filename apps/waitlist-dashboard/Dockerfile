# The private waitlist dashboard. Plain JavaScript: no build step, one
# runtime dependency (pg), run as the unprivileged `node` user (uid and gid 1000).
# The base is pinned by digest (IN-12, 15 November 2026): Node 22.23.5, the base the
# running waitlist image was built from (its build provenance).
FROM node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Owned by root and not writable by the app: it never changes its own code.
COPY src ./src
COPY scripts ./scripts
RUN chmod -R a+rX /app

# Numeric, so the pod's runAsNonRoot can check it (IN-10): `node` is 1000:1000.
USER 1000:1000
EXPOSE 8080

# Answers 200 whether or not the secrets are set, so a deploy never waits on
# them (src/config.js).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/main.js"]
