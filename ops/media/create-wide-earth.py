"""Export the reviewed OpenRouter Earth film as a silent full-width hero loop.

Usage: python3 ops/media/create-wide-earth.py /path/to/earth-wide-a.mp4
See docs/design/earth-wide-2026-10-07/README.md for prompts and provenance.
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_SHA256 = '8784b2fa0ab653ef52a0a2045473989d4801aa0656d259497a06a9688ffc05d3'

if len(sys.argv) != 2:
    raise SystemExit('Usage: create-wide-earth.py /path/to/earth-wide-a.mp4')
source = Path(sys.argv[1]).resolve()
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
    raise SystemExit('Use the reviewed OpenRouter source documented with this revision.')
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('Install ffmpeg before exporting the reviewed film.')

# Keep the complete wide frame. Blend the last second into the first, rotate
# the phase to start after that blend, then slow the seven-second cycle to 16s.
# Repeat the first image at the final frame and use matching fixed-QP keyframes.
filters = (
    '[0:v]trim=end=8,setpts=PTS-STARTPTS,scale=2560:-2,split=2[base][h];'
    '[h]trim=0:1,setpts=PTS-STARTPTS[head];'
    '[base][head]xfade=transition=fade:duration=1:offset=7,'
    'trim=start=1:end=8,setpts=(PTS-STARTPTS)*16/7,'
    'minterpolate=fps=30:mi_mode=blend,'
    'tpad=stop_mode=clone:stop_duration=0.3,trim=end_frame=480,split=2[b][f];'
    '[b]trim=end_frame=479,setpts=PTS-STARTPTS[body];'
    '[f]trim=end_frame=1,setpts=PTS-STARTPTS[first];'
    '[body][first]concat=n=2:v=1:a=0,settb=1/30,setpts=N,format=yuv420p[out]'
)
video = ROOT / 'public/videos/uain-earth-wide-2026-10.mp4'
poster = ROOT / 'public/images/landing/earth-wide-2026-10.webp'
subprocess.run([
    ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', str(source),
    '-filter_complex', filters, '-map', '[out]', '-an', '-r', '30',
    '-c:v', 'libx264', '-qp', '22', '-x264-params', 'aq-mode=0',
    '-force_key_frames', 'expr:eq(n,0)+eq(n,479)', '-preset', 'medium',
    '-movflags', '+faststart', str(video),
], check=True)
subprocess.run([
    ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', str(video),
    '-frames:v', '1', '-c:v', 'libwebp', '-quality', '88', str(poster),
], check=True)
print(video)
print(poster)
