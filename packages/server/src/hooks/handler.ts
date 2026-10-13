import type { EventBus } from '../events/bus.js';
import { SessionError, type SessionManager } from '../sessions/manager.js';
import { nextTransition } from '../sessions/status.js';
import type { EventRepo } from './repo.js';

/** Hook payloads (tool responses, transcripts) can be huge; keep the audit log bounded. */
const MAX_PAYLOAD_CHARS = 32 * 1024;

export function capPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(payload).length <= MAX_PAYLOAD_CHARS) return payload;
  const capped: Record<string, unknown> = { _truncated: true };
  for (const [key, value] of Object.entries(payload)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    capped[key] = text.length > 2_000 ? `${text.slice(0, 2_000)}…[${text.length} chars]` : value;
  }
  return capped;
}

/** Applies Claude Code hook events: audit log + status state machine. */
export class HookHandler {
  constructor(
    private readonly sessions: SessionManager,
    private readonly events: EventRepo,
    private readonly bus: EventBus,
  ) {}

  handle(sessionId: string, payload: Record<string, unknown>): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionError('unknown session', 404);
    const name = payload.hook_event_name;
    if (typeof name !== 'string' || !name) throw new SessionError('payload.hook_event_name is required', 400);

    const event = this.events.insert(sessionId, name, capPayload(payload), Date.now());
    this.bus.publish({ type: 'event', event });

    // SessionStart establishes Claude's own session id (it also changes on /clear); keep it for `--resume`.
    if (name === 'SessionStart' && typeof payload.session_id === 'string' && payload.session_id) {
      this.sessions.rememberClaudeSessionId(sessionId, payload.session_id);
    }

    if (name === 'UserPromptSubmit') this.sessions.rememberPrompt(sessionId);

    // A session that falls back to a shell is not "closed" when Claude says goodbye; the exit handler decides.
    if (name === 'SessionEnd' && this.sessions.handleSessionEnd(sessionId, typeof payload.reason === 'string' ? payload.reason : undefined)) return;

    const transition = nextTransition(session, name, payload);
    this.sessions.applyTransition(sessionId, transition);
  }
}
