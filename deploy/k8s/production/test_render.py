"""Tests for render.py: the production manifest is rendered whole, for one apply.

The cases on the native ConfigMap are the ones ops/chain/test_native_deploy.py
held for apply-native.sh (retired 10 November 2026). The last class runs the
real `kubectl kustomize` and is skipped where kubectl is not installed (the
test sandbox); every deploy runs the same render and `verify` before it applies.
"""
import contextlib
import copy
import importlib.util
import io
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('render', HERE / 'render.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)

TAGS = {'web': 'a' * 40, 'pilot': 'b' * 40, 'waitlist': 'c' * 40}


def native_config(**changes):
    data = {
        'UAIN_AUTHORITY': 'native', 'UAIN_NATIVE_PROJECTION': '1',
        'UAIN_NATIVE_STATE_BINARY': '/opt/uain-native/public/state/' + 'a' * 64 + '/uain-state',
        'UAIN_NATIVE_STATE_SHA256': 'a' * 64,
        'UAIN_NATIVE_GENESIS': '/opt/uain-native/public/genesis/' + 'b' * 64 + '/genesis.json',
        'UAIN_NATIVE_GENESIS_SHA256': 'b' * 64,
        'UAIN_NATIVE_RPC': 'http://127.0.0.1:26667',
        'UAIN_NATIVE_PUBLICATION_DIR': '/var/lib/uain-native/publications',
        'UAIN_NATIVE_CHAIN_ID': 'uain-shadow-20261008-1',
    }
    data.update(changes)
    return {'data': data}


class Cluster:
    """A stand-in for kubectl: answers the two reads and records every call."""

    def __init__(self, config=None, replicas='4', fail=()):
        self.config, self.replicas, self.fail, self.calls, self.kustomizations = config, replicas, fail, [], []

    def __call__(self, *args):
        self.calls.append(args)
        if 'configmap' in args:
            if 'configmap' in self.fail:
                return SimpleNamespace(returncode=1, stdout='', stderr='connection refused')
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.config) if self.config else '', stderr='')
        if 'deployment' in args:
            if 'deployment' in self.fail:
                return SimpleNamespace(returncode=1, stdout='', stderr='connection refused')
            return SimpleNamespace(returncode=0, stdout=self.replicas, stderr='')
        if args[0] == 'kustomize':
            directory = Path(args[1])
            self.kustomizations.append({p.name: p.read_text() for p in directory.iterdir()})
            return SimpleNamespace(returncode=0, stdout='kind: Rendered\n', stderr='')
        raise AssertionError(f'unexpected kubectl {args}')

    @property
    def mutations(self):
        return [c for c in self.calls if c[0] != 'kustomize' and 'get' not in c]


