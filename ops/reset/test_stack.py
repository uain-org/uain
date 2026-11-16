import subprocess,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import stack
from stack import tree_hash
class StackTest(unittest.TestCase):
 def test_public_application_tree_rejects_redirected_root_before_copy(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary);real=root/'real';real.mkdir();(real/'CURRENT').write_text('fixture');redirected=root/'redirected';redirected.symlink_to(real,target_is_directory=True)
   with self.assertRaises(ValueError):tree_hash(redirected)
   with self.assertRaises(ValueError):tree_hash(real/'CURRENT')
   self.assertEqual(tree_hash(real),tree_hash(real))

 # 13 November 2026 (security review OP-4): a oneshot that is running reads
 # "activating"; it is not stopped. An unreadable state refuses.
 def test_unit_active_reads_active_state_and_fails_closed(self):
  def answer(code,state):return patch.object(stack.subprocess,'run',return_value=subprocess.CompletedProcess([],code,stdout=state,stderr=b''))
  for state,expected in [(b'active\n',True),(b'activating\n',True),(b'deactivating\n',True),(b'reloading\n',True),(b'inactive\n',False),(b'failed\n',False)]:
   with self.subTest(state=state),answer(0,state) as run:
    self.assertIs(stack.unit_active('uain-survey-attester.service'),expected)
    self.assertEqual(run.call_args.args[0],['systemctl','show','-p','ActiveState','--value','uain-survey-attester.service'])
  for code,state in [(1,b'inactive\n'),(0,b''),(0,b'\n')]:
   with self.subTest(code=code,state=state),answer(code,state),self.assertRaises(RuntimeError):stack.unit_active('uain-survey-attester.service')
