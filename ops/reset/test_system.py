import copy,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import system,stack
class SystemTest(unittest.TestCase):
 def test_changed_prepared_public_runtime_refuses_before_archive_or_activation(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);key=root/'fixture-key';key.write_text('ab'*32)
   expected={'prepared':True,'proved_minted':'0','epoch':'20261012_010203','operator':'operator:fixture','app_node':{'id':'fixture-app'},'db_node':{'id':'fixture-db'},'database':{},'runtime':{'native':{'authority':'native'}}}
   expected['digest']=system.digest(expected);current=copy.deepcopy(expected);current['runtime']['native']['authority']='pilot'
   (root/'prepared-plan.json').write_text(json.dumps(expected))
   with patch.dict(os.environ,{'UAIN_RESET_KEY_FILE':str(key)}),patch.object(stack,'unit_active',return_value=False),patch.object(system,'runners_active',return_value=[]),patch.object(stack,'epoch_dir',return_value=root),patch.object(system,'plan',return_value=current),patch.object(stack,'stopped_checkpoint',side_effect=AssertionError('unreviewed runtime reached capture')):
    with self.assertRaisesRegex(ValueError,'Prepared public native runtime changed'):system.apply(expected,expected['digest'])
   self.assertFalse((root/'journal.json').exists())

 def test_operator_and_confirm_fail_closed(self):
  with self.assertRaises(ValueError):system.plan('20261008_000000','member:someone')
  with self.assertRaises(ValueError):system.apply({'digest':'a'*64},'wrong')
  with patch.object(stack,'unit_active',return_value=True):
   with self.assertRaises(ValueError):system.apply({'digest':'a'*64},'a'*64)

class QuietAndBalanceGuards(unittest.TestCase):
 """10 November 2026 (plan W11, audit 13-C #5/#6): no reset under live BAINK, payments,
 custody or a renamed runner, and none that silently discards AI$ balances."""
 def listed(self,*units):
  class Done:returncode=0;stdout=''.join(u+' loaded active running Fixture runner\n' for u in units)
  return patch.object(system.subprocess,'run',return_value=Done())

 def test_a_renamed_repository_runner_is_still_found(self):
  with self.listed('actions.runner.nuah-org-uain-universa.uain-production.service','actions.runner.senti-org-swarm-ai.uain-app-1.service'):
   self.assertEqual(system.runners_active(),['actions.runner.nuah-org-uain-universa.uain-production.service'])
  with patch.object(stack,'unit_active',return_value=False),self.listed('actions.runner.nuah-org-uain-universa.uain-production.service'):
   with self.assertRaisesRegex(ValueError,'Drain and stop the UAIN Actions runners'):system.require_quiet()
  with patch.object(stack,'unit_active',return_value=False),self.listed('uain-ci-worker-2.service'):
   with self.assertRaisesRegex(ValueError,'uain-ci-worker-2'):system.require_quiet()

 def test_an_unlistable_runner_state_refuses(self):
  class Failed:returncode=1;stdout=''
  with patch.object(system.subprocess,'run',return_value=Failed()):
   with self.assertRaisesRegex(ValueError,'Cannot list Actions runners'):system.runners_active()

 def test_live_baink_payment_or_custody_units_refuse(self):
  for unit in ['baink-server-holder-payer.service','uain-central-reviewer-custody.service','uain-survey-attester.timer','uain-private-review-broker.service']:
   with self.subTest(unit=unit),self.listed(),patch.object(stack,'unit_active',side_effect=lambda u,unit=unit:u==unit):
    with self.assertRaisesRegex(ValueError,'Stop the BAINK, payment and custody units first.*'+unit.replace('.','\\.')):system.require_quiet()
  with self.listed(),patch.object(stack,'unit_active',return_value=False):system.require_quiet()

 def test_minted_supply_needs_the_exact_acknowledgement(self):
  system.require_discard_acknowledged({},'0')
  system.require_discard_acknowledged({'discard_minted':'5000000'},'5000000')
  for plan in [{},{'discard_minted':'0'},{'discard_minted':'4999999'}]:
   with self.assertRaisesRegex(ValueError,'AI\\$ balances exist \\(minted 5000000\\)'):system.require_discard_acknowledged(plan,'5000000')
  for bad in [None,5000000,'-1','05','1e9']:
   with self.assertRaisesRegex(ValueError,'Invalid proved AI\\$ supply'):system.require_discard_acknowledged({},bad)

 def test_prepare_refuses_minted_balances_before_writing_or_quiescing(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary)
   expected={'epoch':'20261110_010203','operator':'operator:fixture','app_node':{},'db_node':{},'database':{},'runtime':{}}
   expected['digest']=system.digest(expected)
   with patch.object(stack,'unit_active',return_value=False),self.listed(),patch.object(stack,'epoch_dir',return_value=root),\
        patch.object(stack,'node_inventory',return_value={}),patch.object(system.checkpoint,'minted',return_value='5000000'),\
        patch.object(system.runtime,'quiesce',side_effect=AssertionError('quiesced before the balance guard')):
    with self.assertRaisesRegex(ValueError,'--discard-minted 5000000'):system.prepare(expected,expected['digest'])
   self.assertFalse((root/'prepare.json').exists())

 def test_the_acknowledgement_is_bound_into_the_plan_digest(self):
  with patch.object(stack,'node_inventory',return_value={'genesis_sha256':'g'}),patch.object(system,'remote',return_value={'node':{'genesis_sha256':'g'},'database':{}}),\
       patch.object(system.runtime,'inventory',return_value={}),patch.object(system,'LEDGER_PIN',Path(__file__)):
   bare=system.plan('20261110_010203','operator:fixture');acknowledged=system.plan('20261110_010203','operator:fixture','5000000')
  self.assertNotIn('discard_minted',bare);self.assertEqual(acknowledged['discard_minted'],'5000000')
  self.assertNotEqual(bare['digest'],acknowledged['digest'])
  with self.assertRaisesRegex(ValueError,'Invalid --discard-minted'):system.plan('20261110_010203','operator:fixture','5e6')

