import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { ACTIVE_SESSION_STATUSES, type Session, type SessionKind, type SessionStatus } from '@orch/shared';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { isSuspicious } from './status.js';

type SessionRow = typeof sessions.$inferSelect;

export interface NewSession {
  id: string;
  taskId: string | null;
  parentSessionId?: string | null;
  kind: SessionKind;
  cwd: string;
  model: string | null;
  status: SessionStatus;
  now: number;
}

export type SessionPatch = Partial<
  Pick<SessionRow, 'kind' | 'status' | 'pid' | 'claudeSessionId' | 'title' | 'promptedAt' | 'activeSubagents' | 'lastActivityAt' | 'endedAt'>
>;

export function toSession(row: SessionRow, now: number = Date.now()): Session {
  return { ...row, suspicious: isSuspicious(row, now) };
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  insert(s: NewSession): Session {
    const row = this.db
      .insert(sessions)
      .values({
        id: s.id,
        taskId: s.taskId,
        parentSessionId: s.parentSessionId ?? null,
        kind: s.kind,
        cwd: s.cwd,
        model: s.model,
        claudeSessionId: null,
        title: null,
        promptedAt: null,
        status: s.status,
        pid: null,
        activeSubagents: 0,
        lastActivityAt: s.now,
        startedAt: s.now,
        endedAt: null,
      })
      .returning()
      .get();
    return toSession(row);
  }

  get(id: string): Session | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row && toSession(row);
  }

  list(): Session[] {
    const now = Date.now();
    return this.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.startedAt))
      .all()
      .map((r) => toSession(r, now));
  }

  listByStatus(statuses: readonly SessionStatus[]): Session[] {
    const now = Date.now();
    return this.db
      .select()
      .from(sessions)
      .where(inArray(sessions.status, [...statuses]))
      .all()
      .map((r) => toSession(r, now));
  }

  update(id: string, patch: SessionPatch): Session | undefined {
    if (Object.keys(patch).length === 0) return this.get(id);
    const row = this.db.update(sessions).set(patch).where(eq(sessions.id, id)).returning().get();
    return row && toSession(row);
  }

  /** Number of worker sessions that still occupy a worker slot. */
  countActiveWorkers(): number {
    const [row] = this.db
      .select({ n: count() })
      .from(sessions)
      .where(and(eq(sessions.kind, 'worker'), inArray(sessions.status, [...ACTIVE_SESSION_STATUSES])))
      .all();
    return row?.n ?? 0;
  }
}
