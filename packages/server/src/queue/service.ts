import { randomUUID } from 'node:crypto';
import type { Message, SessionStatus } from '@orch/shared';
import type { EventBus } from '../events/bus.js';
import { ENTER, toBracketedPaste } from './paste.js';
import type { MessageRepo } from './repo.js';

/** What the queue needs from the session layer. */
export interface SessionPort {
  getStatus(sessionId: string): SessionStatus | undefined;
  /** Optimistically marks the session busy right after text was submitted to it. */
  markBusy(sessionId: string): void;
  /** Whether the terminal app is ready to receive a bracketed paste (see LiveSession.isReadyForPaste). */
  isInputReady(sessionId: string): boolean;
  /** Writes raw bytes to the PTY; false if there is no live process. */
  write(sessionId: string, data: string): boolean;
}

export interface QueueOptions {
  /** Pause between the pasted text and the Enter keystroke. */
  enterDelayMs?: number;
  /** How long to wait for the terminal app to become ready for input before giving up until the next idle event. */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  /** Delay before retrying a delivery that stalled because the terminal was not ready. */
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Per-session inbox. A message is injected into the terminal only while the session is `idle`
 * (bracketed paste, then a separate Enter); otherwise it stays `queued` until the next idle event.
 */
export class MessageQueue {
  private readonly flushing = new Set<string>();
  private readonly enterDelayMs: number;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly retryMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly repo: MessageRepo,
    private readonly sessions: SessionPort,
    private readonly bus: EventBus,
    private readonly options: QueueOptions = {},
  ) {
    this.enterDelayMs = options.enterDelayMs ?? 250;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
    this.readyPollMs = options.readyPollMs ?? 100;
    this.retryMs = options.retryMs ?? 5_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** Stores the message and delivers it right away if the session is idle. */
  enqueue(sessionId: string, body: string): Message {
    const message = this.repo.insert({ id: randomUUID(), sessionId, body }, this.now());
    this.bus.publish({ type: 'message', message });
    void this.flush(sessionId);
    return message;
  }

  list(sessionId: string): Message[] {
    return this.repo.listBySession(sessionId);
  }

  /** Delivers queued messages one by one for as long as the session stays idle. Returns how many were sent. */
  async flush(sessionId: string): Promise<number> {
    if (this.flushing.has(sessionId)) return 0;
    this.flushing.add(sessionId);
    let delivered = 0;
    let stalled = false;
    try {
      while (this.sessions.getStatus(sessionId) === 'idle') {
        const message = this.repo.nextQueued(sessionId);
        if (!message) break;
        if (!(await this.waitUntilReady(sessionId))) {
          stalled = this.sessions.getStatus(sessionId) === 'idle';
          break;
        }
        if (!this.sessions.write(sessionId, toBracketedPaste(message.body))) break;
        // From now on the agent is processing input; stop other deliveries until the next Stop event.
        this.sessions.markBusy(sessionId);
        await this.sleep(this.enterDelayMs);
        if (!this.sessions.write(sessionId, ENTER)) break;
        const done = this.repo.markDelivered(message.id, this.now());
        if (done) this.bus.publish({ type: 'message', message: done });
        delivered += 1;
      }
    } catch (err) {
      this.options.onError?.(err);
    } finally {
      this.flushing.delete(sessionId);
    }
    // Idle but the terminal never became ready: no further hook event is guaranteed, so try again later.
    if (stalled) setTimeout(() => void this.flush(sessionId), this.retryMs).unref();
    return delivered;
  }

  /** Polls until the terminal can take a paste. False if the session stopped being idle or the wait timed out. */
  private async waitUntilReady(sessionId: string): Promise<boolean> {
    for (let waited = 0; waited <= this.readyTimeoutMs; waited += this.readyPollMs) {
      if (this.sessions.getStatus(sessionId) !== 'idle') return false;
      if (this.sessions.isInputReady(sessionId)) return true;
      await this.sleep(this.readyPollMs);
    }
    return false;
  }
}
