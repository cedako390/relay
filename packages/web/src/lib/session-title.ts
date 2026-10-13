import type { Session, Task } from '@orch/shared';
import { shortId } from '@/lib/utils';

/** Task title for a worker, else the name Claude gave the conversation, else a placeholder. */
export function sessionTitle(session: Session, tasks: Record<string, Task | undefined>): string {
  const task = session.taskId ? tasks[session.taskId]?.title : undefined;
  if (session.kind === 'terminal') return 'Терминал';
  return task || session.title || (session.promptedAt === null ? 'Новая сессия' : `Session ${shortId(session.id)}`);
}
