"""Tests for ops/ci/rollout-wait.py: the production deploy's rollout decision."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollout_wait', Path(__file__).with_name('rollout-wait.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


def deployment(replicas=2, generation=4, observed=4, updated=2, available=2, total=2, conditions=()):
    return dict(metadata=dict(name='pilot', generation=generation, annotations={w.REVISION: '7'}),
                spec=dict(replicas=replicas, selector=dict(matchLabels=dict(app='pilot'))),
                status=dict(observedGeneration=observed, updatedReplicas=updated, availableReplicas=available,
                            replicas=total, conditions=list(conditions)))


def rs(uid, revision):
    return dict(metadata=dict(uid=uid, annotations={w.REVISION: revision}))


def pod(name, owner, is_ready=True, deleting=False):
    meta = dict(name=name, ownerReferences=[dict(uid=owner)])
    if deleting:
        meta['deletionTimestamp'] = '2026-11-10T10:00:00Z'
    return dict(metadata=meta, status=dict(phase='Running', conditions=[dict(type='Ready', status='True' if is_ready else 'False')]))


SETS = [rs('new', '7'), rs('old', '6')]


class DecideTest(unittest.TestCase):
    def test_new_pods_ready_and_old_only_terminating_is_done(self):
        state, _, details = w.decide(deployment(), SETS, [pod('new-a', 'new'), pod('new-b', 'new'),
                                                          pod('old-a', 'old', deleting=True), pod('old-b', 'old', is_ready=False, deleting=True)])
        self.assertEqual(state, 'done')
        self.assertEqual(details['old_terminating'], ['old-a', 'old-b'])

    def test_new_pod_not_ready_waits_and_is_named(self):
        state, message, details = w.decide(deployment(available=1), SETS, [pod('new-a', 'new'), pod('new-b', 'new', is_ready=False),
                                                                          pod('old-a', 'old', deleting=True)])
        self.assertEqual(state, 'wait')
        self.assertIn('1 of 2 new pods ready', message)
        self.assertEqual(details['new_unready'], ['new-b'])

    def test_progress_deadline_fails_at_once(self):
        stuck = deployment(available=0, conditions=[dict(type='Progressing', status='False', reason='ProgressDeadlineExceeded',
                                                         message='ReplicaSet "pilot-7" has timed out progressing.')])
        state, message, details = w.decide(stuck, SETS, [pod('new-a', 'new', is_ready=False), pod('new-b', 'new', is_ready=False)])
        self.assertEqual(state, 'fail')
        self.assertIn('progress deadline exceeded', message)
        self.assertEqual(details['new_unready'], ['new-a', 'new-b'])

    def test_unobserved_generation_waits(self):
        state, message, _ = w.decide(deployment(observed=3), SETS, [pod('new-a', 'new'), pod('new-b', 'new')])
        self.assertEqual((state, message), ('wait', 'the controller has not observed the new spec yet'))

    def test_old_pod_still_active_waits(self):
        state, message, _ = w.decide(deployment(total=3), SETS, [pod('new-a', 'new'), pod('new-b', 'new'), pod('old-a', 'old')])
        self.assertEqual(state, 'wait')
        self.assertIn('old-a', message)

    def test_too_few_updated_replicas_waits(self):
        state, message, _ = w.decide(deployment(updated=1, available=1), SETS, [pod('new-a', 'new'), pod('old-a', 'old')])
        self.assertEqual((state, message), ('wait', '1 of 2 replicas updated'))

    def test_terminating_new_pod_does_not_count_as_ready(self):
        state, _, _ = w.decide(deployment(), SETS, [pod('new-a', 'new'), pod('new-b', 'new', deleting=True)])
        self.assertEqual(state, 'wait')

    def test_missing_new_replicaset_waits(self):
        state, _, _ = w.decide(deployment(), [rs('old', '6')], [pod('old-a', 'old')])
        self.assertEqual(state, 'wait')


class MainTest(unittest.TestCase):
    def run_main(self, snapshots, timeout='600', clock=None, extra=()):
        printed = []
        with patch.object(w, 'snapshot', side_effect=snapshots), patch.object(w, 'kubectl', side_effect=subprocess.CalledProcessError(1, 'kubectl')), \
                patch.object(w.time, 'sleep'), patch('builtins.print', side_effect=lambda *a, **k: printed.append(' '.join(map(str, a)))), \
                patch.object(w.time, 'monotonic', side_effect=clock or (lambda: 0)):
            code = w.main(['rollout-wait.py', 'uain', 'pilot', timeout, *extra])
        return code, '\n'.join(printed)

    # --settle: the wait before a deploy changes anything. It never fails the deploy.
    def test_settle_waits_for_an_earlier_rollout_to_finish(self):
        going = (deployment(available=1), SETS, [pod('new-a', 'new'), pod('new-b', 'new', is_ready=False), pod('old-a', 'old')])
        done = (deployment(), SETS, [pod('new-a', 'new'), pod('new-b', 'new')])
        code, out = self.run_main([going, going, done], extra=['--settle'])
        self.assertEqual(code, 0)
        self.assertIn('pilot: 1 of 2 new pods ready', out)
        self.assertIn('pilot: 2 of 2 new pods ready', out)
        self.assertNotIn('::warning::', out)

    def test_settle_goes_on_past_a_stuck_or_slow_rollout_with_a_warning(self):
        stuck = deployment(available=0, conditions=[dict(type='Progressing', status='False', reason='ProgressDeadlineExceeded',
                                                         message='ReplicaSet "pilot-7" has timed out progressing.')])
        code, out = self.run_main([(stuck, SETS, [pod('new-a', 'new', is_ready=False)])], extra=['--settle'])
        self.assertEqual(code, 0)
        self.assertIn('::warning::pilot: an earlier rollout is unfinished (progress deadline exceeded', out)
        self.assertNotIn('::error::', out)
        ticks = iter([0, 10, 400])
        slow = (deployment(available=1), SETS, [pod('new-a', 'new'), pod('new-b', 'new', is_ready=False)])
        code, out = self.run_main([slow, slow], timeout='300', clock=lambda: next(ticks), extra=['--settle'])
        self.assertEqual(code, 0)
        self.assertIn('::warning::pilot: an earlier rollout is unfinished (not rolled out after 300s', out)

    def test_settle_passes_when_there_is_no_deployment_yet_and_the_plain_wait_does_not(self):
        missing = subprocess.CalledProcessError(1, 'kubectl', stderr='Error from server (NotFound): deployments.apps "pilot" not found')
        code, out = self.run_main([missing], extra=['--settle'])
        self.assertEqual(code, 0)
        self.assertIn('::notice::pilot: nothing to wait for before this deploy', out)
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_main([missing])

    # --since: one deploy should make one ReplicaSet for a Deployment.
    def test_since_counts_the_replicasets_this_deploy_made(self):
        def made(name, at, uid, revision):
            return dict(metadata=dict(name=name, uid=uid, creationTimestamp=at, annotations={w.REVISION: revision}))
        earlier = made('pilot-old', '2026-11-10T08:01:37Z', 'old', '6')
        one = [made('pilot-new', '2026-11-10T09:30:05Z', 'new', '7'), earlier]
        pods = [pod('new-a', 'new'), pod('new-b', 'new')]
        code, out = self.run_main([(deployment(), one, pods)], extra=['--since', '2026-11-10T09:30:00Z'])
        self.assertEqual(code, 0)
        self.assertIn('pilot: 1 new ReplicaSet(s) since 2026-11-10T09:30:00Z: pilot-new', out)
        self.assertNotIn('::warning::', out)
        # What every deploy did before 10 November 2026: three within three seconds.
        three = [made('pilot-a', '2026-11-10T09:30:02Z', 'a', '5'), made('pilot-b', '2026-11-10T09:30:03Z', 'b', '6'),
                 made('pilot-new', '2026-11-10T09:30:05Z', 'new', '7'), earlier]
        code, out = self.run_main([(deployment(), three, pods)], extra=['--since', '2026-11-10T09:30:00Z'])
        self.assertEqual(code, 0)
        self.assertIn('::warning::pilot: this deploy made 3 ReplicaSets (pilot-a, pilot-b, pilot-new)', out)
        # Nothing changed: no new ReplicaSet, and the argument order does not matter.
        printed = []
        with patch.object(w, 'snapshot', side_effect=[(deployment(), one, pods)]), patch.object(w.time, 'sleep'), \
                patch('builtins.print', side_effect=lambda *a, **k: printed.append(' '.join(map(str, a)))):
            self.assertEqual(w.main(['rollout-wait.py', '--since', '2026-11-10T10:00:00Z', 'uain', 'pilot']), 0)
        self.assertIn('pilot: 0 new ReplicaSet(s) since 2026-11-10T10:00:00Z', '\n'.join(printed))

    def test_terminating_old_pods_pass_with_a_notice(self):
        code, out = self.run_main([(deployment(), SETS, [pod('new-a', 'new'), pod('new-b', 'new'), pod('old-a', 'old', deleting=True)])])
        self.assertEqual(code, 0)
        self.assertIn('::notice::pilot rolled out; old pods still terminating (not a failure): old-a', out)

    def test_unready_new_pods_fail_clearly_at_the_timeout(self):
        ticks = iter([0, 10, 700])
        frame = (deployment(available=1), SETS, [pod('new-a', 'new'), pod('new-b', 'new', is_ready=False), pod('old-a', 'old', deleting=True)])
        code, out = self.run_main([frame, frame], timeout='600', clock=lambda: next(ticks))
        self.assertEqual(code, 1)
        self.assertIn('--- new pod new-b is not ready', out)
        self.assertIn('::error::pilot not rolled out after 600s: 1 of 2 new pods ready; new pods not ready: new-b; old pods still active: none', out)


if __name__ == '__main__':
    unittest.main()
