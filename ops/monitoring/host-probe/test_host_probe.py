import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import host_probe  # noqa: E402

NODES = {
    "items": [
        {
            "metadata": {"name": "uain-app-1"},
            "status": {
                "conditions": [
                    {"type": "MemoryPressure", "status": "False"},
                    {"type": "DiskPressure", "status": "True"},
                    {"type": "PIDPressure", "status": "False"},
                    {"type": "Ready", "status": "True"},
                ]
            },
        }
    ]
}


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.log = os.path.join(self.dir, "uain-edge.log")
        self.config = dict(
            host_probe.DEFAULTS,
            output_dir=os.path.join(self.dir, "textfile"),
            state=os.path.join(self.dir, "state", "state.json"),
            edge_log=self.log,
        )

    def metrics(self):
        with open(os.path.join(self.config["output_dir"], "uain_host_probe.prom")) as f:
            return f.read()

    def append(self, path, text):
        with open(path, "a") as f:
            f.write(text)

    def test_node_conditions_become_zero_or_one(self):
        conditions = host_probe.node_conditions(NODES, ["DiskPressure", "Ready", "PIDPressure"])
        self.assertEqual(conditions[("uain-app-1", "DiskPressure")], 1)
        self.assertEqual(conditions[("uain-app-1", "PIDPressure")], 0)
        host_probe.run(self.config, now=1000, kubectl=lambda: json.dumps(NODES))
        text = self.metrics()
        self.assertIn('uain_k8s_node_condition{node="uain-app-1",condition="DiskPressure"} 1', text)
        self.assertIn('uain_k8s_node_condition{node="uain-app-1",condition="MemoryPressure"} 0', text)
        self.assertIn("uain_host_probe_timestamp_seconds 1000", text)

    def test_unreadable_kubectl_leaves_out_conditions_but_still_writes(self):
        def broken():
            raise OSError("no k3s")

        host_probe.run(self.config, now=5, kubectl=broken)
        text = self.metrics()
        self.assertNotIn("uain_k8s_node_condition{", text)
        self.assertIn("uain_host_probe_timestamp_seconds 5", text)

    def test_edge_counts_accumulate_across_runs_and_wait_for_whole_lines(self):
        self.append(self.log, "1.0 uain.global 200 200\n1.1 uain.global 504 -\n1.2 waitlist.uain.global 502 502\n1.3 evil.example 500 -\n1.4 uain.global 20")
        host_probe.run(self.config, now=10, kubectl=lambda: json.dumps(NODES))
        text = self.metrics()
        self.assertIn('uain_edge_responses_total{site="uain.global",class="2xx"} 1', text)
        self.assertIn('uain_edge_responses_total{site="uain.global",class="5xx"} 1', text)
        self.assertIn('uain_edge_gateway_errors_total{site="uain.global",status="504"} 1', text)
        self.assertIn('uain_edge_gateway_errors_total{site="waitlist.uain.global",status="502"} 1', text)
        self.assertIn('uain_edge_responses_total{site="other",class="5xx"} 1', text)
        # Every class is present from the start, so rate() never misses a first error.
        self.assertIn('uain_edge_responses_total{site="www.uain.global",class="5xx"} 0', text)
        # The partial line finishes; counts carry over from the state file.
        self.append(self.log, "0 200 -\n2.0 uain.global 502 -\n")
        host_probe.run(self.config, now=40, kubectl=lambda: json.dumps(NODES))
        text = self.metrics()
        self.assertIn('uain_edge_responses_total{site="uain.global",class="2xx"} 2', text)
        self.assertIn('uain_edge_responses_total{site="uain.global",class="5xx"} 2', text)
        self.assertIn('uain_edge_gateway_errors_total{site="uain.global",status="502"} 1', text)

    def test_rotation_finishes_the_old_file_then_reads_the_new_one(self):
        self.append(self.log, "1 uain.global 200 200\n")
        host_probe.run(self.config, now=1, kubectl=lambda: "{}")
        self.append(self.log, "2 uain.global 504 -\n")  # written before rotation, not yet read
        os.rename(self.log, self.log + ".1")
        self.append(self.log, "3 uain.global 502 -\n")
        host_probe.run(self.config, now=2, kubectl=lambda: "{}")
        text = self.metrics()
        self.assertIn('uain_edge_responses_total{site="uain.global",class="5xx"} 2', text)
        self.assertIn('uain_edge_responses_total{site="uain.global",class="2xx"} 1', text)

    def test_truncated_log_starts_again_and_missing_log_is_fine(self):
        host_probe.run(self.config, now=1, kubectl=lambda: "{}")  # no log yet
        self.append(self.log, "1 uain.global 200 200\n" * 3)
        host_probe.run(self.config, now=2, kubectl=lambda: "{}")
        with open(self.log, "w") as f:
            f.write("4 uain.global 503 -\n")
        host_probe.run(self.config, now=3, kubectl=lambda: "{}")
        text = self.metrics()
        self.assertIn('uain_edge_responses_total{site="uain.global",class="2xx"} 3', text)
        self.assertIn('uain_edge_gateway_errors_total{site="uain.global",status="503"} 1', text)


if __name__ == "__main__":
    unittest.main()
