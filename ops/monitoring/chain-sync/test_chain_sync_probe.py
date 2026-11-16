import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import chain_sync_probe as probe_module  # noqa: E402


def status(height, time_text, catching=False):
    return {"result": {"sync_info": {"latest_block_height": str(height), "latest_block_time": time_text, "catching_up": catching}}}


class ProbeTests(unittest.TestCase):
    def test_stuck_node_that_claims_caught_up_shows_its_tip_age(self):
        now = probe_module.parse_time("2026-11-09T08:25:00Z")
        responses = {
            ("validator", "/status"): status(1389636, "2026-11-09T08:24:58.900000000Z"),
            ("validator", "/net_info"): {"result": {"n_peers": "1"}},
            ("holder-payer", "/status"): status(1383560, "2026-11-09T04:59:55.776120378Z", catching=False),
        }

        def fetch(node, path):
            if (node["name"], path) not in responses:
                raise OSError("no answer")
            return responses[(node["name"], path)]

        samples = [(n, probe_module.probe({"name": n, "rpc": "http://127.0.0.1:1"}, now, fetch)) for n in ["validator", "holder-payer", "relay"]]
        text = probe_module.render(samples, now)
        self.assertIn('uain_chain_latest_height{node="validator"} 1389636', text)
        self.assertIn('uain_chain_peers{node="validator"} 1', text)
        self.assertIn('uain_chain_catching_up{node="holder-payer"} 0', text)
        age = [l for l in text.splitlines() if l.startswith('uain_chain_block_age_seconds{node="holder-payer"}')][0]
        self.assertGreater(float(age.split()[-1]), 12000, "3.4 hours stale even though catching_up is 0")
        self.assertIn('uain_chain_up{node="relay"} 0', text)
        self.assertNotIn('uain_chain_latest_height{node="relay"}', text)
        self.assertIn("uain_chain_probe_timestamp_seconds", text)

    def test_atomic_write_and_loopback_only_config(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "t", "uain_chain.prom")
            probe_module.write_atomic(path, "x 1\n")
            self.assertEqual(open(path).read(), "x 1\n")
            self.assertEqual(os.listdir(os.path.dirname(path)), ["uain_chain.prom"])
            bad = os.path.join(root, "c.json")
            open(bad, "w").write('{"output":"%s","nodes":[{"name":"x","rpc":"http://10.0.0.1:26657"}]}' % path)
            with self.assertRaises(SystemExit):
                probe_module.load_config(bad)


if __name__ == "__main__":
    unittest.main()
