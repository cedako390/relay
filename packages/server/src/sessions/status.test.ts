import { describe, expect, it } from 'vitest';
import { isSuspicious, nextTransition, SUSPICIOUS_AFTER_MS, type SessionState } from './status.js';

const state = (status: SessionState['status'], activeSubagents = 0): SessionState => ({ status, activeSubagents });

describe('nextTransition', () => {
  it.each(['SessionStart', 'Stop'])('%s -> idle', (event) => {
    expect(nextTransition(state('busy'), event)).toEqual({ status: 'idle', touchActivity: true });
  });

  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact'])('%s -> busy and refreshes activity', (event) => {
    expect(nextTransition(state('idle'), event)).toEqual({ status: 'busy', touchActivity: true });
  });

  it('PostToolUse moves a waiting session (permission granted) back to busy', () => {
    expect(nextTransition(state('waiting'), 'PostToolUse').status).toBe('busy');
  });

  it('Notification for a permission prompt -> waiting', () => {
    expect(nextTransition(state('busy'), 'Notification', { notification_type: 'permission_prompt' }).status).toBe('waiting');
  });

  it('Notification without a type -> waiting', () => {
    expect(nextTransition(state('busy'), 'Notification').status).toBe('waiting');
  });

  it('idle_prompt Notification does not make an idle session undeliverable', () => {
    expect(nextTransition(state('idle'), 'Notification', { notification_type: 'idle_prompt' })).toEqual({
      touchActivity: false,
    });
  });

  it('PermissionRequest -> waiting', () => {
    expect(nextTransition(state('busy'), 'PermissionRequest').status).toBe('waiting');
  });

  it('SessionEnd -> closed', () => {
    expect(nextTransition(state('idle'), 'SessionEnd').status).toBe('closed');
  });

  it('counts subagents without changing the status', () => {
    expect(nextTransition(state('busy', 1), 'SubagentStart')).toEqual({ activeSubagents: 2, touchActivity: true });
    expect(nextTransition(state('busy', 2), 'SubagentStop')).toEqual({ activeSubagents: 1, touchActivity: true });
  });

  it('never lets the subagent counter go negative', () => {
    expect(nextTransition(state('busy', 0), 'SubagentStop').activeSubagents).toBe(0);
  });

  it('ignores unknown events', () => {
    expect(nextTransition(state('idle'), 'SomethingNew')).toEqual({ touchActivity: false });
  });

  // hook.mjs posts asynchronously, so events of the old Claude process can arrive after the shell took over
  it.each(['closed', 'dead', 'shell'] as const)('a %s session is never changed by late events', (status) => {
    for (const event of ['SessionStart', 'Stop', 'PreToolUse', 'Notification', 'SubagentStart', 'SessionEnd']) {
      expect(nextTransition(state(status), event)).toEqual({ touchActivity: false });
    }
  });
});

describe('isSuspicious', () => {
  const now = 1_000_000_000;

  it('flags busy sessions without activity for more than 10 minutes', () => {
    expect(isSuspicious({ status: 'busy', lastActivityAt: now - SUSPICIOUS_AFTER_MS - 1 }, now)).toBe(true);
  });

  it('does not flag recent activity', () => {
    expect(isSuspicious({ status: 'busy', lastActivityAt: now - SUSPICIOUS_AFTER_MS + 1000 }, now)).toBe(false);
  });

  it.each(['idle', 'waiting', 'starting', 'closed', 'dead'] as const)('never flags a %s session', (status) => {
    expect(isSuspicious({ status, lastActivityAt: 0 }, now)).toBe(false);
  });
});
