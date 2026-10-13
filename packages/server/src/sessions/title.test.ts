import { describe, expect, it } from 'vitest';
import type { Session } from '@orch/shared';
import type { EventRepo } from '../hooks/repo.js';
import type { EventBus } from '../events/bus.js';
import { silentLog } from '../test-utils.js';
import { LiveSession } from './live-session.js';
import type { PtyProcess } from './pty.js';
import type { SessionManager } from './manager.js';
import { TitleReconciler } from './reconciler.js';
import {
  classifyTitle,
  conversationTitle,
  extractTitles,
  READY_CONFIRM_MS,
  reconcileWithTitle,
  WORKING_CONFIRM_MS,
  type TitleObservation,
} from './title.js';

const osc = (title: string): string => `\x1b]0;${title}\x07`;

describe('classifyTitle', () => {
  it('✳ means ready for input', () => {
    expect(classifyTitle('✳ Claude Code')).toBe('ready');
  });
  it.each(['◐ Claude Code', '◑ PowerShell ping wait test', '◒ x', '◓ x', '⠂ Claude Code', '⣾ x'])('%s means working', (t) => {
    expect(classifyTitle(t)).toBe('working');
  });
  it.each(['claude', 'C:\\Users\\admin\\.local\\bin\\claude.EXE', '', '   '])('ignores non-state title %j', (t) => {
    expect(classifyTitle(t)).toBeNull();
  });
});

describe('conversationTitle', () => {
  it('strips the state glyph', () => {
    expect(conversationTitle('✳ Greeting exchange')).toBe('Greeting exchange');
    expect(conversationTitle('◑ Greeting exchange')).toBe('Greeting exchange');
  });
  it.each(['claude', 'C:\Windows\system32\cmd.exe', '✳ Claude Code', '◐ Claude Code', '✳'])('%s is not a name', (t) => {
    expect(conversationTitle(t)).toBeNull();
  });
});

describe('extractTitles', () => {
  it('finds titles terminated by BEL or ST', () => {
    expect(extractTitles(`abc${osc('one')}def\x1b]0;two\x1b\\`).titles).toEqual(['one', 'two']);
  });
  it('keeps an unterminated sequence for the next chunk', () => {
    const first = extractTitles('text\x1b]0;◐ Cla');
    expect(first.titles).toEqual([]);
    expect(extractTitles(first.rest + 'ude Code\x07').titles).toEqual(['◐ Claude Code']);
  });
  it('ignores other OSC codes and plain text', () => {
    expect(extractTitles('\x1b]8;;http://x\x07link\x1b]8;;\x07').titles).toEqual([]);
  });
});

describe('reconcileWithTitle', () => {
  const NOW = 1_000_000;
  const base: TitleObservation = {
    status: 'busy',
    statusSince: NOW - 60_000,
    activeSubagents: 0,
    lastActivityAt: NOW - 60_000,
    state: 'ready',
    stateSince: NOW - 20_000,
    lastWorkingAt: NOW - 25_000,
  };

  describe('busy -> idle (interrupted work, no Stop hook)', () => {
    it('corrects when work was seen, the title is ready and hooks were quiet long enough', () => {
      expect(reconcileWithTitle(base, NOW)).toBe('idle');
    });
    it('waits until the ready title is stable', () => {
      expect(reconcileWithTitle({ ...base, stateSince: NOW - (READY_CONFIRM_MS - 100) }, NOW)).toBeNull();
    });
    it('waits while hooks are still arriving', () => {
      expect(reconcileWithTitle({ ...base, lastActivityAt: NOW - 1000 }, NOW)).toBeNull();
    });
    it('does nothing while the title shows work', () => {
      expect(reconcileWithTitle({ ...base, state: 'working', stateSince: NOW - 30_000, lastWorkingAt: NOW }, NOW)).toBeNull();
    });
    it('does not trust a ready title if no work was ever seen after the session became busy', () => {
      // e.g. right after a message was pasted but before the TUI reacted
      expect(reconcileWithTitle({ ...base, statusSince: NOW - 10_000, lastWorkingAt: NOW - 25_000 }, NOW)).toBeNull();
    });
    it('does nothing while sub-agents are active', () => {
      expect(reconcileWithTitle({ ...base, activeSubagents: 1 }, NOW)).toBeNull();
    });
    it('does nothing without any title information', () => {
      expect(reconcileWithTitle({ ...base, state: null, stateSince: null }, NOW)).toBeNull();
    });
  });

  describe('waiting -> busy (permission granted, no hook fires)', () => {
    const waiting: TitleObservation = {
      ...base,
      status: 'waiting',
      statusSince: NOW - 10_000,
      state: 'working',
      stateSince: NOW - 5_000,
      lastWorkingAt: NOW,
    };
    it('corrects when the spinner resumed after the status became waiting', () => {
      expect(reconcileWithTitle(waiting, NOW)).toBe('busy');
    });
    it('waits a moment so a flicker does not count', () => {
      expect(reconcileWithTitle({ ...waiting, stateSince: NOW - (WORKING_CONFIRM_MS - 100) }, NOW)).toBeNull();
    });
    it('keeps waiting while the permission dialog is shown (ready title)', () => {
      expect(reconcileWithTitle({ ...waiting, state: 'ready' }, NOW)).toBeNull();
    });
    it('ignores a spinner that started before the status became waiting', () => {
      expect(reconcileWithTitle({ ...waiting, stateSince: NOW - 20_000 }, NOW)).toBeNull();
    });
  });

  it.each(['idle', 'starting', 'closed', 'dead'] as const)('never touches a %s session', (status) => {
    expect(reconcileWithTitle({ ...base, status }, NOW)).toBeNull();
  });
});

