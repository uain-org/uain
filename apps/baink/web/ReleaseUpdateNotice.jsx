import React, { useState, useEffect } from 'react';
import { reloadBlocked } from './release-update.js';

/** Explicit refresh only. Reuses existing BAINK notice/button styles. */
export default function ReleaseUpdateNotice({ update, activity, signedIn, identityToken, persisted, onReload, onDismiss }) {
  const [backupFor, setBackupFor] = useState(null);
  const backup = backupFor === identityToken && backupFor !== null;
  useEffect(() => setBackupFor(null), [identityToken]);
  if (!update) return null;
  const blocked = activity.writes > 0;
  return <section className="notice" role="status" aria-label="Page update" style={{position:'fixed',bottom:16,right:16,zIndex:1000,width:'min(440px, calc(100vw - 32px))',boxSizing:'border-box',padding:16,background:'white',border:'1px solid #d9e3f0',boxShadow:'0 4px 24px #17283e22'}}>
    <strong>{update.changed ? 'A new version is available.' : 'This page could not load part of the app.'}</strong>
    <p>Unsent form edits will be lost. Reload does not resend any action.</p>
    {blocked && <p>Wait for the current action to finish.</p>}
    {activity.uncertain && <p>An action may have reached the server. After reloading, check its recorded status before trying it again.</p>}
    {signedIn && (persisted ? <p>Your kept device session will be restored if it is still valid.</p> : <label className="check"><input type="checkbox" checked={backup} onChange={e=>setBackupFor(e.target.checked ? identityToken : null)}/> I have my identity backup. Reloading will sign me out.</label>)}
    <div style={{display:'flex',gap:8,marginTop:12,flexWrap:'wrap'}}>
      <button className="button small" disabled={blocked || (signedIn && !persisted && !backup)} onClick={()=>{ if (!reloadBlocked()) onReload(); }}>Reload page</button>
      <button className="button small" onClick={onDismiss}>Not now</button>
    </div>
  </section>;
}

/** Keep the notice alive if React's lazy landing chunk cannot load. */
export class ReleaseChunkBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(error) { this.props.onError(error); }
  render() { return this.state.error ? <div className="panel" role="alert">This part of the page could not load. Check your connection, then use Reload page.</div> : this.props.children; }
}
