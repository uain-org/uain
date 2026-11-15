/**
 * Kalki's projects, for the Earth page's Real view (docs/observatory.md).
 *
 *   GET /api/kalki   where each of Kalki's projects stands (public)
 *
 * Until 13 October 2026 this was /api/bridge/kalki, part of the bridge. The
 * bridge now lives in its own repository (the bridge repository); this read is
 * UAIN's own and stays here.
 */
/**
 * Where Kalki's projects stand, read from Kalki's screen (GET /api/status,
 * UAIN_KALKI_STATUS_URL with UAIN_KALKI_KEY) and passed on for the Earth
 * page to draw. Reading only, kept for half a minute so the page's polling
 * costs Kalki one call. Empty where Kalki is not set, or does not answer.
 */
let kalkiSeen: { at: number; projects: unknown[] } = { at: 0, projects: [] };
let kalkiRefresh: Promise<unknown[]> | undefined;
let kalkiRetryAt = 0;
const staleProjects = () =>
  Date.now() - kalkiSeen.at <= 300_000 ? kalkiSeen.projects : [];
async function statusBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Kalki body unavailable');
  const chunks: Buffer[] = [];
  const maxBytes = 1024 * 1024;
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes)
      throw new Error('Kalki body exceeds byte limit');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Kalki body exceeds byte limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function kalkiProjects() {
  const url = process.env.UAIN_KALKI_STATUS_URL;
  const key = process.env.UAIN_KALKI_KEY;
  if (!url || !key) return [];
  if (Date.now() - kalkiSeen.at < 30_000) return kalkiSeen.projects;
  if (kalkiRefresh) return kalkiRefresh;
  if (Date.now() < kalkiRetryAt) return staleProjects();
  kalkiRefresh = refreshKalki(url, key);
  try {
    return await kalkiRefresh;
  } finally {
    kalkiRefresh = undefined;
  }
}

async function refreshKalki(url: string, key: string) {
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Kalki HTTP ${response.status}`);
    const body = await statusBody(response);
    const text = (v: unknown, max: number) =>
      typeof v === 'string' ? v.replace(/[<>]/g, '').slice(0, max) : '';
    const count = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const projects = (Array.isArray(body.projects) ? body.projects : [])
      .slice(0, 60)
      .filter(
        (p) =>
          p &&
          typeof p.id === 'string' &&
          /^[a-z0-9][a-z0-9-]{1,39}$/.test(p.id),
      )
      .map((p) => ({
        id: text(p.id, 40),
        name: text(p.name, 160),
        arm: p.arm
          ? {
              number: text(p.arm.number, 4),
              name: text(p.arm.name, 80),
              role: text(p.arm.role, 80),
              mission: text(p.arm.mission, 300),
            }
          : null,
        paused: p.paused === true,
        autonomous: p.autonomous === true,
        milestone: p.milestone
          ? {
              seq: count(p.milestone.seq),
              title: text(p.milestone.title, 160),
              status: text(p.milestone.status, 20),
            }
          : null,
        milestones: {
          done: count(p.milestones?.done),
          total: count(p.milestones?.total),
        },
        tasks: {
          passed: count(p.tasks?.passed),
          failed: count(p.tasks?.failed),
        },
        doing: (Array.isArray(p.doing) ? p.doing : [])
          .slice(0, 4)
          .map((d) => text(d, 200)),
        last: p.last
          ? { at: count(p.last.at), text: text(p.last.text, 240) }
          : null,
      }))
      .filter((p) => /^[a-z0-9][a-z0-9-]{1,39}$/.test(p.id));
    kalkiSeen = { at: Date.now(), projects };
    kalkiRetryAt = 0;
  } catch {
    // Bound retries while Kalki restarts, without renewing stale data.
    kalkiRetryAt = Date.now() + 10_000;
  }
  return staleProjects();
}

export async function handleKalki(req, res, url, send) {
  if (url.pathname !== '/api/kalki') return false;
  if (req.method !== 'GET') {
    send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    return true;
  }
  send(res, 200, { projects: await kalkiProjects() });
  return true;
}
