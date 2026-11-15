"""Run on a resource-limited server, once. Fetch an immutable model snapshot."""
import hashlib
import json
import sys
from pathlib import Path
from huggingface_hub import snapshot_download
from embedding_server import REPOSITORY,REVISION
path = Path(sys.argv[1])
if (path/'manifest.json').exists():
    raise SystemExit('Model directory already provisioned; verify it instead of overwriting it')
files = ['model_optimized.onnx','config.json','special_tokens_map.json','tokenizer.json','tokenizer_config.json','vocab.txt']
snapshot_download(repo_id=REPOSITORY,revision=REVISION,allow_patterns=files,local_dir=str(path))
manifest = {'repository':REPOSITORY,'revision':REVISION,'sha256':{name:hashlib.sha256((path/name).read_bytes()).hexdigest() for name in files}}
(path/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
print(json.dumps(manifest))
