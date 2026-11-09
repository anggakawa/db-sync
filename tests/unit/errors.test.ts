import { describe, expect, it } from 'vitest';
import { SyncBusyError } from '../../src/shared/api';
import { errorMessage, isBusyError } from '../../src/renderer/errors';

const wrapped = (msg: string) => new Error(`Error invoking remote method 'dbsync:startSync': Error: ${msg}`);

describe('errors', () => {
  it('strips the IPC prefix', () => expect(errorMessage(wrapped('Nope.'))).toBe('Nope.'));
  it('leaves other messages alone', () => expect(errorMessage(new Error('Plain'))).toBe('Plain'));
  it('recognises the busy message after IPC, and the real error', () => {
    expect(isBusyError(wrapped(new SyncBusyError().message))).toBe(true);
    expect(isBusyError(new SyncBusyError())).toBe(true);
  });
  it('does not mistake other errors for busy', () => expect(isBusyError(wrapped('Something else.'))).toBe(false));
});