class FakePty implements PtyProcess {
  pid = 1;
  private data: Array<(d: string) => void> = [];
  write(): void {}
  resize(): void {}
  kill(): void {}
  onData(l: (d: string) => void): void {
    this.data.push(l);
  }
  onExit(): void {}
  emit(d: string): void {
    for (const l of this.data) l(d);
  }
}

describe('LiveSession title tracking', () => {
  it('follows ready/working transitions from the PTY stream, including split chunks', () => {
    const pty = new FakePty();
    const live = new LiveSession('s', pty, () => undefined);
    expect(live.title.state).toBeNull();

    pty.emit(osc('claude'));
    expect(live.title.state).toBeNull();

    pty.emit(osc('✳ Claude Code'));
    expect(live.title.state).toBe('ready');

    pty.emit('\x1b]0;◐ Claude');
    expect(live.title.state).toBe('ready'); // not complete yet
    pty.emit(' Code\x07');
    expect(live.title.state).toBe('working');
    expect(live.title.lastWorkingAt).not.toBeNull();

    const since = live.title.since;
    pty.emit(osc('◑ Claude Code'));
    expect(live.title.since).toBe(since); // spinner frames are not a state change
  });
});

describe('LiveSession conversation name', () => {
  it('reports the name once per change, ignoring placeholders and spinner frames', () => {
    const pty = new FakePty();
    const names: string[] = [];
    new LiveSession('s', pty, () => undefined, { onTitle: (t) => names.push(t) });
    pty.emit(osc('claude'));
    pty.emit(osc('✳ Claude Code'));
    pty.emit(osc('◐ Claude Code'));
    pty.emit(osc('◑ Greeting exchange'));
    pty.emit(osc('✳ Greeting exchange'));
    pty.emit(osc('✳ Renamed'));
    expect(names).toEqual(['Greeting exchange', 'Renamed']);
  });
});

describe('TitleReconciler', () => {
  it('corrects a stale busy session and records an audit event', () => {
    const NOW = 5_000_000;
    const session = {
      id: 's1', status: 'busy', activeSubagents: 0, lastActivityAt: NOW - 60_000,
    } as unknown as Session;
    const setStatus: Array<[string, string]> = [];
    const inserted: Array<{ type: string; payload: unknown }> = [];
    const manager = {
      list: () => [session],
      liveSession: () => ({ exited: false, title: { state: 'ready', since: NOW - 20_000, lastWorkingAt: NOW - 25_000 } }),
      statusSince: () => NOW - 60_000,
      setStatus: (id: string, s: string) => void setStatus.push([id, s]),
    } as unknown as SessionManager;
    const events = {
      insert: (_id: string, type: string, payload: unknown) => {
        inserted.push({ type, payload });
        return { id: 1, sessionId: 's1', type, payload, ts: NOW };
      },
    } as unknown as EventRepo;
    const bus = { publish: () => undefined } as unknown as EventBus;

    new TitleReconciler(manager, events, bus, silentLog).tick(NOW);

    expect(setStatus).toEqual([['s1', 'idle']]);
    expect(inserted[0]?.type).toBe('OrchReconcile');
  });
});
