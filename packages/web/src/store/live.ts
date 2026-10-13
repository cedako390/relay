import type { Message, ServerEvent, Session, SessionEvent, Task } from '@orch/shared';
import { create } from 'zustand';

const MAX_EVENTS_PER_SESSION = 100;

interface LiveState {
  connected: boolean;
  sessions: Record<string, Session>;
  tasks: Record<string, Task>;
  /** Oldest first. */
  messages: Record<string, Message[]>;
  /** Newest first. */
  events: Record<string, SessionEvent[]>;

  setConnected: (connected: boolean) => void;
  setSessions: (list: Session[]) => void;
  setTasks: (list: Task[]) => void;
  mergeMessages: (sessionId: string, list: Message[]) => void;
  mergeEvents: (sessionId: string, list: SessionEvent[]) => void;
  apply: (event: ServerEvent) => void;
}

const byId = <T extends { id: string }>(list: T[]): Record<string, T> => Object.fromEntries(list.map((x) => [x.id, x]));

function upsertMessage(list: Message[] = [], message: Message): Message[] {
  const i = list.findIndex((m) => m.id === message.id);
  if (i === -1) return [...list, message].sort((a, b) => a.createdAt - b.createdAt);
  const next = list.slice();
  next[i] = message;
  return next;
}

function mergeEventLists(current: SessionEvent[] = [], incoming: SessionEvent[]): SessionEvent[] {
  const seen = new Set<number>();
  return [...incoming, ...current]
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => b.id - a.id)
    .slice(0, MAX_EVENTS_PER_SESSION);
}

export const useLive = create<LiveState>((set) => ({
  connected: false,
  sessions: {},
  tasks: {},
  messages: {},
  events: {},

  setConnected: (connected) => set({ connected }),
  setSessions: (list) => set({ sessions: byId(list) }),
  setTasks: (list) => set({ tasks: byId(list) }),

  mergeMessages: (sessionId, list) =>
    set((s) => ({ messages: { ...s.messages, [sessionId]: list.reduce(upsertMessage, s.messages[sessionId] ?? []) } })),

  mergeEvents: (sessionId, list) => set((s) => ({ events: { ...s.events, [sessionId]: mergeEventLists(s.events[sessionId], list) } })),

  apply: (event) =>
    set((s) => {
      switch (event.type) {
        case 'session':
          return { sessions: { ...s.sessions, [event.session.id]: event.session } };
        case 'task':
          return { tasks: { ...s.tasks, [event.task.id]: event.task } };
        case 'task_deleted': {
          const { [event.id]: _removed, ...rest } = s.tasks;
          return { tasks: rest };
        }
        case 'message':
          return {
            messages: { ...s.messages, [event.message.sessionId]: upsertMessage(s.messages[event.message.sessionId], event.message) },
          };
        case 'event':
          return {
            events: { ...s.events, [event.event.sessionId]: mergeEventLists(s.events[event.event.sessionId], [event.event]) },
          };
        case 'hello':
          return {};
      }
    }),
}));
