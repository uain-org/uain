'use client';

import { useLivePage } from '@/components/network/live-rows';
import type { LiveTask } from '@/lib/network/live';
import { ArrowRight, FileSearch } from 'lucide-react';

const statusLabel: Record<string, string> = {
  open: 'Open for work',
  needs_comparison: 'Comparing answers',
  awaiting_verification: 'Checking',
  answered: 'Answered',
  closed: 'Closed',
};

/** A real pilot task, read from the same feed as the network portal. */
export function LiveTaskSpotlight() {
  const { list, status } = useLivePage<LiveTask>(
    '/api/tasks?project=longevity-and-ageing-open-questions-on-open-data&page_size=20',
    'tasks',
  );
  const task = list?.rows.find((row) => row.status === 'open') ?? list?.rows[0];
  const loading = list === null && !status.stale;
  const label = task
    ? status.stale
      ? 'Last available update'
      : 'Latest update'
    : loading
      ? 'Loading'
      : status.stale
        ? 'Updates unavailable'
        : 'No current work';

  return (
    <div className="home-task home-live" aria-live="polite">
      <div className="home-task__top">
        <span className="home-live__overline">CURRENT RESEARCH</span>
        <span
          className={
            status.stale || !task
              ? 'home-task__live'
              : 'home-task__live home-task__live--current'
          }
        >
          {label}
        </span>
        {task && (
          <span className="home-task__state">
            {statusLabel[task.status] ?? 'In progress'}
          </span>
        )}
      </div>
      {task ? (
        <>
          <div className="home-live__body">
            <h3>Longevity &amp; ageing</h3>
            <p>Follow the search for healthier, longer lives.</p>
          </div>
          <div className="home-task__bottom">
            <a href={`/network/projects/${encodeURIComponent(task.project_id)}`}>
              View research progress <ArrowRight size={16} aria-hidden="true" />
            </a>
          </div>
        </>
      ) : (
        <>
          <div className="home-live__empty">
            <div className="home-live__visual" aria-hidden="true">
              <FileSearch size={38} strokeWidth={1.3} />
            </div>
            <div>
              <h3>
                {loading
                  ? 'Loading research updates'
                  : status.stale
                    ? 'Research updates unavailable'
                    : 'No current work to show'}
              </h3>
              <p>
                {loading
                  ? 'Checking for the latest work…'
                  : status.stale
                    ? 'Please check back later.'
                    : 'New research will appear here when it is available.'}
              </p>
            </div>
          </div>
          <div className="home-task__bottom">
            <span>Members share their work so anyone can follow it.</span>
          </div>
        </>
      )}
    </div>
  );
}
