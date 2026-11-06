import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type DbSyncApi } from '../shared/api';
import type { CheckIssue, SyncEvent } from '../shared/types';

// Only the fixed channels are reachable, and ipcRenderer itself is never handed to the page.
const api: DbSyncApi = {
  listProfiles: () => ipcRenderer.invoke(CHANNELS.listProfiles),
  saveProfile: (input) => ipcRenderer.invoke(CHANNELS.saveProfile, input),
  deleteProfile: (id) => ipcRenderer.invoke(CHANNELS.deleteProfile, id),
  testConnection: (input, side) => ipcRenderer.invoke(CHANNELS.testConnection, input, side),
  startSync: (id) => ipcRenderer.invoke(CHANNELS.startSync, id),
  restoreBackup: (id) => ipcRenderer.invoke(CHANNELS.restoreBackup, id),
  recover: (id) => ipcRenderer.invoke(CHANNELS.recover, id),
  cancel: () => ipcRenderer.invoke(CHANNELS.cancel),
  answerWarnings: (accept) => ipcRenderer.invoke(CHANNELS.answerWarnings, accept),
  onSyncEvent(handler) {
    const listener = (_e: IpcRendererEvent, profileId: string, event: SyncEvent) => handler(profileId, event);
    ipcRenderer.on(CHANNELS.syncEvent, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.syncEvent, listener); };
  },
  onWarnings(handler) {
    const listener = (_e: IpcRendererEvent, profileId: string, issues: CheckIssue[]) => handler(profileId, issues);
    ipcRenderer.on(CHANNELS.warnings, listener);
    return () => { ipcRenderer.removeListener(CHANNELS.warnings, listener); };
  },
};

contextBridge.exposeInMainWorld('dbSync', api);
