"""Forced endpoint must refuse a shell, other databases and arbitrary files."""
import io
import json
import os
import unittest
from unittest.mock import patch
import node_main

class NodeTest(unittest.TestCase):
    def call(self,request,command='uain-reset-node'):
        with patch.object(node_main.os,'geteuid',return_value=0),patch.object(node_main.socket,'gethostname',return_value='uain-db-1'),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':command}),patch.object(node_main.sys,'stdin',io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()+b'\n'))):
            node_main.main()
    def test_no_general_command(self):
        with self.assertRaises(ValueError):self.call({},'uname -a')
    def test_other_database_refused_before_mutation(self):
        with patch.object(node_main.database,'stage') as stage:
            with self.assertRaises(ValueError):self.call({'action':'stage-db','epoch':'20261008_000001','database':{'database':'postgres','epoch':'20261008_000001','target':'uain_reset_20261008_000001'}})
            stage.assert_not_called()
    def test_arbitrary_export_refused(self):
        with patch.object(node_main.stack,'epoch_dir') as directory:
            with self.assertRaises(ValueError):self.call({'action':'fetch','epoch':'20261008_000001','file':'../../secret'})
            directory.assert_not_called()
    def test_oversized_request_refused(self):
        with patch.object(node_main.os,'geteuid',return_value=0),patch.object(node_main.socket,'gethostname',return_value='uain-db-1'),patch.dict(os.environ,{'SSH_ORIGINAL_COMMAND':'uain-reset-node'}),patch.object(node_main.sys,'stdin',io.TextIOWrapper(io.BytesIO(b' '*131073))):
            with self.assertRaises(ValueError):node_main.main()

if __name__=='__main__':unittest.main()
