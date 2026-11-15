"""Guard temporary paths before invoking an installed Nginx for trusted fixtures.

An isolated -p prefix does not replace absolute compiled-in temporary paths.
Even nginx -t can create/chown them. This guard is intentionally not a general
Nginx sandbox: callers still own the rest of their fixture configuration.
"""
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess


TEMP_PATHS = {
    'client_body_temp_path': 'body',
    'proxy_temp_path': 'proxy',
    'fastcgi_temp_path': 'fastcgi',
    'uwsgi_temp_path': 'uwsgi',
    'scgi_temp_path': 'scgi',
}


def _root(root):
    path = Path(root)
    if not path.is_absolute() or path.is_symlink():
        raise ValueError('Fixture root must be an absolute non-symlink directory')
    try:
        path = path.resolve(strict=True)
        info = path.stat()
    except OSError as error:
        raise ValueError('Fixture root is unavailable') from error
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) & 0o022):
        raise ValueError('Fixture root must be owned and not writable by others')
    # Fixture-generated paths are single plain Nginx tokens, never substitutions.
    if not re.fullmatch(r'[A-Za-z0-9_./-]+', str(path)):
        raise ValueError('Unsafe fixture root token')
    return path


def _inside(base, value, *, directory=True):
    path = Path(value)
    if (not path.is_absolute() or '..' in path.parts or '$' in value
            or not re.fullmatch(r'[A-Za-z0-9_./-]+', value)):
        raise ValueError('Unsafe fixture path')
    try:
        parts = path.relative_to(base).parts
        path.resolve().relative_to(base)
    except (ValueError, OSError, RuntimeError) as error:
        raise ValueError('Fixture path escapes its root') from error
    if not parts:
        raise ValueError('Fixture path must be beneath its root')
    current = base
    for part in parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Fixture path contains a symlink')
        if current.exists() and current != path and not current.is_dir():
            raise ValueError('Fixture path ancestor is not a directory')
    if path.exists() and directory and not path.is_dir():
        raise ValueError('Fixture temporary path is not a directory')
    return path


def temp_directives(root):
    base = _root(root)
    return ''.join(
        f'{name} {_inside(base, str(base / suffix))};\n'
        for name, suffix in TEMP_PATHS.items()
    ).encode()


def _tokens(text):
    """Retain structural punctuation separately from quoted regex/JSON text."""
    word = []
    quote = None
    escaped = False
    comment = False
    for char in text:
        if comment:
            if char == '\n':
                comment = False
            continue
        if escaped:
            word.append(char)
            escaped = False
            continue
        if char == '\\':
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            else:
                word.append(char)
            continue
        if char in ('"', "'"):
            quote = char
        elif char == '#':
            if word:
                yield ''.join(word), False
                word = []
            comment = True
        elif char.isspace() or char in ';{}':
            if word:
                yield ''.join(word), False
                word = []
            if char in ';{}':
                yield char, True
        else:
            word.append(char)
    if quote or escaped:
        raise ValueError('Unterminated fixture configuration token')
    if word:
        yield ''.join(word), False


def validate_config(config, root):
    base = _root(root)
    try:
        text = config.decode('utf-8') if isinstance(config, bytes) else config
    except UnicodeError as error:
        raise ValueError('Invalid fixture configuration encoding') from error
    if not isinstance(text, str) or len(text) > 1048576 or '\0' in text:
        raise ValueError('Invalid fixture configuration')
    paths = {}
    stack = []
    statement = []
    for token, structural in _tokens(text):
        if not structural:
            statement.append(token)
            continue
        if token == '{':
            if not statement:
                raise ValueError('Missing fixture block directive')
            stack.append(statement[0])
        elif token == '}':
            if statement or not stack:
                raise ValueError('Unbalanced fixture block')
            stack.pop()
        elif statement:
            name = statement[0]
            if name == 'include':
                raise ValueError('Fixture configuration cannot include other files')
            if name in TEMP_PATHS:
                if stack != ['http'] or name in paths or len(statement) != 2:
                    raise ValueError('Fixture temp directives must occur once at http scope')
                paths[name] = _inside(base, statement[1])
        statement = []
    if stack or statement or set(paths) != set(TEMP_PATHS) or len(set(paths.values())) != 5:
        raise ValueError('Every fixture temporary path must be explicitly isolated')
    return paths


def _checked_config(config, root):
    base = _root(root)
    try:
        relative = Path(config).absolute().relative_to(Path(root).absolute())
    except ValueError as error:
        raise ValueError('Fixture configuration escapes its root') from error
    path = _inside(base, str(base / relative), directory=False)
    if not path.is_file():
        raise ValueError('Fixture configuration is not a regular file')
    validate_config(path.read_bytes(), base)
    return path, base


def syntax_check(binary, config, root):
    path, base = _checked_config(config, root)
    return subprocess.run(
        [binary, '-t', '-p', str(base), '-c', str(path)],
        capture_output=True, timeout=10,
    )


def start(binary, config, root):
    path, base = _checked_config(config, root)
    return subprocess.Popen(
        [binary, '-p', str(base), '-c', str(path)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


def snapshot_default_paths(binary):
    """Read compiled default directory metadata without testing a configuration."""
    result = subprocess.run([binary, '-V'], capture_output=True, timeout=10, check=True)
    text = (result.stdout + result.stderr).decode('utf-8')
    if 'configure arguments:' not in text:
        raise ValueError('Cannot identify compiled Nginx temporary paths')
    arguments = shlex.split(text.split('configure arguments:', 1)[1].strip())
    flags = dict(item.split('=', 1) for item in arguments if item.startswith('--') and '=' in item)
    names = ['client-body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']
    snapshot = {}
    for name in names:
        value = flags.get(f'--http-{name}-temp-path')
        if value is None:
            raise ValueError('Cannot identify every compiled Nginx temporary path')
        path = Path(value)
        if not path.is_absolute():
            path = Path(flags.get('--prefix', '/usr/local/nginx')) / path
        try:
            info = path.lstat()
            snapshot[str(path)] = {
                'exists': True, 'uid': info.st_uid, 'gid': info.st_gid,
                'mode': stat.S_IMODE(info.st_mode), 'inode': info.st_ino,
                'device': info.st_dev,
            }
        except FileNotFoundError:
            snapshot[str(path)] = {'exists': False}
    return snapshot
