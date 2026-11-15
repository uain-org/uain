'use client';

import { useLivePage } from '@/components/network/live-rows';

/** Proposed projects are the goal; the active count is read live from the network. */
export function ProjectGoal() {
  const { list, status } = useLivePage<unknown>(
    '/api/projects?page_size=1',
    'projects',
  );
  const active =
    list !== null ? list.count.toLocaleString('en-US') : status.stale ? '–' : '…';

  return (
    <dl className="home-goal" aria-live="polite">
      <div className="home-goal__item">
        <dt>Proposed projects (goal)</dt>
        <dd>21,600</dd>
      </div>
      <div className="home-goal__item home-goal__item--active">
        <dt>Active now</dt>
        <dd>{active}</dd>
      </div>
    </dl>
  );
}
