"""Rule tests for the Grafana alerts in grafana/provisioning/alerting/rules.yml.

Every rule there is a PromQL query (A) and a threshold (B). This test reads
each rule, checks its shape, and turns it into the equivalent Prometheus
alerting rule (`(A) <op> threshold`, same `for`), so `promtool test rules` can
show it firing and clearing on synthetic series: no node is stopped and no disk
is filled to prove an alert.

promtool comes from $PROMTOOL (a command, `{dir}` is replaced by the test's
working directory), else `promtool` on PATH; without either, only the shape
checks run. On uain-app-1, with the production Prometheus image:
  PROMTOOL='docker run --rm -v {dir}:{dir} -w {dir} --entrypoint promtool prom/prometheus:v3.15.0' \
    python3 -m unittest discover -s ops/monitoring -p 'test_alert_rules.py' -v
Only standard-library Python (the CI image has no PyYAML).
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest

RULES = os.path.join(os.path.dirname(__file__), "grafana", "provisioning", "alerting", "rules.yml")
OPS = {"gt": ">", "lt": "<"}


def load_rules(path=RULES):
    with open(path) as f:
        text = f.read()
    blocks = re.split(r"\n(?=      - uid: )", text)[1:]
    rules = []
    for block in blocks:
        def field(pattern):
            m = re.search(pattern, block, re.M)
            return m.group(1) if m else None

        rules.append({
            "uid": field(r"^      - uid: (\S+)$"),
            "title": field(r"^        title: (\S+)$"),
            "expr": field(r"^              expr: '(.*)'$"),
            "op": field(r"evaluator: \{ type: (\w+),"),
            "threshold": field(r"evaluator: \{ type: \w+, params: \[([-0-9.]+)\] \}"),
            "for": field(r"^        for: (\S+)$"),
            "noData": field(r"^        noDataState: (\S+)$"),
        })
    return rules


def prometheus_rules(rules):
    """The rules as a Prometheus rule file (JSON is valid YAML)."""
    return json.dumps({"groups": [{"name": "uain", "interval": "1m", "rules": [
        {"alert": r["title"], "expr": f'({r["expr"].replace(chr(39) * 2, chr(39))}) {OPS[r["op"]]} {r["threshold"]}', "for": r["for"]}
        for r in rules]}]}, indent=1)


def series(name, labels, values):
    inner = ",".join(f'{k}="{v}"' for k, v in labels.items())
    return {"series": f"{name}{{{inner}}}", "values": values}


APP = {"host": "uain-app-1", "job": "node", "instance": "node-exporter:9100"}

# Each case: series over minutes, then which alerts fire (with labels) when.
CASES = [
    {
        "name": "disk below 20% fires UainDiskLow after 15 minutes and clears; 15% alert stays quiet",
        "input_series": [
            series("node_filesystem_avail_bytes", {**APP, "mountpoint": "/"}, "25x10 18x30 30x10"),
            series("node_filesystem_size_bytes", {**APP, "mountpoint": "/"}, "100x52"),
        ],
        "alert_rule_test": [
            {"eval_time": "20m", "alertname": "UainDiskLow", "exp_alerts": []},
            {"eval_time": "30m", "alertname": "UainDiskLow", "exp_alerts": [{"exp_labels": {**APP, "mountpoint": "/"}}]},
            {"eval_time": "30m", "alertname": "UainDiskFilling", "exp_alerts": []},
            {"eval_time": "50m", "alertname": "UainDiskLow", "exp_alerts": []},
        ],
    },
    {
        "name": "node DiskPressure fires within two minutes and clears",
        "input_series": [
            series("uain_k8s_node_condition", {**APP, "node": "uain-app-1", "condition": "DiskPressure"}, "0x5 1x5 0x5"),
            series("uain_k8s_node_condition", {**APP, "node": "uain-app-1", "condition": "Ready"}, "1x15"),
            series("uain_host_probe_timestamp_seconds", APP, "0+60x15"),
        ],
        "alert_rule_test": [
            {"eval_time": "5m", "alertname": "UainNodeDiskPressure", "exp_alerts": []},
            {"eval_time": "8m", "alertname": "UainNodeDiskPressure", "exp_alerts": [{"exp_labels": {"node": "uain-app-1"}}]},
            {"eval_time": "13m", "alertname": "UainNodeDiskPressure", "exp_alerts": []},
            {"eval_time": "13m", "alertname": "UainHostProbeNotRunning", "exp_alerts": []},
        ],
    },
    {
        "name": "a chain node whose tip ages past 180 s for 5 minutes fires UainChainNodeBehind and clears",
        "input_series": [
            # validator: tip age 5 s, then stuck (age grows 60 s a minute), then caught up again
            series("uain_chain_block_age_seconds", {"node": "validator", "host": "uain-app-1"}, "5x5 60+60x10 5x10"),
            # a node at 170 s never fires
            series("uain_chain_block_age_seconds", {"node": "holder-payer", "host": "uain-app-1"}, "170x26"),
        ],
        "alert_rule_test": [
            {"eval_time": "9m", "alertname": "UainChainNodeBehind", "exp_alerts": []},
            {"eval_time": "14m", "alertname": "UainChainNodeBehind", "exp_alerts": [{"exp_labels": {"node": "validator", "host": "uain-app-1"}}]},
            {"eval_time": "20m", "alertname": "UainChainNodeBehind", "exp_alerts": []},
        ],
    },
    {
        "name": "native proof older than 120 s fires UainNativeProofStale at once and clears",
        "input_series": [
            series("uain_native_latest_block_age_seconds", {"host": "uain-app-1"}, "6x3 121 300 6x3"),
        ],
        "alert_rule_test": [
            {"eval_time": "3m", "alertname": "UainNativeProofStale", "exp_alerts": []},
            {"eval_time": "4m", "alertname": "UainNativeProofStale", "exp_alerts": [{"exp_labels": {}}]},
            {"eval_time": "7m", "alertname": "UainNativeProofStale", "exp_alerts": []},
        ],
    },
    {
        "name": "front-door 5xx over 5% with at least 10 errors fires UainEdgeErrors; a few rollout 502s do not",
        "input_series": [
            # 600 requests a minute on uain.global
            series("uain_edge_responses_total", {**APP, "site": "uain.global", "class": "2xx"}, "0+600x30"),
            # minutes 0-10: 2 errors a minute (0.3%); 10-20: 60 a minute (about 9%); 20-30: none
            series("uain_edge_responses_total", {**APP, "site": "uain.global", "class": "5xx"}, "0+2x10 80+60x10 680x10"),
            # waitlist: 3 errors among 4 requests in one minute: high share, too few to page
            series("uain_edge_responses_total", {**APP, "site": "waitlist.uain.global", "class": "2xx"}, "0x10 1x20"),
            series("uain_edge_responses_total", {**APP, "site": "waitlist.uain.global", "class": "5xx"}, "0x10 3x20"),
        ],
        "alert_rule_test": [
            {"eval_time": "9m", "alertname": "UainEdgeErrors", "exp_alerts": []},
            {"eval_time": "19m", "alertname": "UainEdgeErrors", "exp_alerts": [{"exp_labels": {"site": "uain.global"}}]},
            {"eval_time": "29m", "alertname": "UainEdgeErrors", "exp_alerts": []},
        ],
    },
]


def promtool_command():
    if os.environ.get("PROMTOOL"):
        return os.environ["PROMTOOL"]
    found = shutil.which("promtool")
    return shlex.quote(found) if found else None


class RuleShapeTests(unittest.TestCase):
    def test_every_rule_has_a_query_threshold_and_unique_names(self):
        rules = load_rules()
        self.assertGreaterEqual(len(rules), 20)
        for r in rules:
            for key in ("uid", "title", "expr", "op", "threshold", "for", "noData"):
                self.assertTrue(r[key], f"{r['uid'] or r['title']}: no {key}")
            self.assertIn(r["op"], OPS)
            self.assertRegex(r["for"], r"^\d+[smh]$")
        self.assertEqual(len({r["uid"] for r in rules}), len(rules))
        self.assertEqual(len({r["title"] for r in rules}), len(rules))

    def test_disk_and_edge_alerts_have_the_agreed_thresholds(self):
        by = {r["title"]: r for r in load_rules()}
        self.assertEqual((by["UainDiskLow"]["op"], by["UainDiskLow"]["threshold"]), ("lt", "0.2"))
        self.assertEqual((by["UainDiskFilling"]["op"], by["UainDiskFilling"]["threshold"]), ("lt", "0.15"))
        self.assertIn('condition="DiskPressure"', by["UainNodeDiskPressure"]["expr"])
        self.assertEqual(by["UainNativeProofStale"]["threshold"], "120")
        self.assertIn("uain_edge_responses_total", by["UainEdgeErrors"]["expr"])
        # Prometheus gives node-exporter series a `host` label (uain-app-1), which
        # would overwrite a scraped `host`; the edge series use `site`.
        self.assertNotIn("host", by["UainEdgeErrors"]["expr"])
        self.assertEqual(by["UainHostProbeNotRunning"]["noData"], "Alerting")


@unittest.skipUnless(promtool_command(), "promtool not available (set PROMTOOL)")
class PromtoolRuleTests(unittest.TestCase):
    def test_alerts_fire_and_clear_on_synthetic_series(self):
        work = tempfile.mkdtemp(prefix="uain-rule-test-")
        os.chmod(work, 0o755)
        with open(os.path.join(work, "rules.yml"), "w") as f:
            f.write(prometheus_rules(load_rules()))
        tests = {"rule_files": ["rules.yml"], "evaluation_interval": "1m",
                 "tests": [{"interval": "1m", "name": c["name"], "input_series": c["input_series"],
                            "alert_rule_test": c["alert_rule_test"]} for c in CASES]}
        with open(os.path.join(work, "tests.yml"), "w") as f:
            json.dump(tests, f, indent=1)
        for name in os.listdir(work):
            os.chmod(os.path.join(work, name), 0o644)
        command = shlex.split(promtool_command().replace("{dir}", work)) + ["test", "rules", "tests.yml"]
        done = subprocess.run(command, cwd=work, capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
