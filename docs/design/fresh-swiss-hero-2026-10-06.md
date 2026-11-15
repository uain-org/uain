# Fresh Swiss Earth hero — 6 October 2026

The previous film still contained two route origins after its second bright dot
was masked. This replacement starts with new artwork and a new model-generated
film. None of the previous reference images or videos were used in the selected
source. No geographic textures, hubs or paths are patched into the export.

## Selected source

- Reference: Nano Banana 2.1, 16:9, two new alternatives, selected wide A.
- Film: Omni 1.1 Flash, Frames, 720p, 10 seconds, two outputs; selected take E.
- The same new wide reference was provided as the start and end frame.
- Six existing arcs meet at one point in the Swiss Alps immediately north of
  Italy. Remote pins are endpoints with one attached arc, never route origins.
- Motion is limited to restrained lighting and atmospheric movement. The model
  also produces gentle highlights along the fixed arcs; their geometry stays
  attached to the same Swiss origin.
- Source MP4 SHA-256:
  `f1e169988327e93216a42c9a30602f264be58000dc97ce367ba708762541a6f3`.
- Reference JPG SHA-256:
  `d88ce2b0734a470e6c8c18879f95b726025cda754c61d22b037431483b50e664`.
- [Selected Flow video](https://flow.google.com/project/a4f351b0-2d7f-4b88-ab12-d23b8c6b2807/edit/f22f9308-f738-4c5e-9e15-f5182d9dfe84).
- [Selected reference](https://flow.google.com/project/a4f351b0-2d7f-4b88-ab12-d23b8c6b2807/edit/d5d354fe-7421-43ab-9ce3-f773be9115f2).

## Alternatives reviewed

| Take | Model / duration | Decision |
|---|---|---|
| A | Omni 1.1 Flash / 10s | Reject: adds a route during animation; portrait reference is cropped poorly. |
| B | Omni 1.1 Flash / 10s | Routes retain one origin, but Europe and Scandinavia are cropped. |
| C | Veo 3.1 Fast / 8s | Reject: adds routes and bright electrical effects. |
| D | Omni 1.1 Flash / 10s | One origin and good framing; repeated expanding hub rings are too distracting. |
| E | Omni 1.1 Flash / 10s | Selected: quietest full-globe composition and fixed shared Swiss origin. |

A/B/C used the initial brand-new imagegen reference. D/E used the new widescreen
Nano Banana A reference. The imagegen reference was generated from text, not an
edit of an old frame. Flow showed 30 credits for A/B, 20 for C, 0 for the two wide
images, and 30 for D/E: 80 displayed generation credits in this run. No plan or
credits were purchased, and OpenRouter was not needed.

## Exact prompts

### Selected reference generation

Create a completely NEW photorealistic premium Earth-from-space background for the United AI Network. Wide 16:9 landscape. Full blue planet centered with generous deep navy space left and right, dawn atmosphere glow upper left, realistic Europe and Africa facing the viewer. EUROPE MUST BE WELL WITHIN THE FRAME. Switzerland at horizontal center and 40 percent down the image, not at the top edge. Exactly ONE small bright cyan-white hub located on Switzerland in the Alps, immediately north of Italy. Exactly FIVE delicate elegant curved cyan connection lines all begin at the EXACT SAME Swiss point and radiate outward to five dim tiny endpoints: Britain, Scandinavia, eastern North America visible near left horizon, India near right horizon, and southern Africa. Strict star topology: no line between remote endpoints, no crossing that makes a second hub, no line originates from eastern Europe. Swiss hub is clearly brightest, all endpoints are tiny and dim. Clean refined thin arcs, no thick energetic beams. Keep the planet and Swiss hub centered in the central square so a homepage hero crop remains clear. Clouds over oceans, land geography visible, scientific calm cinematic blue aesthetic, navy black surrounding space. No text, letters, labels, flag, Swiss cross, logo, watermark, frame, interface. Everything fully inside the wide image, no cropped Switzerland or Europe.

### Selected video generation

Animate this entirely new Earth artwork as a restrained cinematic background loop. Keep the camera ABSOLUTELY LOCKED and the full globe in the same position. Preserve all SIX existing thin arcs EXACTLY, joined at one and only one Swiss hub in the Alps immediately north of Italy. Every route begins at this exact single Swiss point for every frame. No added routes, no extra junctions, no eastern European origin, no new nodes or moving bright dots. Do NOT animate route drawing or moving particles. Animation is limited to very slow wispy ocean cloud drift, delicate blue atmospheric shimmer and a subtle breathing glow on the one Swiss hub. Remote endpoints remain tiny dim pins and never flare. The existing thin arcs stay permanently fixed and softly luminous. Sophisticated quiet natural motion, no lightning, no flashing, no camera motion, no planet rotation, no zoom. End on the provided opening frame with matching position, lighting, clouds and all arcs for a seamless cycle. No text, icons, logo or watermark. Silent.

### Initial video comparison

Create a NEW premium cinematic Earth network loop from the provided fresh frame. Lock the camera and real geography. Preserve the exact SINGLE-ORIGIN STAR topology shown: ALL FIVE thin routes permanently meet at the SAME ONE glowing point over Switzerland. Switzerland is the only hub and every route begins there. Keep routes attached to this one Swiss point for every frame. Remote dots are only dim endpoints; no line begins at them, no route connects two remote endpoints, no new arcs, no second center in eastern Europe, no branching junctions. Animation: very gentle atmospheric/cloud drift and subtle slow luminous packets traveling OUTWARD FROM SWITZERLAND along the five existing routes. Do not redraw, relocate or multiply routes or nodes. Swiss hub remains clearly brighter than endpoints. Calm polished scientific aesthetic, no camera move, no rotation, no orbit, no zoom, no map/flag/cross, no text, no labels, no logo. Smooth cyclic motion: end on the exact opening frame so this feels continuous when looped. Silent film.


## Website export

Run `python3 ops/media/create-seamless-swiss.py /path/to/selected-source.mp4`.
The script refuses any file that does not match the selected source hash.

- Center crop: 820 × 720 at x=230, y=0 of the 1280 × 720 source. This keeps the
  globe, origin and endpoints visible and places corner branding outside the
  hero's framing. It does not mask any node or alter any route.
- Blend the source's last second into its first second and rotate the phase so
  the wrap follows adjacent frames; slow the resulting nine-second cycle to
  twenty seconds and interpolate to 30 fps.
- Final frame repeats the opening frame; both are independently encoded
  keyframes at the same quantization level for identical decoded pixels.
- H.264, yuv420p, fast-start MP4, no audio stream, 600 frames.
- Website assets: `public/videos/uain-swiss-star.mp4` and
  `public/images/landing/swiss-star.webp`.
- Hero URLs change to prevent reuse of the rejected cached video. The still
  fallback remains available for reduced motion, save-data and loading errors.

## Evidence

Local source videos, prompt text and contact sheets are retained in the ignored
`work/fresh-switzerland-hero-2026-10-06/` folder. Source take E was reviewed across
its full ten-second timeline using half-second contact frames and the player.
The final export passed review across the twenty-second timeline at half-second
intervals. All arcs remained joined to the same Swiss origin.

- `wrap-check.json`: first/last RGB pixels are identical; opening-frame SHA-256
  `ffa8e71e979689aebda8fed46193cc11882e43e864818e5cbe5ec54e04ceb385`.
- `export-metadata.json`: twenty seconds, 600 frames, 820 × 720, 30 fps, H.264,
  no audio; MP4 SHA-256
  `a2a3de58d5f9ac6208406785531b15940c9124bc4bd9a187001380c3d22a55e2`.
- Local browser: new asset loaded at readyState 4, muted autoplay and loop true,
  video opacity 1. Desktop and 390px layouts fit with no horizontal overflow.
- Reduced-motion emulation: zero video elements, matching poster loaded. All
  temporary browser emulation and viewport settings were reset afterwards.
- Clean-checkout TypeScript and Vinext site build passed; hero component lint
  and Git whitespace check passed. The main checkout's blanket TypeScript scan
  includes an unrelated ignored custody checkout under `work/`, so the clean
  tracked-files checkout is used for the site check.
- Screenshots: `local-hero-desktop.png` and `local-mobile.png`.

Production verification is tracked in `remaining_work.md`.

## Production verification — 6 October 2026

PR #152 passed all nine checks in run 37500542165, including both backend passes.
The tested merge candidate `a61d63ad14f9da998adf47a8724fc3d1d13bcc7a` had parents
current main `443b43150492ab027bc43a1c0c646c0459fa24aa` and branch head
`ca53689d218f69c06fcfe852819aa7920cbaefb7`.

Merged production commit `585576ecb525c36b2be488f2b2cfaef59f974cb1` deployed in
successful run 37500971014. The live browser loads `/videos/uain-swiss-star.mp4`
with duration 20, readyState 4, opacity 1, paused false, muted true and loop true.
The downloaded served file matches the reviewed local MP4 SHA-256. The full hero
screenshot is `work/fresh-switzerland-hero-2026-10-06/live-hero.png`; playback
state and release IDs are saved alongside it. Previous navigation, FAQ/white
paper buttons and project-support pages are preserved.
