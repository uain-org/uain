#!/usr/bin/env python3
"""cargo fmt --check that tolerates release-pinned source.

Some Rust sources are pinned byte-for-byte by a qualified holder tool release
(chain/private-exchange/pins/*.release.json, "sourceSha256"). Their compiled binary
embeds line numbers, so reformatting them would break the release's
provenance. Formatting differences in such a file are accepted only while the
file still matches its pinned SHA-256; every other file must be formatted.

Usage: rustfmt-check.py <Cargo.toml> (run from the chain/ directory).
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def pinned_sources():
    pins = {}
    for record in sorted((REPO / 'chain/private-exchange/pins').glob('*.release.json')):
        for path, digest in json.loads(record.read_text()).get('sourceSha256', {}).items():
            pins[(REPO / path).resolve()] = (digest, record.name)
    return pins


def main():
    if len(sys.argv) != 2:
        sys.exit('usage: rustfmt-check.py <Cargo.toml>')
    result = subprocess.run(['cargo', 'fmt', '--manifest-path', sys.argv[1], '--', '--check'],
                            capture_output=True, text=True)
    sys.stdout.write(result.stdout)
    sys.stderr.write(result.stderr)
    if result.returncode == 0:
        return
    files = {Path(m).resolve() for m in re.findall(r'^Diff in (.+?):\d+:', result.stdout, re.M)}
    if not files:
        sys.exit(f'cargo fmt failed (exit {result.returncode}) without a formatting diff')
    pins, failed = pinned_sources(), []
    for path in sorted(files):
        pin = pins.get(path)
        if pin and hashlib.sha256(path.read_bytes()).hexdigest() == pin[0]:
            print(f'accepted: {path.relative_to(REPO)} is unformatted but byte-pinned by {pin[1]}')
        else:
            failed.append(str(path.relative_to(REPO)))
    if failed:
        sys.exit('rustfmt check failed for: ' + ', '.join(failed))


if __name__ == '__main__':
    main()
