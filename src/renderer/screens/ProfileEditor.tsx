import { useState, type ReactNode } from 'react';
import type { ConnectionSide, ConnectionTestResult } from '../../shared/api';
import type { Engine, ProfileInput, ProfileView } from '../../shared/types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { errorMessage } from '../errors';

interface SideForm { host: string; port: string; user: string; password: string; noPassword: boolean; database: string }
interface Form { name: string; engine: Engine; backupEnabled: boolean; source: SideForm & { ssl: boolean }; target: SideForm }

const FLAVOR = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB' } as const;
const DEFAULT_PORT: Record<Engine, string> = { postgres: '5432', mysql: '3306' };

function blankSide(engine: Engine, host: string): SideForm {
  return { host, port: DEFAULT_PORT[engine], user: '', password: '', noPassword: false, database: '' };
}

function fromView(p: ProfileView): Form {
  // A stored empty password shows as "No password" ticked; an unreadable one has to be typed again.
  const side = (e: ProfileView['target']): SideForm => ({
    host: e.host, port: String(e.port), user: e.user, password: '', noPassword: !e.hasPassword && !e.passwordUnreadable, database: e.database,
  });
  return { name: p.name, engine: p.engine, backupEnabled: p.backupEnabled, source: { ...side(p.source), ssl: p.source.ssl }, target: side(p.target) };
}

function emptyForm(): Form {
  return { name: '', engine: 'postgres', backupEnabled: true, source: { ...blankSide('postgres', ''), ssl: false }, target: blankSide('postgres', 'localhost') };
}

function passwordOf(s: SideForm): string | undefined {
  if (s.noPassword) return '';
  return s.password !== '' ? s.password : undefined; // undefined keeps the stored password
}

/** Built field by field: the API rejects unknown fields, so a ProfileView is never spread into it. */
function buildInput(f: Form, id: string | undefined): ProfileInput {
  const password = (s: SideForm) => { const v = passwordOf(s); return v === undefined ? {} : { password: v }; };
  return {
    ...(id !== undefined && { id }),
    name: f.name.trim(),
    engine: f.engine,
    backupEnabled: f.backupEnabled,
    source: { host: f.source.host.trim(), port: Number(f.source.port), user: f.source.user, database: f.source.database.trim(), ssl: f.source.ssl, ...password(f.source) },
    target: { host: f.target.host.trim(), port: Number(f.target.port), user: f.target.user, database: f.target.database.trim(), ...password(f.target) },
  };
}

type Problems = Partial<Record<'name' | 'source' | 'target', string>>;

function validPort(v: string): boolean {
  const n = Number(v);
  return /^\d+$/.test(v.trim()) && n >= 1 && n <= 65535;
}

function sideProblem(label: string, s: SideForm, saved: ProfileView['target'] | undefined, hostChanged: boolean): string | null {
  if (!s.host.trim()) return `Enter the ${label} host.`;
  if (!validPort(s.port)) return `The ${label} port must be a number from 1 to 65535.`;
  if (!s.user.trim()) return `Enter the ${label} user.`;
  if (!s.database.trim()) return `Enter the ${label} database name.`;
  if (passwordOf(s) === undefined) {
    if (!saved) return `Enter the ${label} password, or tick No password.`;
    if (saved.passwordUnreadable) return `The saved ${label} password can't be read any more. Enter it again, or tick No password.`;
    if (hostChanged) return `The ${label} host or port changed. Enter the ${label} password again, or tick No password.`;
  }
  return null;
}

