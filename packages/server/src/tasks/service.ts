import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { canReceiveMessages, isActiveSessionStatus, type CreateTaskBody, type Session, type Task, type TaskStatus, type UpdateTaskBody } from '@orch/shared';
import { resolveModel, type Config } from '../config/index.js';
import type { EventBus } from '../events/bus.js';
import { checkDepth, freeWorkerSlots, hasWorkerCapacity } from './limits.js';
import type { TaskRepo } from './repo.js';
import { prepareWorkerCwd } from './worktree.js';

export class TaskError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
  }
}

/** What the task layer needs from the session layer. */
export interface WorkerPort {
  get(sessionId: string): Session | undefined;
  countActiveWorkers(): number;
  startWorker(input: { taskId: string; cwd: string; model: string | null }): Session;
  kill(sessionId: string): void;
}

export interface TaskMessagePort {
  enqueue(sessionId: string, body: string): unknown;
}

export interface CreateTaskContext {
  /** Session that issued the request (MCP caller); supplies default parent and cwd. */
  callerSessionId?: string | null;
}

const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled'];
export const isTerminalTaskStatus = (s: TaskStatus): boolean => TERMINAL_TASK_STATUSES.includes(s);

export function buildWorkerPrompt(task: Pick<Task, 'id' | 'title' | 'description'>): string {
  return [
    'You are a worker agent started by the Orchestrator for a single task.',
    `Task id: ${task.id}`,
    `Title: ${task.title}`,
    '',
    task.description.trim() || '(no further description)',
    '',
    'When you are finished, call the MCP tool `report_result` of the `orchestrator` server with',
    `task_id "${task.id}", status "done" or "failed", and a short summary of the outcome as result.`,
  ].join('\n');
}

export function buildCompletionMessage(task: Pick<Task, 'id' | 'title' | 'status' | 'result'>): string {
  return [
    `[Orchestrator] Task "${task.title}" (id ${task.id}) finished with status: ${task.status}.`,
    `Result: ${task.result?.trim() || '(none)'}`,
  ].join('\n');
}

export class TaskService {
  /** Workers being prepared (worktree creation is async) that already hold a slot. */
  private reserved = 0;

  constructor(
    private readonly config: Config,
    private readonly repo: TaskRepo,
    private readonly workers: WorkerPort,
    private readonly messages: TaskMessagePort,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  list(): Task[] {
    return this.repo.list();
  }

  get(id: string): Task | undefined {
    return this.repo.get(id);
  }

  children(parentId: string): Task[] {
    return this.repo.listChildren(parentId);
  }

  async create(input: CreateTaskBody, ctx: CreateTaskContext = {}): Promise<Task> {
    const caller = ctx.callerSessionId ? this.workers.get(ctx.callerSessionId) : undefined;
    const parentId = input.parentId === undefined ? (caller?.taskId ?? null) : input.parentId;
    if (parentId && !this.repo.get(parentId)) throw new TaskError(`parent task not found: ${parentId}`, 404);

    const depth = checkDepth(parentId ? this.repo.depth(parentId) : null, this.config.maxDepth);
    if (!depth.ok) throw new TaskError(depth.reason, 409);

    const task = this.repo.insert(
      {
        id: randomUUID(),
        parentId,
        title: input.title,
        description: input.description,
        model: resolveModel(this.config, input.model),
        cwd: input.cwd ?? caller?.cwd ?? null,
        creatorSessionId: caller?.id ?? null,
        status: 'pending',
      },
      Date.now(),
    );
    this.publish(task);
    return input.start ? await this.start(task.id) : task;
  }

  /** Starts a worker for the task, or leaves it `queued` when the worker limit is reached. */
  async start(id: string): Promise<Task> {
    const task = this.require(id);
    if (task.status !== 'pending' && task.status !== 'queued') {
      throw new TaskError(`task is ${task.status}; only pending or queued tasks can be started`, 409);
    }
    if (!hasWorkerCapacity(this.workers.countActiveWorkers() + this.reserved, this.config.maxWorkers)) {
      return task.status === 'queued' ? task : this.save(id, { status: 'queued' });
    }
    this.reserved += 1;
    try {
      return await this.launch(task);
    } finally {
      this.reserved -= 1;
    }
  }

  /** Starts as many queued tasks as free worker slots allow (oldest first). */
  async drain(): Promise<void> {
    try {
      const queued = this.repo.listByStatus('queued');
      const slots = freeWorkerSlots(this.workers.countActiveWorkers() + this.reserved, this.config.maxWorkers);
      for (const task of queued.slice(0, slots)) {
        try {
          await this.start(task.id);
        } catch (err) {
          this.log.error({ err, taskId: task.id }, 'failed to start queued task');
        }
      }
    } catch (err) {
      // Never let a background failure take down the server (and every running session with it).
      this.log.error({ err }, 'draining the task queue failed');
    }
  }

  /** `report_result`: the worker (or an ancestor task's session) records the outcome. */
  report(taskId: string, status: 'done' | 'failed', result: string, callerSessionId: string | null): Task {
    const task = this.require(taskId);
    if (!callerSessionId) throw new TaskError('report_result requires a session started by the Orchestrator', 403);
    const caller = this.workers.get(callerSessionId);
    const allowed =
      task.sessionId === callerSessionId ||
      (caller?.taskId != null && caller.taskId !== task.id && this.repo.ancestry(task.id).includes(caller.taskId));
    if (!allowed) throw new TaskError('this session may not report a result for that task', 403);
    if (isTerminalTaskStatus(task.status)) throw new TaskError(`task already ${task.status}`, 409);
    return this.save(taskId, { status, result });
  }

  markRunning(id: string, sessionId: string): Task {
    return this.save(id, { status: 'running', sessionId });
  }

  update(id: string, patch: UpdateTaskBody): Task {
    const task = this.require(id);
    const next: Parameters<TaskRepo['update']>[1] = {};
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.model !== undefined) next.model = patch.model === null ? null : resolveModel(this.config, patch.model);
    if (patch.result !== undefined) next.result = patch.result;
    if (patch.status !== undefined) next.status = patch.status;
    const saved = this.save(id, next);
    if (patch.status === 'cancelled' && task.status !== 'cancelled') this.killWorker(task);
    return saved;
  }

