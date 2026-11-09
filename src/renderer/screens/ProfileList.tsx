import type { ProfileView, SyncOutcome } from '../../shared/types';
import { Logo } from '../components/Logo';
import { ResultNotice, SyncPanel, type RunState } from '../components/SyncPanel';

export interface ProfileListProps {
  profiles: ProfileView[] | null;
  run: RunState | null;
  results: Record<string, SyncOutcome>;
  onNew: () => void;
  onEdit: (id: string) => void;
  onSync: (p: ProfileView) => void;
  onRestore: (p: ProfileView) => void;
  onRecover: (p: ProfileView) => void;
  onCancel: () => void;
}

const ENGINE_LABEL = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB' } as const;

function unreadableSides(p: ProfileView): string {
  if (p.source.passwordUnreadable && p.target.passwordUnreadable) return 'The source and target passwords need re-entering.';
  return p.source.passwordUnreadable ? 'The source password needs re-entering.' : 'The target password needs re-entering.';
}

export function ProfileList(props: ProfileListProps) {
  const { profiles, run } = props;
  const busy = run !== null;
  return (
    <main className="screen">
      <header className="screen-head">
        <h1><Logo /></h1>
        <button type="button" className="primary" onClick={props.onNew} disabled={busy}>New profile</button>
      </header>
      {profiles === null && <p className="muted">Loading profiles...</p>}
      {profiles !== null && profiles.length === 0 && (
        <div className="empty">
          <p><strong>No profiles yet.</strong></p>
          <p className="muted">A profile says which development database to copy and which local database to overwrite with it.</p>
        </div>
      )}
      <ul className="cards">
        {profiles?.map((p) => {
          const running = run?.profileId === p.id ? run : null;
          const outcome = props.results[p.id] ?? p.lastResult;
          return (
            <li key={p.id} className="card">
              <div className="card-head">
                <div>
                  <h2>{p.name}</h2>
                  <span className="tag">{ENGINE_LABEL[p.engine]}</span>
                </div>
                <div className="row-actions">
                  <button type="button" className="primary" onClick={() => props.onSync(p)} disabled={busy}>Sync</button>
                  {p.hasBackup && <button type="button" onClick={() => props.onRestore(p)} disabled={busy}>Restore previous local data</button>}
                  <button type="button" onClick={() => props.onEdit(p.id)} disabled={running !== null}>Edit</button>
                </div>
              </div>
              <dl className="ends">
                <div className="end source"><dt>From</dt><dd><code>{p.source.host}:{p.source.port}</code> / <code>{p.source.database}</code></dd></div>
                <div className="end target"><dt>To</dt><dd><code>{p.target.host}:{p.target.port}</code> / <code>{p.target.database}</code></dd></div>
              </dl>
              {p.hasUnfinishedSync && !running && (
                <div className="banner warn" role="alert">
                  <div>
                    <strong>A sync did not finish.</strong>
                    <span> Your local database may be incomplete or missing until it is recovered.</span>
                  </div>
                  <button type="button" onClick={() => props.onRecover(p)} disabled={busy}>Recover</button>
                </div>
              )}
              {(p.source.passwordUnreadable || p.target.passwordUnreadable) && (
                <div className="banner warn" role="alert">
                  <div>
                    <strong>A saved password can't be read.</strong>
                    <span> {unreadableSides(p)} Re-enter the password for this profile before syncing.</span>
                  </div>
                  <button type="button" onClick={() => props.onEdit(p.id)} disabled={running !== null}>Edit</button>
                </div>
              )}
              {running ? (
                <SyncPanel run={running} onCancel={props.onCancel} />
              ) : outcome ? (
                <ResultNotice outcome={outcome} unfinished={p.hasUnfinishedSync} />
              ) : (
                <p className="muted">Not synced yet.</p>
              )}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
