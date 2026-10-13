/** Bridge exposed by the Electron preload (packages/desktop/src/preload.ts); absent in a plain browser. */
interface OrchBridge {
  pickFolder(defaultPath?: string): Promise<string | null>;
}

declare global {
  interface Window {
    orch?: OrchBridge;
  }
}

export const canPickFolder = (): boolean => typeof window.orch?.pickFolder === 'function';

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  return (await window.orch?.pickFolder(defaultPath)) ?? null;
}
