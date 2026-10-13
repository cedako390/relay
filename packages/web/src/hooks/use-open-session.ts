import { isActiveSessionStatus } from '@orch/shared';
import { useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { api } from '@/lib/api';
import { useLive } from '@/store/live';

/** A normal left click (not ctrl/cmd/shift/alt-click, which should keep the browser's own link behaviour). */
export const isPlainClick = (e: MouseEvent): boolean => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Opens a session in the main area. A finished session is brought back with `claude --resume` first
 * (the terminal socket only exists once the process does); if that fails, the page still opens and
 * offers a retry together with the reason.
 */
export function useOpenSession(): (id: string) => Promise<void> {
  const navigate = useNavigate();
  return useCallback(
    async (id: string) => {
      const session = useLive.getState().sessions[id];
      if (session && !isActiveSessionStatus(session.status)) {
        try {
          await api.resumeSession(id);
        } catch {
          // the page's Resume button retries and shows the reason
        }
      }
      await navigate({ to: '/sessions/$sessionId', params: { sessionId: id } });
    },
    [navigate],
  );
}
