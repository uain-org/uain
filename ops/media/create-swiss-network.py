# Vector paths and analytical light layers composited onto the generated film.
# Bern / central Swiss Alps in the source composition: x=790,y=320.
import subprocess, sys, hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=Path(sys.argv[1]).resolve()
assert hashlib.sha256(source.read_bytes()).hexdigest() == 'f1d7a965640a185b50838f7b936a84d435f62d249f3d7678585c2618ccc18c5a', 'This placement is calibrated only for the selected Flow clip'
work=root/'work/media-swiss'; work.mkdir(parents=True,exist_ok=True)
hub=(790,320)
curves=[((748,276),(776,273)),((682,367),(724,308)),((1100,456),(991,269)),((1172,227),(1012,127)),((912,522),(828,395))]
filters=[]
for end,control in curves:
 # Sample quadratic curves densely for a continuous 1px vector overlay.
 for i in range(241):
  t=i/240; x=round((1-t)**2*hub[0]+2*(1-t)*t*control[0]+t*t*end[0]);y=round((1-t)**2*hub[1]+2*(1-t)*t*control[1]+t*t*end[1]);
  filters.append(f'drawbox=x={x}:y={y}:w=1:h=1:color=0xC3ECFF@0.22:t=fill:replace=1')
# Static transparent vector overlay, new artwork rather than editing a still.
subprocess.run(['ffmpeg','-y','-f','lavfi','-i','color=black@0:s=1280x720,format=rgba','-vf',','.join(filters),'-frames:v','1',str(work/'swiss-arcs.png'),'-loglevel','error'],check=True)
# A soft white-blue hub, core plus restrained atmospheric halo.
a="clip(255*exp(-((X-32)*(X-32)+(Y-32)*(Y-32))/28)+140*exp(-((X-32)*(X-32)+(Y-32)*(Y-32))/230),0,255)"
subprocess.run(['ffmpeg','-y','-f','lavfi','-i','color=black@0:s=64x64,format=rgba','-vf',f"geq=r='180+75*exp(-((X-32)*(X-32)+(Y-32)*(Y-32))/16)':g=245:b=255:a='{a}'",'-frames:v','1',str(work/'swiss-hub.png'),'-loglevel','error'],check=True)
subprocess.run(['ffmpeg','-y','-i',str(source),'-loop','1','-i',str(work/'swiss-arcs.png'),'-loop','1','-i',str(work/'swiss-hub.png'),'-filter_complex',"[0:v]delogo=x=898:y=277:w=32:h=36[earth];[earth][1:v]overlay=0:0:shortest=1[paths];[paths][2:v]overlay=758:288:shortest=1,crop=820:720:460:0,format=yuv420p[out]",'-map','[out]','-an','-t','8','-c:v','libx264','-crf','21','-preset','medium','-movflags','+faststart',str(root/'public/videos/uain-switzerland-network.mp4'),'-loglevel','error'],check=True)
subprocess.run(['ffmpeg','-y','-i',str(root/'public/videos/uain-switzerland-network.mp4'),'-ss','2','-frames:v','1',str(root/'public/images/landing/switzerland-network.webp'),'-loglevel','error'],check=True)
