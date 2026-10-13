import { index, integer, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { MessageStatus, SessionKind, SessionStatus, TaskStatus } from '@orch/shared';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    parentId: text('parent_id').references((): AnySQLiteColumn => tasks.id),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    status: text('status').$type<TaskStatus>().notNull().default('pending'),
    model: text('model'),
    /** Directory the worker should run in (needed for tasks waiting in the queue). */
    cwd: text('cwd'),
    sessionId: text('session_id'),
    /** Session that created the task (told about the outcome when the task settles). */
    creatorSessionId: text('creator_session_id'),
    result: text('result'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('tasks_parent_idx').on(t.parentId), index('tasks_status_idx').on(t.status)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id'),
    /** Orchestrator that spawned this session via `create_orchestrator` (null: opened by the user). */
    parentSessionId: text('parent_session_id'),
    kind: text('kind').$type<SessionKind>().notNull(),
    cwd: text('cwd').notNull(),
    model: text('model'),
    /** Claude Code's own session id (from the SessionStart hook); what `claude --resume` needs. */
    claudeSessionId: text('claude_session_id'),
    /** The name Claude gives the conversation in its window title (OSC 0), once it has one. */
    title: text('title'),
    /** When the first prompt was submitted; a session nobody wrote to is not worth listing in the history. */
    promptedAt: integer('prompted_at'),
    status: text('status').$type<SessionStatus>().notNull(),
    pid: integer('pid'),
    activeSubagents: integer('active_subagents').notNull().default(0),
    lastActivityAt: integer('last_activity_at').notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [index('sessions_status_idx').on(t.status)],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    ts: integer('ts').notNull(),
  },
  (t) => [index('events_session_idx').on(t.sessionId, t.id)],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    body: text('body').notNull(),
    status: text('status').$type<MessageStatus>().notNull().default('queued'),
    createdAt: integer('created_at').notNull(),
    deliveredAt: integer('delivered_at'),
  },
  (t) => [index('messages_session_idx').on(t.sessionId, t.status, t.createdAt)],
);
