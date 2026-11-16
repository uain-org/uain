#!/usr/bin/env python3
"""Content-addressed public research copies; never rewrites historical claims."""
import argparse,hashlib,http.client,io,ipaddress,json,os,re,shutil,socket,ssl,tarfile,tempfile,time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit,urljoin

def digest(path):
 value=hashlib.sha256();size=0
 with Path(path).open('rb') as source:
  while chunk:=source.read(1024*1024):value.update(chunk);size+=len(chunk)
 return value.hexdigest(),size

def checked_root(root):
 root=Path(root)
 if not root.is_absolute() or root.resolve()!=root or not root.is_dir() or root.stat().st_mode&0o077 or root.stat().st_uid!=os.geteuid():raise ValueError('private owned absolute non-symlink evidence directory required')
 return root

def retain(root,item,source):
 root=checked_root(root);sha=item['sha256'];expected=item['bytes']
 if not re.fullmatch('[a-f0-9]{64}',sha) or not isinstance(expected,int) or not 0<=expected<=8*1024**3:raise ValueError('bounded content commitment required')
 target=root/(sha+'.blob');temporary=None
 try:
  descriptor,temporary=tempfile.mkstemp(prefix='.pending-',dir=root);value=hashlib.sha256();size=0
  with os.fdopen(descriptor,'wb') as out:
   while chunk:=source.read(1024*1024):
    size+=len(chunk)
    if size>expected:raise ValueError('artifact exceeds declared bytes')
    out.write(chunk);value.update(chunk)
   out.flush();os.fsync(out.fileno())
  if (value.hexdigest(),size)!=(sha,expected):raise ValueError('artifact bytes differ from original commitment')
  try:os.link(temporary,target)
  except FileExistsError:
   if target.is_symlink() or digest(target)!=(sha,expected):raise ValueError('immutable artifact store differs')
  directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:
  if temporary:Path(temporary).unlink(missing_ok=True)
 return target

def verify(root,items):
 root=checked_root(root);available=[];missing=[]
 for item in items:
  path=root/(item['sha256']+'.blob')
  if not path.exists():missing.append(item['sha256']);continue
  if path.is_symlink() or not path.is_file() or digest(path)!=(item['sha256'],item['bytes']):raise ValueError('stored public artifact commitment differs')
  available.append(item)
 return {'available':len(available),'bytes':sum(i['bytes'] for i in available),'missing':missing,'verified':available}

def public_target(uri):
 if not isinstance(uri,str) or any(ord(c)<=32 for c in uri):raise ValueError('literal public HTTPS artifact URI required')
 u=urlsplit(uri)
 if u.scheme!='https' or not u.hostname or u.username or u.password or u.fragment or u.port not in (None,443):raise ValueError('public HTTPS artifact origin required')
 try:address=ipaddress.ip_address(u.hostname)
 except ValueError:
  if re.fullmatch('[0-9.:]+',u.hostname):raise ValueError('public artifact address required')
 else:
  if not address.is_global:raise ValueError('public artifact address required')
 return u

def retrieve(uri):
 for redirect in range(6):
  u=public_target(uri);addresses=[r[4][0] for r in socket.getaddrinfo(u.hostname,443,type=socket.SOCK_STREAM)]
  if not addresses or any(not ipaddress.ip_address(v).is_global for v in addresses):raise ValueError('public artifact address required')
  connection=http.client.HTTPSConnection(u.hostname,timeout=90,context=ssl.create_default_context())
  connection._create_connection=lambda address,timeout,source_address=None:socket.create_connection((addresses[0],443),timeout,source_address)
  connection.request('GET',u.path+('?' +u.query if u.query else ''),headers={'User-Agent':'UAIN-public-evidence-retention/1','Accept-Encoding':'identity'})
  response=connection.getresponse()
  if response.status in (301,302,303,307,308):
   location=response.getheader('Location');response.close();connection.close()
   if not location:raise ValueError('artifact redirect absent')
   uri=urljoin(uri,location);continue
  if response.status!=200:response.close();connection.close();raise ValueError('artifact public response unavailable')
  return response,connection
 raise ValueError('artifact redirect bound exceeded')

