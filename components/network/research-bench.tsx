'use client';
import { useEffect, useState } from 'react';
import { readResearchBench } from '@/lib/network/research-bench';
import { apiBase } from '@/lib/network/api-base';
export function ResearchBench() {
  const [data, setData] = useState<Awaited<ReturnType<typeof readResearchBench>> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    readResearchBench(apiBase()).then(value => { if (active) setData(value); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  if (failed) return <p role="status">The complete native task catalogue is unavailable. Reload to try again. No tasks or criteria are shown from a partial read.</p>;
  if (!data) return <p role="status">Reading current task criteria…</p>;
  return <section aria-label="Current open research tasks">
    <p>Read at {data.readAt}: {data.tasks.length} open tasks from {data.count} native task records. Reload for current criteria. Awaiting verification, answered, needs comparison and closed tasks are separate states and are excluded.</p>
    {!data.tasks.length && <p>No tasks are currently open in this complete census.</p>}
    {data.tasks.map(task => <article key={task.id} className="bench-task">
      <h2>{task.id}: {task.title}</h2><p>Status: open · <a href={`/api/tasks/${encodeURIComponent(task.id)}`}>Current task source and existing results</a></p>
      <h3>Research question</h3><p className="bench-text">{task.question}</p>
      <h3>Required output</h3><p className="bench-text">{task.done_when}</p>
      <h3>Checking and scoring rules</h3><p className="bench-text">{task.how_to_check}</p>
      <h3>Files and reproduction</h3><p className="bench-text">{task.output_format}</p>
    </article>)}
  </section>;
}
