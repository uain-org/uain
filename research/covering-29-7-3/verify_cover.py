#!/usr/bin/env python3
"""Bounded mathematical covering-witness verifier; runs no submitted code."""
import argparse
import itertools
import json
import re
from pathlib import Path

MAX_BYTES = 32768
TOKEN = re.compile(r'(?:0|[1-9][0-9]*)\Z', re.ASCII)


def verify(data, *, v=29, k=7, t=3, max_blocks=130):
    if not (isinstance(data, bytes) and 1 <= t <= k <= v and max_blocks > 0):
        raise ValueError('invalid verifier input or parameters')
    if len(data) > MAX_BYTES:
        return {'accepted': False, 'error': 'resource_limit', 'missing': None}
    try:
        text = data.decode('ascii')
    except UnicodeDecodeError:
        return {'accepted': False, 'error': 'non_ascii', 'missing': None}
    # Only space, LF and CRLF delimiters. No blank/header/comment rows.
    lines = text.split('\n')
    if lines[-1] == '':
        lines.pop()
    blocks = []
    seen = set()
    error = None
    if not lines or len(lines) > max_blocks:
        error = 'block_count'
    else:
        for line in lines:
            if line.endswith('\r'):
                line = line[:-1]
            tokens = line.split(' ')
            if len(tokens) != k or any(not TOKEN.fullmatch(x) or len(x) > len(str(v - 1)) for x in tokens):
                error = 'row_format'
                break
            block = tuple(sorted(map(int, tokens)))
            if any(x >= v for x in block):
                error = 'out_of_range'
                break
            if len(set(block)) != k:
                error = 'duplicate_point'
                break
            if block in seen:
                error = 'duplicate_block'
                break
            seen.add(block)
            blocks.append(block)
    # Invalid syntax does not define a witness; do not misreport prefix coverage.
    if error:
        return {'accepted': False, 'error': error, 'missing': None}
    covered = set()
    for block in blocks:
        covered.update(itertools.combinations(block, t))
    total = sum(1 for _ in itertools.combinations(range(v), t))
    missing = total - len(covered)
    return {'accepted': missing == 0, 'error': None if missing == 0 else 'incomplete',
            'blocks': len(blocks), 'triples' if t == 3 else 'subsets': total,
            'covered': len(covered), 'missing': missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file', type=Path)
    args = parser.parse_args()
    try:
        with args.file.open('rb') as stream:
            data = stream.read(MAX_BYTES + 1)
        result = verify(data)
    except OSError as exc:
        result = {'accepted': False, 'error': 'read_error', 'missing': None, 'detail': str(exc)}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['accepted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
