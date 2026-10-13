import { serverEventSchema } from '@orch/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { useLive } from '@/store/live';

/**
 * Keeps the Zustand store live:
 *  - TanStack Query performs the initial load (and a reload after every reconnect);
 *  - the shared /ws/events socket then streams session, task, message and hook-event changes.
 */
export function useLiveSync(): void {
  const queryClient = useQueryClient();

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: api.sessions, staleTime: Infinity });
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: api.tasks, staleTime: Infinity });
  useEffect(() => {
    if (sessions.data) useLive.getState().setSessions(sessions.data);
  }, [sessions.data]);
  useEffect(() => {
    if (tasks.data) useLive.getState().setTasks(tasks.data);
  }, [tasks.data]);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: number | undefined;
    let closed = false;
    let attempt = 0;
    let everConnected = false;

    const connect = (): void => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${proto}//${window.location.host}/ws/events`);
      socket.onopen = () => {
        attempt = 0;
        useLive.getState().setConnected(true);
        // Anything may have changed while we were away: reload snapshots.
        if (everConnected) void queryClient.invalidateQueries();
        everConnected = true;
      };
      socket.onmessage = (msg: MessageEvent<string>) => {
        try {
          const parsed = serverEventSchema.safeParse(JSON.parse(msg.data));
          if (parsed.success) useLive.getState().apply(parsed.data);
        } catch {
          // ignore malformed frame
        }
      };
      socket.onclose = () => {
        useLive.getState().setConnected(false);
        if (closed) return;
        attempt += 1;
        timer = window.setTimeout(connect, Math.min(5000, 500 * attempt));
      };
    };
    connect();

    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [queryClient]);
}
