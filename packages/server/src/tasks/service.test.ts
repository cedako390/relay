import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SessionStatus } from '@orch/shared';
import { EventBus } from '../events/bus.js';
import { createTestDb, silentLog, testConfig } from '../test-utils.js';
import { TaskRepo } from './repo.js';
import { buildWorkerPrompt, TaskError, TaskService, type WorkerPort } from './service.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'orch-test-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

class FakeWorkers implements WorkerPort {
  sessions = new Map<string, Session>();
  killed: string[] = [];
  private n = 0;

  get = (id: string): Session | undefined => this.sessions.get(id);

  countActiveWorkers = (): number =>
    [...this.sessions.values()].filter((s) => s.kind === 'worker' && ['starting', 'idle', 'busy', 'waiting'].includes(s.status)).length;

  startWorker = ({ taskId, cwd, model }: { taskId: string; cwd: string; model: string | null }): Session => {
    const session: Session = {
      id: `s${++this.n}`,
      taskId,
      parentSessionId: null,
      kind: 'worker',
      cwd,
      model,
      claudeSessionId: null, title: null, promptedAt: null,
      status: 'starting',
      pid: 1,
      activeSubagents: 0,
      lastActivityAt: 0,
      startedAt: 0,
      endedAt: null,
      suspicious: false,
    };
    this.sessions.set(session.id, session);
    return session;
  };

  kill = (id: string): void => {
    this.killed.push(id);
    this.set(id, 'closed');
  };

  /** An orchestrator-style session (no task) that can create tasks. */
  addOrchestrator(id: string, status: SessionStatus = 'idle'): void {
    this.sessions.set(id, {
      id, taskId: null, parentSessionId: null, kind: 'orchestrator', cwd: '/x', model: null, claudeSessionId: null, title: null, promptedAt: null, status,
      pid: 1, activeSubagents: 0, lastActivityAt: 0, startedAt: 0, endedAt: null, suspicious: false,
    });
  }

  set(id: string, status: SessionStatus): Session {
    const s = { ...this.sessions.get(id)!, status };
    this.sessions.set(id, s);
    return s;
  }
}