  remove(id: string): void {
    const task = this.require(id);
    const doomed = [...this.repo.descendants(id).reverse(), task];
    for (const t of doomed) {
      const session = t.sessionId ? this.workers.get(t.sessionId) : undefined;
      if (session && isActiveSessionStatus(session.status)) {
        throw new TaskError(`task ${t.id} still has an active session; cancel it first`, 409);
      }
    }
    for (const t of doomed) {
      this.repo.delete(t.id);
      this.bus.publish({ type: 'task_deleted', id: t.id });
    }
  }

  /** Session ended: settle the task unless a result was already reported. */
  handleSessionEnded(session: Session, info: { killed: boolean }): void {
    const task = session.taskId ? this.repo.get(session.taskId) : undefined;
    if (task && task.sessionId === session.id && task.status === 'running') {
      if (info.killed) this.save(task.id, { status: 'cancelled', result: task.result ?? 'Session terminated before the task finished' });
      else if (session.status === 'dead') this.save(task.id, { status: 'failed', result: task.result ?? 'Session process died without reporting a result' });
      else this.save(task.id, { status: 'done', result: task.result ?? 'Session exited without reporting a result' });
    }
    void this.drain();
  }

  /** A worker whose task is already settled has nothing left to do: close it to free the slot. */
  handleSessionIdle(session: Session): void {
    if (session.kind !== 'worker' || !session.taskId) return;
    const task = this.repo.get(session.taskId);
    if (task && task.sessionId === session.id && isTerminalTaskStatus(task.status)) {
      this.log.info({ sessionId: session.id, taskId: task.id }, 'closing finished worker');
      this.workers.kill(session.id);
    }
  }

  private async launch(task: Task): Promise<Task> {
    const baseCwd = task.cwd ?? this.config.defaultCwd;
    mkdirSync(baseCwd, { recursive: true });
    const prepared = await prepareWorkerCwd(baseCwd, task.id, this.config.worktreesDir, this.log);
    try {
      const session = this.workers.startWorker({ taskId: task.id, cwd: prepared.cwd, model: task.model });
      const running = this.save(task.id, { status: 'running', sessionId: session.id, cwd: baseCwd });
      this.messages.enqueue(session.id, buildWorkerPrompt(running));
      return running;
    } catch (err) {
      this.save(task.id, { status: 'failed', result: `Could not start worker: ${(err as Error).message}` });
      throw err;
    }
  }

  private killWorker(task: Task): void {
    const session = task.sessionId ? this.workers.get(task.sessionId) : undefined;
    if (session && isActiveSessionStatus(session.status)) this.workers.kill(session.id);
  }

  private require(id: string): Task {
    const task = this.repo.get(id);
    if (!task) throw new TaskError(`task not found: ${id}`, 404);
    return task;
  }

  private save(id: string, patch: Parameters<TaskRepo['update']>[1]): Task {
    const before = this.repo.get(id);
    const task = this.repo.update(id, patch, Date.now());
    if (!task) throw new TaskError(`task not found: ${id}`, 404);
    this.publish(task);
    if (before && !isTerminalTaskStatus(before.status) && isTerminalTaskStatus(task.status)) this.notifyCreator(task);
    return task;
  }

  /** Tells the session that created the task how it ended; it arrives as a normal message once that session is idle. */
  private notifyCreator(task: Task): void {
    if (!task.creatorSessionId || task.creatorSessionId === task.sessionId) return;
    const creator = this.workers.get(task.creatorSessionId);
    if (!creator || !canReceiveMessages(creator.status)) return;
    this.messages.enqueue(creator.id, buildCompletionMessage(task));
  }

  private publish(task: Task): void {
    this.bus.publish({ type: 'task', task });
  }
}
