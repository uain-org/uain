#!/usr/bin/env python3
"""Host probe for uain-app-1: two numbers the existing exporters cannot see.

Runs every 30 s from uain-host-probe.timer and writes node-exporter textfile
metrics (atomic rename), so no port, exporter or agent is added:

- uain_k8s_node_condition{node, condition}: 1 when the k3s node reports the
  condition True (DiskPressure, MemoryPressure, PIDPressure, Ready). The kubelet
  evicts production pods under DiskPressure (9 Nov 2026 outage).
- uain_edge_responses_total{site, class} and uain_edge_gateway_errors_total{site,
  status}: responses the front door (host nginx) sent for UAIN's names, read from
  /var/log/nginx/uain-edge.log (log_format uain_edge in front-door.conf). nginx's
  own 502 and 504 never reach a pilot copy, so UainErrorRate cannot see them.
- uain_host_probe_timestamp_seconds: when this probe last ran.

Counters are cumulative across runs (state file); a rotated log is finished from
its `.1` copy, matched by inode, before the new file is read from the start.
Only standard-library Python. Usage: host_probe.py [config.json]
"""
import json
import os
import subprocess
import sys
import tempfile
import time

DEFAULTS = {
    "output_dir": "/var/lib/node_exporter/textfile",
    "state": "/var/lib/uain-host-probe/state.json",
    "edge_log": "/var/log/nginx/uain-edge.log",
    "hosts": ["uain.global", "waitlist.uain.global", "www.uain.global"],
    "kubectl": ["k3s", "kubectl", "get", "nodes", "-o", "json"],
    "conditions": ["DiskPressure", "MemoryPressure", "PIDPressure", "Ready"],
}
CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"]
GATEWAY = ["502", "503", "504"]
MAX_READ = 64 * 1024 * 1024  # never read more than this per run


def node_conditions(nodes_json, wanted):
    """{(node, condition): 0|1} from `kubectl get nodes -o json`."""
    out = {}
    for item in nodes_json.get("items", []):
        name = item.get("metadata", {}).get("name", "")
        seen = {c.get("type"): c.get("status") == "True" for c in item.get("status", {}).get("conditions", [])}
        for cond in wanted:
            if cond in seen:
                out[(name, cond)] = 1 if seen[cond] else 0
    return out


def empty_counts(hosts):
    return {
        "responses": {h: {c: 0 for c in CLASSES} for h in hosts + ["other"]},
        "gateway": {h: {s: 0 for s in GATEWAY} for h in hosts + ["other"]},
    }


def count_lines(text, counts, hosts):
    """Add complete lines of `msec host status upstream_status` to counts."""
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 3 or not parts[2].isdigit() or len(parts[2]) != 3:
            continue
        host = parts[1].lower() if parts[1].lower() in hosts else "other"
        status = parts[2]
        cls = status[0] + "xx"
        if cls in counts["responses"][host]:
            counts["responses"][host][cls] += 1
        if status in counts["gateway"][host]:
            counts["gateway"][host][status] += 1


def read_from(path, offset):
    """Complete lines from offset; returns (text, new_offset). A partial last line waits."""
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read(MAX_READ)
    end = data.rfind(b"\n")
    if end < 0:
        return "", offset
    return data[: end + 1].decode("utf-8", "replace"), offset + end + 1


def read_edge(log, state, counts, hosts):
    """Advance through the edge log; updates state {inode, offset} in place."""
    try:
        st = os.stat(log)
    except FileNotFoundError:
        return
    inode, offset = state.get("inode"), state.get("offset", 0)
    if inode is not None and inode != st.st_ino:
        # Rotated: finish the old file if it is still there as `.1`.
        old = log + ".1"
        try:
            if os.stat(old).st_ino == inode:
                text, _ = read_from(old, offset)
                count_lines(text, counts, hosts)
        except FileNotFoundError:
            pass
        offset = 0
    elif st.st_size < offset:  # truncated in place
        offset = 0
    text, offset = read_from(log, offset)
    count_lines(text, counts, hosts)
    state["inode"], state["offset"] = st.st_ino, offset


def render(conditions, counts, now):
    lines = [
        "# HELP uain_k8s_node_condition 1 when the k3s node reports this condition True.",
        "# TYPE uain_k8s_node_condition gauge",
    ]
    for (node, cond), v in sorted(conditions.items()):
        lines.append(f'uain_k8s_node_condition{{node="{node}",condition="{cond}"}} {v}')
    lines += [
        "# HELP uain_edge_responses_total Responses the front door sent for UAIN's names, by status class.",
        "# TYPE uain_edge_responses_total counter",
    ]
    for host, by in sorted(counts["responses"].items()):
        for cls in CLASSES:
            lines.append(f'uain_edge_responses_total{{site="{host}",class="{cls}"}} {by[cls]}')
    lines += [
        "# HELP uain_edge_gateway_errors_total 502, 503 and 504 responses the front door sent for UAIN's names.",
        "# TYPE uain_edge_gateway_errors_total counter",
    ]
    for host, by in sorted(counts["gateway"].items()):
        for status in GATEWAY:
            lines.append(f'uain_edge_gateway_errors_total{{site="{host}",status="{status}"}} {by[status]}')
    lines += [
        "# HELP uain_host_probe_timestamp_seconds When the host probe last ran.",
        "# TYPE uain_host_probe_timestamp_seconds gauge",
        f"uain_host_probe_timestamp_seconds {now:.0f}",
    ]
    return "\n".join(lines) + "\n"


def write_atomic(path, text):
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def load_state(path, hosts):
    try:
        with open(path) as f:
            state = json.load(f)
    except (FileNotFoundError, ValueError):
        state = {}
    counts = empty_counts(hosts)
    for kind in ("responses", "gateway"):
        for host, by in state.get("counts", {}).get(kind, {}).items():
            if host in counts[kind]:
                for k, v in by.items():
                    if k in counts[kind][host] and isinstance(v, int):
                        counts[kind][host][k] = v
    state["counts"] = counts
    return state


def run(config, now=None, kubectl=None):
    now = time.time() if now is None else now
    hosts = [h.lower() for h in config["hosts"]]
    state = load_state(config["state"], hosts)
    try:
        raw = kubectl() if kubectl else subprocess.run(config["kubectl"], check=True, capture_output=True, text=True, timeout=20).stdout
        conditions = node_conditions(json.loads(raw), config["conditions"])
    except (OSError, ValueError, subprocess.SubprocessError):
        conditions = {}  # the series go stale; the alert reads the probe timestamp too
    edge = state.setdefault("edge", {})
    read_edge(config["edge_log"], edge, state["counts"], hosts)
    write_atomic(os.path.join(config["output_dir"], "uain_host_probe.prom"), render(conditions, state["counts"], now))
    write_atomic(config["state"], json.dumps(state))
    return conditions, state


def main(argv):
    config = dict(DEFAULTS)
    if len(argv) > 1:
        with open(argv[1]) as f:
            config.update(json.load(f))
    run(config)


if __name__ == "__main__":
    main(sys.argv)
