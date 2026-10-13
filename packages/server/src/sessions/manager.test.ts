import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TerminalServerFrame } from '@orch/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../events/bus.js';
import { createTestDb, silentLog, testConfig } from '../test-utils.js';
import { SessionManager } from './manager.js';
import type { PtyProcess, SpawnPtyOptions } from './pty.js';
import { SessionRepo } from './repo.js';

class FakePty implements PtyProcess {
  private static next = 1000;
  readonly pid = FakePty.next++;
  readonly written: string[] = [];
  private dataListener: (data: string) => void = () => undefined;
  private exitListener: (code: number) => void = () => undefined;
  constructor(readonly opts: SpawnPtyOptions) {}
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(): void {
    this.exitListener(0);
  }
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.exitListener = listener;
  }
  emit(data: string): void {
    this.dataListener(data);
  }
  exit(code: number): void {
    this.exitListener(code);
  }
}

describe('SessionManager: shell after Claude, terminal sessions', () => {
  let spawned: FakePty[];
  let manager: SessionManager;
  let cwd: string;

  beforeEach(() => {
    spawned = [];
    cwd = mkdtempSync(path.join(tmpdir(), 'orch-manager-'));
    const config = testConfig({ sessionsDir: path.join(cwd, 'sessions'), shellBin: 'powershell.exe', claudeBin: 'claude' });
    manager = new SessionManager({
      config,
      repo: new SessionRepo(createTestDb()),
      bus: new EventBus(),
      log: silentLog,
      spawn: (opts) => {
        const pty = new FakePty(opts);
        spawned.push(pty);
        return pty;
      },
    });
  });

  it('leaves the user in a shell, in the same terminal, when Claude exits on its own', () => {
    const session = manager.create({ cwd });
    const claude = spawned[0]!;
    expect(claude.opts.command).toBe('claude');
    const live = manager.liveSession(session.id)!;
    const frames: TerminalServerFrame[] = [];
    live.attach((f) => frames.push(f));
    live.resize(100, 40);

    manager.handleSessionEnd(session.id, 'prompt_input_exit'); // SessionEnd hook
    claude.exit(0);

    const after = manager.get(session.id)!;
    expect(after.status).toBe('shell');
    expect(after.endedAt).toBeNull();
    expect(after.pid).toBe(spawned[1]!.pid);
    expect(spawned[1]!.opts).toMatchObject({ command: 'powershell.exe', args: ['-NoLogo'], cwd, cols: 100, rows: 40 });
    // The same LiveSession keeps serving the viewers: no exit frame, the new shell's output flows through.
    expect(manager.liveSession(session.id)).toBe(live);
    expect(live.exited).toBe(false);
    spawned[1]!.emit('PS> ');
    expect(frames.some((f) => f.type === 'exit')).toBe(false);
    expect(frames.at(-1)).toEqual({ type: 'output', data: 'PS> ' });
    expect(live.write('dir\r')).toBe(true);
    expect(spawned[1]!.written).toEqual(['dir\r']);
  });

  it('SessionEnd does not close the session; the shell is warmed up and adopted when Claude exits', () => {
    const session = manager.create({ cwd });
    const claude = spawned[0]!;
    const live = manager.liveSession(session.id)!;
    const frames: TerminalServerFrame[] = [];
    live.attach((f) => frames.push(f));

    expect(manager.handleSessionEnd(session.id, 'prompt_input_exit')).toBe(true);
    expect(manager.get(session.id)!.status).toBe('starting'); // untouched: no "closed" flash
    expect(spawned).toHaveLength(2); // the shell is already starting
    spawned[1]!.emit('PS> '); // its prompt appears while Claude is still shutting down
    expect(frames).toEqual([]); // not shown yet

    claude.exit(0);
    expect(manager.get(session.id)!.status).toBe('shell');
    expect(spawned).toHaveLength(2); // the warmed shell was reused, not a new one
    expect(frames.map((f) => (f.type === 'output' ? f.data : '')).join('')).toContain('PS> ');
    expect(manager.get(session.id)!.pid).toBe(spawned[1]!.pid);
  });

  it('SessionEnd from /clear keeps the session as is and starts no shell', () => {
    const session = manager.create({ cwd });
    expect(manager.handleSessionEnd(session.id, 'clear')).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('a warmed-up shell is discarded when the session is killed', () => {
    const session = manager.create({ cwd });
    manager.handleSessionEnd(session.id, 'other');
    manager.kill(session.id);
    expect(manager.get(session.id)!.status).toBe('closed');
    expect(spawned).toHaveLength(2); // the warm one, already killed; none started afterwards
  });

  it('SessionEnd of a worker is left to the normal state machine', () => {
    const worker = manager.create({ cwd, kind: 'worker', taskId: 't1' });
    expect(manager.handleSessionEnd(worker.id, 'other')).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it('closes for good when the shell itself exits', () => {
    const session = manager.create({ cwd });
    spawned[0]!.exit(0);
    spawned[1]!.exit(1); // exit code of the last command in the shell
    expect(manager.get(session.id)!.status).toBe('closed');
    expect(spawned).toHaveLength(2);
  });

  it('does not start a shell when the session was terminated on purpose', () => {
    const session = manager.create({ cwd });
    manager.kill(session.id);
    expect(manager.get(session.id)!.status).toBe('closed');
    expect(spawned).toHaveLength(1);
  });

  it('does not start a shell for a worker or a nested orchestrator', () => {
    const worker = manager.create({ cwd, kind: 'worker', taskId: 't1' });
    spawned[0]!.exit(0);
    expect(manager.get(worker.id)!.status).toBe('closed');
    const nested = manager.create({ cwd, parentSessionId: worker.id });
    spawned[1]!.exit(0);
    expect(manager.get(nested.id)!.status).toBe('closed');
    expect(spawned).toHaveLength(2);
  });

  it('a terminal session is a plain shell without Claude hooks, restartable after it closes', () => {
    const terminal = manager.create({ cwd, kind: 'terminal' });
    expect(terminal).toMatchObject({ kind: 'terminal', status: 'shell', model: null });
    expect(spawned[0]!.opts.command).toBe('powershell.exe');
    expect(spawned[0]!.opts.args).toEqual(['-NoLogo']);
    expect(spawned[0]!.opts.env.ORCH_SESSION_ID).toBeUndefined();
    expect(spawned[0]!.opts.args).not.toContain('--settings');

    spawned[0]!.exit(0);
    expect(manager.get(terminal.id)!.status).toBe('closed');
    expect(spawned).toHaveLength(1); // a terminal that exited does not respawn by itself

    manager.resume(terminal.id);
    expect(manager.get(terminal.id)).toMatchObject({ status: 'shell', endedAt: null });
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.opts.command).toBe('powershell.exe');
  });

  it('brings back a session nobody wrote to as a fresh claude, not with --resume', () => {
    const session = manager.create({ cwd });
    manager.rememberClaudeSessionId(session.id, 'claude-abc'); // SessionStart arrived, but no prompt was ever sent
    manager.kill(session.id);
    expect(manager.get(session.id)!.status).toBe('closed');

    const back = manager.resume(session.id); // e.g. after the app was restarted
    expect(back.status).toBe('starting');
    expect(back.claudeSessionId).toBeNull();
    expect(spawned[1]!.opts.command).toBe('claude');
    expect(spawned[1]!.opts.args).not.toContain('--resume');
    expect(spawned[1]!.opts.env.ORCH_SESSION_ID).toBe(session.id);
  });

  it('a session with a conversation is still resumed with --resume', () => {
    const session = manager.create({ cwd });
    manager.rememberClaudeSessionId(session.id, 'claude-abc');
    manager.rememberPrompt(session.id);
    manager.kill(session.id);

    manager.resume(session.id);
    const args = spawned[1]!.opts.args;
    expect(args[args.indexOf('--resume') + 1]).toBe('claude-abc');
  });

  it('a session whose transcript is gone starts fresh instead of failing', () => {
    const session = manager.create({ cwd });
    manager.rememberClaudeSessionId(session.id, 'claude-abc');
    manager.rememberPrompt(session.id);
    manager.kill(session.id);

    manager.resume(session.id, { claudeSessionId: 'claude-abc', transcriptPath: path.join(cwd, 'missing.jsonl') });
    expect(spawned[1]!.opts.args).not.toContain('--resume');
  });

  it('marks shell sessions of a previous server run as dead at boot', () => {
    const terminal = manager.create({ cwd, kind: 'terminal' });
    const fresh = new SessionManager({
      config: testConfig(),
      repo: (manager as unknown as { deps: { repo: SessionRepo } }).deps.repo,
      bus: new EventBus(),
      log: silentLog,
      spawn: (opts) => new FakePty(opts),
    });
    expect(fresh.reconcileOrphans()).toBe(1);
    expect(fresh.get(terminal.id)!.status).toBe('dead');
  });
});
