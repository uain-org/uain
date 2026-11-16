#!/usr/bin/env bash
# Readability preflight runs before secrets/manifest changes. No server, network,
# mounted path or credentials are available to these short-lived containers.
set -euo pipefail
registry=${1:?exact registry required}
tag=${2:?exact source revision required}
[[ "$registry" == 10.98.0.1:5000/uain && "$tag" =~ ^[0-9a-f]{40}$ ]]
limits=(--rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --cpus 1 --memory 256m --memory-swap 256m --pids-limit 64)
docker run "${limits[@]}" --entrypoint node "$registry/pilot:$tag" -e 'const fs=require("node:fs");if(process.getuid()===0)throw Error("runtime must be unprivileged");for(const p of ["/app/package.json","/app/dist/src/api/server.js","/app/native-rpc-transport.mjs"])fs.accessSync(p,fs.constants.R_OK);console.log("pilot runtime files readable")'
docker run "${limits[@]}" --entrypoint node "$registry/waitlist:$tag" -e 'const fs=require("node:fs");if(process.getuid()===0)throw Error("runtime must be unprivileged");for(const p of ["/app/package.json","/app/src/main.js"])fs.accessSync(p,fs.constants.R_OK);console.log("waitlist runtime files readable")'
docker run "${limits[@]}" --entrypoint /bin/sh "$registry/web:$tag" -c 'test "$(id -u)" != 0 || exit 1; for p in /etc/nginx/templates/default.conf.template /usr/share/nginx/html/index.html /usr/share/nginx/html/worker/uain-worker.mjs /usr/share/nginx/html/worker/manifest.json /usr/share/nginx/html/worker/manifest.sig; do test -r "$p" || exit 1; done; echo "web runtime files readable"'
