import type { FastifyBaseLogger as Logger } from 'fastify';
import type { EventBus } from '../events/bus.js';
import type { EventRepo } from '../hooks/repo.js';
import type { SessionManager } from './manager.js';
import { reconcileWithTitle } from './title.js';

export const RECONCILE_INTERVAL_MS = 1_000;

/**
 * Corrects hook-derived statuses that went stale, using the terminal window title (see title.ts):
 * Esc interrupts fire no Stop hook, and nothing fires after a permission prompt is answered.
 * Every correction is written to the `events` table as an `OrchReconcile` event for auditing.
 */
export class TitleReconciler {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly sessions: SessionManager,
    private readonly events: EventRepo,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly intervalMs: number = RECONCILE_INTERVAL_MS,
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(now: number = Date.now()): void {
    for (const session of this.sessions.list()) {
      if (session.status !== 'busy' && session.status !== 'waiting') continue;
      const live = this.sessions.liveSession(session.id);
      if (!live || live.exited) continue;

      const title = live.title;
      const corrected = reconcileWithTitle(
        {
          status: session.status,
          statusSince: this.sessions.statusSince(session.id),
          activeSubagents: session.activeSubagents,
          lastActivityAt: session.lastActivityAt,
          state: title.state,
          stateSince: title.since,
          lastWorkingAt: title.lastWorkingAt,
        },
        now,
      );
      if (!corrected) continue;

      this.log.info({ id: session.id, from: session.status, to: corrected }, 'status corrected from window title');
      const event = this.events.insert(
        session.id,
        'OrchReconcile',
        { from: session.status, to: corrected, reason: 'window-title', hook_event_name: 'OrchReconcile' },
        now,
      );
      this.bus.publish({ type: 'event', event });
      this.sessions.setStatus(session.id, corrected);
    }
  }
}
