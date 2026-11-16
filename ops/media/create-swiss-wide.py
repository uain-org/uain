"""Export the reviewed Swiss-route film at its native motion speed.

Usage: python3 ops/media/create-swiss-wide.py /path/to/source.mp4
Provenance: docs/design/swiss-routes-wide-2026-10-07/README.md
"""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE_SHA256 = 'f8bc7e83073f9dca1f7dac02d41c02ef446a2fc70cd4b96481e78b975247f478'

if len(sys.argv) != 2:
    raise SystemExit('Usage: create-swiss-wide.py /path/to/source.mp4')
source = Path(sys.argv[1]).resolve()
if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA256:
    raise SystemExit('Use the reviewed OpenRouter source documented with this revision.')
ffmpeg = shutil.which('ffmpeg')
if not ffmpeg:
    raise SystemExit('Install ffmpeg before exporting the reviewed film.')

# Blend only the last 0.6s into the opening, then start after that opening
# interval. The resulting 7.4s cycle retains native speed throughout.
# Repeat the opening image at the final frame with matching fixed-QP keys.
filters = (
    '[0:v]trim=end=8,setpts=PTS-STARTPTS,scale=2560:1086,fps=30,split=2[b][h];'
    '[h]trim=end=0.6,setpts=PTS-STARTPTS[head];'
    '[b][head]xfade=transition=fade:duration=0.6:offset=7.4,'
    'trim=start=0.6:end=8,setpts=PTS-STARTPTS,'
    'tpad=stop_mode=clone:stop_duration=0.1,trim=end_frame=222,split=2[v][f];'
    '[v]trim=end_frame=221,setpts=PTS-STARTPTS[body];'
    '[f]trim=end_frame=1,setpts=PTS-STARTPTS[first];'
    '[body][first]concat=n=2:v=1:a=0,settb=1/30,setpts=N,format=yuv420p[out]'
)
video = ROOT / 'public/videos/uain-swiss-wide-motion-2026-10.mp4'
poster = ROOT / 'public/images/landing/swiss-wide-motion-2026-10.webp'
subprocess.run([
    ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-i', str(source),
    '-filter_complex', filters, '-map', '[out]', '-an', '-r', '30',
    '-c:v', 'libx264', '-qp', '22', '-x264-params', 'aq-mode=0',
    '-force_key_frames', 'expr:eq(n,0)+eq(n,221)', '-preset', 'medium',
    '-movflags', '+faststart', str(video),
], check=True)
# Motion-disabled visitors see the established Swiss routes, not an empty
# opening frame. This is also the video-load fallback.
subprocess.run([
    ffmpeg, '-y', '-hide_banner', '-loglevel', 'error', '-ss', '4',
    '-i', str(video), '-frames:v', '1', '-c:v', 'libwebp', '-quality', '88',
    str(poster),
], check=True)
print(video)
print(poster)
