/**
 * KPIs and future-solvable tasks (white paper 5.3; decision D7, taken on 30
 * September 2026). The rules only: no store, no ledger. The writes that use
 * them are in application/kpi.ts, with settlement's hold in application/db.ts.
 *
 * - A KPI is a mathematically defined marker of success: a metric, a
 *   comparator, a threshold (none for "occurs"), where it will be read, and
 *   the date by which it is judged. A task may carry one, and so may a
 *   project.
 * - A task is "instant" (the default: verified work is paid when it settles,
 *   as always) or "future": it needs a KPI, its work is checked as any work
 *   is, and the award of work that settles is held until the KPI resolves.
 *   Met, the awards are paid as settlement would have paid them; not met, or
 *   unresolved KPI_GRACE_DAYS after the date, they are withheld.
 * - A task's KPI is frozen once the task has a submission.
 */
import { sourceKind } from '../integrations/sources.ts';

export const TASK_KINDS = ['instant', 'future'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const KPI_COMPARATORS = ['>=', '<=', '==', 'occurs'] as const;
export type KpiComparator = (typeof KPI_COMPARATORS)[number];

/** How long after its date an unresolved KPI expires, and the held awards with it. */
export const KPI_GRACE_DAYS = 30;
/** How far ahead a KPI may be dated. */
export const KPI_MAX_YEARS = 50;
/** How long a KPI's statement must be: a sentence, not a word. */
export const KPI_STATEMENT_MIN = 20;
/** How long a resolution's note must be: long enough to say what the source shows. */
export const KPI_NOTE_MIN = 20;

const DAY_MS = 86_400_000;
const GRACE_MS = KPI_GRACE_DAYS * DAY_MS;
const FIELDS = ['statement', 'metric', 'comparator', 'threshold', 'unit', 'source', 'resolves_by'];

export interface Kpi {
  statement: string;
  metric: string;
  comparator: KpiComparator;
  threshold: number | null;
  unit: string | null;
  source: string;
  resolves_by: string;
}

export interface KpiProblem { field: string; why: string }

/**
 * Where a KPI is read, or a resolution's evidence is: a web address over
 * https, or an identifier a registry answers for (a trial number, a PubMed ID
 * or a DOI).
 */
export function isKpiSource(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  const k = sourceKind(s);
  if (!k) return false;
  return k.kind !== 'url' || /^https:\/\//i.test(s);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * When a KPI's date passes, as an ISO instant: a date (YYYY-MM-DD) is the end
 * of that day in UTC, a time is itself. Null for anything else, a date that
 * does not exist (2027-02-30) included.
 */
export function deadlineOf(resolvesBy: unknown): string | null {
  const s = String(resolvesBy ?? '').trim();
  const d = DATE.exec(s);
  if (d) {
    const at = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]));
    const back = new Date(at);
    if (back.getUTCFullYear() !== Number(d[1]) || back.getUTCMonth() !== Number(d[2]) - 1 ||
      back.getUTCDate() !== Number(d[3]))
      return null;
    return new Date(at + DAY_MS).toISOString();
  }
  if (!INSTANT.test(s)) return null;
  const at = Date.parse(s);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** When a KPI due at `deadline` expires unresolved. */
export const expiresAt = (deadline: string): string =>
  new Date(Date.parse(deadline) + GRACE_MS).toISOString();

const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : null);

/**
 * A KPI as stored, with the instant its date passes, or every reason it is
 * refused. Strict: an unknown field, a threshold on "occurs", a number given
 * as text or a date in the past is refused, not repaired.
 */
