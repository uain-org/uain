"""Resource-limited server qualification with the actual pinned model."""
import json
import sys
import time
from pathlib import Path
from embedding_server import load_model,MODEL
start=time.monotonic()
encode=load_model(Path(sys.argv[1]))
passages=['Enzymes repair damaged protein structures and restore their folding.',
          'Potato agriculture improves crop yields by controlling soil moisture.',
          'An aircraft wing uses aerodynamic lift to sustain flight.']
vectors=encode(passages,'passage')
q=encode(['Restoring broken proteins'],'query')[0]
scores=[sum(a*b for a,b in zip(q,v)) for v in vectors]
assert len(vectors)==3 and all(len(v)==384 for v in vectors)
assert scores[0]>scores[1] and scores[0]>scores[2],scores
long=encode(['protein '*180],'passage')[0]
assert len(long)==384 and abs(sum(v*v for v in long)-1)<0.001
print(json.dumps({'model':MODEL,'dimensions':384,'scores':scores,'seconds':round(time.monotonic()-start,3),'offline':True,'long_input':True}))
