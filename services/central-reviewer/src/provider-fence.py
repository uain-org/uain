#!/usr/bin/python3
"""Fixed server Codex in an outer network/filesystem namespace. No custody access.
Only --fixture/--review modes; stdin goes to fixed CLI, never a command interpreter.
"""
import stat,os,sys,socket,socketserver,threading,subprocess,tempfile,pathlib,hashlib,ipaddress,select,json,shutil
CLI_ROOT='/runtime' if len(sys.argv)>1 and sys.argv[1]=='--inner' else str(pathlib.Path(__file__).resolve().parents[1]/'runtime')
BWRAP=CLI_ROOT+'/bin/bwrap'
CLI_SHA='b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306'
BWRAP_SHA='77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'
HOSTS={'chatgpt.com','api.openai.com','auth.openai.com'}
DISABLED=['shell_tool','unified_exec','apps','browser_use','browser_use_external','computer_use','image_generation','in_app_browser','code_mode_host','multi_agent','plugins','hooks','skill_search','sleep_tool','view_image','goals','workspace_dependencies','tool_suggest']
def auth_path():
 path=pathlib.Path('/etc/uain-central-reviewer/provider-auth.json');info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o777!=0o400 or info.st_nlink!=1:raise ValueError('provider auth custody refused')
 for parent in path.parents:
  info=parent.lstat()
  if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:raise ValueError('provider auth ancestor refused')
 return path

def allowed_target(target):return target in {h+':443' for h in HOSTS}
def public_ip(value):
 ip=ipaddress.ip_address(value)
 return ip.is_global and not ip.is_multicast and not ip.is_reserved and not ip.is_unspecified
class Proxy(socketserver.StreamRequestHandler):
 def handle(self):
  upstream=None
  try:
   line=self.rfile.readline(4097)
   if len(line)>4096:raise ValueError()
   parts=line.decode('ascii').strip().split(' ')
   if len(parts)!=3 or parts[0]!='CONNECT' or not allowed_target(parts[1]):raise ValueError()
   size=len(line)
   while True:
    line=self.rfile.readline(4097);size+=len(line)
    if size>8192 or not line:raise ValueError()
    if line in [b'\r\n',b'\n']:break
   host=parts[1][:-4];addresses=socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)
   if not addresses or any(not public_ip(a[4][0]) for a in addresses):raise ValueError()
   address=addresses[0];upstream=socket.socket(address[0],address[1],address[2]);upstream.settimeout(20);upstream.connect(address[4]);self.connection.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
   while True:
    ready,_,_=select.select([self.connection,upstream],[],[],120)
    if not ready:break
    for src in ready:
     data=src.recv(65536)
     if not data:return
     (upstream if src is self.connection else self.connection).sendall(data)
  except Exception:
   try:self.connection.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
   except OSError:pass
  finally:
   if upstream:upstream.close()
class UnixProxy(socketserver.ThreadingUnixStreamServer):daemon_threads=True
class Bridge(socketserver.BaseRequestHandler):
 def handle(self):
  remote=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
  try:
   remote.connect('/proxy/socket')
   while True:
    ready,_,_=select.select([self.request,remote],[],[],120)
    if not ready:break
    for src in ready:
     data=src.recv(65536)
     if not data:return
     (remote if src is self.request else self.request).sendall(data)
  finally:remote.close()
class TcpBridge(socketserver.ThreadingTCPServer):daemon_threads=True;allow_reuse_address=True

def inner(mode,port,canary):
 bridge=TcpBridge(('127.0.0.1',9000),Bridge);threading.Thread(target=bridge.serve_forever,daemon=True).start()
 if mode=='fixture':
  result={}
  try:pathlib.Path(canary).read_bytes();result['hostReadDenied']=False
  except OSError:result['hostReadDenied']=True
  try:pathlib.Path('/runtime/fixture-write').write_text('FICTIONAL');result['runtimeWriteDenied']=False
  except OSError:result['runtimeWriteDenied']=True
  try:s=socket.create_connection(('127.0.0.1',int(port)),1);s.close();result['hostLoopbackDenied']=False
  except OSError:result['hostLoopbackDenied']=True
  s=socket.create_connection(('127.0.0.1',9000));s.sendall(b'CONNECT 169.254.169.254:443 HTTP/1.1\r\n\r\n');result['privateProxyDenied']=b'403' in s.recv(256);s.close()
  print(json.dumps(result));return 0 if all(result.values()) else 1
 env={'HOME':'/provider','CODEX_HOME':'/provider','PATH':'/usr/bin:/bin','HTTPS_PROXY':'http://127.0.0.1:9000','HTTP_PROXY':'http://127.0.0.1:9000','ALL_PROXY':'http://127.0.0.1:9000','NO_PROXY':'','LANG':'C.UTF-8'}
 args=['/runtime/bin/codex','exec','--model','gpt-6.1-sol','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--json','--dangerously-bypass-approvals-and-sandbox','-C','/work','-c','mcp_servers={}','-c','web_search="disabled"']
 for feature in DISABLED:args+=['-c','features.'+feature+'=false']
 args+=['-']
 return subprocess.run(args,env=env,timeout=150).returncode

def main():
 if len(sys.argv)==5 and sys.argv[1]=='--inner':return inner(sys.argv[2],sys.argv[3],sys.argv[4])
 if len(sys.argv)!=2 or sys.argv[1] not in ['--fixture','--review']:raise SystemExit('fixed mode required')
 mode=sys.argv[1][2:]
 for file,expected in [(BWRAP,BWRAP_SHA),(CLI_ROOT+'/bin/codex',CLI_SHA)]:
  if hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest()!=expected:raise SystemExit('runtime pin mismatch')
 directory=tempfile.mkdtemp(prefix='uain-provider-fence-');server=None;listener=None
 try:
  base=pathlib.Path(directory);(base/'work').mkdir();(base/'canary').write_text('FICTIONAL CANARY ONLY');listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen();port=listener.getsockname()[1]
  server=UnixProxy(str(base/'socket'),Proxy);threading.Thread(target=server.serve_forever,daemon=True).start()
  args=['/usr/bin/aa-exec','-p','uain-codex-bwrap','--',BWRAP,'--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/etc','--ro-bind','/etc/ssl','/etc/ssl','--ro-bind',CLI_ROOT,'/runtime','--ro-bind',str(pathlib.Path(__file__).resolve()),'/fence.py','--ro-bind',str(base/'work'),'/work','--dir','/proxy','--ro-bind',str(base/'socket'),'/proxy/socket','--tmpfs','/provider']
  if mode=='review':args+=['--ro-bind',str(auth_path()),'/provider/auth.json']
  args+=['--chdir','/work','--remount-ro','/','--','/usr/bin/python3','/fence.py','--inner',mode,str(port),str(base/'canary')]
  return subprocess.run(args,timeout=165).returncode
 finally:
  if server:server.shutdown();server.server_close()
  if listener:listener.close()
  shutil.rmtree(directory)
if __name__=='__main__':raise SystemExit(main())