class PreparedPlanBinding(unittest.TestCase):
 """13 November 2026 (security review OP-5, register #97): apply runs only the plan that
 prepare saved, and repeats the AI$ discard acknowledgement before its first step."""
 def prepared(self,root,**changes):
  plan={'prepared':True,'proved_minted':'5000000','discard_minted':'5000000','epoch':'20261113_010203','operator':'operator:fixture',
        'app_node':{},'db_node':{},'database':{},'runtime':{'native':{}},'guardian_checkpoint':{}}
  plan.update(changes);plan.pop('digest',None);plan['digest']=system.digest(plan);return plan
 def refuse(self,root,expected,pattern):
  key=root/'fixture-key';key.write_text('ab'*32)
  with patch.dict(os.environ,{'UAIN_RESET_KEY_FILE':str(key)}),patch.object(stack,'unit_active',return_value=False),patch.object(system,'runners_active',return_value=[]),\
       patch.object(stack,'epoch_dir',return_value=root),patch.object(system,'plan',side_effect=AssertionError('reached the live plan')):
   with self.assertRaisesRegex(ValueError,pattern):system.apply(expected,expected['digest'])
  self.assertFalse((root/'journal.json').exists())

 def test_an_edited_plan_with_a_recomputed_digest_is_refused(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);saved=self.prepared(root);(root/'prepared-plan.json').write_text(json.dumps(saved))
   edited=self.prepared(root,database={'name':'another'})
   self.refuse(root,edited,'saved prepared plan')

 def test_a_missing_prepared_plan_is_refused(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);self.refuse(root,self.prepared(root),'saved prepared plan')

 def test_apply_repeats_the_discard_acknowledgement(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary)
   for changes,pattern in [({'discard_minted':None},'AI\\$ balances exist'),({'proved_minted':None},'Invalid proved AI\\$ supply')]:
    plan=self.prepared(root,**changes);plan={k:v for k,v in plan.items() if v is not None};plan.pop('digest');plan['digest']=system.digest(plan)
    (root/'prepared-plan.json').write_text(json.dumps(plan))
    with self.subTest(changes=changes):self.refuse(root,plan,pattern)

 def test_prepare_measures_the_supply_again_before_stopping_the_nodes(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary)
   expected={'epoch':'20261113_010203','operator':'operator:fixture','app_node':{},'db_node':{},'database':{},'runtime':{}}
   expected['digest']=system.digest(expected)
   class Done:returncode=0;stdout=''
   with patch.object(stack,'unit_active',return_value=False),patch.object(system.subprocess,'run',return_value=Done()),patch.object(stack,'epoch_dir',return_value=root),\
        patch.object(stack,'node_inventory',return_value={}),patch.object(system.checkpoint,'minted',side_effect=['0','5000000']),\
        patch.object(system.runtime,'quiesce',return_value=None),patch.object(system.checkpoint,'proven',return_value={}),\
        patch.object(stack,'command',side_effect=AssertionError('stopped a node before the second balance guard')):
    with self.assertRaisesRegex(ValueError,'--discard-minted 5000000'):system.prepare(expected,expected['digest'])
   self.assertFalse((root/'prepared-plan.json').exists())
