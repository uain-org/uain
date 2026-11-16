import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './identity.js';
import { nativeProofFreshness, watchNativeProof } from './native-balance.js';
import {
  nativeResearchView,
  nativeResearchPath,
  createNativeResearchGate,
} from './native-research-view.js';
import NativeWorkCurrent from './NativeWorkCurrent.jsx';

export default function NativeResearchRecord({ address, identity = null }) {
  const [currentSelection, setCurrentSelection] = useState(null),
    selectionSequence = useRef(0);
  useEffect(() => {
    setCurrentSelection(null);
  }, [identity, address]);
  const gate = useRef(null);
  if (!gate.current) gate.current = createNativeResearchGate();
  const snapshotRef = useRef(null),
    [snapshot, setSnapshot] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const load = useCallback(async () => {
    let context;
    try {
      const path = nativeResearchPath(address);
      context = gate.current.begin(address);
      snapshotRef.current = null;
      setSnapshot(null);
      setError('');
      setLoading(true);
      // This endpoint is public. Do not pass identity, signing data or account options.
      const payload = await api(path),
        view = nativeResearchView(payload, address);
      gate.current.apply(context, () => {
        if (!view.proofCurrent) {
          snapshotRef.current = null;
          setSnapshot(null);
          setError(view.notice);
          return;
        }
        const next = { address, context, payload };
        snapshotRef.current = next;
        setSnapshot(next);
      });
    } catch {
      const fail = () => {
        snapshotRef.current = null;
        setSnapshot(null);
        setError(
          'The native research record could not be read. Refresh to try again.',
        );
      };
      if (context) gate.current.apply(context, fail);
      else fail();
    } finally {
      if (context) gate.current.apply(context, () => setLoading(false));
      else setLoading(false);
    }
  }, [address]);
  useEffect(() => {
    load();
    return () => {
      gate.current.invalidate();
      snapshotRef.current = null;
    };
  }, [load]);
  useEffect(() => {
    if (!snapshot || snapshot.address !== address) return;
    const expire = () => {
      if (
        snapshotRef.current !== snapshot ||
        nativeProofFreshness(snapshot.payload.proof).fresh
      )
        return;
      gate.current.apply(snapshot.context, () => {
        gate.current.invalidate();
        snapshotRef.current = null;
        setSnapshot(null);
        setLoading(false);
        setError('The native proof expired. Refresh to read current records.');
      });
    };
    if (!nativeProofFreshness(snapshot.payload.proof).fresh) {
      expire();
      return;
    }
    return watchNativeProof(snapshot.payload.proof, expire);
  }, [snapshot, address]);
  useEffect(() => {
    const visible = () => {
      const current = snapshotRef.current;
      if (
        document.hidden ||
        !current ||
        current.address !== address ||
        nativeProofFreshness(current.payload.proof).fresh
      )
        return;
      gate.current.apply(current.context, () => {
        gate.current.invalidate();
        snapshotRef.current = null;
        setSnapshot(null);
        setLoading(false);
        setError(
          'The native proof expired while this page was away. Refresh to read current records.',
        );
      });
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [address]);
  const view = nativeResearchView(
    snapshot?.address === address ? snapshot.payload : null,
    address,
  );
  return (
    <>
      <section className="panel settings-panel">
        <h2>Native-committed research records</h2>
        <p>
          Historical imported work verified against the native ledger. Later
          native updates are outside this view. This bounded selection is not a
          complete native history and is separate from the self-declared profile
          and public HTTP projection.
        </p>
        <button
          className="button"
          type="button"
          disabled={loading}
          onClick={load}
        >
          {loading ? 'Reading native records…' : 'Refresh native records'}
        </button>
        <p role="status" aria-live="polite">
          {loading
            ? 'Reading a bounded public proof selection…'
            : view.proofCurrent
              ? view.records === null
                ? 'Current native member proof · research records unreported.'
                : view.status === 'partial'
                  ? 'Current proof · partial imported-record coverage.'
                  : 'Current proof · selected imported records only.'
              : error || view.notice}
        </p>
        {view.proofCurrent && (
          <>
            <p>
              Recorded member: {view.member.name || address}. Recorded licence:{' '}
              {view.member.licence || 'not included'}.
            </p>
            <p className="fine-print">
              Native height {view.proof.height} · Header {view.proof.headerTime}
              . The oldest qualified proof controls expiry.
            </p>
            {view.records === null ? (
              <p>
                Research records are unreported or unavailable in this
                selection. No achievement count is inferred.
              </p>
            ) : view.records.length === 0 ? (
              <p>
                No work records were returned within this bounded selection.
                This is not a zero-achievement or complete-history assertion.
              </p>
            ) : (
              <div className="request-list">
                {view.records.map((record) => (
                  <article className="request-row" key={record.id}>
                    <div className="request-main">
                      <h3>{record.id}</h3>
                      <p>
                        Project: {record.projectId} · Task: {record.taskId}
                      </p>
                      <p>
                        Imported state: {record.state || 'not included'} ·
                        Submitted: {record.submittedAt || 'not included'}
                      </p>
                      <p>
                        {record.claim ||
                          'No claim text is included in this record.'}
                      </p>
                      {identity?.address === address && (
                        <button
                          className="button"
                          type="button"
                          onClick={() =>
                            setCurrentSelection({
                              generation: ++selectionSequence.current,
                              binding: {
                                projectId: record.projectId,
                                taskId: record.taskId,
                                workId: record.id,
                                authorInstanceId: record.authorInstanceId,
                              },
                            })
                          }
                        >
                          Select for current status
                        </button>
                      )}
                      <p>
                        Recorded checking members:{' '}
                        {record.distinctCheckerMembers}. Non-author members with
                        recorded confirmed/new/original entries:{' '}
                        {record.distinctNonAuthorConfirmedNewMembers}.
                      </p>
                      <ul>
                        {record.checks.map((check, index) => (
                          <li
                            key={`${check.memberAddress}:${check.instanceId}:${index}`}
                          >
                            <code>{check.memberAddress}</code> ·{' '}
                            {check.instanceId}:{' '}
                            {check.verdict || 'verdict not included'},{' '}
                            {check.novelty || 'novelty not included'},{' '}
                            {check.original
                              ? 'original entry'
                              : 'not an original entry'}
                            .
                          </li>
                        ))}
                      </ul>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </>
        )}
        <p className="fine-print">
          This is evidence of committed imported records, not a fresh novelty
          review, paid AI$, earned balance, operator vetting or permission to
          access a private project.
        </p>
      </section>
      {identity?.address === address && currentSelection && (
        <NativeWorkCurrent
          key={`${address}:${currentSelection.generation}`}
          identity={identity}
          address={address}
          binding={currentSelection.binding}
          onClose={() => setCurrentSelection(null)}
        />
      )}
    </>
  );
}
