#!/usr/bin/env python3
"""Chain sync probe for UAIN's own CometBFT nodes.

Reads each configured node's `/status` and writes Prometheus metrics to a
node-exporter textfile (atomic rename), so the existing node-exporter serves
them and Grafana alerts on them. It opens no port and needs no Docker socket in
a container: nodes inside containers are read with `docker exec`.

Config (JSON): {"output": "/var/lib/node_exporter/textfile/uain_chain.prom",
  "nodes": [{"name": "validator", "rpc": "http://127.0.0.1:26667"},
            {"name": "holder-payer", "container": "baink-holder-payer", "rpc": "http://127.0.0.1:27657"}]}

Metrics, one series per node:
  uain_chain_up                     1 when /status answered
  uain_chain_latest_height          latest block height
  uain_chain_block_age_seconds      now - latest block time (the tip age)
  uain_chain_catching_up            CometBFT's own flag (it can read 0 while a
                                    node is stuck behind; trust the tip age)
  uain_chain_peers                  connected peers
  uain_chain_probe_timestamp_seconds  when this file was written
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime

NAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-_")


def parse_time(text):
    # CometBFT prints nanoseconds: 2026-11-09T08:23:55.190176813Z
    head, _, frac = text.rstrip("Z").partition(".")
    base = datetime.strptime(head, "%Y-%m-%dT%H:%M:%S")
    epoch = (base - datetime(1970, 1, 1)).total_seconds()
    return epoch + (float("0." + frac) if frac else 0.0)


def fetch_json(node, path, timeout=8):
    url = node["rpc"].rstrip("/") + path
    if node.get("container"):
        script = "fetch(%s).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" % json.dumps(url)
        out = subprocess.run(["docker", "exec", node["container"], "node", "-e", script], capture_output=True, timeout=timeout, check=True)
        return json.loads(out.stdout)
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read())


def probe(node, now, fetch=fetch_json):
    try:
        status = fetch(node, "/status")["result"]
        info = status["sync_info"]
        sample = {
            "up": 1,
            "latest_height": int(info["latest_block_height"]),
            "block_age_seconds": max(0.0, now - parse_time(info["latest_block_time"])),
            "catching_up": 1 if info["catching_up"] else 0,
        }
        try:
            sample["peers"] = int(fetch(node, "/net_info")["result"]["n_peers"])
        except Exception:
            pass
        return sample
    except Exception:
        return {"up": 0}


def render(samples, now):
    lines = []
    for metric, kind, help_text in [
        ("up", "gauge", "1 when the node's /status answered"),
        ("latest_height", "gauge", "Latest block height of the node"),
        ("block_age_seconds", "gauge", "Seconds since the node's latest block"),
        ("catching_up", "gauge", "CometBFT catching_up flag"),
        ("peers", "gauge", "Connected peers"),
    ]:
        name = "uain_chain_" + metric
        lines += ["# HELP %s %s" % (name, help_text), "# TYPE %s %s" % (name, kind)]
        for node, sample in samples:
            if metric in sample:
                value = sample[metric]
                lines.append('%s{node="%s"} %s' % (name, node, ("%.3f" % value) if isinstance(value, float) else value))
    lines += ["# HELP uain_chain_probe_timestamp_seconds When the probe last ran", "# TYPE uain_chain_probe_timestamp_seconds gauge", "uain_chain_probe_timestamp_seconds %.3f" % now]
    return "\n".join(lines) + "\n"


def write_atomic(path, text):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=".uain_chain.")
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_config(path):
    with open(path) as handle:
        config = json.load(handle)
    for node in config["nodes"]:
        if not node["name"] or set(node["name"]) - NAME_OK:
            raise SystemExit("node names use a-z, 0-9, - and _")
        if not node["rpc"].startswith("http://127.0.0.1:"):
            raise SystemExit("only loopback node RPCs are probed")
    return config


def main(argv):
    config = load_config(argv[1] if len(argv) > 1 else "/etc/uain-chain-sync/config.json")
    now = time.time()
    samples = [(node["name"], probe(node, now)) for node in config["nodes"]]
    write_atomic(config["output"], render(samples, now))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
