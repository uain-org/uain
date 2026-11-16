import React, { useEffect, useRef, useState } from 'react';
import { api } from './identity.js';
import { nativeProofFreshness } from './native-balance.js';
import {
  nativeWorkCurrentPath,
  createNativeWorkCurrentReader,
} from './native-work-current-view.js';
import NativeWorkClaim from './NativeWorkClaim.jsx';

export default function NativeWorkCurrent({
  identity,
  address,
  binding,
  onClose,
}) {
  const [state, setState] = useState(null),
    reader = useRef(null);
  let path = null;
  try {
    path = nativeWorkCurrentPath(identity?.address, address, binding);
  } catch {}
  if (!reader.current)
    reader.current = createNativeWorkCurrentReader({
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
    available = view?.available && nativeProofFreshness(view.proof).fresh;
  return (
    <section className="panel settings-panel">
      <h2>Current native work status</h2>
      <p>
        Selected work: {binding.workId} · Project: {binding.projectId} · Task:{' '}
        {binding.taskId}.
      </p>
      <p>
        This separate read checks the selected work's operational status. It
        does not change the imported history above.
      </p>
      <button
        className="button"
        type="button"
        disabled={selected?.loading}
        onClick={() => reader.current.read()}
      >
        {selected?.loading
          ? 'Reading current status…'
          : selected?.requested
            ? 'Refresh current status'
            : 'Read current native status'}
      </button>
      <button
        className="button"
        type="button"
        onClick={() => {
          reader.current.dispose();
          onClose();
        }}
      >
        Close current status
      </button>
      <p role="status" aria-live="polite">
        {selected?.loading
          ? 'Reading one bounded, signed native status selection…'
          : available
            ? 'Current proof · selected operational status only.'
            : selected?.error ||
              'No current status is qualified. Use Read current native status to check.'}
      </p>
      {available && (
        <>
          <p>
            Native work state: {view.work.state}. Pending:{' '}
            {view.work.pending || 'none reported'}. Withheld:{' '}
            {view.work.withheld || 'none reported'}.
          </p>
          <p>
            Status source: <code>{view.work.statusSourceKey}</code>. Record
            source: <code>{view.work.recordSourceKey}</code>.
          </p>
          <p>
            Native task state: {view.task.state}. Kind: {view.task.kind}.
            Outcome: {view.task.outcome || 'none reported'}.
          </p>
          <p>
            Task source: <code>{view.task.sourceKey}</code>.
          </p>
          <p>
            Native project state: {view.project.state}. Source:{' '}
            <code>{view.project.sourceKey}</code>.
          </p>
          <p className="fine-print">
            Native height {view.proof.height} · Header {view.proof.headerTime}.
          </p>
        </>
      )}
      <p className="fine-print">
        Claim beliefs and AI$ payment are not established by this record. A
        recorded status does not establish new scientific confirmation,
        eligibility or private project permissions.
      </p>
      <NativeWorkClaim identity={identity} address={address} binding={binding} />
    </section>
  );
}