def immutable_json(path,value):
 data=(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n').encode()
 try:
  with Path(path).open('xb') as out:os.chmod(path,0o600);out.write(data);out.flush();os.fsync(out.fileno())
 except FileExistsError:
  if Path(path).read_bytes()!=data:raise ValueError('immutable evidence metadata differs')

def capture(root,plan,skip=()):
 root=checked_root(root);immutable_json(root/'plan.json',plan)
 if any(s not in {i['sha256'] for i in plan['objects']} for s in skip):raise ValueError('skipped artifact not in reviewed plan')
 def one(item):
  existing=root/(item['sha256']+'.blob')
  if existing.exists():verify(root,[item]);return {'sha256':item['sha256'],'status':'retained','bytes':item['bytes']}
  status='unavailable'
  for reference in item['references']:
   response=connection=None
   try:response,connection=retrieve(reference['manifest']['uri']);retain(root,item,response);status='retained';break
   except Exception:pass # preserve source claims and report unavailable; never substitute new bytes
   finally:
    if response:response.close()
    if connection:connection.close()
  result={'sha256':item['sha256'],'status':status,'bytes':item['bytes']};print(json.dumps(result),flush=True);return result
 with ThreadPoolExecutor(max_workers=2) as workers:results=list(workers.map(one,[i for i in plan['objects'] if i['sha256'] not in skip]))
 census={**verify(root,plan['objects']),'source_records_root':plan['records_root'],'source_manifest_digest':plan['manifest_digest'],'results':results,'historical_unhosted_labels':len(plan['unavailable']),'captured_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
 immutable_json(root/('census-'+str(time.time_ns())+'.json'),census);return census

def recover(root,plan,directories):
 targets={i['bytes']:[] for i in plan['objects']}
 for item in plan['objects']:targets[item['bytes']].append(item)
 found=[];skip={'.codex','.claude','.ssh','.git','node_modules','auth','sessions','keys','vault','private','provider-auth'}
 forbidden={'key.json','member.json','worker.json','state.json','config.json','credentials.json','auth.json','.env'}
 for directory in directories:
  for base,dirs,files in os.walk(directory,followlinks=False):
   dirs[:]=[d for d in dirs if d not in skip and not Path(base,d).is_symlink()]
   for name in files:
    path=Path(base,name)
    if name in forbidden or re.search(r'(^|[._-])(key|keys|token|auth|secret|member|provider|config|state|worker|profile|credentials|session)([._-]|$)',name,re.I) or path.is_symlink() or path.suffix not in ('.json','.csv','.tsv','.gz','.zip'):continue
    try:
     candidates=targets.get(path.stat().st_size,[])
     if not candidates:continue
     sha,size=digest(path)
     for item in candidates:
      if sha==item['sha256']:
       with path.open('rb') as source:retain(root,item,source)
       found.append({'sha256':sha,'bytes':size,'path':str(path)})
    except (OSError,PermissionError):continue
 return {'matched':found,'examined_roots':directories}

def pack(root,target,plan):
 root=checked_root(root)
 if (root/'plan.json').is_symlink() or json.loads((root/'plan.json').read_text())!=plan:raise ValueError('stored reviewed public plan differs')
 checked=verify(root,plan['objects']);names=['plan.json']+[i['sha256']+'.blob' for i in checked['verified']]
 with open(target,'xb') as output:
  os.chmod(target,0o600)
  with tarfile.open(fileobj=output,mode='w|') as archive:
   for name in names:archive.add(root/name,arcname=name,recursive=False)
  output.flush();os.fsync(output.fileno())
 sha,size=digest(target);return {'sha256':sha,'bytes':size,'objects':checked['available'],'plan_sha256':digest(root/'plan.json')[0],'source_records_root':plan.get('records_root'),'source_manifest_digest':plan.get('manifest_digest')}

def restore(archive,root,expected,expected_plan):
 if digest(archive)[0]!=expected:raise ValueError('public evidence backup digest differs')
 root=Path(root);root.mkdir(mode=0o700,parents=False,exist_ok=False);checked_root(root)
 with tarfile.open(archive,'r:') as source:
  for member in source:
   if not member.isfile() or not re.fullmatch(r'(plan\.json|[a-f0-9]{64}\.blob)',member.name) or member.size>(16*1024**2 if member.name=='plan.json' else 8*1024**3):raise ValueError('unexpected public evidence backup member')
   stream=source.extractfile(member)
   with (root/member.name).open('xb') as output:os.chmod(root/member.name,0o600);shutil.copyfileobj(stream,output,1024*1024)
 if digest(root/'plan.json')[0]!=expected_plan:raise ValueError('restored reviewed public plan differs')
 plan=json.loads((root/'plan.json').read_text())
 permitted={'plan.json',*(item['sha256']+'.blob' for item in plan['objects'])}
 if any(path.name not in permitted for path in root.iterdir()):raise ValueError('unmanifested public evidence backup blob')
 return verify(root,plan['objects'])

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['capture','verify','recover','pack','restore']);parser.add_argument('--root',required=True);parser.add_argument('--plan');parser.add_argument('--plan-sha256');parser.add_argument('--archive');parser.add_argument('--archive-sha256');parser.add_argument('--search',action='append',default=[]);parser.add_argument('--skip-sha256',action='append',default=[]);args=parser.parse_args()
 plan=None
 if args.action!='restore':
  if not args.plan or digest(args.plan)[0]!=args.plan_sha256:raise ValueError('exact reviewed public plan digest required')
  plan=json.loads(Path(args.plan).read_text())
 if args.action=='capture':result=capture(args.root,plan,args.skip_sha256)
 elif args.action=='verify':result=verify(args.root,plan['objects'])
 elif args.action=='recover':result=recover(args.root,plan,args.search)
 elif args.action=='pack':result=pack(args.root,args.archive,plan)
 else:result=restore(args.archive,args.root,args.archive_sha256,args.plan_sha256)
 print(json.dumps(result,sort_keys=True))
