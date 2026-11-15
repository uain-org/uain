"""Private CPU embedding endpoint. Submitted content never leaves the owned host."""
import hashlib
import hmac
import json
import os
import socket
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore, Lock, Timer

MODEL = 'bge-small-en-v1.5:aa8f8b060edb00e03bfdd08813a2949946c8ba55:chunks-v1'
REVISION = 'aa8f8b060edb00e03bfdd08813a2949946c8ba55'
REPOSITORY = 'Qdrant/bge-small-en-v1.5-onnx-Q'

def load_model(directory):
    from fastembed import TextEmbedding
    from tokenizers import Tokenizer
    from numpy import mean
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest['revision'] != REVISION:
        raise RuntimeError('Unexpected model revision')
    for name, digest in manifest['sha256'].items():
        if Path(name).name != name or hashlib.sha256((directory/name).read_bytes()).hexdigest() != digest:
            raise RuntimeError('Model file integrity check failed')
    model = TextEmbedding(model_name='BAAI/bge-small-en-v1.5',threads=2,
                          providers=['CPUExecutionProvider'],specific_model_path=str(directory))
    tokenizer = Tokenizer.from_file(str(directory/'tokenizer.json'))
    tokenizer.no_truncation()
    def encode(texts,kind):
        result = []
        for text in texts:
            ids = tokenizer.encode(text,add_special_tokens=False).ids
            pieces = [tokenizer.decode(ids[i:i+384]) for i in range(0,len(ids),384)] or [text]
            # bge retrieval query instruction is part of this pinned embedding space.
            if kind == 'query':
                pieces = ['Represent this sentence for searching relevant passages: '+p for p in pieces]
            vectors = list(model.embed(pieces,batch_size=8))
            v = mean(vectors,axis=0)
            norm = float((v*v).sum()**0.5)
            if not norm:
                raise RuntimeError('Empty embedding')
            result.append((v/norm).tolist())
        return result
    return encode

class Server(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self,address,encode,token,request_deadline=10):
        # SV-5 (13 November 2026): the 15 s timeout applies to each receive, so a client that sends one
        # byte at a time held a slot for ever, and eight such clients blocked the server. Each connection
        # now has a deadline for its whole request (headers and body); past it the socket is shut down.
        self.request_deadline = request_deadline
        self.deadlines = {}
        self.deadlines_lock = Lock()
        self.slots = BoundedSemaphore(8)
        self.inference = Lock()
        self.encode = encode
        self.token = token
        super().__init__(address,Handler)
    def process_request(self,request,address):
        request.settimeout(15)
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        timer = Timer(self.request_deadline,self.cut,(request,))
        timer.daemon = True
        with self.deadlines_lock:
            self.deadlines[request] = timer
        timer.start()
        try:
            super().process_request(request,address)
        except BaseException:
            self.stop_deadline(request)
            self.slots.release()
            raise
    @staticmethod
    def cut(request):
        try:
            request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    def stop_deadline(self,request):
        with self.deadlines_lock:
            timer = self.deadlines.pop(request,None)
        if timer is not None:
            timer.cancel()
    def process_request_thread(self,request,address):
        try:
            super().process_request_thread(request,address)
        finally:
            self.stop_deadline(request)
            self.slots.release()

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass  # No request content or bearer tokens in logs.
    def reply(self,status,value):
        data = json.dumps(value,separators=(',',':'),allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.server.stop_deadline(self.request)  # The request is fully read.
        self.reply(200 if self.path=='/health' else 404,{'model':MODEL,'ok':self.path=='/health'})
    def do_POST(self):
        if self.path != '/embed':
            return self.reply(404,{'error':'not_found'})
        if not hmac.compare_digest(self.headers.get('Authorization',''),f'Bearer {self.server.token}'):
            return self.reply(401,{'error':'unauthorized'})
        try:
            length = int(self.headers.get('Content-Length','0'))
            if not 0 < length <= 64_000:
                return self.reply(413,{'error':'body_size'})
            raw = self.rfile.read(length)
            self.server.stop_deadline(self.request)  # The request is fully read; inference has its own wait bound.
            body = json.loads(raw)
            texts = body.get('texts')
            if body.get('model') != MODEL or body.get('kind') not in ('query','passage'):
                return self.reply(400,{'error':'model_or_kind'})
            if not isinstance(texts,list) or not 1 <= len(texts) <= 8 or any(
                not isinstance(t,str) or not t.strip() or len(t)>1500 for t in texts):
                return self.reply(400,{'error':'text_batch'})
            if not self.server.inference.acquire(timeout=5):
                return self.reply(503,{'error':'busy'})
            try:
                vectors = self.server.encode(texts,body['kind'])
            finally:
                self.server.inference.release()
            return self.reply(200,{'model':MODEL,'vectors':vectors})
        except (ValueError,TypeError,AttributeError):
            return self.reply(400,{'error':'invalid_json'})
        except Exception:
            return self.reply(503,{'error':'embedding_failed'})

if __name__ == '__main__':
    directory = Path(os.environ['UAIN_MODEL_DIR'])
    token = Path(os.environ['UAIN_EMBEDDING_TOKEN_FILE']).read_text().strip()
    if len(token)<32:
        raise RuntimeError('Embedding token is too short')
    server = Server((os.environ.get('UAIN_EMBEDDING_BIND','127.0.0.1'),int(os.environ.get('UAIN_EMBEDDING_PORT','8073'))),load_model(directory),token)
    server.serve_forever()
