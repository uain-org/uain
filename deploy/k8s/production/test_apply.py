"""Tests for apply.sh: one deploy changes each Deployment at most once.

apply.sh, render.py, ops/ci/rollout-wait.py and ops/ci-scope/release.py run for
real against a stand-in `kubectl` (written below into a temporary directory)
that keeps a small cluster in a JSON file: three Deployments, their pod
templates and one ReplicaSet for each change of a template, as the Deployment
controller makes them. No cluster is contacted. FIXTURE level.
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
REGISTRY = '10.98.0.1:5000/uain'
OLD = {'web': 'a' * 40, 'pilot': 'b' * 40, 'waitlist': 'c' * 40}
NEW = 'd' * 40

FAKE_KUBECTL = textwrap.dedent('''\
    #!/usr/bin/env python3
    """A stand-in for kubectl: a cluster kept in $FAKE_STATE, every call logged to $FAKE_LOG."""
    import hashlib, json, os, re, sys
    from pathlib import Path

    args = sys.argv[1:]
    state_file = Path(os.environ['FAKE_STATE'])
    state = json.loads(state_file.read_text())
    with open(os.environ['FAKE_LOG'], 'a') as log:
        log.write(json.dumps(args) + '\\n')
    REGISTRY = '10.98.0.1:5000/uain'

    def save():
        state_file.write_text(json.dumps(state))

    def change(name, template):
        """A Deployment controller: a changed pod template makes a ReplicaSet."""
        d = state['deployments'][name]
        if d['template'] == template:
            return False
        d['template'] = template
        d['generation'] += 1
        state['clock'] += 1
        d['replicasets'].append({'name': f'{name}-{len(d["replicasets"])}', 'at': f'2099-01-01T00:00:{state["clock"]:02d}Z'})
        return True

    def value(flag):
        return args[args.index(flag) + 1]

    def out(text):
        sys.stdout.write(text)
        sys.exit(0)

    if args and args[0] == 'kustomize':
        directory = Path(args[1])
        native = (directory / 'native-pilot.patch.yaml').exists()
        out((directory / 'uain.yaml').read_text() + f'\\n# native={native}\\n# marker={state["manifest"]}\\n')

    if args and args[0] == 'apply':
        text = Path(value('-f')).read_text()
        tags = {c: re.search(rf'/uain/{c}:([0-9a-f]{{40}})', text).group(1) for c in ('web', 'pilot', 'waitlist')}
        native = '# native=True' in text
        marker = re.search(r'# marker=(.*)', text).group(1)
        if '--dry-run=server' in args:
            image = lambda c: f'{REGISTRY}/{c}:{tags[c]}'
            env = [{'secretRef': {'name': 'uain-env'}}] + ([{'configMapRef': {'name': 'uain-native-config'}}] if native else [])
            containers = [{'name': 'pilot', 'image': image('pilot'), 'envFrom': env}]
            volumes = [{'name': 'ledger'}]
            if native:
                containers.append({'name': 'native-rpc', 'image': state.get('dry_run_sidecar') or image('pilot')})
                volumes += [{'name': n} for n in ('native-public', 'native-publications', 'native-rpc-socket')]
            # Every pod as uain.yaml declares it: no API token, RuntimeDefault, non-root.
            secure = {'automountServiceAccountToken': False,
                      'securityContext': {'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}}}
            pod = lambda cs, **more: {'template': {'spec': {'containers': cs, **secure, **more}}}
            job = lambda n: {'kind': 'CronJob', 'metadata': {'name': n}, 'spec': {'suspend': native, 'jobTemplate': {'spec': {
                'template': {'spec': {'containers': [{'name': n, 'image': image('pilot')}], **secure}}}}}}
            items = [
                {'kind': 'Deployment', 'metadata': {'name': 'pilot'}, 'spec': {
                    'strategy': {'rollingUpdate': {'maxSurge': 2, 'maxUnavailable': 0}}, **pod(containers, volumes=volumes)}},
                {'kind': 'Deployment', 'metadata': {'name': 'web'}, 'spec': pod([{'name': 'web', 'image': image('web')}])},
                {'kind': 'Deployment', 'metadata': {'name': 'waitlist'}, 'spec': pod([{'name': 'waitlist', 'image': image('waitlist')}])},
                job('research-index')] + ([job('native-projection')] if native else [])
            out(json.dumps({'kind': 'List', 'items': items}))
        for name in ('pilot', 'web', 'waitlist'):
            keep = state['deployments'][name]['template'].split('|restart')[1:]
            # The pilot's template also carries the manifest's own content (the marker).
            base = f'{name}:{tags[name]}' + (f'|manifest={marker}' if name == 'pilot' else '')
            change(name, '|restart'.join([base] + keep))
        save()
        out('applied\\n')

    if args[:2] == ['-n', 'uain']:
        rest = args[2:]
        if rest[0] == 'set' and rest[1] == 'image':
            name = rest[2].split('/')[1]
            tag = rest[3].rsplit(':', 1)[1]
            keep = state['deployments'][name]['template'].split('|restart')[1:]
            change(name, '|restart'.join([f'{name}:{tag}'] + keep))
            save()
            out('image updated\\n')
        if rest[:2] == ['rollout', 'restart']:
            for target in rest[2:]:
                name = target.split('/')[1]
                state['clock'] += 1
                change(name, state['deployments'][name]['template'].split('|restart')[0] + f'|restart{state["clock"]}')
            save()
            out('restarted\\n')
        if rest[0] == 'get':
            kind = rest[1]
            output = value('-o') if '-o' in rest else ''
            if kind == 'pods' and output == 'wide':
                out('')
            if kind == 'configmap' and rest[2] == 'uain-native-config' and output == 'json':
                out(json.dumps(state['native_config']) if state.get('native_config') else '')
            if kind == 'configmap' and rest[2] == 'uain-release':
                out(json.dumps({'data': {'release.json': json.dumps(state['release'])}}))
            if kind in ('secret', 'configmap') and output.startswith('jsonpath={.metadata.uid}'):
                out(state['versions'].get(rest[2], ''))
            if kind == 'deployment' and output == 'jsonpath={.spec.template}':
                out(state['deployments'][rest[2]]['template'])
            if kind == 'deployment' and output == 'jsonpath={.spec.replicas}':
                out(str(state['deployments'][rest[2]]['replicas']))
            if kind == 'deployment' and output == 'json':
                d = state['deployments'][rest[2]]
                if d.get('stuck'):
                    conditions = [{'type': 'Progressing', 'reason': 'ProgressDeadlineExceeded', 'message': 'timed out'}]
                else:
                    conditions = []
                n = d['replicas']
                out(json.dumps({'metadata': {'name': rest[2], 'generation': d['generation'],
                                             'annotations': {'deployment.kubernetes.io/revision': str(len(d['replicasets']))}},
                                'spec': {'replicas': n, 'selector': {'matchLabels': {'app': rest[2]}}},
                                'status': {'observedGeneration': d['generation'], 'updatedReplicas': n, 'availableReplicas': n,
                                           'replicas': n, 'conditions': conditions}}))
            name = value('-l').split('=')[1] if '-l' in rest else ''
            if kind == 'replicasets':
                sets = state['deployments'][name]['replicasets']
                out(json.dumps({'items': [{'metadata': {'name': s['name'], 'uid': s['name'], 'creationTimestamp': s['at'],
                                                         'annotations': {'deployment.kubernetes.io/revision': str(i + 1)}}}
                                          for i, s in enumerate(sets)]}))
            if kind == 'pods':
                d = state['deployments'][name]
                newest = d['replicasets'][-1]['name']
                out(json.dumps({'items': [{'metadata': {'name': f'{newest}-{i}', 'ownerReferences': [{'uid': newest}]},
                                           'status': {'phase': 'Running', 'conditions': [{'type': 'Ready', 'status': 'True'}]}}
                                          for i in range(d['replicas'])]}))
    sys.stderr.write(f'fake kubectl: unexpected {args}\\n')
    sys.exit(64)
''')

NATIVE = {'data': {
    'UAIN_AUTHORITY': 'native', 'UAIN_NATIVE_PROJECTION': '1',
    'UAIN_NATIVE_STATE_BINARY': '/opt/uain-native/public/state/' + 'a' * 64 + '/uain-state', 'UAIN_NATIVE_STATE_SHA256': 'a' * 64,
    'UAIN_NATIVE_GENESIS': '/opt/uain-native/public/genesis/' + 'b' * 64 + '/genesis.json', 'UAIN_NATIVE_GENESIS_SHA256': 'b' * 64,
    'UAIN_NATIVE_RPC': 'http://127.0.0.1:26667', 'UAIN_NATIVE_PUBLICATION_DIR': '/var/lib/uain-native/publications',
    'UAIN_NATIVE_CHAIN_ID': 'uain-shadow-20261008-1'}}
SECRETS = ('uain-env', 'uain-retrieval', 'uain-kalki', 'uain-ledger', 'uain-native-config')


def fingerprint(versions, names, kinds):
    return ','.join(f'{kind}/{name}={versions.get(name) or "-"}' for kind, name in zip(kinds, names))


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.dir = Path(self.temporary.name)
        (self.dir / 'bin').mkdir()
        stub = self.dir / 'bin' / 'kubectl'
        stub.write_text(FAKE_KUBECTL.replace('#!/usr/bin/env python3', '#!' + sys.executable, 1))
        stub.chmod(0o755)
        versions = {name: f'uid-{name}/7' for name in SECRETS}
        kinds = ('secret', 'secret', 'secret', 'secret', 'configmap')
        self.state = {
            'clock': 0, 'manifest': 'v1', 'native_config': NATIVE, 'versions': versions,
            'deployments': {name: {'template': f'{name}:{OLD[name]}' + ('|manifest=v1' if name == 'pilot' else ''),
                                   'generation': 1, 'replicas': 4 if name == 'pilot' else 2,
                                   'replicasets': [{'name': f'{name}-0', 'at': '2026-11-10T08:01:37Z'}]}
                            for name in OLD},
            'release': {'schemaVersion': 1, 'source': 'e' * 40,
                        'components': {name: {'tag': tag, 'digest': 'sha256:' + 'f' * 64} for name, tag in OLD.items()},
                        'inputs': {'pilot': fingerprint(versions, SECRETS, kinds),
                                   'waitlist': fingerprint(versions, SECRETS[:1], kinds)}},
        }

    def tearDown(self):
        self.temporary.cleanup()

    def fresh(self):
        """A second cluster within one test."""
        self.tearDown()
        self.setUp()

    def deploy(self, mode='scoped', base='e' * 40, changed=(), expect=0):
        (self.dir / 'state.json').write_text(json.dumps(self.state))
        (self.dir / 'log').write_text('')
        tags = {name: NEW if name in changed else OLD[name] for name in OLD}
        env = {**os.environ, 'PATH': f'{self.dir / "bin"}:{os.environ["PATH"]}',
               'FAKE_STATE': str(self.dir / 'state.json'), 'FAKE_LOG': str(self.dir / 'log'),
               'REGISTRY': REGISTRY, 'TAG': NEW, 'SCOPE_MODE': mode, 'BASE': base, 'RUNNER_TEMP': str(self.dir),
               **{f'TAG_{name.upper()}': tag for name, tag in tags.items()},
               **{f'CHANGED_{name.upper()}': 'true' if name in changed else 'false' for name in OLD}}
        result = subprocess.run(['bash', str(HERE / 'apply.sh')], env=env, capture_output=True, text=True)
        self.output = result.stdout + result.stderr
        self.assertEqual(result.returncode, expect, self.output)
        self.state = json.loads((self.dir / 'state.json').read_text())
        self.calls = [json.loads(line) for line in (self.dir / 'log').read_text().splitlines()]
        return self.calls

    def changes(self):
        """The calls that change the cluster, shortened."""
        out = []
        for call in self.calls:
            if call[0] == 'apply' and '--dry-run=server' not in call:
                out.append('apply')
            elif call[2:4] == ['set', 'image']:
                out.append('set image ' + call[4])
            elif call[2:4] == ['rollout', 'restart']:
                out.append('restart ' + ' '.join(t.split('/')[1] for t in call[4:]))
        return out

    def made(self):
        """How many ReplicaSets this deploy made for each Deployment."""
        return {name: len(d['replicasets']) - 1 for name, d in self.state['deployments'].items()}

    def test_a_new_pilot_image_is_one_apply_and_one_replicaset(self):
        # Before 10 November 2026: apply, then the native patch, two ReplicaSets a second apart.
        self.deploy(changed=('pilot',))
        self.assertEqual(self.changes(), ['apply'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 1, 'waitlist': 0})
        self.assertIn('pilot: 1 new ReplicaSet(s) since', self.output)
        self.assertNotIn('::warning::', self.output)

    def test_a_manifest_change_in_full_mode_rolls_out_once_and_restarts_nothing(self):
        # Before: apply, the native patch and a restart of all three; three pilot ReplicaSets in three seconds.
        self.state['manifest'] = 'v2'
        self.deploy(mode='full')
        self.assertEqual(self.changes(), ['apply'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 1, 'waitlist': 0})

    def test_full_mode_with_nothing_changed_rolls_out_nothing(self):
        # A workflow or helper change: no image and no part of the manifest differs.
        self.deploy(mode='full')
        self.assertEqual(self.changes(), ['apply'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 0, 'waitlist': 0})
        self.assertIn('pilot: 0 new ReplicaSet(s) since', self.output)

    def test_a_web_release_sets_one_image_and_does_not_apply(self):
        self.deploy(changed=('web',))
        self.assertEqual(self.changes(), ['set image deployment/web'])
        self.assertEqual(self.made(), {'web': 1, 'pilot': 0, 'waitlist': 0})
        self.assertIn('pilot unchanged: the manifest is not applied again', self.output)

    def test_a_scoped_deploy_with_no_component_changes_nothing(self):
        # An operator script or the pre-push check: nothing to build, nothing to roll out.
        self.deploy()
        self.assertEqual(self.changes(), [])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 0, 'waitlist': 0})

    def test_a_changed_secret_restarts_only_what_reads_it_once(self):
        self.state['versions']['uain-kalki'] = 'uid-uain-kalki/8'  # the pilot reads it, the waitlist does not
        self.deploy()
        self.assertEqual(self.changes(), ['apply', 'restart pilot'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 1, 'waitlist': 0})
        self.fresh()
        self.state['versions']['uain-env'] = 'uid-uain-env/8'  # both read it
        self.deploy()
        self.assertEqual(self.changes(), ['apply', 'restart pilot waitlist'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 1, 'waitlist': 1})

    def test_a_changed_secret_beside_a_new_image_is_still_one_replicaset(self):
        self.state['versions']['uain-env'] = 'uid-uain-env/8'
        self.deploy(changed=('pilot',))
        # The pilot is already rolling out and reads the new value; the waitlist is restarted.
        self.assertEqual(self.changes(), ['apply', 'restart waitlist'])
        self.assertEqual(self.made(), {'web': 0, 'pilot': 1, 'waitlist': 1})
        self.assertIn('pilot: already rolling out with this deploy\'s change; not restarted as well', self.output)

    def test_a_run_by_hand_restarts_every_deployment_once(self):
        self.deploy(mode='full', base='')
        self.assertEqual(self.changes(), ['apply', 'restart pilot web waitlist'])
        self.assertEqual(self.made(), {'web': 1, 'pilot': 1, 'waitlist': 1})
        # With new images as well: the apply rolls them out, and nothing is restarted on top.
        self.fresh()
        self.deploy(mode='full', base='', changed=('web', 'pilot', 'waitlist'))
        self.assertEqual(self.changes(), ['apply'])
        self.assertEqual(self.made(), {'web': 1, 'pilot': 1, 'waitlist': 1})

    def test_an_earlier_rollout_is_waited_for_before_anything_changes(self):
        calls = self.deploy(changed=('pilot',))
        first_change = next(i for i, call in enumerate(calls) if call[0] == 'apply' and '--dry-run=server' not in call)
        settled = [call[4] for call in calls[:first_change] if call[2:4] == ['get', 'deployment'] and call[-1] == 'json']
        self.assertEqual(settled[:3], ['pilot', 'web', 'waitlist'])
        # A stuck earlier rollout is a warning, and the deploy goes on.
        self.fresh()
        self.state['deployments']['pilot']['stuck'] = True
        self.deploy(changed=('pilot',), expect=1)  # the fake never recovers, so the final wait fails
        self.assertIn('::warning::pilot: an earlier rollout is unfinished', self.output)
        self.assertEqual(self.changes(), ['apply'])

    def test_a_manifest_that_would_leave_the_wrong_thing_is_never_applied(self):
        self.state['dry_run_sidecar'] = f'{REGISTRY}/pilot:' + '9' * 40  # the sidecar on another tag
        self.deploy(changed=('pilot',), expect=1)
        self.assertEqual(self.changes(), [])
        self.assertIn('::error::rendered manifest: Deployment/pilot: container native-rpc runs pilot:' + '9' * 40, self.output)
        # Unknown pins in the native ConfigMap stop the deploy before the dry run.
        self.fresh()
        self.state['native_config'] = {'data': {**NATIVE['data'], 'UAIN_NATIVE_RPC': 'http://10.98.0.1:26667'}}
        self.deploy(changed=('pilot',), expect=1)
        self.assertEqual(self.changes(), [])
        self.assertFalse(any(call[0] == 'apply' for call in self.calls))

    def test_the_workflow_runs_this_script(self):
        workflow = (ROOT / '.github/workflows/deploy.yml').read_text()
        self.assertIn('run: bash deploy/k8s/production/apply.sh', workflow)
        # The steps this script replaced must not come back beside it.
        for gone in ('apply-native.sh', 'rollout restart', 'set image deployment', 'kubectl apply -f "$rendered"'):
            self.assertFalse(gone in workflow, f'deploy.yml still has "{gone}"')
        # Both images that serve a build id are built with their commit (ops/docs/build-id.mjs).
        builds = [line for line in workflow.splitlines() if 'docker build --pull' in line]
        self.assertEqual(len(builds), 3)
        for line in builds:
            self.assertEqual('--build-arg UAIN_SOURCE_COMMIT="$TAG"' in line, 'waitlist' not in line, line.strip())


if __name__ == '__main__':
    unittest.main()
