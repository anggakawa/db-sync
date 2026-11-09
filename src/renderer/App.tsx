import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckIssue, ProfileView, SyncOutcome } from '../shared/types';
import { ConfirmDialog } from './components/ConfirmDialog';
import type { RunState } from './components/SyncPanel';
import { WarningsDialog } from './components/WarningsDialog';
import { confirmRestoreText, confirmSyncText, errorMessage } from './copy';
import { ProfileEditor } from './screens/ProfileEditor';
import { ProfileList } from './screens/ProfileList';

type Screen = { name: 'list' } | { name: 'editor'; id: string | null };
type Pending = { kind: 'sync' | 'restore'; profile: ProfileView };

const MAX_LOG_LINES = 500;

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [profiles, setProfiles] = useState<ProfileView[] | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [results, setResults] = useState<Record<string, SyncOutcome>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [warnings, setWarnings] = useState<{ profileId: string; issues: CheckIssue[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const profilesRef = useRef<ProfileView[] | null>(null);
  profilesRef.current = profiles;

  const reload = useCallback(async () => {
    try {
      setProfiles(await window.dbSync.listProfiles());
    } catch (err) {
      setNotice(errorMessage(err));
      setProfiles((p) => p ?? []);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    const offEvents = window.dbSync.onSyncEvent((profileId, event) => {
      setRun((r) => {
        if (!r || r.profileId !== profileId) return r;
        if (event.type === 'step') return { ...r, step: event.step, label: '', percent: null };
        if (event.type === 'progress') return { ...r, label: event.label, percent: event.percent };
        return { ...r, log: [...r.log, event.line].slice(-MAX_LOG_LINES) };
      });
    });
    const offWarnings = window.dbSync.onWarnings((profileId, issues) => setWarnings({ profileId, issues }));
    return () => { offEvents(); offWarnings(); };
  }, []);

  async function execute(kind: RunState['kind'], profile: ProfileView) {
    setNotice(null);
    setResults(({ [profile.id]: _dropped, ...rest }) => rest);
    setRun({ profileId: profile.id, kind, step: null, label: '', percent: null, log: [], cancelling: false });
    try {
      const api = window.dbSync;
      const outcome = kind === 'sync' ? await api.startSync(profile.id) : kind === 'restore' ? await api.restoreBackup(profile.id) : await api.recover(profile.id);
      setResults((r) => ({ ...r, [profile.id]: outcome }));
    } catch (err) {
      // Includes "another sync is already running", which arrives as a message only.
      setNotice(errorMessage(err));
    } finally {
      setRun(null);
      setWarnings(null);
      await reload();
    }
  }

  async function answer(accept: boolean) {
    setWarnings(null);
    try {
      await window.dbSync.answerWarnings(accept);
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }

  async function cancel() {
    setRun((r) => (r ? { ...r, cancelling: true } : r));
    try {
      await window.dbSync.cancel();
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }

  const editing = screen.name === 'editor' ? (profiles?.find((p) => p.id === screen.id) ?? null) : null;
  const warningsProfile = warnings ? profiles?.find((p) => p.id === warnings.profileId) : undefined;

  const backToList = () => { setScreen({ name: 'list' }); void reload(); };

  return (
    <>
      {notice && (
        <div className="banner bad top-notice" role="alert">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      {screen.name === 'list' ? (
        <ProfileList
          profiles={profiles} run={run} results={results}
          onNew={() => setScreen({ name: 'editor', id: null })}
          onEdit={(id) => setScreen({ name: 'editor', id })}
          onSync={(p) => setPending({ kind: 'sync', profile: p })}
          onRestore={(p) => setPending({ kind: 'restore', profile: p })}
          onRecover={(p) => void execute('recover', p)}
          onCancel={() => void cancel()}
        />
      ) : (
        <ProfileEditor key={screen.id ?? 'new'} profile={editing} onSaved={backToList} onCancel={backToList} onDeleted={backToList} />
      )}
      {pending && (
        <ConfirmDialog
          title={pending.kind === 'sync' ? 'Overwrite local database?' : 'Restore previous local data?'}
          message={pending.kind === 'sync' ? confirmSyncText(pending.profile) : confirmRestoreText(pending.profile)}
          rows={pending.kind === 'sync'
            ? [
              { label: 'Source: copied from, not changed', tone: 'source', database: pending.profile.source.database, where: `${pending.profile.source.host}:${pending.profile.source.port}` },
              { label: 'Target: will be overwritten', tone: 'target', database: pending.profile.target.database, where: `${pending.profile.target.host}:${pending.profile.target.port}` },
            ]
            : [{ label: 'Target: will be replaced', tone: 'target', database: pending.profile.target.database, where: `${pending.profile.target.host}:${pending.profile.target.port}` }]}
          note={pending.kind === 'sync'
            ? (pending.profile.backupEnabled ? 'Your current local data is backed up first, and put back if the sync fails.' : 'Backups are off for this profile. If the sync fails, the local data cannot be put back.')
            : 'The local data as it is now is discarded.'}
          confirmLabel={pending.kind === 'sync' ? 'Overwrite' : 'Restore'}
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => { const p = pending; setPending(null); void execute(p.kind, p.profile); }}
        />
      )}
      {warnings && (
        <WarningsDialog profileName={warningsProfile?.name ?? warnings.profileId} issues={warnings.issues} onAnswer={(accept) => void answer(accept)} />
      )}
    </>
  );
}
