export interface RankedWork {
  id: string;
  contributor: string;
  state: string;
  verifications: { verifier: string }[];
}
export function rankWork(work: RankedWork[]) {
  const authors = new Map<
    string,
    { id: string; settled: string[]; contested: string[]; other: string[] }
  >();
  const checkers = new Map<string, Set<string>>();
  for (const row of work) {
    if (
      !row.id ||
      !row.contributor ||
      typeof row.state !== 'string' ||
      !Array.isArray(row.verifications)
    )
      throw Error('Incomplete contribution');
    const author = authors.get(row.contributor) ?? {
      id: row.contributor,
      settled: [],
      contested: [],
      other: [],
    };
    (row.state === 'settled'
      ? author.settled
      : row.state === 'contested'
        ? author.contested
        : author.other
    ).push(row.id);
    authors.set(author.id, author);
    for (const check of row.verifications) {
      if (!check.verifier) throw Error('Incomplete checker');
      const ids = checkers.get(check.verifier) ?? new Set<string>();
      ids.add(row.id);
      checkers.set(check.verifier, ids);
    }
  }
  return {
    contributors: [...authors.values()].sort(
      (a, b) => b.settled.length - a.settled.length || a.id.localeCompare(b.id),
    ),
    checkers: [...checkers]
      .map(([id, ids]) => ({ id, work: [...ids] }))
      .sort(
        (a, b) => b.work.length - a.work.length || a.id.localeCompare(b.id),
      ),
  };
}
export async function readLeaderboard(
  base = '',
  fetcher: typeof fetch = fetch,
) {
  const rows: RankedWork[] = [];
  let epoch = '',
    appHash = '',
    count = -1;
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(
      `${base}/api/contributions?page_size=200&page=${page}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw Error('Contribution catalogue unavailable');
    const body = await response.json();
    if (
      body.authority !== 'native' ||
      !body.epoch ||
      typeof body.app_hash !== 'string' ||
      !body.app_hash ||
      !Array.isArray(body.contributions) ||
      body.page !== page ||
      !Number.isInteger(body.pages) ||
      body.pages < page ||
      body.pages > 100 ||
      !Number.isInteger(body.count)
    )
      throw Error('Incomplete native catalogue');
    if (page === 1) {
      epoch = body.epoch;
      appHash = body.app_hash;
      count = body.count;
    }
    if (
      body.epoch !== epoch ||
      body.app_hash !== appHash ||
      body.count !== count
    )
      throw Error('Catalogue changed; reload');
    rows.push(...body.contributions);
    if (page === body.pages) {
      if (
        rows.length !== count ||
        new Set(rows.map((row) => row.id)).size !== count
      )
        throw Error('Incomplete catalogue');
      return {
        ...rankWork(rows),
        count,
        epoch,
        readAt: new Date().toISOString(),
      };
    }
  }
  throw Error('Catalogue exceeds read limit');
}
