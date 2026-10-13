import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Message } from '@orch/shared';
import type { Db } from '../db/index.js';
import { messages } from '../db/schema.js';

export class MessageRepo {
  constructor(private readonly db: Db) {}

  insert(message: Pick<Message, 'id' | 'sessionId' | 'body'>, now: number): Message {
    return this.db
      .insert(messages)
      .values({ ...message, status: 'queued', createdAt: now, deliveredAt: null })
      .returning()
      .get();
  }

  /** Oldest message still waiting for delivery. */
  nextQueued(sessionId: string): Message | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.status, 'queued')))
      .orderBy(asc(messages.createdAt), asc(sql`rowid`))
      .limit(1)
      .get();
  }

  markDelivered(id: string, now: number): Message | undefined {
    return this.db
      .update(messages)
      .set({ status: 'delivered', deliveredAt: now })
      .where(eq(messages.id, id))
      .returning()
      .get();
  }

  listBySession(sessionId: string): Message[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(desc(messages.createdAt), desc(sql`rowid`))
      .all();
  }
}
