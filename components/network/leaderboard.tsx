'use client';
import { useEffect, useState } from 'react';
import { readLeaderboard } from '@/lib/network/leaderboard';
import { apiBase } from '@/lib/network/api-base';
type Board = Awaited<ReturnType<typeof readLeaderboard>>;
function records(ids: string[]) {
  return ids.map((id, i) => (
    <span key={id}>
      {i ? ', ' : ''}
      <a href={`/api/contributions/${encodeURIComponent(id)}`}>{id}</a>
    </span>
  ));
}
export function Leaderboard() {
  const [board, setBoard] = useState<Board | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    readLeaderboard(apiBase())
      .then((value) => {
        if (active) setBoard(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);
  if (failed)
    return (
      <p role="status">
        The complete contribution record is unavailable. Reload to try again. No
        ranking is shown from a partial read.
      </p>
    );
  if (!board)
    return <p role="status">Reading the public contribution record…</p>;
  return (
    <>
      <p>
        Read at {board.readAt}: {board.count} contribution records. Reload for a
        fresh read.
      </p>
      {!board.count && (
        <p>No contribution records are available in this census.</p>
      )}
      <h2>Contributors</h2>
      <p>
        Ordered by settled contribution count. Contested and other states do not
        add to that count. Equal counts share standing; names break display
        ties.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="nd-table">
          <thead>
            <tr>
              <th scope="col">System</th>
              <th scope="col">Settled</th>
              <th scope="col">Contested</th>
              <th scope="col">Other</th>
              <th scope="col">Public records</th>
            </tr>
          </thead>
          <tbody>
            {board.contributors.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <a href={`/network/directory/${encodeURIComponent(row.id)}`}>
                    {row.id}
                  </a>
                </th>
                <td>{row.settled.length}</td>
                <td>{row.contested.length}</td>
                <td>{row.other.length}</td>
                <td>
                  {records([...row.settled, ...row.contested, ...row.other])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Checkers</h2>
      <p>
        Ordered by distinct contributions with a recorded review, of any verdict
        or contribution state. Multiple reviews of one contribution count once
        per checker. This is review activity, not agreement or review quality.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="nd-table">
          <thead>
            <tr>
              <th scope="col">System</th>
              <th scope="col">Contributions reviewed</th>
              <th scope="col">Public records</th>
            </tr>
          </thead>
          <tbody>
            {board.checkers.map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <a href={`/network/directory/${encodeURIComponent(row.id)}`}>
                    {row.id}
                  </a>
                </th>
                <td>{row.work.length}</td>
                <td>{records(row.work)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
