"""FIXTURE QUALIFICATION ONLY: drives ops/custody/project_organizations.py against a real
disposable native daemon on a fictional genesis (see native-daemon-e2e-stage.mjs).

Usage (spawned by the Node stage, never by an operator):
  python3 -I -B python-custody-stage.py <config.json> <call.json>

What is the production code path, unchanged: `process()` (journal-before-I/O, lane check,
fresh-state `build_command` -> `authorize` -> `check_native`, re-authorization before the one
broadcast, definite first-send CheckTx refusal, event-log scan and finalized receipt), `sign()` (key attachment names, seed
handling, Ed25519 and address binding, `verify_envelope`), `load_policy`/`selection_of`
through `protected_read` with its existing test-only `boundary`, the uain-state invocation
and `FleetRuntime.broadcast` (broadcast_tx_sync of the canonical journaled envelope bytes, the
hash check, and the full CheckTx answer that a definite refusal records as evidence).

What is fixture, and only this: the module constants `CHAIN` and `GUARDIAN` are set to the
fictional chain and its fictional guardian (production pins the real ones); keys come from
throwaway fixture seeds in the config through an in-memory custody object instead of the
vault; the trusted uid set is root (the container runs as root) and every protected file
lives under a fresh temporary boundary directory, never under /etc or /var/lib; the reader
skips only the walk that requires root-owned parents up to '/' (the genesis is under /tmp),
while still checking the pinned binary and genesis hashes.

Prints one JSON object: the process() result, or {status: 'refused', code}, plus counters of
signatures and broadcasts made by THIS invocation and the retained envelope, if any.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    call = json.loads(Path(sys.argv[2]).read_text())
    sys.path.insert(0, config['custodyDir'])
    import project_organizations as po  # noqa: E402  (production module, unchanged)
    native, admission = po.native, po.admission
    require = po.require

    # FIXTURE pins: the fictional chain and guardian of this disposable genesis.
    require(config['chainId'].startswith('uain-orgs-fictional-'), 'not_a_fictional_chain')
    po.CHAIN = config['chainId']
    po.GUARDIAN = config['guardian']

    boundary = config['boundary']
    trusted = po.ROOT_UIDS  # the container runs as root; production trusts root only
    read = lambda path, limit=po.SOURCE_LIMIT: po.protected_read(Path(path), trusted, limit, boundary=boundary)
    amendments = native.strict_json(read(config['amendmentsPath'], 256 * 1024))
    selection = po.selection_of(native.strict_json(read(config['selectionPath'], 2 * 1024 * 1024)), amendments)
    policy = po.load_policy(Path(config['policyPath']), selection, trusted, boundary=boundary)

    counters = dict(signed=0, broadcasts=0, broadcastCodes=[])

    class FixtureRuntime(po.FleetRuntime):
        """po.FleetRuntime with the fixture reader paths; broadcast is inherited unchanged."""

        def __init__(self, reader):
            self.p = dict(rpc=reader['rpc'], chain_id=config['chainId'])
            self.reader = reader
            self.deadline = time.monotonic() + 120

        def read(self, selection_):
            r = self.reader
            self.remaining()
            for path, pin in ((r['binary'], r['binarySha256']), (r['genesis'], r['genesisSha256'])):
                require(hashlib.sha256(Path(path).read_bytes()).hexdigest() == pin, 'fixture_pin_mismatch')
            require(json.loads(Path(r['genesis']).read_bytes())['chain_id'] == config['chainId'], 'fixture_chain_mismatch')
            with tempfile.TemporaryDirectory(prefix='uain-orgs-py-proof-', dir=config['tmp']) as temporary:
                out = Path(temporary) / 'state.json'
                result = subprocess.run([r['binary'], '--genesis', r['genesis'], '--genesis-sha256', r['genesisSha256'], '--rpc', r['rpc'],
                                         '--out', str(out), '--max-age', '120s'], input=admission.canonical(selection_),
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=min(20, self.remaining()))
                require(result.returncode == 0, 'native_read_refused')
                state = native.strict_json(out.read_bytes())
                require(state['chain_id'] == config['chainId'], 'fixture_chain_mismatch')
                return state

        def broadcast(self, envelope):
            counters['broadcasts'] += 1
            reply = super().broadcast(envelope)
            counters['broadcastCodes'].append(reply['code'])
            return reply

    class FixtureCustody:
        """In-memory FIXTURE key attachments under the production attachment names."""

        def vault(self):
            return 'fixture-vault'

        def attachment(self, vault, name):
            require(vault == 'fixture-vault', 'fixture_vault')
            key = config['attachments'].get(name)
            require(key is not None, 'fixture_key_missing')
            return json.dumps(key).encode()

    custody = FixtureCustody()

    def signer(command, role):
        counters['signed'] += 1
        return po.sign(custody, command, role)  # production sign(): euid 0, attachment, verify

    root = Path(config['root'])

    def load(path):
        return native.strict_json(po.protected_read(Path(path), trusted, 1024 * 1024, boundary=boundary)) if Path(path).exists() else None

    def write(path, value):
        Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        admission.atomic(path, value)

    out = dict(counters=counters)
    try:
        result = po.process(policy, call['projectId'], call['request'], FixtureRuntime(config['reader']), load, write, signer,
                            root=root, caller=call['caller'])
        out.update(result)
    except po.Refused as error:
        out.update(status='refused', code=error.code)
    except Exception as error:  # a non-Refused failure is a finding: report its type only
        out.update(status='error', error_type=type(error).__name__, message=str(error)[:300])
    try:
        path = po.journal_path(root, call['projectId'], call['request']['id'])
        journal = load(path) if path.exists() else None
    except po.Refused:
        journal = None
    out['envelope'] = journal['envelope'] if journal else None
    out['failed'] = journal.get('failed') if journal else None
    out['journaled'] = journal is not None
    print(json.dumps(out, separators=(',', ':')))


if __name__ == '__main__':
    os.umask(0o077)
    main()
