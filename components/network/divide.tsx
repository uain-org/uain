import { readAt } from '@/lib/network/format';

/**
 * A compact heading for a list read from the connection server.
 */
export function Divide({
  tone,
  label,
  note,
  count,
  noun,
}: {
  tone: 'live';
  label: string;
  note: string;
  count: number;
  noun: string;
}) {
  return (
    <div className={`net-divide net-divide--${tone}`}>
      <span>
        <strong>{label}</strong>
        <small>{note}</small>
      </span>
      <span className="net-divide__count">
        {count} {noun}
        {count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export const CONNECTED_NOTE = 'Read from the connection server.';

/** For records still on screen after the server stopped answering. */
export const staleNote = (okAt: number) =>
  `The connection server has not answered since ${readAt(okAt)}. What is shown is the last it sent, and may be out of date.`;

/**
 * The line a live-only table shows in place of its rows, or above them, when
 * the connection server is not answering. Null when there is nothing to say.
 */
export function feedLine(
  status: { okAt: number | null; stale: boolean; updating?: boolean },
  hasRows: boolean,
) {
  if (!status.stale)
    return status.updating
      ? status.okAt === null
        ? 'Updating public records…'
        : `Updating; verified at ${readAt(status.okAt)}.`
      : null;
  if (status.okAt !== null) return staleNote(status.okAt);
  return hasRows
    ? 'The connection server is not answering. What is shown is from an earlier read, and may be out of date.'
    : 'The connection server is not answering, so there is nothing to show. Nothing is filled in instead.';
}
