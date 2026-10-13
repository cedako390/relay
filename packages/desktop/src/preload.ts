import { contextBridge, ipcRenderer } from 'electron';

// Keep in sync with packages/web/src/lib/native.ts.
contextBridge.exposeInMainWorld('orch', {
  pickFolder: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder', defaultPath),
});
