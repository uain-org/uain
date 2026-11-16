"""Closed-purpose holder release custody helper. Source only until operator installs.

Run with the custody virtualenv as root. Never exports private material. The
approval file, all input ancestors and files must be root-owned and immutable to
other users. No generic signing operation is exposed.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tarfile
import time
import native_migration as native

ROOT=Path('/var/lib/uain-custody/holder-release')
LOCK=Path('/run/lock/uain-custody.lock')
UID=0
KEY='keys/baink-holder-release.json'
RELEASE_PUBLIC='XlRwnWHiN9FuiXUD8Q2gwSlEKLNhetU42uRKQbRuAZs'
PINS={'chainId':'uain-shadow-20261008-1','genesisSha256':'54140a9243c4591ccc9f2e9d49543fc68b87b3e0045416174c232e9dd498f8ff','reviewer':'uain17fae025e2b7492156d438712aab8efcb4113b0fd','relay':'uain1215c651b70db82b70532a496c26fdf424f3bb369','reviewPublicKey':'imXvi5XRE9i3LNfAFfagRPz0F0Dl0tB1rfArCEUYgJ0','reviewEndpoint':'https://baink.money/api/native/review'}
TOOLS={'uaind':'1604415b7302bf70236d50e6c999b7ab95d3029da697090f6bac08cddaee91a6','uain-state':'136698192e9e38323a552f1e2da2eea5b9b90e3d6e7de11116d72ee28c826860','uain-private-state':'45ffaaf1e85cb3d30e01f8ef8c38b75fa6ecb0169f9ecda9a3b22b7ae6286ddb','uain-peer-tunnel':'8f7d10bc016cccadb5df4a3a0e5945e7158232d6c9eb63fa5cb5e3b2f5768242','uain-coin-wallet':'f3fd242f79c44b06b431a57ed94005e80a55f372d92c0c93d7a4bef9601db986','uain-private-wallet':'b0a3b9ebc22ae09d99a770c4f070b114d4c4fa6730c7b99e4ba3dccce8fc3584','uain-wallet-addresses':'19f9c807902519e8eed0e22ed3d3bb2137c7d7819b1c7311ca9e23ec066bbc94','uain-note-inspect':'d252631b28e98b20937e9572481d7afc437e1f9bc8355a72ca0da8c6f8b64147','uain-note-source':'fe175eeef2b27ce945f2367d67154393ac3559c671089b9cfad2f85d8ac65c78'}
HEX=re.compile(r'^[a-f0-9]{64}$')
PROFILE={'schema','expectedVaultSha256','manifestPath','manifestSha256','artifactsDirectory','bootstrapPath','bootstrapSha256','installerDirectory','installerFiles','installerInventorySha256','installerEntry','installerBaseURL','releaseBaseURL','minimumSequence','issuedAt','expiresAt'}

def require(ok):
 if not ok: raise ValueError('Holder release approval refused')
def sha(b):return hashlib.sha256(b).hexdigest()
def canonical(v):return native.canonical(v).encode('utf-8')
def b64(b):return base64.urlsafe_b64encode(b).decode().rstrip('=')
def integer(x):return type(x)==int and 0<=x<=9007199254740991

def trusted(path,directory=False):
 p=Path(path);require(p.is_absolute());target=p.lstat()
 for x in [p,*p.parents]:
  s=x.lstat();require(s.st_uid==UID and not s.st_mode&0o022 and not stat.S_ISLNK(s.st_mode))
  if x!=p or directory:require(stat.S_ISDIR(s.st_mode))
 if not directory:require(stat.S_ISREG(target.st_mode) and target.st_nlink==1)
 return p

def read(path,limit=1048576):
 p=trusted(path);fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(fd);require(s.st_uid==UID and not s.st_mode&0o022 and s.st_nlink==1 and stat.S_ISREG(s.st_mode) and s.st_size<=limit)
  with os.fdopen(fd,'rb',closefd=False) as f:data=f.read(limit+1)
  require(len(data)==s.st_size and len(data)<=limit);return data
 finally:os.close(fd)

def write(path,data):
 p=Path(path);trusted(p.parent,True);tmp=p.with_name(p.name+'.pending')
 # T4: a crash after the pending write left identical bytes: adopt them; refuse others.
 if not native.adopt_pending(tmp,data):
  fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  try:
   with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush();os.fsync(fd)
  finally:os.close(fd)
 os.replace(tmp,p)
 fd=os.open(p.parent,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(fd)
 finally:os.close(fd)

@contextlib.contextmanager
def locked():
 require(os.geteuid()==UID)
 fd=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
 try:
  s=os.fstat(fd);require(s.st_uid==UID and stat.S_ISREG(s.st_mode) and s.st_nlink==1 and not s.st_mode&0o022)
  fcntl.flock(fd,fcntl.LOCK_EX)
  ROOT.mkdir(mode=0o700,parents=True,exist_ok=True);trusted(ROOT,True)
  yield
 finally:os.close(fd)

def keypair(raw,expected=None):
 k=native.strict_json(raw);require(type(k)==dict and isinstance(k.get('private_key'),str) and re.fullmatch(r'[A-Za-z0-9_-]{43}',k['private_key']))
 seed=base64.urlsafe_b64decode(k['private_key']+'=');require(b64(seed)==k['private_key'])
 pub,sign=native.ed25519(seed);require(b64(pub)==k.get('public_key') and (expected is None or expected==b64(pub)))
 return b64(pub),sign

def current(c):
 raw=read(c.VAULT,64*1024*1024);kp=c.vault();c.verify_vault(kp)
 return sha(raw),kp,{r['name']:c.attachment(kp,r['name']) for r in c.records(kp)}

def backup_proof(c,vault_sha):
 # backup() itself authenticates both independent offsite readbacks. Bind its
 # durable receipt to the exact ciphertext, never merely to a recent timestamp.
 with contextlib.redirect_stdout(io.StringIO()):c.backup()
 receipt=read(c.ROOT/'last-backup.json');r=native.strict_json(receipt)
 require(r.get('spaces','').startswith('s3://uain/custody/') and r.get('database','').startswith('10.98.0.2:/var/backups/uain-custody/') and r.get('readback')=='byte-identical, authenticated vault and every attachment verified')
 name=r.get('backup');require(isinstance(name,str) and re.fullmatch(r'uain-custody-[0-9TZ]+\.tar',name))
 package=read(c.ROOT/'backups'/name,128*1024*1024);require(sha(package)==r.get('sha256'))
 with tarfile.open(fileobj=io.BytesIO(package),mode='r:') as t:
  names=t.getnames();require(len(names)==len(set(names)) and 'uain.kdbx' in names and 'manifest.json' in names)
  m=native.strict_json(t.extractfile('manifest.json').read());encrypted=t.extractfile('uain.kdbx').read()
  require(sha(encrypted)==vault_sha and m['sha256']['uain.kdbx']==vault_sha)
 require(sha(read(c.VAULT,64*1024*1024))==vault_sha)
 return sha(receipt)

def provision(c,expected):
 require(isinstance(expected,str) and HEX.fullmatch(expected))
 with locked():
  digest,kp,files=current(c);require(digest==expected)
  if KEY not in files:
   # Keep an encrypted local pre-mutation copy; plaintext exists only in RAM.
   snapshot=ROOT/('before-'+digest+'.kdbx')
   if snapshot.exists():require(sha(read(snapshot,64*1024*1024))==digest)
   else:write(snapshot,read(c.VAULT,64*1024*1024))
   seed=secrets.token_bytes(32);pub,_=native.ed25519(seed)
   files[KEY]=canonical({'schema':'baink-holder-release-key-v1','public_key':b64(pub),'private_key':b64(seed),'created_at':int(time.time()*1000)})
   require(sha(read(c.VAULT,64*1024*1024))==digest)
   with contextlib.redirect_stdout(io.StringIO()):c.save_vault(files)
   # save_vault performs authenticated atomic replacement; fsync the result.
   fd=os.open(c.VAULT,os.O_RDONLY|os.O_NOFOLLOW)
   try:os.fsync(fd)
   finally:os.close(fd)
   fd=os.open(c.VAULT.parent,os.O_RDONLY|os.O_DIRECTORY)
   try:os.fsync(fd)
   finally:os.close(fd)
   digest,kp,actual=current(c);require(actual==files)
  pub,_=keypair(files[KEY]);proof=backup_proof(c,digest)
  write(ROOT/'provision.json',canonical({'vaultSha256':digest,'keySha256':sha(files[KEY]),'backupReceiptSha256':proof,'publicKey':pub}))
  return {'publicKey':pub}

def path_name(v):
 require(isinstance(v,str) and len(v)<=200 and not v.startswith('/') and all(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*',s) for s in v.split('/')))
 require(not any(s.lower() in {'keys','wallet','state','secrets'} or s.lower().endswith(('.key','.pem','.pk8','.seed')) for s in v.split('/')))
 return v

def inventory(items,root):
 require(type(items)==list and 1<=len(items)<=512);trusted(root,True);seen=set();total=0
 for f in items:
  require(type(f)==dict and set(f)=={'path','sha256','size'});name=path_name(f['path']);require(name not in seen);seen.add(name)
  require(isinstance(f['sha256'],str) and HEX.fullmatch(f['sha256']) and integer(f['size']) and 0<f['size']<=268435456)
  data=read(Path(root)/name,268435456);require(len(data)==f['size'] and sha(data)==f['sha256']);total+=len(data)
 require(total<=1073741824)
 actual=set()
 for folder,dirs,files in os.walk(root,followlinks=False):
  trusted(folder,True)
  for d in dirs:trusted(Path(folder)/d,True)
  for f in files:actual.add(str((Path(folder)/f).relative_to(root)))
 require(actual==seen)
 return {f['path']:f['sha256'] for f in items}

def time_window(issued,expires,maximum):
 now=int(time.time()*1000);require(integer(issued) and integer(expires) and issued<=now<expires and expires-issued<=maximum)

def installer_scope(base,sequence=None):
 # Exact legacy origin/path remains valid. No URL parser normalization, aliases,
 # credentials, query strings, fragments, ports or relative paths are accepted.
 if base=='https://baink.money/wallet/installer/':return True
 if type(base)!=str:return False
 match=re.fullmatch(r'https://baink\.money/wallet/installers/([1-9][0-9]{0,15})-[a-f0-9]{40}/',base)
 return bool(match and integer(int(match[1])) and (sequence is None or int(match[1])==sequence))

def validate(profile_path):
 raw=read(profile_path);p=native.strict_json(raw);require(type(p)==dict and set(p)==PROFILE and p['schema']=='baink-holder-release-approval-v1')
 time_window(p['issuedAt'],p['expiresAt'],365*86400000)
 require(integer(p['minimumSequence']) and isinstance(p['expectedVaultSha256'],str) and HEX.fullmatch(p['expectedVaultSha256']))
 require(p['releaseBaseURL']=='https://baink.money/wallet/releases/' and installer_scope(p['installerBaseURL']))
 manifest_raw=read(p['manifestPath']);require(sha(manifest_raw)==p['manifestSha256']);m=native.strict_json(manifest_raw)
 require(type(m)==dict and set(m)=={'schema','sequence','issuedAt','expiresAt','platform','image','pins','files'} and m['schema']=='baink-holder-release-v1')
 require(integer(m['sequence']) and p['minimumSequence']<m['sequence']<=p['minimumSequence']+1000000)
 require(installer_scope(p['installerBaseURL'],m['sequence']))
 if p['installerBaseURL']!='https://baink.money/wallet/installer/':
  require(m['sequence']==p['minimumSequence']+1 and p['installerEntry']=='cli.mjs')
  require(type(p['installerFiles'])==list and len(p['installerFiles'])==5 and all(type(f)==dict for f in p['installerFiles'])
          and all(type(f.get('path'))==str for f in p['installerFiles'])
          and sorted(f['path'] for f in p['installerFiles'])==['application.mjs','cli.mjs','filesystem.mjs','module-references.mjs','release.mjs'])
 time_window(m['issuedAt'],m['expiresAt'],31*86400000)
 require(m['platform']=='linux/amd64' and type(m['image'])==str and re.fullmatch(r'baink\.money/baink-holder@sha256:[a-f0-9]{64}',m['image']) and m['pins']==PINS)
 hashes=inventory(m['files'],p['artifactsDirectory'])
 for name,digest in TOOLS.items():require(hashes.get('tools/'+name)==digest)
 require(hashes.get('tools/native-admission-genesis.json')==PINS['genesisSha256'])
 require(sha(canonical(p['installerFiles']))==p['installerInventorySha256']);installer=inventory(p['installerFiles'],p['installerDirectory'])
 require(path_name(p['installerEntry']) in installer)
 bootstrap=read(p['bootstrapPath']);require(sha(bootstrap)==p['bootstrapSha256'])
 text=bootstrap.decode('utf-8');require(text.lstrip().startswith(('#!/usr/bin/env node','//','/*','import ','const ')) and '\x00' not in text)
 return raw,p,manifest_raw,m,bootstrap

def sign_public_bundle(c,profile_path):
 with locked():
  raw,p,manifest_raw,m,bootstrap=validate(profile_path)
  digest,kp,files=current(c);require(digest==p['expectedVaultSha256'])
  proof=native.strict_json(read(ROOT/'provision.json'))
  require(proof['vaultSha256']==digest and proof['keySha256']==sha(files[KEY]) and proof['backupReceiptSha256']==sha(read(c.ROOT/'last-backup.json')))
  pub,sign=keypair(files[KEY]);require(pub==proof['publicKey'])
  _,release_sign=keypair(files['keys/release-key.json'],RELEASE_PUBLIC)
  journal=ROOT/'signed.json';previous=native.strict_json(read(journal)) if journal.exists() else None
  if previous:
   require(m['sequence']>=previous['sequence'])
   if m['sequence']==previous['sequence']:require(sha(manifest_raw)==previous['manifestSha256'] and sha(raw)==previous['profileSha256'])
  # Repeat every authorization and artifact read immediately before signing.
  require(validate(profile_path)==(raw,p,manifest_raw,m,bootstrap) and sha(read(c.VAULT,64*1024*1024))==digest)
  payload={'schema':'baink-holder-release-authority-v1','holderPublicKey':pub,'pins':PINS,'minimumSequence':p['minimumSequence'],'releaseBaseURL':p['releaseBaseURL'],'installerFiles':p['installerFiles'],'installerEntry':p['installerEntry'],'installerBaseURL':p['installerBaseURL'],'issuedAt':p['issuedAt'],'expiresAt':p['expiresAt']}
  result={'manifestSignature':b64(sign(manifest_raw)),'authority':{'payload':payload,'signature':b64(release_sign(b'UAIN/holder-release-authority/v1\n'+canonical(payload)))},'bootstrapSignature':b64(release_sign(bootstrap))}
  write(journal,canonical({'sequence':m['sequence'],'manifestSha256':sha(manifest_raw),'profileSha256':sha(raw)}))
  return result

def main():
 parser=argparse.ArgumentParser(description=__doc__);sub=parser.add_subparsers(dest='command',required=True)
 sub.add_parser('provision').add_argument('--expected-vault-sha256',required=True)
 sub.add_parser('sign-public-bundle').add_argument('--profile',required=True)
 args=parser.parse_args();import custody
 result=provision(custody,args.expected_vault_sha256) if args.command=='provision' else sign_public_bundle(custody,args.profile)
 print(json.dumps(result,separators=(',',':')))
if __name__=='__main__':main()
