import React, { useEffect, useRef, useState } from 'react';
import { api } from './identity.js';
import { nativeProofFreshness } from './native-balance.js';
import {
  nativeWorkClaimPath,
  createNativeWorkClaimReader,
} from './native-work-claim-view.js';

const actionLabel = (action) =>
  ({ create: 'Create', edit: 'Edit', retract: 'Retraction' })[action] ?? action;

function ClaimRevision({ title, revision }) {
  return (
    <>
      <h4>{title}</h4>
      <p>{revision.statement}</p>
      {revision.action === 'retract' && (
        <p>
          Retraction: this revision records a withdrawal. It is not positive
          confirmation of the claim, whatever its recorded state.
        </p>
      )}
      <p>
        Recorded state: {revision.state}. Recorded action:{' '}
        {actionLabel(revision.action)}.
      </p>
      <p>
        Revision: <code>{revision.id}</code>. Based on:{' '}
        {revision.base ? <code>{revision.base}</code> : 'none'}.
      </p>
      {revision.sources.length > 0 ? (
        <ul aria-label={`Sources for ${title.toLowerCase()}`}>
          {revision.sources.map((source) => (
            <li key={source}>
              <code>{source}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p>No sources are reported for this revision.</p>
      )}
    </>
  );
}

export default function NativeWorkClaim({ identity, address, binding }) {
  const [state, setState] = useState(null),
    reader = useRef(null);
  let path = null;
  try {
    path = nativeWorkClaimPath(identity?.address, address, binding);
  } catch {}
  if (!reader.current)
    reader.current = createNativeWorkClaimReader({
      request: api,
      publish: setState,
    });
  useEffect(() => {
    if (path) reader.current.select(identity, address, binding);
    else {
      reader.current.dispose();
      setState(null);
    }
    return () => reader.current.dispose();
  }, [identity, path]);
  useEffect(() => {
    const visible = () => {
      if (!document.hidden) reader.current.checkFreshness();
    };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, []);
  if (!path) return null;
  const selected =
    state?.owner === identity && state?.path === path ? state : null;
  const view = selected?.view,
    available = view?.available && nativeProofFreshness(view.proof).fresh,
    claim = available && view.association === 'present' ? view.claim : null,
    absent =
      available && view.association === 'absent' && view.claim === null,
    qualified = Boolean(claim || absent);
  return (
    <section aria-label="Selected work claim provenance">
      <h3>Selected work claim provenance</h3>
      <p>
        This separate read checks the claim associated with the selected work.
        It does not change the current status or the imported history above.
      </p>
      <button
        className="button"
        type="button"
        disabled={selected?.loading}
        onClick={() => reader.current.read()}
      >
        {selected?.loading
          ? 'Reading claim provenance…'
          : selected?.requested
            ? 'Refresh claim provenance'
            : 'Read selected claim provenance'}
      </button>
      <p role="status" aria-live="polite">
        {selected?.loading
          ? 'Reading one bounded, signed claim provenance selection…'
          : qualified
            ? 'Current proof · selected claim provenance only.'
            : selected?.error ||
              'No claim provenance is qualified. Use Read selected claim provenance to check.'}
      </p>
      {absent && (
        <p>
          This snapshot reports no claim associated with the selected work. That
          covers this work and snapshot only. It does not establish that no
          claim or history exists elsewhere.
        </p>
      )}
      {claim && (
        <>
          <p>
            Claim: <code>{claim.id}</code>. Project: {claim.projectId}.
          </p>
          <p>
            Claim source: <code>{claim.sourceKey}</code>. Association source:{' '}
            <code>{claim.associationSourceKey}</code>.
          </p>
          <ClaimRevision
            title="Revision associated with this work"
            revision={claim.associatedRevision}
          />
          {claim.believedRevision ? (
            <ClaimRevision
              title="Currently believed revision"
              revision={claim.believedRevision}
            />
          ) : (
            <>
              <h4>Currently believed revision</h4>
              <p>
                No currently believed revision is reported by this snapshot.
                This does not mean a retraction or a scientific refutation.
              </p>
            </>
          )}
        </>
      )}
      {qualified && (
        <p className="fine-print">
          Native height {view.proof.height} · Header {view.proof.headerTime}.
        </p>
      )}
      <p className="fine-print">
        This is selected, bounded native claim and revision provenance, not
        complete history. Trust is not evaluated. Independent scientific
        confirmation and checker consensus are not established. No eligibility,
        payment or reward is inferred, and AI$ payment is not established by
        this record.
      </p>
    </section>
  );
}
