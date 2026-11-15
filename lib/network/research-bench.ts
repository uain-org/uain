export interface BenchTask {
  id: string;
  title: string;
  status: string;
  question: string;
  done_when: string;
  how_to_check: string;
  output_format: string;
}
export async function readResearchBench(base = '', fetcher: typeof fetch = fetch) {
  const tasks: BenchTask[] = [];
  let epoch = '', hash = '', count = -1, pages = -1;
  for (let page = 1; page <= 100; page++) {
    const response = await fetcher(`${base}/api/tasks?page_size=100&page=${page}`, {
      signal: AbortSignal.timeout(15000), cache: 'no-store',
    });
    if (!response.ok) throw Error('Task catalogue unavailable');
    const body = await response.json();
    if (body.authority !== 'native' || typeof body.epoch !== 'string' || !body.epoch ||
      typeof body.app_hash !== 'string' || !body.app_hash || !Array.isArray(body.tasks) ||
      body.page !== page || !Number.isInteger(body.pages) || body.pages < page || body.pages > 100 ||
      !Number.isInteger(body.count) || body.count < 0) throw Error('Incomplete native catalogue');
    if (page === 1) { epoch = body.epoch; hash = body.app_hash; count = body.count; pages = body.pages; }
    if (body.epoch !== epoch || body.app_hash !== hash || body.count !== count || body.pages !== pages)
      throw Error('Task catalogue changed; reload');
    for (const task of body.tasks) {
      if (!task || typeof task.id !== 'string' || !task.id || typeof task.status !== 'string' || !task.status)
        throw Error('Incomplete task');
      if (task.status === 'open' && ['title', 'question', 'done_when', 'how_to_check', 'output_format'].some(
        key => typeof task[key] !== 'string' || !task[key].trim())) throw Error('Missing open-task criteria');
      tasks.push(task);
    }
    if (page === pages) {
      if (tasks.length !== count || new Set(tasks.map(t => t.id)).size !== count) throw Error('Partial task census');
      return { count, tasks: tasks.filter(t => t.status === 'open'), readAt: new Date().toISOString() };
    }
  }
  throw Error('Task catalogue exceeds read limit');
}
