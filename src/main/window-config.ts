import type { WebPreferences } from 'electron';

export const windowWebPreferences: WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};
