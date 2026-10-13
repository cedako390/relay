import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session, SessionKind, SessionStatus } from '@orch/shared';
import { silentLog, testConfig } from '../test-utils.js';
import { SessionError } from './manager.js';
import { buildSubOrchestratorPrompt, SubOrchestratorService, type OrchestratorPort } from './sub-orchestrators.js';

const workspace = mkdtempSync(path.join(tmpdir(), 'orch-suborch-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

class FakeSessions implements OrchestratorPort {
  sessions = new Map<string, Session>();
  killed: string[] = [];
  private n = 0;

  add(id: string, over: Partial<Session> = {}, kind: SessionKind = 'orchestrator', status: SessionStatus = 'idle'): Session {
    const s: Session = {
      id, taskId: null, parentSessionId: null, kind, cwd: workspace, model: null, claudeSessionId: null, title: null, promptedAt: null,
      status, pid: 1, activeSubagents: 0, lastActivityAt: 0, startedAt: 0, endedAt: null, suspicious: false, ...over,
    };
    this.sessions.set(id, s);
    return s;
  }

  get = (id: string): Session | undefined => this.sessions.get(id);
  list = (): Session[] => [...this.sessions.values()];
  create = ({ cwd, model, parentSessionId }: { cwd: string; model?: string | null; parentSessionId: string }): Session =>
    this.add(`c${++this.n}`, { cwd, model: model ?? null, parentSessionId, status: 'starting' });
  kill = (id: string): Session => {
    this.killed.push(id);
    const s = { ...this.sessions.get(id)!, status: 'closed' as const };
    this.sessions.set(id, s);
    return s;
  };
}

describe('SubOrchestratorService', () => {
  let fake: FakeSessions;
  let sent: Array<{ sessionId: string; body: string }>;
  let service: SubOrchestratorService;

  const make = (overrides: Parameters<typeof testConfig>[0] = {}): void => {
    fake = new FakeSessions();
    sent = [];
    fake.add('root');
    service = new SubOrchestratorService(
      testConfig({ maxSubOrchestrators: 2, maxOrchestratorDepth: 2, ...overrides }),
      fake,
      { enqueue: (sessionId, body) => void sent.push({ sessionId, body }) },
      silentLog,
    );
  };
  beforeEach(() => make());

  const expectError = (fn: () => unknown, status: number, text: string): void => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(SessionError);
      expect((err as SessionError).statusCode).toBe(status);
      expect((err as SessionError).message).toContain(text);
      return;
    }
    throw new Error('expected SessionError');
  };

  it('starts a child in the caller folder, linked to its parent, and queues the assignment', () => {
    const child = service.create('root', { title: 'Frontend', instructions: 'Do the UI part' });
    expect(child.parentSessionId).toBe('root');
    expect(child.kind).toBe('orchestrator');
    expect(child.cwd).toBe(workspace);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe(child.id);
    expect(sent[0]!.body).toContain('Do the UI part');
    expect(sent[0]!.body).toContain('session_id "root"');
  });

  it('uses the given folder and model when provided', () => {
    const child = service.create('root', { title: 't', instructions: 'i', cwd: workspace, model: 'haiku' });
    expect(child.model).toBe('haiku');
  });

  it('refuses callers that are not sessions of the orchestrator, or are workers', () => {
    expectError(() => service.create(null, { title: 't', instructions: 'i' }), 403, 'requires a session');
    expectError(() => service.create('ghost', { title: 't', instructions: 'i' }), 403, 'requires a session');
    fake.add('w1', { taskId: 'task' }, 'worker');
    expectError(() => service.create('w1', { title: 't', instructions: 'i' }), 403, 'only orchestrator');
  });

  it('enforces the limit of active sub-orchestrators and frees a slot when one closes', () => {
    const a = service.create('root', { title: 'a', instructions: 'i' });
    service.create('root', { title: 'b', instructions: 'i' });
    expectError(() => service.create('root', { title: 'c', instructions: 'i' }), 409, 'active sub-orchestrators');
    service.close('root', a.id);
    expect(() => service.create('root', { title: 'c', instructions: 'i' })).not.toThrow();
  });

  it('enforces the depth limit', () => {
    const child = service.create('root', { title: 'a', instructions: 'i' });
    expect(service.depth(fake.get('root')!)).toBe(1);
    expect(service.depth(child)).toBe(2);
    expectError(() => service.create(child.id, { title: 'deeper', instructions: 'i' }), 409, 'depth limit');
  });

  it('is off when MAX_SUB_ORCHESTRATORS is 0', () => {
    make({ maxSubOrchestrators: 0 });
    expectError(() => service.create('root', { title: 't', instructions: 'i' }), 409, 'disabled');
  });

  it('survives a cycle in the parent chain', () => {
    fake.add('x', { parentSessionId: 'y' });
    fake.add('y', { parentSessionId: 'x' });
    expect(service.depth(fake.get('x')!)).toBe(2);
  });

  describe('close', () => {
    it('only closes active sessions that the caller created', () => {
      const child = service.create('root', { title: 'a', instructions: 'i' });
      fake.add('other');
      expectError(() => service.close('other', child.id), 403, 'that you created');
      expectError(() => service.close(null, child.id), 403, 'that you created');
      expectError(() => service.close('root', 'ghost'), 404, 'not found');
      expect(service.close('root', child.id).status).toBe('closed');
      expect(fake.killed).toEqual([child.id]);
      expectError(() => service.close('root', child.id), 409, 'already closed');
    });
  });

  describe('handleSessionEnded', () => {
    it('tells the parent when a child ends by itself', () => {
      const child = service.create('root', { title: 'a', instructions: 'i' });
      sent.length = 0;
      service.handleSessionEnded({ ...child, status: 'dead', title: 'Backend' }, { killed: false });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.sessionId).toBe('root');
      expect(sent[0]!.body).toContain('Backend');
      expect(sent[0]!.body).toContain('dead');
    });

    it('stays quiet when the parent closed it, when there is no parent, or the parent is gone', () => {
      const child = service.create('root', { title: 'a', instructions: 'i' });
      sent.length = 0;
      service.handleSessionEnded(child, { killed: true });
      service.handleSessionEnded(fake.get('root')!, { killed: false });
      fake.add('root', {}, 'orchestrator', 'closed');
      service.handleSessionEnded(child, { killed: false });
      expect(sent).toEqual([]);
    });
  });

  it('prompt names the parent and keeps the assignment', () => {
    const body = buildSubOrchestratorPrompt({ sessionId: 's', parentId: 'p', title: 'T', instructions: '  work  ' });
    expect(body).toContain('id p');
    expect(body).toContain('Assignment: T');
    expect(body).toContain('\nwork\n');
  });
});
