#!/usr/bin/python3 -I
"""Publish the native chain's proof age for Prometheus (node-exporter textfile).

Custody, BAINK and the member client refuse native proofs older than 120 s, so
the age of the newest block is the number that says whether payments can
move. Every 15 s (uain-native-proof-age.timer) this reads the local
validator's RPC /status, remembers the newest block it has seen, and writes
uain_native.prom atomically. When the RPC does not answer (for example while
a backup has the validator stopped) the age keeps growing from the last block
seen, so the UainNativeProofStale alert (ops/monitoring/grafana) fires once
it passes 120 s. Read-only: no key, no write to the node.
"""
import datetime
import json
import os
from pathlib import Path
import sys
import urllib.request

RPC = 'http://127.0.0.1:26667/status'
STATE = Path('/var/lib/uain-proof-age/last.json')
OUTPUT = Path('/var/lib/node_exporter/textfile/uain_native.prom')
GATE_SECONDS = 120


def parse_time(value):
    # CometBFT gives RFC 3339 with nanoseconds: 2026-11-09T03:11:13.330871234Z
    head, _, rest = value.rstrip('Z').partition('.')
    micro = (rest + '000000')[:6] if rest else '000000'
    return datetime.datetime.fromisoformat(head + '.' + micro + '+00:00')


def read_status(url=RPC, timeout=3):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        info = json.loads(response.read(1024 * 1024))['result']['sync_info']
    return dict(height=int(info['latest_block_height']), time=parse_time(info['latest_block_time']).isoformat())


def atomic(path, text):
    path = Path(path); pending = path.with_name('.' + path.name + '.pending')
    with pending.open('w') as out:
        out.write(text); out.flush(); os.fsync(out.fileno())
    os.chmod(pending, 0o644); os.replace(pending, path)


def render(status, last, now):
    age = None if last is None else max(0.0, (now - datetime.datetime.fromisoformat(last['time'])).total_seconds())
    lines = ['# HELP uain_native_latest_block_age_seconds Seconds since the newest native block this host has seen (proofs older than 120 s are refused).',
             '# TYPE uain_native_latest_block_age_seconds gauge']
    if age is not None:
        lines.append('uain_native_latest_block_age_seconds %.3f' % age)
        lines += ['# TYPE uain_native_latest_block_height gauge', 'uain_native_latest_block_height %d' % last['height']]
    lines += ['# TYPE uain_native_rpc_up gauge', 'uain_native_rpc_up %d' % (1 if status else 0),
              '# TYPE uain_native_proof_age_gate_seconds gauge', 'uain_native_proof_age_gate_seconds %d' % GATE_SECONDS]
    return '\n'.join(lines) + '\n', age


def tick(now=None, reader=read_status, state=STATE, output=OUTPUT):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    last = json.loads(state.read_text()) if state.exists() else None
    try:
        status = reader()
    except Exception:
        status = None
    if status and (last is None or status['height'] >= last['height']):
        last = status; atomic(state, json.dumps(last) + '\n')
    text, age = render(status, last, now)
    atomic(output, text)
    return age


def main():
    os.umask(0o022)
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True); OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    age = tick()
    print(json.dumps(dict(age_seconds=age)))
    # A failed exit is visible in systemd as well as in the alert.
    if age is None or age > GATE_SECONDS:
        sys.exit(1)


if __name__ == '__main__':
    main()
