import { describe, expect, it } from 'vitest';
import { windowWebPreferences } from '../../src/main/window-config';

describe('scaffold', () => {
  it('main window settings stay locked down', () => {
    expect(windowWebPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
  });
});
