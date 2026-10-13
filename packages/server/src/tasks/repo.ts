import { asc, eq, sql } from 'drizzle-orm';
import type { Task, TaskStatus } from '@orch/shared';
import type { Db } from '../db/index.js';
import { tasks } from '../db/schema.js';

export interface NewTask {
  id: string;
  parentId: string | null;
  title: string;
  description: string;
  model: string | null;
  cwd: string | null;
  creatorSessionId: string | null;
  status: TaskStatus;
}

export type TaskPatch = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'model' | 'cwd' | 'sessionId' | 'result'>
>;

export class TaskRepo {
  constructor(private readonly db: Db) {}

  insert(t: NewTask, now: number): Task {
    return this.db
      .insert(tasks)
      .values({ ...t, sessionId: null, result: null, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  get(id: string): Task | undefined {
    return this.db.select().from(tasks).where(eq(tasks.id, id)).get();
  }

  list(): Task[] {
    return this.db.select().from(tasks).orderBy(asc(tasks.createdAt), asc(sql`rowid`)).all();
  }

  listChildren(parentId: string): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.parentId, parentId)).orderBy(asc(tasks.createdAt), asc(sql`rowid`)).all();
  }

  listByStatus(status: TaskStatus): Task[] {
    return this.db.select().from(tasks).where(eq(tasks.status, status)).orderBy(asc(tasks.createdAt), asc(sql`rowid`)).all();
  }

  update(id: string, patch: TaskPatch, now: number): Task | undefined {
    return this.db
      .update(tasks)
      .set({ ...patch, updatedAt: now })
      .where(eq(tasks.id, id))
      .returning()
      .get();
  }

  delete(id: string): void {
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  /** Task ids from the given task up to the root (inclusive of the task itself). */
  ancestry(id: string): string[] {
    const chain: string[] = [];
    let current = this.get(id);
    while (current && !chain.includes(current.id)) {
      chain.push(current.id);
      current = current.parentId ? this.get(current.parentId) : undefined;
    }
    return chain;
  }

  /** Depth of a task in its tree (root = 1). */
  depth(id: string): number {
    return this.ancestry(id).length;
  }

  /** All descendants (children, grandchildren, ...), depth-first. */
  descendants(id: string): Task[] {
    const out: Task[] = [];
    const walk = (parent: string): void => {
      for (const child of this.listChildren(parent)) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return out;
  }
}
