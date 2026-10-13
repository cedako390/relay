import type { SessionStatus } from '@orch/shared';

/** After this long in `busy` without hook activity a session is flagged as suspicious (status stays `busy`). */
export const SUSPICIOUS_AFTER_MS = 10 * 60 * 1000;

export interface SessionState {
  status: SessionStatus;
  activeSubagents: number;
}

export interface Transition {
  /** New status, when it changes. */
  status?: SessionStatus;
  /** New value of the subagent counter, when it changes. */
  activeSubagents?: number;
  /** Whether `last_activity_at` should be refreshed. */
  touchActivity: boolean;
}

const NO_CHANGE: Transition = { touchActivity: false };

/** Notification types that do not mean "the agent is blocked on the user". */
const PASSIVE_NOTIFICATIONS = new Set(['idle_prompt', 'auth_success']);

export const isTerminalStatus = (status: SessionStatus): boolean => status === 'closed' || status === 'dead';

/**
 * Pure state machine: maps a Claude Code hook event onto a session transition.
 *
 *  SessionStart / Stop                                   -> idle
 *  UserPromptSubmit / PreToolUse / PostToolUse / PreCompact -> busy
 *  Notification (permission prompt etc.), PermissionRequest -> waiting
 *  SessionEnd                                            -> closed
 *  SubagentStart / SubagentStop                          -> counter only
 *
 * `Notification` with type `idle_prompt` fires ~60s after the agent went idle; treating it as
 * "waiting" would make an idle session undeliverable, so it is ignored for status purposes.
 */
export function nextTransition(
  state: SessionState,
  eventName: string,
  payload: Record<string, unknown> = {},
): Transition {
  // `shell`: Claude is gone and a plain shell runs; a late hook from the old process must not change that.
  if (isTerminalStatus(state.status) || state.status === 'shell') return NO_CHANGE;

  switch (eventName) {
    case 'SessionStart':
    case 'Stop':
      return { status: 'idle', touchActivity: true };
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PreCompact':
      return { status: 'busy', touchActivity: true };
    case 'Notification': {
      const type = typeof payload.notification_type === 'string' ? payload.notification_type : null;
      if (type && PASSIVE_NOTIFICATIONS.has(type)) return NO_CHANGE;
      return { status: 'waiting', touchActivity: true };
    }
    case 'PermissionRequest':
      return { status: 'waiting', touchActivity: true };
    case 'SessionEnd':
      return { status: 'closed', touchActivity: true };
    case 'SubagentStart':
      return { activeSubagents: state.activeSubagents + 1, touchActivity: true };
    case 'SubagentStop':
      return { activeSubagents: Math.max(0, state.activeSubagents - 1), touchActivity: true };
    default:
      return NO_CHANGE;
  }
}

/** A `busy` session with no activity for too long. Purely informational, never changes the status. */
export function isSuspicious(
  session: { status: SessionStatus; lastActivityAt: number },
  now: number,
  thresholdMs: number = SUSPICIOUS_AFTER_MS,
): boolean {
  return session.status === 'busy' && now - session.lastActivityAt > thresholdMs;
}
