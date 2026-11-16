"""Streaming authenticated reset archives. Never release unauthenticated bytes."""
import hashlib
import os
import struct
from pathlib import Path
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

MAGIC = b'UAINRESET01'
CHUNK = 1024*1024
LIMIT = 64*1024**3

def key_bytes(value):
    if len(value)!=64:
        raise ValueError('Invalid archive key')
    result=bytes.fromhex(value)
    if len(result)!=32: raise ValueError('Invalid archive key')
    return result

def seal(source,path,key):
    path=Path(path)
    iv=os.urandom(12)
    cipher=Cipher(algorithms.AES(key_bytes(key)),modes.GCM(iv)).encryptor()
    cipher.authenticate_additional_data(MAGIC)
    sha=hashlib.sha256();size=0
    with path.open('xb') as output:
        os.chmod(path,0o600)
        output.write(MAGIC+iv)
        while data:=source.read(CHUNK):
            size+=len(data)
            if size>LIMIT: raise ValueError('Reset archive too large')
            sha.update(data);output.write(cipher.update(data))
        output.write(cipher.finalize());output.write(cipher.tag)
        output.flush();os.fsync(output.fileno())
    receipt=verify(path,key)
    if receipt['plaintext_sha256']!=sha.hexdigest() or receipt['plaintext_bytes']!=size:
        raise ValueError('Archive readback differs')
    return receipt

def _decrypt(stream,key,sink=None):
    size=os.fstat(stream.fileno()).st_size
    header=stream.read(len(MAGIC)+12)
    if size<len(MAGIC)+12+16 or size>LIMIT+len(MAGIC)+28 or not header.startswith(MAGIC):
        raise ValueError('Invalid reset archive')
    stream.seek(-16,2);tag=stream.read(16)
    cipher=Cipher(algorithms.AES(key_bytes(key)),modes.GCM(header[len(MAGIC):],tag)).decryptor()
    cipher.authenticate_additional_data(MAGIC)
    stream.seek(len(header));remaining=size-len(header)-16;sha=hashlib.sha256();plain_size=0
    while remaining:
        data=stream.read(min(CHUNK,remaining))
        if not data: raise ValueError('Truncated reset archive')
        remaining-=len(data);plain=cipher.update(data);sha.update(plain);plain_size+=len(plain)
        if sink:sink.write(plain)
    final=cipher.finalize();sha.update(final);plain_size+=len(final)
    if sink:sink.write(final)
    return {'plaintext_sha256':sha.hexdigest(),'plaintext_bytes':plain_size}

def verify(path,key):
    with Path(path).open('rb') as stream:
        receipt=_decrypt(stream,key)
        stream.seek(0);sha=hashlib.sha256()
        while data:=stream.read(CHUNK):sha.update(data)
    return {**receipt,'ciphertext_sha256':sha.hexdigest(),'ciphertext_bytes':Path(path).stat().st_size}

def open_verified(path,key,sink):
    # Hold the same descriptor across authentication and replay. Archives are
    # root-owned immutable files; consumers receive nothing on a bad tag/key.
    with Path(path).open('rb') as stream:
        receipt=_decrypt(stream,key)
        stream.seek(0)
        replay=_decrypt(stream,key,sink)
        if receipt!=replay:raise ValueError('Archive changed during replay')
    return receipt

def unpack(path,key,directory):
    """Validate every tar member before extracting into a new private directory."""
    import subprocess
    import tarfile
    import threading
    from pathlib import PurePosixPath
    verify(path,key)
    # Anonymous kernel pipe, bounded by its reader. Nothing plaintext on disk.
    reader,writer=os.pipe();errors=[]
    def feed():
        try:
            with os.fdopen(writer,'wb') as stream:open_verified(path,key,stream)
        except Exception as error:errors.append(type(error).__name__)
    thread=threading.Thread(target=feed);thread.start()
    try:
        with os.fdopen(reader,'rb') as stream,tarfile.open(fileobj=stream,mode='r|gz') as tar:
            total=0;count=0
            for member in tar:
                total+=member.size;count+=1
                if total>LIMIT or count>1_000_000:raise ValueError('Expanded archive too large')
                p=PurePosixPath(member.name)
                if p.is_absolute() or '..' in p.parts or not(member.isfile() or member.isdir()):
                    raise ValueError('Unsafe archive member')
    finally:thread.join()
    if errors:raise ValueError('Archive validation failed')
    directory=Path(directory);directory.mkdir(mode=0o700)
    process=subprocess.Popen(['tar','-xzpf','-','--no-same-owner','-C',str(directory)],stdin=subprocess.PIPE,stderr=subprocess.DEVNULL)
    try:
        open_verified(path,key,process.stdin);process.stdin.close()
        if process.wait()!=0:raise ValueError('Archive extraction failed')
    except Exception:
        process.kill();process.wait();raise
