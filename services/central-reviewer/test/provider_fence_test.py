import importlib.util, pathlib, unittest
p=pathlib.Path(__file__).parents[1]/'src/provider-fence.py'
s=importlib.util.spec_from_file_location('provider_fence',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class FenceTests(unittest.TestCase):
 def test_hosts(self):
  for host in ['localhost','127.0.0.1','169.254.169.254','evil.chatgpt.com','chatgpt.com.evil','api.openai.com:80']:
   self.assertFalse(m.allowed_target(host))
  for host in ['api.openai.com:443','auth.openai.com:443','chatgpt.com:443']:self.assertTrue(m.allowed_target(host))
 def test_addresses(self):
  for ip in ['127.0.0.1','10.0.0.1','::1','169.254.169.254','192.168.1.1']:self.assertFalse(m.public_ip(ip))
  self.assertTrue(m.public_ip('1.1.1.1'))
 def test_fixed_auth_owner_and_mode(self):
  from unittest.mock import patch
  import types,stat
  good=types.SimpleNamespace(st_uid=999,st_mode=stat.S_IFREG|0o400,st_nlink=1)
  with patch.object(m.os,'geteuid',return_value=999),patch.object(m.pathlib.Path,'lstat',autospec=True,side_effect=lambda p:good if p.name=='provider-auth.json' else types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o755)):
   self.assertEqual(str(m.auth_path()),'/etc/uain-central-reviewer/provider-auth.json')
  for bad in [types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFREG|0o400,st_nlink=1),types.SimpleNamespace(st_uid=999,st_mode=stat.S_IFREG|0o600,st_nlink=1),types.SimpleNamespace(st_uid=999,st_mode=stat.S_IFLNK|0o400,st_nlink=1),types.SimpleNamespace(st_uid=999,st_mode=stat.S_IFREG|0o400,st_nlink=2)]:
   with patch.object(m.os,'geteuid',return_value=999),patch.object(m.pathlib.Path,'lstat',return_value=bad):
    with self.assertRaises(ValueError):m.auth_path()
 def test_auth_refuses_replaceable_parent(self):
  from unittest.mock import patch
  import types,stat
  with patch.object(m.os,'geteuid',return_value=999),patch.object(m.pathlib.Path,'lstat',autospec=True,side_effect=lambda p:types.SimpleNamespace(st_uid=999,st_mode=stat.S_IFREG|0o400,st_nlink=1) if p.name=='provider-auth.json' else types.SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o777)):
   with self.assertRaises(ValueError):m.auth_path()
if __name__=='__main__':unittest.main()
