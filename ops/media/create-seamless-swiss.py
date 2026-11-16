"""Export the fresh single-origin Flow film as a silent 20-second hero loop.

Usage: python3 ops/media/create-seamless-swiss.py /path/to/Flow-output.mp4
Only the reviewed fresh take is accepted. No nodes, routes or textures are
added, removed or patched. See docs/design/fresh-swiss-hero-2026-10-06.md.
"""
import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_SHA256 = 'f1e169988327e93216a42c9a30602f264be58000dc97ce367ba708762541a6f3'
if len(sys.argv) != 2:
    raise SystemExit('Usage: create-seamless-swiss.py /path/to/Flow-output.mp4')
source = Path(sys.argv[1]).resolve()
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
    raise SystemExit('Use Swiss star — fresh take E from the documented Flow scene.')

# Center crop preserves the full globe, Swiss origin and endpoints. The corner
# branding is outside this crop. The arcs already share one hub in the source.
# Blend the final second into the first second and rotate the cycle's phase.
# Slow the resulting nine-second cycle to twenty seconds, interpolate to 30fps,
# and repeat the first frame at the end for an identical decoded wrap image.
filters = (
    '[0:v]trim=end=10,setpts=PTS-STARTPTS,crop=820:720:230:0,'
    'split=2[base][h];'
    '[h]trim=0:1,setpts=PTS-STARTPTS[head];'
    '[base][head]xfade=transition=fade:duration=1:offset=9,'
    'trim=start=1:end=10,setpts=(PTS-STARTPTS)*20/9,'
    'minterpolate=fps=30:mi_mode=blend,'
    'tpad=stop_mode=clone:stop_duration=0.3,trim=end_frame=600,'
    'split=2[b][f];'
    '[b]trim=end_frame=599,setpts=PTS-STARTPTS[body];'
    '[f]trim=end_frame=1,setpts=PTS-STARTPTS[first];'
    '[body][first]concat=n=2:v=1:a=0,'
    'settb=1/30,setpts=N,format=yuv420p[out]'
)
video = ROOT / 'public/videos/uain-swiss-star.mp4'
poster = ROOT / 'public/images/landing/swiss-star.webp'
subprocess.run([
    'ffmpeg', '-y', '-i', str(source), '-filter_complex', filters,
    '-map', '[out]', '-an', '-r', '30', '-c:v', 'libx264',
    '-qp', '22', '-x264-params', 'aq-mode=0',
    '-force_key_frames', 'expr:eq(n,0)+eq(n,599)',
    '-preset', 'medium', '-movflags', '+faststart',
    str(video), '-loglevel', 'error',
], check=True)
subprocess.run([
    'ffmpeg', '-y', '-i', str(video), '-frames:v', '1',
    '-quality', '88', str(poster), '-loglevel', 'error',
], check=True)
print(video)
print(poster)