export function ProfileEditor({ profile, onSaved, onCancel, onDeleted }: {
  profile: ProfileView | null; onSaved: () => void; onCancel: () => void; onDeleted: () => void;
}) {
  const [form, setForm] = useState<Form>(() => (profile ? fromView(profile) : emptyForm()));
  const [tests, setTests] = useState<Partial<Record<ConnectionSide, ConnectionTestResult | 'testing'>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showProblems, setShowProblems] = useState(false);

  const changed = (side: 'source' | 'target') =>
    !!profile && (form[side].host.trim() !== profile[side].host || Number(form[side].port) !== profile[side].port);

  const problemFor = (side: 'source' | 'target') => sideProblem(side, form[side], profile?.[side], side === 'source' && changed('source'));
  const problems: Problems = {
    ...(form.name.trim() ? {} : { name: 'Enter a profile name.' }),
    ...(problemFor('source') ? { source: problemFor('source')! } : {}),
    ...(problemFor('target') ? { target: problemFor('target')! } : {}),
  };

  const update = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const updateSide = (side: 'source' | 'target', patch: Partial<SideForm & { ssl: boolean }>) => {
    setForm((f) => ({ ...f, [side]: { ...f[side], ...patch } }));
    setTests((t) => ({ ...t, [side]: undefined }));
  };
  const setEngine = (engine: Engine) => setForm((f) => {
    const swap = (s: SideForm): SideForm => (s.port === DEFAULT_PORT[f.engine] ? { ...s, port: DEFAULT_PORT[engine] } : s);
    return { ...f, engine, source: { ...f.source, ...swap(f.source) }, target: swap(f.target) };
  });

  async function test(side: ConnectionSide) {
    // Source-password rules apply to the source only, and a half-filled other side does not matter.
    const problem = problemFor(side);
    if (problem) { setTests((t) => ({ ...t, [side]: { ok: false, message: problem } })); return; }
    setTests((t) => ({ ...t, [side]: 'testing' }));
    try {
      const result = await window.dbSync.testConnection(buildInput(form, profile?.id), side);
      setTests((t) => ({ ...t, [side]: result }));
    } catch (err) {
      setTests((t) => ({ ...t, [side]: { ok: false, message: errorMessage(err) } }));
    }
  }

  async function save() {
    setError(null);
    if (Object.keys(problems).length > 0) { setShowProblems(true); return; }
    setSaving(true);
    try {
      await window.dbSync.saveProfile(buildInput(form, profile?.id));
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    if (!profile) return;
    try {
      await window.dbSync.deleteProfile(profile.id);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const sidePanel = (side: 'source' | 'target') => {
    const s = form[side];
    const saved = profile?.[side];
    const isSource = side === 'source';
    const t = tests[side];
    const unreadable = !!saved?.passwordUnreadable;
    const placeholder = s.noPassword ? 'No password' : unreadable ? 'Enter the password again' : saved?.hasPassword && !changed(side) ? 'Saved' : '';
    const needsPassword = !s.noPassword && s.password === '';
    const hint = !needsPassword ? null
      : unreadable ? "The saved password can't be read any more. Enter it again."
      : isSource && changed('source') && profile ? 'The host or port changed, so the saved password is no longer used. Enter it again.'
      : null;
    // A password problem that the hint already explains is not repeated.
    const sideProblemText = showProblems && problems[side] && !(hint && problems[side]!.includes('password')) ? problems[side] : undefined;
    return (
      <fieldset className={`side ${side}`}>
        <legend>{isSource ? 'Source (dev, read-only)' : 'Target (local, overwritten)'}</legend>
        <div className="grid-host">
          <Field label="Host"><input value={s.host} onChange={(e) => updateSide(side, { host: e.target.value })} spellCheck={false} autoComplete="off" /></Field>
          <Field label="Port"><input value={s.port} onChange={(e) => updateSide(side, { port: e.target.value })} inputMode="numeric" autoComplete="off" /></Field>
        </div>
        <Field label="User"><input value={s.user} onChange={(e) => updateSide(side, { user: e.target.value })} spellCheck={false} autoComplete="off" /></Field>
        <Field label="Password">
          <input
            type="password" value={s.password} placeholder={placeholder} disabled={s.noPassword} autoComplete="new-password"
            onChange={(e) => updateSide(side, { password: e.target.value })}
          />
        </Field>
        <label className="check">
          <input type="checkbox" checked={s.noPassword} onChange={(e) => updateSide(side, { noPassword: e.target.checked, password: '' })} />
          <span>No password</span>
        </label>
        {hint && <p className="hint warn-text">{hint}</p>}
        <Field label="Database name"><input value={s.database} onChange={(e) => updateSide(side, { database: e.target.value })} spellCheck={false} autoComplete="off" /></Field>
        {isSource && (
          <Field label="SSL">
            <select value={form.source.ssl ? 'required' : 'off'} onChange={(e) => updateSide('source', { ssl: e.target.value === 'required' })}>
              <option value="off">Off</option>
              <option value="required">Required</option>
            </select>
          </Field>
        )}
        {sideProblemText && <p className="field-error" role="alert">{sideProblemText}</p>}
        <div className="row-actions">
          <button type="button" onClick={() => void test(side)} disabled={t === 'testing'}>{t === 'testing' ? 'Testing...' : 'Test connection'}</button>
          <span className="test-result" role="status">
            {t && t !== 'testing' && (t.ok
              ? <span className="ok-text">Connected: {FLAVOR[t.flavor]} {t.versionLabel}</span>
              : <span className="error-text">{t.message}</span>)}
          </span>
        </div>
      </fieldset>
    );
  };

  return (
    <main className="screen">
      <header className="screen-head">
        <h1>{profile ? 'Edit profile' : 'New profile'}</h1>
      </header>
      <form className="editor" onSubmit={(e) => { e.preventDefault(); void save(); }} noValidate>
        <div className="top-fields">
          <Field label="Profile name">
            <input value={form.name} onChange={(e) => update({ name: e.target.value })} autoComplete="off" />
          </Field>
          <Field label="Engine">
            <select value={form.engine} onChange={(e) => setEngine(e.target.value as Engine)}>
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
            </select>
          </Field>
        </div>
        {showProblems && problems.name && <p className="field-error" role="alert">{problems.name}</p>}
        <div className="sides">{sidePanel('source')}{sidePanel('target')}</div>
        <label className="check">
          <input type="checkbox" checked={form.backupEnabled} onChange={(e) => update({ backupEnabled: e.target.checked })} />
          <span>Back up local data before overwriting</span>
        </label>
        {error && <div className="banner bad" role="alert">{error}</div>}
        <div className="editor-actions">
          <button type="submit" className="primary" disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          <button type="button" onClick={onCancel}>Cancel</button>
          {profile && <button type="button" className="danger-quiet" onClick={() => setConfirmDelete(true)}>Delete profile</button>}
        </div>
      </form>
      {confirmDelete && profile && (
        <ConfirmDialog
          title="Delete profile"
          message={`Delete the profile \`${profile.name}\`?`}
          note="The databases themselves are not touched."
          confirmLabel="Delete profile" danger onConfirm={() => void remove()} onCancel={() => setConfirmDelete(false)}
        />
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}</label>;
}