export interface KpiChecked { value?: Kpi; deadline?: string; error?: 'bad_kpi'; problems?: KpiProblem[] }
export function kpiOf(input: unknown, now: number = Date.now()): KpiChecked {
  const problems: KpiProblem[] = [];
  const bad = (field: string, why: string) => problems.push({ field, why });
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { error: 'bad_kpi', problems: [{ field: 'kpi', why: 'an object with the fields below' }] };
  const k = input as Record<string, unknown>;
  for (const key of Object.keys(k)) if (!FIELDS.includes(key)) bad(key, 'not a KPI field');

  const statement = text(k.statement);
  if (!statement || statement.length < KPI_STATEMENT_MIN || statement.length > 2000)
    bad('statement', `the marker of success in words, ${KPI_STATEMENT_MIN} to 2,000 characters`);
  const metric = text(k.metric);
  if (!metric || metric.length > 200) bad('metric', 'what is measured, 1 to 200 characters');
  const comparator = k.comparator as KpiComparator;
  if (!KPI_COMPARATORS.includes(comparator)) bad('comparator', `one of ${KPI_COMPARATORS.join(', ')}`);
  const occurs = comparator === 'occurs';
  let threshold: number | null = null;
  if (occurs) {
    if (k.threshold !== undefined && k.threshold !== null) bad('threshold', 'none for occurs: leave it out or null');
  } else if (typeof k.threshold !== 'number' || !Number.isFinite(k.threshold)) {
    bad('threshold', 'a finite number, for >=, <= and ==');
  } else threshold = k.threshold;
  let unit: string | null = null;
  if (k.unit !== undefined && k.unit !== null) {
    unit = text(k.unit);
    if (!unit || unit.length > 50) bad('unit', 'up to 50 characters, or left out');
    else if (occurs) bad('unit', 'none for occurs: it has no number to measure');
  }
  const source = text(k.source);
  if (!source || source.length > 500 || !isKpiSource(source))
    bad('source', 'where it will be read: an https web address, or a trial number (NCT…), PubMed ID (PMID …) or DOI');
  const resolvesBy = text(k.resolves_by);
  const deadline = deadlineOf(resolvesBy);
  if (!deadline) bad('resolves_by', 'a date, YYYY-MM-DD (the end of that day, UTC), or an ISO 8601 time with its zone');
  else if (Date.parse(deadline) <= now) bad('resolves_by', 'a date still to come');
  else if (Date.parse(deadline) > now + KPI_MAX_YEARS * 365.25 * DAY_MS)
    bad('resolves_by', `within ${KPI_MAX_YEARS} years`);

  if (problems.length) return { error: 'bad_kpi', problems };
  return {
    value: { statement, metric, comparator, threshold, unit, source, resolves_by: resolvesBy },
    deadline,
  };
}

/** A resolution's observation, checked against the KPI's comparator. */
export function observedOf(kpi: Kpi, observed: unknown):
  { value?: number | boolean; error?: 'bad_observed'; expected?: 'boolean' | 'number' } {
  if (kpi.comparator === 'occurs')
    return typeof observed === 'boolean' ? { value: observed } : { error: 'bad_observed', expected: 'boolean' };
  return typeof observed === 'number' && Number.isFinite(observed)
    ? { value: observed }
    : { error: 'bad_observed', expected: 'number' };
}

/** Whether an observation meets the KPI. Exact: == means equal, not close. */
export function kpiMet(kpi: Kpi, observed: number | boolean): boolean {
  switch (kpi.comparator) {
    case 'occurs':
      return observed === true;
    case '>=':
      return (observed as number) >= kpi.threshold;
    case '<=':
      return (observed as number) <= kpi.threshold;
    case '==':
      return observed === kpi.threshold;
  }
  return false;
}

/** A KPI in one line, for a ledger summary. */
export function describeKpi(kpi: Kpi): string {
  const target = kpi.comparator === 'occurs'
    ? `${kpi.metric} occurs`
    : `${kpi.metric} ${kpi.comparator} ${kpi.threshold}${kpi.unit ? ` ${kpi.unit}` : ''}`;
  return `${target}, by ${kpi.resolves_by}, read from ${kpi.source}`;
}

/**
 * Where a future task's KPI stands: 'awaiting' its date, 'due' (the date has
 * passed and it waits for a resolver), or how it resolved: 'met', 'unmet', or
 * 'expired' (unresolved KPI_GRACE_DAYS after its date; read here as soon as
 * that is so, recorded by the sweep in application/kpi.ts). Null for an
 * instant task.
 */
export type KpiStatus = 'awaiting' | 'due' | 'met' | 'unmet' | 'expired';
export function kpiStatus(
  task: { kind?: unknown; resolves_by?: unknown },
  outcome: string | null,
  now: number = Date.now(),
): KpiStatus | null {
  if (task.kind !== 'future') return null;
  if (outcome === 'met' || outcome === 'unmet' || outcome === 'expired') return outcome;
  const due = Date.parse(String(task.resolves_by ?? ''));
  if (!Number.isFinite(due)) return null;
  if (now >= due + GRACE_MS) return 'expired';
  return now >= due ? 'due' : 'awaiting';
}

/** Whether a task still takes answers as far as its KPI goes: before its date. */
export const beforeKpiDate = (task: { kind?: unknown; kpi_status?: unknown }): boolean =>
  task.kind !== 'future' || task.kpi_status === 'awaiting';

type Row = Record<string, unknown>;
const parsed = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

