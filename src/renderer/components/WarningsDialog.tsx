import type { CheckIssue } from '../../shared/types';
import { Modal } from './ConfirmDialog';

export function WarningsDialog({ profileName, issues, onAnswer }: { profileName: string; issues: CheckIssue[]; onAnswer: (accept: boolean) => void }) {
  return (
    <Modal title="Before continuing" onCancel={() => onAnswer(false)}>
      <p>The checks for <strong>{profileName}</strong> found something you should know about. Nothing has been changed yet.</p>
      <ul className="warning-list">
        {issues.map((i, n) => <li key={`${i.code}-${n}`}>{i.message}</li>)}
      </ul>
      <div className="dialog-actions">
        <button type="button" data-initial-focus onClick={() => onAnswer(false)}>Cancel</button>
        <button type="button" className="primary" onClick={() => onAnswer(true)}>Continue</button>
      </div>
    </Modal>
  );
}
