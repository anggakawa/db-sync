import { useEffect, useRef } from 'react';
import type { SyncOutcome, SyncStep } from '../../shared/types';
import { outcomeText, STEP_ORDER, stepLabel, visibleDetails } from '../copy';

export interface RunState {
  profileId: string;
  kind: 'sync' | 'restore' | 'recover';
  step: SyncStep | null;
  label: string;
  percent: number | null;
  log: string[];
  cancelling: boolean;
}

const KIND_TITLE = { sync: 'Syncing', restore: 'Restoring previous local data', recover: 'Recovering the unfinished sync' } as const;

export function SyncPanel({ run, onCancel }: { run: RunState; onCancel: () => void }) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log.length]);

  const current = run.step ? STEP_ORDER.indexOf(run.step) : -1;
  const pct = run.percent === null ? null : Math.max(0, Math.min(100, Math.round(run.percent)));
  return (
    <section className="run" aria-label={KIND_TITLE[run.kind]}>
      <div className="run-head">
        <strong>{KIND_TITLE[run.kind]}</strong>
        {run.kind === 'sync' && (
          <ol className="steps" aria-label="Steps">
            {STEP_ORDER.map((s, i) => (
              <li key={s} className={i < current ? 'done' : i === current ? 'active' : ''} aria-current={i === current ? 'step' : undefined}>{stepLabel(s)}</li>
            ))}
          </ol>
        )}
      </div>
      <div className="progress-line">
        <div className="progress" role="progressbar" aria-label={run.label || 'Progress'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
          <div className={pct === null ? 'bar indeterminate' : 'bar'} style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
        <span className="progress-text">{run.label || 'Working...'}{pct !== null ? ` (${pct}%)` : ''}</span>
      </div>
      <pre className="log" role="log" aria-label="Live log" ref={logRef} tabIndex={0}>{run.log.length ? run.log.join('\n') : 'Waiting for output...'}</pre>
      <div className="row-actions">
        <button type="button" onClick={onCancel} disabled={run.cancelling || run.kind === 'recover'}>{run.cancelling ? 'Cancelling...' : 'Cancel'}</button>
        {run.kind === 'recover' && <span className="muted">Recovery cannot be cancelled.</span>}
      </div>
    </section>
  );
}

/** The result of the last run. While a sync is unfinished, "nothing changed" never reads as "your data is fine". */
export function ResultNotice({ outcome, unfinished }: { outcome: SyncOutcome; unfinished: boolean }) {
  const { title, body: text } = outcomeText(outcome, unfinished);
  const tone = outcome.status === 'success' ? 'ok' : outcome.status === 'cancelled' ? 'neutral' : 'bad';
  const details = outcome.status === 'failed' ? visibleDetails(outcome.details) : '';
  const warnings = outcome.status === 'success' ? outcome.warnings : [];
  return (
    <div className={`result ${tone}`} role="status">
      <p className="result-title">{title}</p>
      <p className="result-body">{text}</p>
      {warnings.length > 0 && (
        <ul className="warning-list">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>
      )}
      {details && (
        <details>
          <summary>Show details</summary>
          <pre className="details">{details}</pre>
        </details>
      )}
    </div>
  );
}
