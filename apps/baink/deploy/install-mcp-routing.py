#!/usr/bin/env python3
"""Install only MCP locations into exact, inspected existing nginx configs."""
import fcntl, hashlib, json, os, pathlib, re, shutil, subprocess, sys
release, primary_sha, preview_sha = sys.argv[1:]
assert os.geteuid() == 0
assert re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{10}', release)
assert all(re.fullmatch(r'[a-f0-9]{64}', value) for value in [primary_sha, preview_sha])
lock = open('/var/lib/baink-deployments/activation.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
assert pathlib.Path('/opt/baink/current').resolve().name == release
backup = pathlib.Path('/var/backups/baink') / release / 'mcp-nginx'
backup.mkdir(mode=0o700)


def block(prefix, upstream):
    return f'''    location = {prefix}/MCP {{ rewrite ^ {prefix}/mcp last; }}
    location = {prefix}/mcp {{
        limit_req zone=baink_api burst=30 nodelay;
        limit_req_status 429;
        proxy_pass http://127.0.0.1:8798{upstream};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 16k;
        proxy_connect_timeout 5s;
        proxy_read_timeout 20s;
    }}

'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace(path, content):
    temporary = path.with_name(path.name + '.mcp-' + release)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    try:
        with os.fdopen(fd, 'wb') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


changes = []
for name, expected, prefix, upstream in [
    ('baink.money.conf', primary_sha, '', ''),
    ('aidollar.money.conf', preview_sha, '/baink', '/mcp'),
]:
    path = pathlib.Path('/etc/nginx/sites-available') / name
    old = path.read_bytes()
    assert digest(old) == expected, 'Config changed since inspection; stop and reconcile.'
    marker = f'    location ^~ {prefix}/api/ {{'
    text = old.decode()
    assert text.count(marker) == 1 and f'location = {prefix}/mcp' not in text
    new = text.replace(marker, block(prefix, upstream) + marker, 1).encode()
    shutil.copy2(path, backup / name)
    os.chmod(backup / name, 0o600)
    changes.append((path, old, new))
try:
    for path, old, new in changes:
        assert path.read_bytes() == old
        replace(path, new)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except BaseException:
    for path, old, new in changes:
        if path.read_bytes() == new:
            replace(path, old)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print(json.dumps({'release': release, 'nginxTest': True, 'reloaded': True,
                  'backup': str(backup), 'configs': [
                      {'name': p.name, 'before': digest(o), 'after': digest(n)}
                      for p, o, n in changes]}))
