import { z } from 'zod';

/** `shell`: a plain shell runs in the terminal (a terminal session, or Claude exited and left the user at the prompt). */
export const SESSION_STATUSES = ['starting', 'idle', 'busy', 'waiting', 'shell', 'closed', 'dead'] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/** `terminal` is a plain shell with no Claude behind it. */
export const sessionKindSchema = z.enum(['orchestrator', 'worker', 'terminal']);
export type SessionKind = z.infer<typeof sessionKindSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  /** Orchestrator that created this session with `create_orchestrator`; null for sessions the user opened. */
  parentSessionId: z.string().nullable(),
  kind: sessionKindSchema,
  cwd: z.string(),
  model: z.string().nullable(),
  /** Claude Code's own session id, once known; lets a finished session be resumed. */
  claudeSessionId: z.string().nullable(),
  /** The name Claude gave the conversation (its window title); null until it has one. */
  title: z.string().nullable(),
  /** When the first prompt was submitted; null for a session nobody has written to. */
  promptedAt: z.number().nullable(),
  status: sessionStatusSchema,
  pid: z.number().nullable(),
  activeSubagents: z.number(),
  lastActivityAt: z.number(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  /** Derived: `busy` with no activity for a long time. Status itself is never changed automatically. */
  suspicious: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

export const createSessionBodySchema = z.object({
  cwd: z.string().min(1),
  model: z.string().optional(),
  taskId: z.string().optional(),
  /** `terminal` starts a plain shell instead of Claude Code. */
  kind: z.enum(['orchestrator', 'terminal']).optional(),
});
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

export const ACTIVE_SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'idle', 'busy', 'waiting', 'shell'];
export const isActiveSessionStatus = (s: SessionStatus): boolean => ACTIVE_SESSION_STATUSES.includes(s);
/** Messages are typed into Claude's prompt, so a session sitting in a plain shell cannot take them. */
export const canReceiveMessages = (s: SessionStatus): boolean => isActiveSessionStatus(s) && s !== 'shell';