class NativeConfigTest(unittest.TestCase):
    def test_absent_config_renders_the_plain_manifest(self):
        cluster = Cluster(config=None)
        r.render(TAGS, cluster)
        (files,) = cluster.kustomizations
        self.assertEqual(sorted(files), ['kustomization.yaml', 'uain.yaml'])
        self.assertNotIn('patches', files['kustomization.yaml'])
        self.assertEqual(cluster.mutations, [])

    def test_failed_read_never_means_absence(self):
        cluster = Cluster(fail=('configmap',))
        with self.assertRaises(RuntimeError):
            r.render(TAGS, cluster)
        self.assertEqual(cluster.kustomizations, [])

    def test_valid_pins_render_the_native_runtime_into_the_one_manifest(self):
        cluster = Cluster(config=native_config())
        r.render(TAGS, cluster)
        (files,) = cluster.kustomizations
        kustomization = files['kustomization.yaml']
        self.assertIn('  - native-projection.yaml', kustomization)
        self.assertIn('  - path: native-pilot.patch.yaml', kustomization)
        self.assertIn('  - path: research-index-suspend.yaml', kustomization)
        self.assertIn('suspend: true', files['research-index-suspend.yaml'])
        # The sidecar and the projection run the pilot's image, at the pilot's tag.
        for name in ('native-pilot.patch.yaml', 'native-projection.yaml'):
            self.assertIn('/uain/pilot:' + 'b' * 40, files[name])
            self.assertNotIn('IMAGE_TAG', files[name])
        # Rendering reads the cluster and changes nothing in it.
        self.assertEqual(cluster.mutations, [])

    def test_unknown_or_changed_pins_fail_before_anything_is_rendered(self):
        for change in [{'extra': 'unknown'}, {'UAIN_NATIVE_RPC': 'http://10.98.0.1:26667'},
                       {'UAIN_NATIVE_STATE_BINARY': '/tmp/untrusted'}, {'UAIN_AUTHORITY': 'unknown'},
                       {'UAIN_NATIVE_GENESIS_SHA256': 'broken'}, {'UAIN_NATIVE_PROJECTION': '0'},
                       {'UAIN_NATIVE_CHAIN_ID': 'other'}, {'UAIN_NATIVE_PUBLICATION_DIR': '/tmp'}]:
            cluster = Cluster(config=native_config(**change))
            with self.assertRaises(ValueError, msg=change):
                r.render(TAGS, cluster)
            self.assertEqual(cluster.kustomizations, [], change)
        missing = native_config()
        del missing['data']['UAIN_NATIVE_RPC']
        with self.assertRaises(ValueError):
            r.render(TAGS, Cluster(config=missing))

    def test_pilot_preparation_preserves_the_index_schedule(self):
        cluster = Cluster(config=native_config(UAIN_AUTHORITY='pilot'))
        r.render(TAGS, cluster)
        (files,) = cluster.kustomizations
        self.assertIn('  - path: native-pilot.patch.yaml', files['kustomization.yaml'])
        self.assertNotIn('research-index-suspend.yaml', files)

    def test_invalid_release_tag_never_reads_the_cluster(self):
        for tags in ({**TAGS, 'pilot': 'latest'}, {**TAGS, 'web': 'A' * 40}, {'web': 'a' * 40}):
            cluster = Cluster(config=native_config())
            with self.assertRaises(ValueError):
                r.render(tags, cluster)
            self.assertEqual(cluster.calls, [])


