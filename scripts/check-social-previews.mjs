/** Check the rendered static export, or anonymously check public URLs after rollout.
 * node --experimental-strip-types scripts/check-social-previews.mjs [https://uain.global]
 * No browser, submissions, tracked CTA requests or social-platform API calls.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { previews } from '../lib/social-preview.ts';
const origin = process.argv[2];
if (origin)
  assert.equal(
    origin,
    'https://uain.global',
    'Only the untracked owned origin is supported',
  );
const decode = (s) =>
  s.replace(
    /&(?:amp|quot|apos|lt|gt|#x27|#39);/g,
    (e) =>
      ({
        '&amp;': '&',
        '&quot;': '"',
        '&apos;': "'",
        '&lt;': '<',
        '&gt;': '>',
        '&#x27;': "'",
        '&#39;': "'",
      })[e],
  );
function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [
      k.toLowerCase(),
      decode(v),
    ]),
  );
}
async function read(path, type) {
  if (!origin) return readFile(`dist/client${path}`);
  const response = await fetch(origin + path, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get('content-type') ?? '', type, path);
  return Buffer.from(await response.arrayBuffer());
}
const rows = [];
for (const [key, p] of Object.entries(previews)) {
  const html = await read(origin ? p.path : `${p.path}.html`, /text\/html/);
  const head = html.toString().split('</head>')[0];
  assert.deepEqual(
    [...head.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => decode(m[1])),
    [p.title],
    `${p.path} document title`,
  );
  const tags = [...head.matchAll(/<(?:meta|link)\b[^>]*>/gi)].map((m) =>
    attributes(m[0]),
  );
  function exactly(name, expected) {
    const values = tags
      .filter((t) => t.property === name || t.name === name || t.rel === name)
      .map((t) => t.content ?? t.href);
    assert.deepEqual(values, [expected], `${p.path} ${name}`);
  }
  const url = 'https://uain.global' + p.path;
  const imagePath = `/images/social/${key}.png`,
    imageUrl = 'https://uain.global' + imagePath;
  exactly('canonical', url);
  exactly('description', p.description);
  for (const prefix of ['og', 'twitter']) {
    exactly(`${prefix}:title`, p.title);
    exactly(`${prefix}:description`, p.description);
    exactly(`${prefix}:image`, imageUrl);
    exactly(`${prefix}:image:alt`, p.alt);
  }
  exactly('og:url', url);
  exactly('og:type', 'website');
  exactly('og:image:width', '1200');
  exactly('og:image:height', '630');
  exactly('twitter:card', 'summary_large_image');
  assert(!head.includes('Founding waitlist open.'), 'Stale homepage image alt');
  const image = await read(imagePath, /image\/png/);
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.subarray(12, 16).toString(), 'IHDR');
  assert.equal(image.readUInt32BE(16), 1200);
  assert.equal(image.readUInt32BE(20), 630);
  assert.deepEqual(
    image,
    await readFile('public' + imagePath),
    'Public/build image must equal committed card',
  );
  rows.push({
    page: url,
    image: imageUrl,
    bytes: image.length,
    sha256: createHash('sha256').update(image).digest('hex'),
    checks:
      'unique page-owned canonical/OG/Twitter fields, matching alt, PNG dimensions and exact source bytes',
  });
}
console.log(
  JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      mode: origin ? 'anonymous public read' : 'local static export',
      pages: rows,
      limits:
        'No browser or platform crawler-cache review; no form, tracked CTA, joining or outside participation.',
    },
    null,
    2,
  ),
);
