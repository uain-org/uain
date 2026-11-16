#!/usr/bin/env bash
# Run as root on uain-app-1 after server qualification. Creates no research.
set -euo pipefail
umask 077
[ "$(id -u)" = 0 ] || { echo 'run as root on uain-app-1' >&2; exit 1; }
[ "$(hostname -s)" = uain-app-1 ] || { echo 'unexpected app host' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
root=/opt/uain-retrieval
[ ! -e "$root" ] || { echo 'already provisioned; do not overwrite a running service' >&2; exit 1; }
id uain-retrieval >/dev/null 2>&1 || useradd --system --home-dir "$root" --shell /usr/sbin/nologin uain-retrieval
install -d -m 0750 -o root -g uain-retrieval "$root" /etc/uain-retrieval
install -m 0644 "$repo/services/retrieval/embedding_server.py" "$repo/services/retrieval/download_model.py" "$repo/services/retrieval/qualify_model.py" "$root/"
install -m 0644 "$repo/services/retrieval/requirements.lock" "$repo/services/retrieval/requirements.hashes.lock" "$root/"
python3 -m venv "$root/venv"
# Every file must match a hash in the lock (SV-6); requirements.lock holds the same pins without hashes.
"$root/venv/bin/pip" install --require-hashes -r "$root/requirements.hashes.lock"
"$root/venv/bin/python" "$root/download_model.py" "$root/model" > "$root/model-receipt.json"
# Pin public checksums obtained in qualification, not just a fresh download's receipt.
"$root/venv/bin/python" - "$root/model/manifest.json" "$repo/services/retrieval/model-manifest.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))==json.load(open(sys.argv[2])), 'Model checksum mismatch'
PY
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "$root/venv/bin/python" "$root/qualify_model.py" "$root/model" > "$root/qualification.json"
openssl rand -hex 32 | tr -d '\n' > /etc/uain-retrieval/token
chown root:uain-retrieval /etc/uain-retrieval/token
chmod 0440 /etc/uain-retrieval/token
chmod -R a+rX "$root/venv" "$root/model"
# No executable or model write access for the service account.
install -m 0644 "$repo/ops/retrieval/uain-embeddings.service" /etc/systemd/system/uain-embeddings.service
systemctl daemon-reload
systemctl enable --now uain-embeddings.service
for i in $(seq 1 30); do curl -fsS --max-time 2 http://10.98.0.1:8073/health >/dev/null && break; sleep 1; done
curl -fsS --max-time 2 http://10.98.0.1:8073/health >/dev/null
# Feature activation only after DB extension is independently prepared.
kubectl -n uain create secret generic uain-retrieval \
  --from-literal=UAIN_RESEARCH_SEARCH=1 \
  --from-literal=UAIN_EMBEDDING_ENDPOINT=http://10.98.0.1:8073 \
  --from-file=UAIN_EMBEDDING_TOKEN=/etc/uain-retrieval/token \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo 'Private embedding endpoint qualified and retrieval secret provisioned.'
