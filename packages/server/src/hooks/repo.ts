import { and, desc, eq } from 'drizzle-orm';
import type { SessionEvent } from '@orch/shared';
import type { Db } from '../db/index.js';
import { events } from '../db/schema.js';

export class EventRepo {
  constructor(private readonly db: Db) {}

  insert(sessionId: string, type: string, payload: unknown, ts: number): SessionEvent {
    return this.db.insert(events).values({ sessionId, type, payload, ts }).returning().get();
  }

  /**
   * What the latest SessionStart hook reported: Claude's session id and its transcript file. Lets a session be
   * resumed even if it was recorded before the id was stored on the row, and tells whether a conversation exists.
   */
  latestSessionStart(sessionId: string): { claudeSessionId?: string; transcriptPath?: string } {
    const row = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, 'SessionStart')))
      .orderBy(desc(events.id))
      .limit(1)
      .get();
    const p = (row?.payload ?? {}) as { session_id?: unknown; transcript_path?: unknown };
    return {
      claudeSessionId: typeof p.session_id === 'string' && p.session_id ? p.session_id : undefined,
      transcriptPath: typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : undefined,
    };
  }

  /** Newest first. */
  listBySession(sessionId: string, limit: number): SessionEvent[] {
    return this.db
      .select()
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(desc(events.id))
      .limit(limit)
      .all();
  }
}
