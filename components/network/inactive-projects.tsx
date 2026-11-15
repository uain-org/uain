'use client';

import { useEffect, useState } from 'react';

type Domain = { id: string; name: string; count: number; file: string };
type Proposal = {
  id: string;
  title: string;
  summary: string;
  kpi: string;
  crew: { namespace: string; planned_slots: number };
};
type Index = { count: number; domains: Domain[] };

const publicCopy = (text: string) =>
  text.replace(/\bAI agents\b/gi, 'AI Agents, AGI, Super AI Systems');

/**
 * The catalogue of research ideas (21,600: 480 in each of 45 domains). None is
 * open: no tasks, members or rewards, and a card opens nothing. Said plainly
 * since 10 November 2026, when a tester took them for projects that would not
 * load, and kept visually apart from the live projects above (K-40).
 */
export function InactiveProjects() {
  const [index, setIndex] = useState<Index | null>(null);
  const [domain, setDomain] = useState('1');
  const [projects, setProjects] = useState<Proposal[] | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    fetch('/projects/inactive.json', { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Catalogue unavailable');
        return r.json();
      })
      .then(setIndex)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(true);
      });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    const selected = index?.domains.find((d) => d.id === domain);
    if (!selected) return;
    const controller = new AbortController();
    setProjects(null);
    setError(false);
    fetch('/projects/' + selected.file, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Catalogue unavailable');
        return r.json();
      })
      .then(setProjects)
      .catch((e) => {
        if (e.name !== 'AbortError') setError(true);
      });
    return () => controller.abort();
  }, [index, domain, retry]);
  const search = query.trim().toLocaleLowerCase();
  const matches = (projects ?? []).filter((p) =>
    [p.id, p.title, p.summary, p.kpi].some((v) =>
      v.toLocaleLowerCase().includes(search),
    ),
  );
  const pages = Math.max(1, Math.ceil(matches.length / 10));
  const current = Math.min(page, pages);
  return (
    <section
      className="inactive-projects"
      aria-labelledby="inactive-projects-title"
    >
      <h2 id="inactive-projects-title">
        Ideas not yet open
        {index ? ` · ${index.count.toLocaleString('en-US')}` : ''}
      </h2>
      <p>
        A catalogue of research ideas
        {index
          ? `, ${Math.round(index.count / Math.max(1, index.domains.length)).toLocaleString('en-US')} in each of ${index.domains.length} domains`
          : ''}
        , written as starting points for future projects. None of them is open
        yet: they have no tasks, members or rewards, and there is nothing to
        open or join. The projects above are the ones running now.
      </p>
      <div className="net-filters">
        <label>
          <span>Domain</span>
          <select
            className="net-select"
            value={domain}
            onChange={(e) => {
              setDomain(e.target.value);
              setPage(1);
            }}
          >
            {(index?.domains ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.count} ideas)
              </option>
            ))}
          </select>
        </label>
        <label className="net-filter-search">
          <span>Search this domain</span>
          <input
            className="net-input"
            type="search"
            value={query}
            placeholder="Title, summary, KPI or ID"
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
      {error ? (
        <p role="alert">
          Catalogue unavailable.{' '}
          <button type="button" onClick={() => setRetry(retry + 1)}>
            Retry
          </button>
        </p>
      ) : projects === null ? (
        <p role="status">Loading ideas…</p>
      ) : (
        <>
          <div className="proposal-grid">
            {matches.slice((current - 1) * 10, current * 10).map((p) => (
              <article className="proposal-card proposal-card--idea" key={p.id}>
                <div className="proposal-card__meta">
                  <span>Idea {p.id}</span>
                  <span className="net-state">Not open yet</span>
                </div>
                <h3>{publicCopy(p.title)}</h3>
                <p>{publicCopy(p.summary)}</p>
                <p>
                  <strong>Target if it opens:</strong> {publicCopy(p.kpi)}
                </p>
              </article>
            ))}
          </div>
          <div
            className="net-pagination"
            aria-label="Idea catalogue pagination"
          >
            <p role="status">
              {matches.length.toLocaleString('en-US')} matches · Page {current}{' '}
              of {pages}
            </p>
            <div>
              <button
                className="net-page-button"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                Previous
              </button>
              <button
                className="net-page-button"
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
