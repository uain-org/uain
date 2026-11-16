"""Real-chain check: custody-built quorum envelopes on a generation-2 node.

Opt-in: UAIN_QUORUM_CHAIN_E2E=1 UAIN_NATIVE_CHAIN_BINARY=<uaind 0.4.0>. Starts
one throwaway node with fictional keys in a temporary directory, never a
configured network. Checks that Go accepts the Python signing bytes and that
one guardian alone is refused while two of three execute.
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

import guardian_quorum as gq
import guardian_approver as ga
import native_migration as native
from test_guardian_quorum import G1, G2, G3, OP, Vault, enc, binding

ENABLED = os.environ.get('UAIN_QUORUM_CHAIN_E2E') == '1' and os.environ.get('UAIN_NATIVE_CHAIN_BINARY')


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


@unittest.skipUnless(ENABLED, 'UAIN_QUORUM_CHAIN_E2E=1 with UAIN_NATIVE_CHAIN_BINARY required')
class QuorumOnChain(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='uain-quorum-chain-'))
        self.binary = os.environ['UAIN_NATIVE_CHAIN_BINARY']
        self.rpc_port, p2p = free_port(), free_port()
        self.chain = 'uain-gen2-fixture-1'
        seed = bytes([31]) * 32
        public, _ = native.ed25519(seed)
        self.applicant = 'uain1' + gq.sha(public)[:40]

        def member(k, name, licence='active', karma=100):
            return dict(id=k['id'], public_key=k['public_key'], name=name, operator=name + ' operator', family=name, licence=licence, karma=karma, credits='0', sequence='0', default_verifier=False, creator=False, active_projects=0)
        app = dict(version=1, generation=2, guardians=[G1['id'], G2['id'], G3['id']], guardian_threshold=2,
                   members=[member(G1, 'guardian-one'), member(G2, 'guardian-two'), member(G3, 'guardian-three'), member(OP, 'operator-reviewer'),
                            member(dict(id=self.applicant, public_key=enc(public)), 'applicant', licence='pending', karma=0)])
        (self.root / 'app.json').write_text(json.dumps(app))
        env = dict(os.environ, UAIN_ALLOW_NON_ORCHARD='1')
        subprocess.run([self.binary, 'init', '--home', str(self.root / 'node'), '--chain-id', self.chain, '--app-genesis', str(self.root / 'app.json'),
                        '--rpc', f'tcp://127.0.0.1:{self.rpc_port}', '--p2p', f'tcp://127.0.0.1:{p2p}'], check=True, capture_output=True, env=env)
        self.node = subprocess.Popen([self.binary, 'start', '--home', str(self.root / 'node')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        self.wait(lambda: self.height() >= 2)
        genesis = (self.root / 'node/config/genesis.json').read_bytes()
        self.quorum = gq.Quorum(binding(chain_id=self.chain, genesis_sha256=gq.sha(genesis)))

    def tearDown(self):
        self.node.terminate()
        self.node.wait(timeout=20)
        shutil.rmtree(self.root, ignore_errors=True)

    def call(self, method, **params):
        body = json.dumps(dict(jsonrpc='2.0', id=1, method=method, params=params)).encode()
        with urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{self.rpc_port}', data=body, headers={'Content-Type': 'application/json'}), timeout=30) as r:
            value = json.loads(r.read())
        self.assertNotIn('error', value)
        return value['result']

    def height(self):
        try:
            return int(self.call('status')['sync_info']['latest_block_height'])
        except Exception:
            return 0

    def wait(self, condition, tries=120):
        for _ in range(tries):
            if condition():
                return
            time.sleep(0.5)
        self.fail('timed out')

    def record(self, key):
        r = self.call('abci_query', path='/store/federation/key', data=key.encode().hex())['response']
        return json.loads(base64.b64decode(r['value'])) if r.get('value') else None

    def member(self, ident):
        return self.record('member/' + ident)

    def send(self, envelope, commit=True):
        tx = base64.b64encode(json.dumps(envelope, separators=(',', ':')).encode()).decode()
        return self.call('broadcast_tx_commit' if commit else 'broadcast_tx_sync', tx=tx)

    def test_one_guardian_refused_two_of_three_execute(self):
        vault = Vault()
        h = self.height()
        licence = dict(version=1, chain_id=self.chain, member=G1['id'], sequence=self.member(G1['id'])['sequence'] if 'sequence' in self.member(G1['id']) else '0',
                       expires_height=str(h + 100), operation='licence', payload=dict(member=self.applicant, status='active', evidence_digest='e' * 64))
        licence['sequence'] = str(self.member(G1['id']).get('sequence', 0))
        direct = gq.sign(vault, self.quorum, 'keys/guardian-1.json', G1['id'], licence)
        self.assertNotEqual(self.send(direct, commit=False)['code'], 0, 'a single guardian licence was accepted')
        propose = gq.propose_command(self.quorum, licence, G1['id'], str(self.member(G1['id']).get('sequence', 0)), str(self.height()))
        r = self.send(gq.sign(vault, self.quorum, 'keys/guardian-1.json', G1['id'], propose))
        self.assertEqual((r['check_tx']['code'], r['tx_result']['code']), (0, 0), r)
        self.assertEqual(self.member(self.applicant)['licence'], 'pending')
        action = self.record('guardian_action/' + propose['payload']['id'])
        self.assertEqual((action['executed'], action['approvals']), ('0', [G1['id']]))
        # The approver's independent check, on the real proved record shape.
        gq.check_action(self.quorum, action, 'licence', licence['payload'], G2['id'], str(self.height()))
        approve = gq.approve_command(self.quorum, propose['payload']['id'], G2['id'], str(self.member(G2['id']).get('sequence', 0)), str(self.height() + 100), action['evidence_digest'])
        r = self.send(gq.sign(vault, self.quorum, 'keys/guardian-2.json', G2['id'], approve))
        self.assertEqual((r['check_tx']['code'], r['tx_result']['code']), (0, 0), r)
        self.assertEqual(self.member(self.applicant)['licence'], 'active')
        done = self.record('guardian_action/' + propose['payload']['id'])
        self.assertNotEqual(done['executed'], '0')
        self.assertEqual(done['subject'], self.applicant)
        # The operator (reviewer) key is not a guardian on generation 2.
        op_licence = dict(licence, member=OP['id'], sequence=str(self.member(OP['id']).get('sequence', 0)), payload=dict(member=G3['id'], status='revoked', evidence_digest='e' * 64))
        self.assertNotEqual(self.send(gq.sign(vault, self.quorum, 'keys/uain-review-key.json', OP['id'], op_licence), commit=False)['code'], 0)


if __name__ == '__main__':
    unittest.main()