/** A resolution as the API serves it (and as its ledger commitment reads it). */
export function hydrateResolution(r: Row | null): Row | null {
  if (!r) return null;
  return {
    task_id: r.task_id,
    outcome: r.outcome,
    met: r.outcome === 'met' ? true : r.outcome === 'unmet' ? false : null,
    observed: parsed(r.observed),
    source: r.source ?? null,
    source_check: parsed(r.source_check),
    note: r.note ?? null,
    resolved_by: r.resolved_by ?? null,
    kpi: parsed(r.kpi),
    contributions: parsed(r.contributions) ?? [],
    at: r.at,
  };
}

/** What an award held for a KPI is, as a contribution shows it. */
export function heldAward(raw: unknown): { credibility: number; credits: number } | null {
  const h = parsed(raw) as { credibility?: number; credits?: number } | null;
  return h ? { credibility: h.credibility ?? 0, credits: h.credits ?? 0 } : null;
}

/**
 * The KPI fields of a task, as every read shows them: its kind, its KPI, and
 * for a future task where the KPI stands, when it falls due and expires, the
 * contributions whose awards wait for it, and how it resolved.
 */
export function taskKpiView(row: Row, contributions: Row[], resolution: Row | null, now: number = Date.now()): Row {
  const kind = (row.kind as string) ?? 'instant';
  const kpi = row.kpi ? JSON.parse(row.kpi as string) : null;
  if (kind !== 'future') return { kind, kpi };
  const deadline = String(row.resolves_by ?? '');
  return {
    kind,
    kpi,
    kpi_status: kpiStatus(row, (resolution?.outcome as string) ?? null, now),
    kpi_due_at: deadline || null,
    kpi_expires_at: deadline ? expiresAt(deadline) : null,
    kpi_held: contributions.filter((c) => c.award_pending === 'kpi').map((c) => c.id),
    kpi_resolution: hydrateResolution(resolution),
  };
}

/** How a task closed for its KPI, for `closed.as`, or null. */
export function closedForKpi(view: Row): string | null {
  const s = view.kpi_status;
  return s === 'met' || s === 'unmet' || s === 'expired' ? `kpi_${s}` : null;
}

/** What uain_describe says about future tasks. */
export const FUTURE_TASKS_RULE =
  'A task is instant (the default: verified work is paid when it settles) or future-solvable ' +
  '(white paper 5.3): it carries a KPI, a mathematically defined marker of success (metric, ' +
  'comparator, threshold, source, resolves_by). Its work is checked as any work is, but the ' +
  'award of work that settles is held (award_pending "kpi") until a UAIN default verifier or ' +
  'trusted arbiter of another member resolves the KPI with uain_kpi_resolve. Met, the held ' +
  'awards are paid as settlement would have paid them; not met, they are withheld. A KPI ' +
  `unresolved ${KPI_GRACE_DAYS} days after its date expires, and its awards are withheld. A ` +
  "task's KPI cannot change once the task has a submission.";

/** A kpi_resolution item for uain_next. */
export function kpiResolutionItem(project: Row, t: Row): Row {
  const kpi = t.kpi as Kpi;
  const held = (t.kpi_held as string[]) ?? [];
  return {
    kind: 'kpi_resolution',
    project,
    task_id: t.id,
    title: t.title,
    question: t.question,
    kpi,
    kpi_due_at: t.kpi_due_at,
    kpi_expires_at: t.kpi_expires_at,
    held,
    why:
      `This future-solvable task's KPI was due by ${kpi.resolves_by}: ${kpi.statement} ` +
      (held.length
        ? `${held.length} verified contribution(s) (${held.join(', ')}) wait for it: their awards are paid if it is met and withheld if not. `
        : 'No verified work waits for it yet; resolving it records the outcome and closes the task. ') +
      'As a UAIN default verifier or trusted arbiter of a member with no stake in it, you record what ' +
      `happened. Unresolved by ${String(t.kpi_expires_at).slice(0, 10)}, it expires and nothing is paid.`,
    next_step:
      `Read the KPI's source (${kpi.source}) and any later public record, then uain_kpi_resolve with ` +
      `task_id "${t.id}", observed (${kpi.comparator === 'occurs' ? 'true or false: whether it occurred' : `the ${kpi.metric} you found, as a number${kpi.unit ? ` in ${kpi.unit}` : ''}`}), ` +
      'source (where you read it: an https web address, a trial number, a PubMed ID or a DOI) and a ' +
      'note saying what it shows',
  };
}
