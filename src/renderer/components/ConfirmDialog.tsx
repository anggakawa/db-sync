import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** A modal that traps Tab, closes on Esc as a cancel, and gives focus back when it goes away. */
export function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    // Start on the safe choice: the Cancel button when there is one, else the first control.
    const first = root.querySelector<HTMLElement>('[data-initial-focus]') ?? root.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? root).focus();
    return () => { previous?.focus?.(); };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRef.current(); return; }
    if (e.key !== 'Tab') return;
    const items = [...ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === firstEl || active === ref.current)) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && active === lastEl) { e.preventDefault(); firstEl.focus(); }
  };

  return (
    <div className="backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Renders `text` with `backticked` parts as code. */
export function Inline({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>))}</>;
}

export interface ConfirmRow { label: string; where: string; database: string; tone: 'source' | 'target' }

export function ConfirmDialog(props: {
  title: string; message: string; rows?: ConfirmRow[]; note?: string;
  confirmLabel: string; danger?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={props.title} onCancel={props.onCancel}>
      <p className="confirm-message"><Inline text={props.message} /></p>
      {props.rows && (
        <div className="confirm-rows">
          {props.rows.map((r) => (
            <div key={r.label} className={`confirm-row ${r.tone}`}>
              <span className="confirm-label">{r.label}</span>
              <span className="confirm-db">{r.database}</span>
              <span className="confirm-where">{r.where}</span>
            </div>
          ))}
        </div>
      )}
      {props.note && <p className="muted">{props.note}</p>}
      <div className="dialog-actions">
        <button type="button" data-initial-focus onClick={props.onCancel}>Cancel</button>
        <button type="button" className={props.danger ? 'danger' : 'primary'} onClick={props.onConfirm}>{props.confirmLabel}</button>
      </div>
    </Modal>
  );
}
