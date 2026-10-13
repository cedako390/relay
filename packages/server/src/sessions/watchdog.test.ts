import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@orch/shared';
import type { SessionManager } from './manager.js';
import { SUSPICIOUS_AFTER_MS } from './status.js';
import { Watchdog } from './watchdog.js';

const NOW = 2_000_000_000_000;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    taskId: null,
    parentSessionId: null,
    kind: 'orchestrator',
    cwd: '/x',
    model: null,
    claudeSessionId: null, title: null, promptedAt: null,
    status: 'busy',
    pid: process.pid, // a pid that is certainly alive
    activeSubagents: 0,
    lastActivityAt: NOW,
    startedAt: NOW,
    endedAt: null,
    suspicious: false,
    ...overrides,
  };
}

function setup(s: Session, live: { exited: boolean } | undefined) {
  const markDead = vi.fn();
  const republish = vi.fn();
  const manager = {
    list: () => [s],
    liveSession: () => live,
    markDead,
    republish,
  } as unknown as SessionManager;
  return { watchdog: new Watchdog(manager), markDead, republish };
}

describe('Watchdog', () => {
  it('leaves healthy sessions alone', () => {
    const { watchdog, markDead } = setup(session(), { exited: false });
    watchdog.tick(NOW);
    watchdog.tick(NOW + 5000);
    expect(markDead).not.toHaveBeenCalled();
  });

  it('marks a session without a live process dead after two consecutive sightings', () => {
    const { watchdog, markDead } = setup(session(), undefined);
    watchdog.tick(NOW);
    expect(markDead).not.toHaveBeenCalled(); // grace period: the exit handler may still be about to run
    watchdog.tick(NOW + 5000);
    expect(markDead).toHaveBeenCalledWith('s1');
  });

  it('marks a session dead when its pid disappeared although no exit event arrived', () => {
    const { watchdog, markDead } = setup(session({ pid: 2_147_483_000 }), { exited: false });
    watchdog.tick(NOW);
    watchdog.tick(NOW + 5000);
    expect(markDead).toHaveBeenCalledWith('s1');
  });

  it('ignores sessions that already ended', () => {
    const { watchdog, markDead } = setup(session({ status: 'closed' }), undefined);
    watchdog.tick(NOW);
    watchdog.tick(NOW + 5000);
    expect(markDead).not.toHaveBeenCalled();
  });

  it('flags a long-busy session as suspicious without changing its status', () => {
    const s = session({ lastActivityAt: NOW - SUSPICIOUS_AFTER_MS - 1000 });
    const { watchdog, markDead, republish } = setup(s, { exited: false });
    watchdog.tick(NOW);
    expect(republish).toHaveBeenCalledTimes(1);
    expect(markDead).not.toHaveBeenCalled();
    watchdog.tick(NOW + 5000);
    expect(republish).toHaveBeenCalledTimes(1); // only on change
  });
});
