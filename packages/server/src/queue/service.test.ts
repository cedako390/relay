import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionStatus } from '@orch/shared';
import { EventBus } from '../events/bus.js';
import { createTestDb } from '../test-utils.js';
import { ENTER, PASTE_END, PASTE_START, toBracketedPaste } from './paste.js';
import { MessageRepo } from './repo.js';
import { MessageQueue, type SessionPort } from './service.js';

class FakeSessions implements SessionPort {
  status: SessionStatus | undefined = 'idle';
  ready = true;
  writes: string[] = [];
  alive = true;
  getStatus = (id: string): SessionStatus | undefined => (id === 's1' ? this.status : undefined);
  markBusy = (): void => {
    this.status = 'busy';
  };
  isInputReady = (): boolean => this.ready;
  write = (_id: string, data: string): boolean => {
    if (!this.alive) return false;
    this.writes.push(data);
    return true;
  };
}

describe('MessageQueue', () => {
  let sessions: FakeSessions;
  let queue: MessageQueue;
  let repo: MessageRepo;

  beforeEach(() => {
    sessions = new FakeSessions();
    repo = new MessageRepo(createTestDb());
    queue = new MessageQueue(repo, sessions, new EventBus(), {
      sleep: async () => undefined,
      readyPollMs: 1,
      readyTimeoutMs: 5,
      retryMs: 60_000,
    });
  });

  /** enqueue() starts a delivery in the background; let it finish before asserting. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

  const statuses = (): string[] => repo.listBySession('s1').reverse().map((m) => m.status);

  it('delivers immediately when the session is idle: bracketed paste, then a separate Enter', async () => {
    queue.enqueue('s1', 'hello');
    await settle();
    await queue.flush('s1');
    expect(sessions.writes).toEqual([`${PASTE_START}hello${PASTE_END}`, ENTER]);
    expect(statuses()).toEqual(['delivered']);
  });

  it.each(['starting', 'busy', 'waiting', 'closed', 'dead'] as const)('keeps the message queued while the session is %s', async (status) => {
    sessions.status = status;
    queue.enqueue('s1', 'hello');
    await settle();
    await queue.flush('s1');
    expect(sessions.writes).toEqual([]);
    expect(statuses()).toEqual(['queued']);
  });

  it('delivers the waiting message once the session becomes idle (Stop event)', async () => {
    sessions.status = 'busy';
    queue.enqueue('s1', 'later');
    sessions.status = 'idle';
    expect(await queue.flush('s1')).toBe(1);
    expect(statuses()).toEqual(['delivered']);
  });

  it('delivers one message per idle period: the session turns busy after the first', async () => {
    queue.enqueue('s1', 'first');
    queue.enqueue('s1', 'second');
    await settle();
    await queue.flush('s1');
    expect(statuses()).toEqual(['delivered', 'queued']);
    expect(sessions.writes.filter((w) => w.startsWith(PASTE_START))).toHaveLength(1);

    sessions.status = 'idle'; // Stop hook
    await queue.flush('s1');
    expect(statuses()).toEqual(['delivered', 'delivered']);
  });

  it('preserves FIFO order', async () => {
    sessions.status = 'busy';
    queue.enqueue('s1', 'one');
    queue.enqueue('s1', 'two');
    sessions.status = 'idle';
    await queue.flush('s1');
    sessions.status = 'idle';
    await queue.flush('s1');
    const pastes = sessions.writes.filter((w) => w.startsWith(PASTE_START));
    expect(pastes).toEqual([`${PASTE_START}one${PASTE_END}`, `${PASTE_START}two${PASTE_END}`]);
  });

  it('does not write while the terminal app is not ready for input', async () => {
    sessions.ready = false;
    queue.enqueue('s1', 'early');
    await settle();
    await queue.flush('s1');
    expect(sessions.writes).toEqual([]);
    expect(statuses()).toEqual(['queued']);

    sessions.ready = true;
    await queue.flush('s1');
    expect(statuses()).toEqual(['delivered']);
  });

  it('keeps the message when the process is gone', async () => {
    sessions.alive = false;
    queue.enqueue('s1', 'x');
    await settle();
    await queue.flush('s1');
    expect(statuses()).toEqual(['queued']);
  });

  it('never runs two deliveries for the same session at once', async () => {
    sessions.status = 'busy';
    queue.enqueue('s1', 'x');
    sessions.status = 'idle';
    const [a, b] = await Promise.all([queue.flush('s1'), queue.flush('s1')]);
    expect(a + b).toBe(1);
    expect(sessions.writes.filter((w) => w.startsWith(PASTE_START))).toHaveLength(1);
  });

  it('keeps messages of different sessions apart', async () => {
    queue.enqueue('other', 'for other');
    await settle();
    await queue.flush('s1');
    expect(sessions.writes).toEqual([]);
  });
});

describe('toBracketedPaste', () => {
  it('keeps multi-line text intact and normalises line endings', () => {
    expect(toBracketedPaste('a\r\nb\n\n  c')).toBe(`${PASTE_START}a\nb\n\n  c${PASTE_END}`);
  });

  it('cannot be terminated early or inject escape sequences', () => {
    const evil = `x${PASTE_END}rm -rf /\x1b[31m`;
    const wrapped = toBracketedPaste(evil);
    expect(wrapped.startsWith(PASTE_START)).toBe(true);
    expect(wrapped.endsWith(PASTE_END)).toBe(true);
    const inner = wrapped.slice(PASTE_START.length, -PASTE_END.length);
    expect(inner).not.toContain('\x1b');
  });
});
