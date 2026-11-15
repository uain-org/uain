/**
 * The world's news, from the GDELT Project's event files
 * (https://www.gdeltproject.org/): every 15 minutes GDELT publishes what the
 * world's news sites reported, one row per event, with its place and source
 * article. It is free for any use with a citation and a link, which the
 * credits carry. The titles are made from the articles' addresses (the files
 * carry no headlines), so they read roughly.
 *
 * The site is a static export with no server of its own, so the browser
 * reads the files directly (they allow any origin). A day is 96 files, about
 * 7 MB, which is too much for every visitor; instead one file every two hours
 * is read and scaled up (about 0.9 MB at first, then one new file each
 * quarter hour), so the day's numbers are estimates and say so.
 */

export interface NewsStory {
  url: string;
  /** A readable title, made from the article's address. */
  title: string;
  /** The news site. */
  source: string;
  place: string;
  lat: number | null;
  lon: number | null;
  /** How many articles carried it. */
  articles: number;
  /** A conflict, a protest, an attack: something that needs solving. */
  trouble: boolean;
  at: number;
}

export interface NewsDay {
  /** The latest file's stories, the most reported first. */
  latest: NewsStory[];
  /** Estimated distinct news stories in the last 24 hours. */
  stories: number;
  /** Of those, the estimated ones about trouble. */
  trouble: number;
}

const BASE = 'https://data.gdeltproject.org/gdeltv2/';

// GDELT's event codes are machine-read and often wrong about the kind
// ("fighting" on an airport story), so the wire shows only the source. A
// story counts as trouble only for the clearest codes: protest (14), assault
// (18), fighting (19) and mass violence (20).
const TROUBLE = new Set(['14', '18', '19', '20']);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** "…/2026/10/08/unvaccinated-dogs-may-be-culled.html" → a sentence. */
export function titleFromUrl(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const parts = path
    .split('/')
    .map((p) => decodeURIComponent(p).replace(/\.[a-z0-9]{2,5}$/i, ''))
    .filter((p) => /[a-z]/i.test(p) && /[-_]/.test(p));
  const slug = parts.sort((a, b) => b.length - a.length)[0];
  if (!slug) return null;
  const words = slug
    .split(/[-_+]+/)
    .filter((w) => w && !/^\d{4,}$/.test(w) && !/^[0-9a-f]{8,}$/i.test(w));
  if (words.length < 3) return null;
  const text = words.join(' ').slice(0, 110);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A zip with one deflated file, opened by the browser's own inflater. */
async function unzip(buf: ArrayBuffer): Promise<string> {
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error('not a zip');
  const method = view.getUint16(8, true);
  const size = view.getUint32(18, true);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const start = 30 + nameLen + extraLen;
  const body = new Uint8Array(buf, start, size || buf.byteLength - start);
  if (method === 0) return new TextDecoder().decode(body);
  const stream = new Blob([body])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/** Files already read, by their time stamp: a file never changes. */
const read = new Map<string, NewsStory[]>();

async function readFile(stamp: string): Promise<NewsStory[]> {
  const seen = read.get(stamp);
  if (seen) return seen;
  const res = await fetch(`${BASE}${stamp}.export.CSV.zip`);
  if (!res.ok) throw new Error(`GDELT ${res.status}`);
  const text = await unzip(await res.arrayBuffer());
  const at = Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(8, 10),
    +stamp.slice(10, 12),
  );
  // One story per article: GDELT often lists several events from one.
  const byUrl = new Map<string, NewsStory>();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < 61) continue;
    const url = f[60];
    const trouble = TROUBLE.has(f[26].slice(0, 2));
    const old = byUrl.get(url);
    if (old) {
      old.trouble ||= trouble;
      continue;
    }
    const lat = f[56] ? Number(f[56]) : null;
    const lon = f[57] ? Number(f[57]) : null;
    byUrl.set(url, {
      url,
      title: titleFromUrl(url) ?? '',
      source: hostOf(url),
      place: f[52],
      lat: Number.isFinite(lat) ? lat : null,
      lon: Number.isFinite(lon) ? lon : null,
      articles: Number(f[33]) || 1,
      trouble,
      at,
    });
  }
  const stories = [...byUrl.values()];
  read.set(stamp, stories);
  if (read.size > 40) read.delete(read.keys().next().value!);
  return stories;
}

const stampOf = (t: number) =>
  new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/** The latest file now, then the day's estimate as the samples arrive. */
export async function readNews(onUpdate: (day: NewsDay) => void) {
  const last = await fetch(`${BASE}lastupdate.txt`).then((r) => r.text());
  const stamp = /(\d{14})\.export/.exec(last)?.[1];
  if (!stamp) throw new Error('GDELT: no latest file');
  const latestAt = Date.UTC(
    +stamp.slice(0, 4),
    +stamp.slice(4, 6) - 1,
    +stamp.slice(6, 8),
    +stamp.slice(8, 10),
    +stamp.slice(10, 12),
  );
  const latest = await readFile(stamp);
  const sorted = latest
    .filter((s) => s.title)
    .sort((a, b) => b.articles - a.articles);
  // Each file covers 15 minutes; a day is 96 of them. One sample every two
  // hours stands for the eight files around it.
  const samples = [latest];
  const day = (): NewsDay => {
    const per = (pick: (s: NewsStory) => boolean) =>
      samples.reduce((n, s) => n + s.filter(pick).length, 0) / samples.length;
    return {
      latest: sorted,
      stories: Math.round(per(() => true) * 96),
      trouble: Math.round(per((s) => s.trouble) * 96),
    };
  };
  onUpdate(day());
  for (let i = 1; i < 12; i++) {
    try {
      const even = latestAt - (latestAt % (2 * 3600 * 1000));
      samples.push(await readFile(stampOf(even - (i - 1) * 2 * 3600 * 1000)));
      onUpdate(day());
    } catch {
      // A missing file now and then is normal; the estimate uses the rest.
    }
  }
}
