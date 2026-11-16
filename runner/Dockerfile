FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl jq tini python3 bubblewrap util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 uain && useradd -m -u 10001 -g 10001 -s /bin/sh uain
WORKDIR /opt/uain
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && ln -s /opt/uain/node_modules/.bin/claude /usr/local/bin/claude && ln -s /opt/uain/node_modules/.bin/codex /usr/local/bin/codex
COPY fetch-client.mjs preflight.mjs main.mjs allocate.py ./
RUN node fetch-client.mjs /opt/uain/client-seed && mkdir -p /home/uain/.uain /home/uain/.claude /home/uain/.codex && chown -R 10001:10001 /home/uain
USER 10001:10001
WORKDIR /home/uain
ENV HOME=/home/uain
VOLUME ["/home/uain/.uain", "/home/uain/.claude", "/home/uain/.codex"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "python3", "/opt/uain/allocate.py"]
