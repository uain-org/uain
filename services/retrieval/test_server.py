import json
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from embedding_server import Server,MODEL

class EndpointTest(unittest.TestCase):
    def setUp(self):
        self.server = Server(('127.0.0.1',0),lambda texts,kind:[[1.0]+[0.0]*383 for t in texts],'x'*40)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def call(self,body,token='x'*40):
        req = urllib.request.Request(f'http://127.0.0.1:{self.server.server_port}/embed',json.dumps(body).encode(),{'Authorization':'Bearer '+token})
        try:
            with urllib.request.urlopen(req) as r: return r.status,json.load(r)
        except urllib.error.HTTPError as r: return r.code,json.load(r)
    def test_contract_and_auth(self):
        body={'texts':['research'],'kind':'passage','model':MODEL}
        code,value=self.call(body); self.assertEqual(code,200); self.assertEqual(len(value['vectors'][0]),384)
        self.assertEqual(self.call(body,'bad')[0],401)
        self.assertEqual(self.call({**body,'texts':['x']*9})[0],400)
        self.assertEqual(self.call({**body,'model':'other'})[0],400)
        self.assertEqual(self.call({**body,'texts':['x'*1501]})[0],400)

class SlowClientTest(unittest.TestCase):
    """SV-5 (13 November 2026): eight clients that dribble a request forever used to hold all eight slots."""
    def setUp(self):
        self.server = Server(('127.0.0.1',0),lambda texts,kind:[[1.0]+[0.0]*383 for t in texts],'x'*40,request_deadline=1)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.stop = threading.Event()
    def tearDown(self):
        self.stop.set()
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def dribble(self,sock):
        try:
            sock.sendall(b'GET /health HTTP/1.1\r\n')
            while not self.stop.wait(0.2):
                sock.sendall(b'X')
        except OSError:
            pass
        finally:
            sock.close()
    def test_slow_clients_cannot_hold_every_slot(self):
        for _ in range(8):
            sock = socket.create_connection(('127.0.0.1',self.server.server_port))
            threading.Thread(target=self.dribble,args=(sock,),daemon=True).start()
        time.sleep(0.3)
        deadline = time.monotonic()+4
        status = None
        while time.monotonic() < deadline and status != 200:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.server.server_port}/health',timeout=2) as r:
                    status = r.status
            except (urllib.error.URLError,ConnectionError,OSError):
                time.sleep(0.2)
        self.assertEqual(status,200)

if __name__=='__main__': unittest.main()