class BuildTest(unittest.TestCase):
    def test_each_component_gets_its_own_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            r.build(directory, TAGS, None, None)
            text = (Path(directory) / 'uain.yaml').read_text()
        self.assertEqual(text.count('/uain/web:' + 'a' * 40), 1)
        self.assertEqual(text.count('/uain/pilot:' + 'b' * 40), 2)  # the Deployment and research-index
        self.assertEqual(text.count('/uain/waitlist:' + 'c' * 40), 1)
        self.assertNotIn('IMAGE_TAG', text)

    def test_the_pilot_keeps_the_copies_it_has_within_the_autoscaler_bounds(self):
        for live, expected in (('4', 4), ('9', 9), ('14', 14), ('3', None), ('15', None), ('', None), ('many', None)):
            self.assertEqual(r.live_pilot_replicas(Cluster(replicas=live)), expected, live)
        cluster = Cluster(config=native_config(), replicas='9')
        r.render(TAGS, cluster)
        self.assertIn('replicas:\n  - name: pilot\n    count: 9\n', cluster.kustomizations[0]['kustomization.yaml'])
        cluster = Cluster(replicas='')  # first deploy: no Deployment yet
        r.render(TAGS, cluster)
        self.assertNotIn('replicas:', cluster.kustomizations[0]['kustomization.yaml'])
        with self.assertRaises(RuntimeError):
            r.render(TAGS, Cluster(fail=('deployment',)))
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            r.build(directory, TAGS, None, 40)

    def test_the_bounds_are_the_autoscalers(self):
        text = (HERE / 'uain.yaml').read_text()
        self.assertIn(f'minReplicas: {r.PILOT_MIN}\n', text)
        self.assertIn(f'maxReplicas: {r.PILOT_MAX}\n', text)

    def test_the_manifest_keeps_every_ready_copy_through_a_rollout(self):
        text = (HERE / 'uain.yaml').read_text()
        pilot = text.split('\n---\n')[1]
        self.assertIn('name: pilot', pilot)
        self.assertIn('rollingUpdate: { maxSurge: 2, maxUnavailable: 0 }', pilot)
        self.assertIn('minReadySeconds: 10', pilot)
        patch = (HERE / 'native-pilot.patch.yaml').read_text()
        # The sidecar counts towards readiness and outlives the pilot's 20 s shutdown,
        # within the pod's 30 s.
        self.assertIn('startupProbe:', patch)
        self.assertIn('preStop: { sleep: { seconds: 20 } }', patch)
        self.assertIn('terminationGracePeriodSeconds: 30', pilot)

    def test_pods_mount_no_api_token_and_use_the_default_seccomp_profile(self):
        # No workload calls the Kubernetes API (security review IN-10, 13 November 2026).
        text = (HERE / 'uain.yaml').read_text()
        workloads = {}
        for document in text.split('\n---\n'):
            kind = re.search(r'^kind: (Deployment|CronJob)$', document, re.M)
            if kind:
                name = re.search(r'^(?:  name: |metadata: \{ name: )([\w-]+)', document, re.M).group(1)
                workloads[name] = document
        self.assertEqual(sorted(workloads), ['pilot', 'research-index', 'waitlist', 'web'])
        for name, document in workloads.items():
            # At the pod spec's own indentation, beside `containers:`, once.
            pod = re.search(r'^( +)containers:$', document, re.M).group(1)
            self.assertEqual(re.findall(r'^( *)automountServiceAccountToken: false$', document, re.M), [pod], name)
            context = re.findall(r'^( *)securityContext: \{([^\n]*)\}$', document, re.M)
            self.assertEqual([indent for indent, _ in context], [pod], name)
            self.assertIn('seccompProfile: { type: RuntimeDefault }', context[0][1], name)
        # Every pod runs as a non-root user the kubelet can check (IN-10, 15 November 2026).
        for name, document in workloads.items():
            self.assertIn('{ runAsNonRoot: true,', document, name)
        self.assertIn('runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000,', workloads['pilot'])
        self.assertIn('securityContext: { runAsNonRoot: true, seccompProfile:', workloads['web'])
        self.assertIn('securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile:', workloads['waitlist'])
        self.assertIn('          resources:\n            requests: { cpu: 50m, memory: 64Mi }\n', workloads['web'])
        self.assertNotIn('limits:', workloads['web'])

    def test_a_failed_kustomize_is_an_error(self):
        class Broken(Cluster):
            def __call__(self, *args):
                if args[0] == 'kustomize':
                    return SimpleNamespace(returncode=1, stdout='', stderr='bad patch')
                return super().__call__(*args)
        with self.assertRaises(RuntimeError):
            r.render(TAGS, Broken())


# What the server's dry run returns for every pod in uain.yaml and native-projection.yaml.
def secure():
    return {'automountServiceAccountToken': False,
            'securityContext': {'runAsNonRoot': True, 'seccompProfile': {'type': 'RuntimeDefault'}}}


def deployment(name, containers, **spec):
    return {'kind': 'Deployment', 'metadata': {'name': name},
            'spec': {'template': {'spec': {'containers': containers, **secure(), **spec.pop('pod', {})}}, **spec}}


def cronjob(name, image, **spec):
    return {'kind': 'CronJob', 'metadata': {'name': name},
            'spec': {'jobTemplate': {'spec': {'template': {'spec': {'containers': [{'name': name, 'image': image}], **secure()}}}}, **spec}}


