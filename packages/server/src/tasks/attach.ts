import type { Task } from '@orch/shared';
import { TaskError, type TaskService } from './service.js';

/**
 * Links a manually created session to an existing task (POST /api/sessions with task_id):
 * the task becomes `running` and owned by that session.
 */
export function attachSessionToTask(tasks: TaskService, taskId: string, sessionId: string): Task {
  const task = tasks.get(taskId);
  if (!task) throw new TaskError(`task not found: ${taskId}`, 404);
  if (task.status !== 'pending' && task.status !== 'queued') {
    throw new TaskError(`task is ${task.status}; only pending or queued tasks can get a session`, 409);
  }
  return tasks.markRunning(taskId, sessionId);
}
