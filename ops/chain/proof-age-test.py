import datetime
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('proof_age', Path(__file__).with_name('proof-age.py')); p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
T0 = datetime.datetime(2026, 11, 9, 3, 11, 13, tzinfo=datetime.timezone.utc)


class ProofAgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); root = Path(self.tmp.name)
        self.state = root / 'last.json'; self.output = root / 'uain_native.prom'

    def tearDown(self): self.tmp.cleanup()

    def tick(self, now, status):
        def reader():
            if status is None: raise OSError('connection refused')
            return status
        return p.tick(now=now, reader=reader, state=self.state, output=self.output)

    def test_parses_cometbft_nanosecond_time(self):
        self.assertEqual(p.parse_time('2026-11-09T03:11:13.330871234Z'), T0.replace(microsecond=330871))
        self.assertEqual(p.parse_time('2026-11-09T03:11:13Z'), T0)

    def test_age_keeps_growing_while_the_validator_is_stopped(self):
        self.assertAlmostEqual(self.tick(T0 + datetime.timedelta(seconds=2), dict(height=100, time=T0.isoformat())), 2)
        # The 9 Nov backup stopped the validator 152 s: the RPC refuses, the age passes the gate.
        age = self.tick(T0 + datetime.timedelta(seconds=152), None)
        self.assertGreater(age, p.GATE_SECONDS)
        text = self.output.read_text()
        self.assertIn('uain_native_latest_block_age_seconds 152.000', text); self.assertIn('uain_native_rpc_up 0', text)
        self.assertIn('uain_native_latest_block_height 100', text)

    def test_never_moves_backwards_and_reports_no_age_before_any_block(self):
        self.assertIsNone(self.tick(T0, None)); self.assertNotIn('\nuain_native_latest_block_age_seconds ', self.output.read_text())
        self.tick(T0, dict(height=100, time=T0.isoformat()))
        self.tick(T0, dict(height=90, time=(T0 - datetime.timedelta(seconds=60)).isoformat()))
        self.assertIn('uain_native_latest_block_height 100', self.output.read_text())


if __name__ == '__main__':
    unittest.main()