def applied(native=True):
    image = lambda repo: f'{r.REGISTRY}/{repo}:{TAGS[repo]}'
    env = [{'secretRef': {'name': 'uain-env'}}] + ([{'configMapRef': {'name': 'uain-native-config'}}] if native else [])
    containers = [{'name': 'pilot', 'image': image('pilot'), 'envFrom': env}]
    volumes = [{'name': 'ledger'}]
    if native:
        containers.append({'name': 'native-rpc', 'image': image('pilot')})
        volumes = [{'name': v} for v in r.NATIVE_VOLUMES] + volumes
    items = [
        {'kind': 'Namespace', 'metadata': {'name': 'uain'}},
        deployment('pilot', containers, pod={'volumes': volumes},
                   strategy={'type': 'RollingUpdate', 'rollingUpdate': {'maxSurge': 2, 'maxUnavailable': 0}}),
        deployment('web', [{'name': 'web', 'image': image('web')}]),
        deployment('waitlist', [{'name': 'waitlist', 'image': image('waitlist')}]),
        cronjob('research-index', image('pilot'), **({'suspend': True} if native else {})),
    ]
    if native:
        items.append(cronjob('native-projection', image('pilot')))
    return {'kind': 'List', 'items': items}


class VerifyTest(unittest.TestCase):
    def test_the_intended_result_has_no_problem(self):
        self.assertEqual(r.verify(applied(), TAGS, 'native'), [])
        self.assertEqual(r.verify(applied(native=False), TAGS, None), [])
        pilot_authority = applied()
        del pilot_authority['items'][4]['spec']['suspend']
        self.assertEqual(r.verify(pilot_authority, TAGS, 'pilot'), [])

    def problems(self, change, authority='native', native=True):
        objects = applied(native)
        change(objects['items'])
        return r.verify(objects, TAGS, authority)

    def test_a_sidecar_left_on_another_image_is_refused(self):
        # What the old apply left for a second: the new pilot beside the old sidecar.
        def change(items):
            items[1]['spec']['template']['spec']['containers'][1]['image'] = f'{r.REGISTRY}/pilot:' + 'd' * 40
        (problem,) = self.problems(change)
        self.assertIn('native-rpc runs pilot:' + 'd' * 40, problem)

    def test_a_pilot_without_the_native_configmap_is_refused(self):
        # What `kubectl apply` of uain.yaml alone did: envFrom is replaced as a whole.
        def change(items):
            items[1]['spec']['template']['spec']['containers'][0]['envFrom'].pop()
        self.assertTrue(any('does not read uain-native-config' in p for p in self.problems(change)))

    def test_missing_or_reordered_containers_are_refused(self):
        def drop(items):
            items[1]['spec']['template']['spec']['containers'].pop()
        self.assertTrue(any("expected ['pilot', 'native-rpc']" in p for p in self.problems(drop)))
        def swap(items):
            items[1]['spec']['template']['spec']['containers'].reverse()
        self.assertTrue(any("expected ['pilot', 'native-rpc']" in p for p in self.problems(swap)))

    def test_a_native_runtime_without_its_configmap_is_refused(self):
        self.assertTrue(any('although uain-native-config does not exist' in p
                            for p in r.verify(applied(native=True), TAGS, None)))

    def test_a_strategy_that_stops_ready_copies_first_is_refused(self):
        def change(items):
            items[1]['spec']['strategy']['rollingUpdate']['maxUnavailable'] = 1
        self.assertTrue(any('maxUnavailable is not 0' in p for p in self.problems(change)))

    def test_wrong_tags_placeholders_and_missing_objects_are_refused(self):
        def tag(items):
            items[2]['spec']['template']['spec']['containers'][0]['image'] = f'{r.REGISTRY}/web:' + 'b' * 40
        self.assertTrue(any('web runs web:' in p for p in self.problems(tag)))
        def placeholder(items):
            items[4]['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]['image'] = f'{r.REGISTRY}/pilot:IMAGE_TAG'
        self.assertTrue(any('placeholder' in p for p in self.problems(placeholder)))
        def foreign(items):
            items[3]['spec']['template']['spec']['containers'][0]['image'] = 'docker.io/library/node:22'
        self.assertTrue(any('not an image of' in p for p in self.problems(foreign)))
        def gone(items):
            del items[3]
        self.assertIn('Deployment/waitlist is missing', self.problems(gone))
        def projection(items):
            items.pop()
        self.assertIn('CronJob/native-projection is missing', self.problems(projection))
        def running(items):
            items[4]['spec']['suspend'] = False
        self.assertTrue(any('research-index is not suspended' in p for p in self.problems(running)))

    def test_a_pod_with_a_token_without_seccomp_or_as_root_is_refused(self):
        pods = {1: lambda items: items[1]['spec']['template']['spec'],
                2: lambda items: items[2]['spec']['template']['spec'],
                3: lambda items: items[3]['spec']['template']['spec'],
                4: lambda items: items[4]['spec']['jobTemplate']['spec']['template']['spec'],
                5: lambda items: items[5]['spec']['jobTemplate']['spec']['template']['spec']}
        names = {1: 'Deployment/pilot', 2: 'Deployment/web', 3: 'Deployment/waitlist',
                 4: 'CronJob/research-index', 5: 'CronJob/native-projection'}
        breaks = {
            'mounts a service-account token': [lambda pod: pod.pop('automountServiceAccountToken'),
                                               lambda pod: pod.update(automountServiceAccountToken=True)],
            'RuntimeDefault seccomp profile': [lambda pod: pod['securityContext'].pop('seccompProfile'),
                                               lambda pod: pod['securityContext'].update(seccompProfile={'type': 'Unconfined'})],
            'may run as root': [lambda pod: pod['securityContext'].pop('runAsNonRoot'),
                                lambda pod: pod['securityContext'].update(runAsNonRoot=False),
                                lambda pod: pod.pop('securityContext')],
        }
        for index, pod in pods.items():
            for words, ways in breaks.items():
                for way in ways:
                    def change(items, pod=pod, way=way):
                        way(pod(items))
                    found = self.problems(change)
                    self.assertTrue(any(p.startswith(names[index]) and words in p for p in found), (names[index], words, found))

    def test_the_command_line_names_each_problem_and_exits_1(self):
        cluster = Cluster(config=native_config())
        bad = copy.deepcopy(applied())
        bad['items'][1]['spec']['template']['spec']['containers'].pop()
        said = io.StringIO()  # kept out of the test log: the lines are workflow annotations
        with contextlib.redirect_stdout(said), contextlib.redirect_stderr(said):
            self.assertEqual(r.main(['verify', *TAGS.values()], cluster, io.StringIO(json.dumps(bad))), 1)
            self.assertIn("::error::rendered manifest: Deployment/pilot has containers ['pilot']", said.getvalue())
            self.assertEqual(r.main(['verify', *TAGS.values()], cluster, io.StringIO(json.dumps(applied()))), 0)
            out = io.StringIO()
            self.assertEqual(r.main(['render', *TAGS.values()], cluster, stdout=out), 0)
            self.assertEqual(out.getvalue(), 'kind: Rendered\n')
            self.assertEqual(r.main(['apply', *TAGS.values()], cluster), 2)
        self.assertEqual(cluster.mutations, [])


@unittest.skipUnless(shutil.which('kubectl'), 'kubectl is not installed here; every deploy runs this render and verify')
class KustomizeTest(unittest.TestCase):
    """The real merge: the rendered pilot Deployment is the one that runs in production."""

    def rendered(self, authority, replicas=None):
        with tempfile.TemporaryDirectory() as directory:
            r.build(directory, TAGS, authority, replicas)
            result = r.kubectl('kustomize', directory)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def document(self, text, kind, name):
        for document in text.split('\n---\n'):
            if re.search(rf'^kind: {kind}$', document, re.M) and re.search(rf'^  name: {name}$', document, re.M):
                return document
        self.fail(f'{kind}/{name} is not in the rendered manifest')

    def containers(self, pilot):
        """The container names of the pilot Deployment, in order (the pod's own keys follow the list)."""
        section = pilot.split('      containers:\n')[1].split('\n      securityContext:')[0]
        return re.findall(r'^        name: (\S+)$', section, re.M)

    def test_the_native_runtime_is_merged_into_the_pilot_deployment(self):
        text = self.rendered('native', 6)
        self.assertNotIn('IMAGE_TAG', text)
        pilot = self.document(text, 'Deployment', 'pilot')
        self.assertIn('  replicas: 6\n', pilot)
        self.assertIn('      maxUnavailable: 0\n', pilot)
        self.assertIn('  minReadySeconds: 10\n', pilot)
        # Both containers, the pilot first (kubectl exec and logs default to it), on one tag.
        self.assertEqual(self.containers(pilot), ['pilot', 'native-rpc'])
        self.assertEqual(pilot.count('image: 10.98.0.1:5000/uain/pilot:' + 'b' * 40), 2)
        # The pilot reads its three secrets and the native ConfigMap; the sidecar the ConfigMap.
        self.assertEqual(pilot.count('configMapRef:'), 2)
        self.assertEqual(pilot.count('secretRef:'), 3)
        # Nothing of uain.yaml's own pilot container is lost in the merge.
        for kept in ('startupProbe:', 'readinessProbe:', 'livenessProbe:', 'path: /api/ready', 'name: UAIN_WRITER_POOL',
                     'mountPath: /var/lib/uain-pilot', 'secretName: uain-ledger', 'terminationGracePeriodSeconds: 30'):
            self.assertIn(kept, pilot, kept)
        for added in ('mountPath: /opt/uain-native/public', 'mountPath: /var/lib/uain-native/publications',
                      'mountPath: /run/uain-native-rpc', 'path: /run/uain-native-rpc', 'seconds: 20'):
            self.assertIn(added, pilot, added)
        self.assertIn('suspend: true', self.document(text, 'CronJob', 'research-index'))
        self.assertIn('/uain/pilot:' + 'b' * 40, self.document(text, 'CronJob', 'native-projection'))
        web = self.document(text, 'Deployment', 'web')
        self.assertIn('seconds: 10', web)
        self.assertIn('      maxUnavailable: 0\n', web)
        # Every pod, the merged pilot included, mounts no API token and runs under RuntimeDefault.
        for kind, name in (('Deployment', 'pilot'), ('Deployment', 'web'), ('Deployment', 'waitlist'),
                           ('CronJob', 'research-index'), ('CronJob', 'native-projection')):
            document = self.document(text, kind, name)
            self.assertEqual(len(re.findall(r'^ +automountServiceAccountToken: false$', document, re.M)), 1, name)
            self.assertEqual(len(re.findall(r'^ +seccompProfile:\n +type: RuntimeDefault$', document, re.M)), 1, name)

    def test_without_the_configmap_the_manifest_is_the_plain_one(self):
        text = self.rendered(None)
        pilot = self.document(text, 'Deployment', 'pilot')
        self.assertEqual(self.containers(pilot), ['pilot'])
        self.assertNotIn('configMapRef', pilot)
        self.assertIn('  replicas: 4\n', pilot)
        self.assertNotIn('native-projection', text)
        self.assertNotIn('suspend', self.document(text, 'CronJob', 'research-index'))

    def test_pilot_authority_adds_the_runtime_and_leaves_the_index_running(self):
        text = self.rendered('pilot')
        self.assertEqual(self.containers(self.document(text, 'Deployment', 'pilot')), ['pilot', 'native-rpc'])
        self.assertNotIn('suspend', self.document(text, 'CronJob', 'research-index'))


if __name__ == '__main__':
    unittest.main()
