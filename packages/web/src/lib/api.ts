import {
  messageSchema,
  sessionEventSchema,
  sessionSchema,
  taskSchema,
  type CreateSessionBody,
  type CreateTaskBody,
  type Message,
  type Session,
  type SessionEvent,
  type Task,
  type UpdateTaskBody,
} from '@orch/shared';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const configSchema = z.object({
  allowedModels: z.array(z.string()),
  defaultModel: z.string().nullable(),
  maxWorkers: z.number(),
  maxDepth: z.number(),
  defaultCwd: z.string(),
  platform: z.string(),
});
export type ServerConfig = z.infer<typeof configSchema>;

async function request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // not JSON
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return schema.parse(undefined);
  return schema.parse(await res.json());
}

export const api = {
  config: () => request('GET', '/api/config', configSchema),
  sessions: () => request('GET', '/api/sessions', z.array(sessionSchema)),
  createSession: (body: CreateSessionBody) => request('POST', '/api/sessions', sessionSchema, body),
  resumeSession: (id: string) => request('POST', `/api/sessions/${id}/resume`, sessionSchema),
  killSession: (id: string) => request('DELETE', `/api/sessions/${id}`, sessionSchema),
  sessionEvents: (id: string, limit = 50) =>
    request('GET', `/api/sessions/${id}/events?limit=${limit}`, z.array(sessionEventSchema)),
  messages: (id: string) => request('GET', `/api/sessions/${id}/messages`, z.array(messageSchema)),
  postMessage: (id: string, body: string): Promise<Message> =>
    request('POST', `/api/sessions/${id}/messages`, messageSchema, { body }),
  tasks: () => request('GET', '/api/tasks', z.array(taskSchema)),
  createTask: (body: Omit<CreateTaskBody, 'description' | 'start'> & Partial<Pick<CreateTaskBody, 'description' | 'start'>>) =>
    request('POST', '/api/tasks', taskSchema, body),
  updateTask: (id: string, body: UpdateTaskBody) => request('PATCH', `/api/tasks/${id}`, taskSchema, body),
  startTask: (id: string) => request('POST', `/api/tasks/${id}/start`, taskSchema),
  deleteTask: (id: string) => request('DELETE', `/api/tasks/${id}`, z.undefined()),
};

export type { Message, Session, SessionEvent, Task };
