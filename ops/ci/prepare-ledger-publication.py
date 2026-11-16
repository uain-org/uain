#!/usr/bin/python3 -I
"""Prepare one public signed root inside the credential-free CI container.

Reuse the trusted export validator. No dependency install, compiler, token or
anchor transaction is needed. The root-installed launcher rechecks the output.
"""
import importlib.util,json,os,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('public_root_validator',Path(__file__).with_name('launcher.py'))
validator=importlib.util.module_from_spec(spec);spec.loader.exec_module(validator)
FIELDS=('date','root','head','count','first_id','last_id','provisional','signature')

def prepare(raw,date):
 if len(raw)>4096:raise ValueError('Public root exceeds bound')
 def unique(pairs):
  value={}
  for key,item in pairs:
   if key in value:raise ValueError('Duplicate root field refused')
   value[key]=item
  return value
 def reject(_):raise ValueError('Inexact root number refused')
 try:value=json.loads(raw,object_pairs_hook=unique,parse_constant=reject,parse_float=reject)
 except (UnicodeError,json.JSONDecodeError):raise ValueError('Invalid public root JSON') from None
 if type(value)!=dict or set(value) not in (set(FIELDS),set(FIELDS)|{'computed_at'}):raise ValueError('Exact signed root fields required')
 if 'computed_at' in value and (type(value['computed_at'])!=str or len(value['computed_at'])>64):raise ValueError('Bounded computation metadata required')
 canonical=(json.dumps({key:value[key] for key in FIELDS},indent=2)+'\n').encode()
 return validator.validate_publication(canonical,date)

def main():
 if len(sys.argv)!=4:raise ValueError('Exact date, input and output required')
 date,source,directory=sys.argv[1:];validator.publication_date(date)
 with open(source,'rb') as file:raw=file.read(4097)
 data=prepare(raw,date);out=Path(directory);out.mkdir(mode=0o700,parents=True,exist_ok=True)
 if out.is_symlink():raise ValueError('Output link refused')
 fd=os.open(out/(date+'.json'),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'wb') as file:file.write(data);file.flush();os.fsync(file.fileno())
if __name__=='__main__':main()
