import io
import tempfile
import unittest
from pathlib import Path
import tarfile
from archive import seal,verify,open_verified,unpack
class ArchiveTest(unittest.TestCase):
    def test_roundtrip_and_no_unauthenticated_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'archive';key='ab'*32;data=b'fixture secret'*120000
            receipt=seal(io.BytesIO(data),path,key)
            self.assertEqual(receipt['plaintext_bytes'],len(data))
            self.assertNotIn(b'fixture secret',path.read_bytes())
            output=io.BytesIO();open_verified(path,key,output);self.assertEqual(output.getvalue(),data)
            with self.assertRaises(FileExistsError):seal(io.BytesIO(data),path,key)
            output=io.BytesIO()
            with self.assertRaises(Exception):open_verified(path,'cd'*32,output)
            self.assertEqual(output.getvalue(),b'')
            mutated=bytearray(path.read_bytes());mutated[100]^=1;path.write_bytes(mutated)
            with self.assertRaises(Exception):open_verified(path,key,output)
            self.assertEqual(output.getvalue(),b'')
    def test_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'bad';path.write_bytes(b'UAINRESET01'+b'0'*20)
            with self.assertRaises(Exception):verify(path,'ab'*32)
    def test_authenticated_traversal_is_refused_before_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w:gz') as tar:
                info=tarfile.TarInfo('../escape');info.size=3;tar.addfile(info,io.BytesIO(b'bad'))
            data.seek(0);seal(data,root/'archive','ab'*32)
            with self.assertRaises(ValueError):unpack(root/'archive','ab'*32,root/'out')
            self.assertFalse((root/'out').exists());self.assertFalse((root/'escape').exists())
    def test_safe_envelope_restores_exact_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);data=io.BytesIO()
            with tarfile.open(fileobj=data,mode='w:gz') as tar:
                info=tarfile.TarInfo('node/state');info.size=7;tar.addfile(info,io.BytesIO(b'fixture'))
            data.seek(0);seal(data,root/'archive','ab'*32)
            unpack(root/'archive','ab'*32,root/'out')
            self.assertEqual((root/'out/node/state').read_bytes(),b'fixture')
if __name__=='__main__':unittest.main()
