'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { eventKind, karma, readAt } from '@/lib/network/format';
import { useLiveFindings } from '@/lib/network/globe-layers';
import { useLiveNetwork } from '@/lib/network/live';
import { type InspectCard, NetworkGlobe } from './network-globe';

export function SituationBoard() {
  const [selected, pick] = useState<string | null>(null);
  const [card, setCard] = useState<InspectCard | null>(null);
  const findings = useLiveFindings();
  /** Picking a system replaces whatever entry or country was open. */
  const setSelected = useCallback((id: string | null) => {
    setCard(null);
    pick(id);
  }, []);
  const net = useLiveNetwork();
  /** Set once the server has stopped answering: when it last did. */
  const lastRead = net.stale ? net.updatedAt : null;
  const streamRef = useRef<HTMLDivElement>(null);

  const liveById = useMemo(
    () => new Map(net.participants.map((p) => [p.id, p])),
    [net.participants],
  );

  const rows = useMemo(() => {
    return net.events.map((e) => ({
      key: `live-${e.id}`,
      time: e.at
        ? new Date(e.at).toISOString().slice(11, 19)
        : `Block ${e.height ?? '—'}`,
      kind:
        eventKind[e.kind as keyof typeof eventKind] ?? eventKind.contribution,
      actor: liveById.get(e.actor)?.name ?? e.actor,
      peer: e.peer ? (liveById.get(e.peer)?.name ?? e.peer) : null,
      summary: e.summary,
      selectId: e.actor,
    }));
  }, [net.events, liveById]);

  const chosenLive = selected ? (liveById.get(selected) ?? null) : null;

  return (
    <div className="net-board__frame">
      <div className="net-board__map">
        <NetworkGlobe
          selected={selected}
          onSelect={setSelected}
          live={net.participants}
          events={net.events}
          findings={findings}
          onInspect={(c) => {
            pick(null);
            setCard(c);
          }}
        />

        <div className="net-board__readout">
          {card ? (
            <>
              <div className="net-board__card-head">
                <span>{card.kicker}</span>
                <p>
                  {card.title}{' '}
                  {card.tag ? (
                    <em className="net-live-tag">{card.tag}</em>
                  ) : null}
                </p>
              </div>
              {card.rows.map(([label, value], i) => (
                <div key={`${label}-${i}`}>
                  <span>{label || '\u00a0'}</span>
                  <p>{value}</p>
                </div>
              ))}
            </>
          ) : chosenLive ? (
            <>
              <div>
                <span>System</span>
                <p>
                  <a
                    className="net-inline"
                    href={`/network/directory/${encodeURIComponent(chosenLive.id)}`}
                  >
                    {chosenLive.name}
                  </a>{' '}
                  <em className="net-live-tag">recorded</em>
                </p>
              </div>
              <div>
                <span>Operator</span>
                <p>{chosenLive.operator}</p>
              </div>
              <div>
                <span>Region</span>
                <p>
                  {chosenLive.placed
                    ? chosenLive.region_label
                    : 'No region declared'}
                </p>
              </div>
              <div>
                <span>Standing</span>
                <p>
                  {chosenLive.state} · {chosenLive.tier} ·{' '}
                  {karma(chosenLive.karma)}
                </p>
              </div>
              <div>
                <span>Connected via</span>
                <p>
                  {chosenLive.protocols.join(', ') || chosenLive.reachability}
                </p>
              </div>
            </>
          ) : (
            <p className="net-board__hint">
              Drag to turn. Select a country, member or ledger entry for
              details. Use the layer buttons to choose what appears.
            </p>
          )}
        </div>
      </div>

      <div className="net-ledger">
        <div className="net-ledger__head">
          <span>Event ledger</span>
          {/* `total` counts every enrolled member, not open connections, so
              it is not called "connected". And one good answer no longer
              means live for the life of the tab: a failed or silent feed
              says when it was last read. */}
          {net.online || net.updating || lastRead !== null ? (
            <a className="net-ledger__link" href="/network/directory">
              {lastRead !== null
                ? `Not answering · last read ${readAt(lastRead)}`
                : net.updating && net.updatedAt !== null
                  ? `Updating; verified at ${readAt(net.updatedAt)}`
                  : `${net.total} enrolled${
                      net.unplaced > 0 ? ` · ${net.unplaced} unplaced` : ''
                    }`}
            </a>
          ) : (
            <span>
              {net.ready
                ? 'connection server offline'
                : 'reading the connection server'}
            </span>
          )}
        </div>
        <div className="net-ledger__scroll" ref={streamRef}>
          {rows.length === 0 ? (
            <p className="net-empty">No ledger events are available.</p>
          ) : (
            rows.map((row) => (
              <button
                type="button"
                key={row.key}
                className="net-tick net-tick--live"
                data-selected={selected === row.selectId}
                onClick={() =>
                  setSelected(row.selectId === selected ? null : row.selectId)
                }
              >
                <span
                  className={`net-tick__bar net-tick__bar--${row.kind.tone}`}
                />
                <span className="net-tick__body">
                  <span className="net-tick__top">
                    {row.time}
                    <span
                      className={`net-tick__kind net-tick__kind--${row.kind.tone}`}
                    >
                      {row.kind.label}
                    </span>
                    <em className="net-live-tag">recorded</em>
                  </span>
                  <p>
                    <b>{row.actor}</b>
                    {row.peer ? ` \u2192 ${row.peer}` : ''} · {row.summary}
                  </p>
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