describe('TaskService', () => {
  let workers: FakeWorkers;
  let enqueued: Array<{ sessionId: string; body: string }>;
  let service: TaskService;
  let repo: TaskRepo;

  const make = (overrides: Parameters<typeof testConfig>[0] = {}): void => {
    workers = new FakeWorkers();
    enqueued = [];
    repo = new TaskRepo(createTestDb());
    service = new TaskService(
      testConfig({ defaultCwd: workspace, worktreesDir: path.join(workspace, 'wt'), maxWorkers: 2, maxDepth: 3, ...overrides }),
      repo,
      workers,
      { enqueue: (sessionId, body) => void enqueued.push({ sessionId, body }) },
      new EventBus(),
      silentLog,
    );
  };
  beforeEach(() => make());

  describe('depth limit', () => {
    it('rejects a task nested deeper than maxDepth', async () => {
      const t1 = await service.create({ title: 'root', description: '', start: false });
      const t2 = await service.create({ title: 'child', description: '', parentId: t1.id, start: false });
      const t3 = await service.create({ title: 'grandchild', description: '', parentId: t2.id, start: false });
      await expect(service.create({ title: 'too deep', description: '', parentId: t3.id, start: false })).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(service.list()).toHaveLength(3);
    });

    it('uses the calling session task as default parent', async () => {
      const root = await service.create({ title: 'root', description: '', start: true });
      const child = await service.create({ title: 'sub', description: '', start: false }, { callerSessionId: root.sessionId });
      expect(child.parentId).toBe(root.id);
    });

    it('rejects an unknown parent', async () => {
      await expect(service.create({ title: 'x', description: '', parentId: 'nope', start: false })).rejects.toBeInstanceOf(TaskError);
    });
  });

  describe('worker limit', () => {
    it('starts workers up to maxWorkers and queues the rest', async () => {
      const a = await service.create({ title: 'a', description: '', start: true });
      const b = await service.create({ title: 'b', description: '', start: true });
      const c = await service.create({ title: 'c', description: '', start: true });
      expect([a.status, b.status, c.status]).toEqual(['running', 'running', 'queued']);
      expect(workers.countActiveWorkers()).toBe(2);
    });

    it('starts the queued task when a worker finishes', async () => {
      const a = await service.create({ title: 'a', description: '', start: true });
      await service.create({ title: 'b', description: '', start: true });
      const c = await service.create({ title: 'c', description: '', start: true });
      expect(service.get(c.id)?.status).toBe('queued');

      const ended = workers.set(a.sessionId!, 'closed');
      service.handleSessionEnded(ended, { killed: false });
      await vi.waitFor(() => expect(service.get(c.id)?.status).toBe('running'), { timeout: 5000 });
    });

    it('does not exceed the limit with concurrent starts', async () => {
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((title) => service.create({ title, description: '', start: true })),
      );
      expect(results.filter((t) => t.status === 'running')).toHaveLength(2);
      expect(results.filter((t) => t.status === 'queued')).toHaveLength(2);
      expect(workers.countActiveWorkers()).toBe(2);
    });

    it('does not start a task unless it is pending or queued', async () => {
      const a = await service.create({ title: 'a', description: '', start: true });
      await expect(service.start(a.id)).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('models', () => {
    it('keeps whitelisted aliases and falls back to the default for unknown values', async () => {
      make({ defaultModel: 'sonnet' });
      const ok = await service.create({ title: 'a', description: '', model: 'Haiku', start: false });
      const bad = await service.create({ title: 'b', description: '', model: 'gpt-9', start: false });
      expect(ok.model).toBe('haiku');
      expect(bad.model).toBe('sonnet');
    });

    it('uses null (claude default) when there is no default model', async () => {
      const t = await service.create({ title: 'a', description: '', model: 'whatever', start: false });
      expect(t.model).toBeNull();
    });
  });

  describe('worker prompt', () => {
    it('is queued for the new session and names the task id and report_result', async () => {
      const t = await service.create({ title: 'Do it', description: 'details', start: true });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.sessionId).toBe(t.sessionId);
      expect(enqueued[0]!.body).toContain(t.id);
      expect(enqueued[0]!.body).toContain('report_result');
      expect(buildWorkerPrompt(t)).toContain('details');
    });
  });

  describe('report_result', () => {
    it('lets the worker settle its own task', async () => {
      const t = await service.create({ title: 'a', description: '', start: true });
      const done = service.report(t.id, 'done', 'all good', t.sessionId!);
      expect(done).toMatchObject({ status: 'done', result: 'all good' });
    });

    it('rejects unknown callers and other workers', async () => {
      const a = await service.create({ title: 'a', description: '', start: true });
      const b = await service.create({ title: 'b', description: '', start: true });
      expect(() => service.report(a.id, 'done', 'x', null)).toThrow(TaskError);
      expect(() => service.report(a.id, 'done', 'x', b.sessionId!)).toThrow(/may not report/);
    });

    it('lets a parent task session report for its descendants', async () => {
      const parent = await service.create({ title: 'parent', description: '', start: true });
      const child = await service.create({ title: 'child', description: '', parentId: parent.id, start: false });
      expect(service.report(child.id, 'failed', 'gave up', parent.sessionId!).status).toBe('failed');
    });

    it('cannot be reported twice', async () => {
      const t = await service.create({ title: 'a', description: '', start: true });
      service.report(t.id, 'done', 'x', t.sessionId!);
      expect(() => service.report(t.id, 'failed', 'y', t.sessionId!)).toThrow(/already done/);
    });
  });

  describe('session lifecycle', () => {
    const run = async () => {
      const t = await service.create({ title: 'a', description: '', start: true });
      return { t, sessionId: t.sessionId! };
    };

    it('clean exit without a report -> done', async () => {
      const { t, sessionId } = await run();
      service.handleSessionEnded(workers.set(sessionId, 'closed'), { killed: false });
      expect(service.get(t.id)?.status).toBe('done');
    });

    it('process death -> failed', async () => {
      const { t, sessionId } = await run();
      service.handleSessionEnded(workers.set(sessionId, 'dead'), { killed: false });
      expect(service.get(t.id)?.status).toBe('failed');
    });

    it('terminated by the user -> cancelled', async () => {
      const { t, sessionId } = await run();
      service.handleSessionEnded(workers.set(sessionId, 'closed'), { killed: true });
      expect(service.get(t.id)?.status).toBe('cancelled');
    });

    it('keeps a reported result when the session ends afterwards', async () => {
      const { t, sessionId } = await run();
      service.report(t.id, 'failed', 'broken', sessionId);
      service.handleSessionEnded(workers.set(sessionId, 'closed'), { killed: false });
      expect(service.get(t.id)).toMatchObject({ status: 'failed', result: 'broken' });
    });

    it('closes a worker that went idle after its task was settled', async () => {
      const { t, sessionId } = await run();
      service.handleSessionIdle(workers.set(sessionId, 'idle'));
      expect(workers.killed).toEqual([]);
      service.report(t.id, 'done', 'ok', sessionId);
      service.handleSessionIdle(workers.set(sessionId, 'idle'));
      expect(workers.killed).toEqual([sessionId]);
    });

    it('cancelling a task kills its session', async () => {
      const { t, sessionId } = await run();
      service.update(t.id, { status: 'cancelled' });
      expect(workers.killed).toEqual([sessionId]);
    });
  });

  describe('completion notice for the creator', () => {
    const create = async () => {
      workers.addOrchestrator('boss');
      const t = await service.create({ title: 'job', description: '', start: true }, { callerSessionId: 'boss' });
      enqueued.length = 0; // drop the worker prompt
      return t;
    };

    it('records which session created the task', async () => {
      const t = await create();
      expect(t.creatorSessionId).toBe('boss');
    });

    it('tells the creator when the worker reports a result', async () => {
      const t = await create();
      service.report(t.id, 'done', 'it works', t.sessionId!);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.sessionId).toBe('boss');
      expect(enqueued[0]!.body).toContain('job');
      expect(enqueued[0]!.body).toContain('done');
      expect(enqueued[0]!.body).toContain('it works');
    });

    it('tells the creator when the worker dies without a report', async () => {
      const t = await create();
      service.handleSessionEnded(workers.set(t.sessionId!, 'dead'), { killed: false });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]!.body).toContain('failed');
    });

    it('notifies only once even if the session ends after the report', async () => {
      const t = await create();
      service.report(t.id, 'done', 'ok', t.sessionId!);
      service.handleSessionEnded(workers.set(t.sessionId!, 'closed'), { killed: false });
      expect(enqueued).toHaveLength(1);
    });

    it('stays silent when the creator session is gone', async () => {
      const t = await create();
      workers.set('boss', 'closed');
      service.report(t.id, 'done', 'ok', t.sessionId!);
      expect(enqueued).toEqual([]);
    });

    it('stays silent for tasks created through REST (no creator)', async () => {
      const t = await service.create({ title: 'rest', description: '', start: true });
      enqueued.length = 0;
      service.report(t.id, 'done', 'ok', t.sessionId!);
      expect(enqueued).toEqual([]);
    });
  });

  describe('remove', () => {
    it('refuses to delete a task whose session is still active', async () => {
      const t = await service.create({ title: 'a', description: '', start: true });
      expect(() => service.remove(t.id)).toThrow(/active session/);
    });

    it('deletes a task together with its descendants', async () => {
      const root = await service.create({ title: 'root', description: '', start: false });
      await service.create({ title: 'child', description: '', parentId: root.id, start: false });
      service.remove(root.id);
      expect(service.list()).toEqual([]);
    });
  });
});
