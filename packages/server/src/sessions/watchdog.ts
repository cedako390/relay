import { isActiveSessionStatus } from '@orch/shared';
import { isProcessAlive } from './pty.js';
import type { SessionManager } from './manager.js';
import { isSuspicious } from './status.js';

export const WATCHDOG_INTERVAL_MS = 5_000;

/**
 * Safety net for missed hook events:
 *  - marks sessions whose PTY process is gone as `dead`;
 *  - flips the derived `suspicious` flag (busy, no activity for a long time) and re-broadcasts the session.
 * The status of a suspicious session is never changed automatically.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  private readonly suspicious = new Set<string>();
  /** Sessions whose process looked gone on the previous tick (exit events may lag behind by a moment). */
  private readonly missing = new Set<string>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly intervalMs: number = WATCHDOG_INTERVAL_MS,
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
      if (!isActiveSessionStatus(session.status)) {
        this.suspicious.delete(session.id);
        this.missing.delete(session.id);
        continue;
      }
      const live = this.sessions.liveSession(session.id);
      const gone = !live || (!live.exited && session.pid !== null && !isProcessAlive(session.pid));
      if (gone) {
        // Require two consecutive sightings so the PTY's own exit handling (which knows whether we
        // killed the process on purpose) gets the chance to record the final status first.
        if (!this.missing.has(session.id)) {
          this.missing.add(session.id);
          continue;
        }
        this.suspicious.delete(session.id);
        this.missing.delete(session.id);
        this.sessions.markDead(session.id);
        continue;
      }
      this.missing.delete(session.id);
      const flagged = isSuspicious(session, now);
      if (flagged !== this.suspicious.has(session.id)) {
        if (flagged) this.suspicious.add(session.id);
        else this.suspicious.delete(session.id);
        this.sessions.republish(session.id);
      }
    }
  }
}
