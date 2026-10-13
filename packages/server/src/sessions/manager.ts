import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import {
  isActiveSessionStatus,
  type Session,
  type SessionKind,
  type SessionStatus,
} from '@orch/shared';
import { resolveModel, type Config } from '../config/index.js';
import type { EventBus } from '../events/bus.js';
import { buildClaudeArgs } from './claude-args.js';
import { writeClaudeConfig } from './claude-config.js';
import { LiveSession } from './live-session.js';
import { buildChildEnv, shellArgs, spawnPty, type PtyProcess, type SpawnPtyOptions } from './pty.js';
import { SessionRepo, type SessionPatch } from './repo.js';
import { isTerminalStatus, type Transition } from './status.js';

export class SessionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
  ) {
    super(message);
  }
}

export interface CreateSessionInput {
  cwd: string;
  model?: string | null;
  taskId?: string | null;
  parentSessionId?: string | null;
  kind?: SessionKind;
}

export type StatusListener = (session: Session, previous: SessionStatus) => void;
export type EndListener = (session: Session, info: { killed: boolean }) => void;
export type PtySpawner = (opts: SpawnPtyOptions) => PtyProcess;

export interface SessionManagerDeps {
  config: Config;
  repo: SessionRepo;
  bus: EventBus;
  log: Logger;
  spawn?: PtySpawner;
}

/**
 * Printed when Claude has exited and a shell takes over the terminal. It also switches off the terminal
 * modes Claude may have left on (mouse, focus events, bracketed paste, hidden cursor), as a shell would expect.
 */
const SHELL_NOTICE =
  '\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l' +
  '\r\n\x1b[90m[Claude завершён, дальше обычный терминал]\x1b[0m\r\n';

interface WarmShell {
  pty: PtyProcess;
  /** Output printed before the shell was attached to the terminal. */
  output: string[];
  adopted: boolean;
  timer: NodeJS.Timeout;
}

/** A warmed-up shell is dropped if Claude has not exited by then. */
const WARM_SHELL_TTL_MS = 30_000;

function assertDirectory(cwd: string): void {
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new SessionError(`cwd does not exist or is not a directory: ${cwd}`);
  }
}

/** Owns the in-memory PTY processes and mirrors their lifecycle into the database. */
export class SessionManager {
  private readonly live = new Map<string, LiveSession>();
  /** When each session last changed status (in memory; used to judge how fresh a status is). */
  private readonly statusChangedAt = new Map<string, number>();
  /** Sessions whose end listeners have already run. */
  private readonly ended = new Set<string>();
  /** Shells started ahead of time for sessions whose Claude is about to exit. */
  private readonly warm = new Map<string, WarmShell>();
  private readonly statusListeners: StatusListener[] = [];
  private readonly endListeners: EndListener[] = [];
  private readonly spawn: PtySpawner;

  constructor(private readonly deps: SessionManagerDeps) {
    this.spawn = deps.spawn ?? spawnPty;
  }

  onStatusChange(listener: StatusListener): void {
    this.statusListeners.push(listener);
  }

  onEnded(listener: EndListener): void {
    this.endListeners.push(listener);
  }

  get(id: string): Session | undefined {
    return this.deps.repo.get(id);
  }

  list(): Session[] {
    return this.deps.repo.list();
  }

  /** When the session's current status began; falls back to its start time. */
  statusSince(id: string): number {
    return this.statusChangedAt.get(id) ?? this.get(id)?.startedAt ?? 0;
  }

  liveSession(id: string): LiveSession | undefined {
    return this.live.get(id);
  }

  /** Sessions the registry still holds a process for. */
  liveIds(): string[] {
    return [...this.live.keys()];
  }

  create(input: CreateSessionInput): Session {
    const { config, repo } = this.deps;
    const cwd = path.resolve(input.cwd);
    assertDirectory(cwd);
    const id = randomUUID();
    const kind: SessionKind = input.kind ?? (input.taskId ? 'worker' : 'orchestrator');
    if (kind === 'terminal') {
      const terminal = repo.insert({ id, taskId: null, parentSessionId: null, kind, cwd, model: null, status: 'shell', now: Date.now() });
      const started = this.startProcess(id, cwd, [], true) ?? terminal;
      this.deps.log.info({ id, pid: started.pid, cwd }, 'terminal started');
      return started;
    }
    const model = resolveModel(config, input.model);

    const files = writeClaudeConfig({
      sessionsDir: config.sessionsDir,
      sessionId: id,
      hookScript: config.hookScript,
      orchUrl: config.orchUrl,
    });
    const args = buildClaudeArgs(config, files, model);

    const session = repo.insert({ id, taskId: input.taskId ?? null, parentSessionId: input.parentSessionId ?? null, kind, cwd, model, status: 'starting', now: Date.now() });
    const updated = this.startProcess(id, cwd, args) ?? session;
    this.deps.log.info({ id, pid: updated.pid, cwd, model, kind }, 'session started');
    return updated;
  }

  /**
   * Brings a finished (closed/dead) session back with `claude --resume`, in the same row and terminal,
   * so its history entry, tab and message inbox stay. `lastStart` is what the latest SessionStart hook
   * reported: it covers sessions recorded before the id was stored on the row, and its transcript tells
   * whether there is a conversation to continue. Without one, a fresh `claude` starts instead (see below).
   */
  resume(id: string, lastStart: { claudeSessionId?: string; transcriptPath?: string } = {}): Session {
    const { config } = this.deps;
    const session = this.get(id);
    if (!session) throw new SessionError('session not found', 404);
    if (!isTerminalStatus(session.status)) {
      throw new SessionError(`session is ${session.status}; only closed or dead sessions can be resumed`, 409);
    }
    if (session.kind === 'terminal') {
      // Nothing to continue: a closed terminal just gets a fresh shell in its folder.
      assertDirectory(session.cwd);
      this.ended.delete(id);
      this.update(id, { status: 'shell', pid: null, lastActivityAt: Date.now(), endedAt: null });
      const restarted = this.startProcess(id, session.cwd, [], true);
      this.deps.log.info({ id, pid: restarted?.pid }, 'terminal restarted');
      return restarted ?? session;
    }
    // Claude writes no transcript until the first message is sent, so a session nobody wrote to has nothing to
    // `--resume` (it would print "No conversation found" and exit). The tab was only an empty prompt, so it is
    // brought back as exactly that: a fresh `claude` in the same row, as if the process had survived the restart.
    const knownId = session.claudeSessionId ?? lastStart.claudeSessionId;
    const noConversation = !knownId || session.promptedAt === null || (!!lastStart.transcriptPath && !existsSync(lastStart.transcriptPath));
    const claudeSessionId = noConversation ? null : knownId;
    assertDirectory(session.cwd);

    const files = writeClaudeConfig({
      sessionsDir: config.sessionsDir,
      sessionId: id,
      hookScript: config.hookScript,
      orchUrl: config.orchUrl,
    });
    const args = buildClaudeArgs(config, files, session.model, claudeSessionId);

    this.ended.delete(id);
    this.update(id, {
      status: 'starting',
      pid: null,
      claudeSessionId,
      activeSubagents: 0,
      lastActivityAt: Date.now(),
      endedAt: null,
      // A resumed worker is driven by the user now. As a worker, its (already settled) task would make the
      // server close it again at the first idle, and it would keep occupying a worker slot.
      kind: 'orchestrator',
    });
    const updated = this.startProcess(id, session.cwd, args);
    this.deps.log.info({ id, pid: updated?.pid, claudeSessionId }, claudeSessionId ? 'session resumed' : 'empty session restarted');
    return updated ?? session;
  }

  /** A plain shell in the given folder; no hooks or MCP, so no orchestrator variables either. */
  private spawnShell(cwd: string, size?: { cols: number; rows: number }): PtyProcess {
    const { shellBin } = this.deps.config;
    return this.spawn({ command: shellBin, args: shellArgs(shellBin), cwd, env: buildChildEnv(process.env, {}), ...size });
  }

  /**
   * Spawns `claude` (or, with `shell`, a plain shell) for an existing row and registers its PTY.
   * Marks the session dead if the spawn fails.
   */
  private startProcess(id: string, cwd: string, args: string[], shell = false): Session | undefined {
    const { config, log } = this.deps;
    let pty: PtyProcess;
    try {
      pty = shell
        ? this.spawnShell(cwd)
        : this.spawn({
            command: config.claudeBin,
            args,
            cwd,
            env: buildChildEnv(process.env, {
              ORCH_SESSION_ID: id,
              ORCH_URL: config.orchUrl,
            }),
          });
    } catch (err) {
      const what = shell ? config.shellBin : config.claudeBin;
      log.error({ err, id }, `failed to spawn ${what}`);
      this.update(id, { status: 'dead', endedAt: Date.now() });
      this.ended.add(id);
      throw new SessionError(`failed to start "${what}": ${(err as Error).message}`, 500);
    }

    // Only folders the server created itself (git worktrees) may have the trust dialog answered for them.
    const rel = path.relative(config.worktreesDir, cwd);
    const inWorktree = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    const liveSession = new LiveSession(id, pty, (code) => this.handleExit(id, code), {
      autoAcceptTrust: !shell && config.autoTrustWorktrees && inWorktree,
      onTitle: shell ? undefined : (title) => this.rememberTitle(id, title),
    });
    this.live.set(id, liveSession);
    return this.update(id, { pid: pty.pid });
  }

  /** Records Claude's own session id (SessionStart), which `resume` hands to `claude --resume`. */
  rememberClaudeSessionId(id: string, claudeSessionId: string): void {
    if (this.get(id)?.claudeSessionId === claudeSessionId) return;
    this.update(id, { claudeSessionId });
  }

  /** Keeps the name Claude gave the conversation, shown as the session's title in the history. */
  rememberTitle(id: string, title: string): void {
    if (this.get(id)?.title === title) return;
    this.update(id, { title });
  }

  /** The first submitted prompt makes the session a conversation worth keeping in the history. */
  rememberPrompt(id: string): void {
    if (this.get(id)?.promptedAt != null) return;
    this.update(id, { promptedAt: Date.now() });
  }

  /** Terminates the PTY process. The final status is recorded by the exit handler. */
  kill(id: string): Session {
    const session = this.get(id);
    if (!session) throw new SessionError('session not found', 404);
    const live = this.live.get(id);
    this.discardWarmShell(id);
    if (live && !live.exited) {
      live.kill();
    } else if (isActiveSessionStatus(session.status)) {
      // No process behind an "active" row (e.g. left over from a previous server run).
      this.finish(id, 'dead', false);
    }
    return this.get(id) ?? session;
  }

  write(id: string, data: string): boolean {
    return this.live.get(id)?.write(data) ?? false;
  }

  /** Applies a hook-driven transition and persists/publishes it. */
  applyTransition(id: string, transition: Transition): Session | undefined {
    const patch: SessionPatch = {};
    if (transition.status) patch.status = transition.status;
    if (transition.activeSubagents !== undefined) patch.activeSubagents = transition.activeSubagents;
    if (transition.touchActivity) patch.lastActivityAt = Date.now();
    if (transition.status === 'closed') patch.endedAt = Date.now();
    return this.update(id, patch);
  }

  setStatus(id: string, status: SessionStatus): Session | undefined {
    const current = this.get(id);
    if (!current || isTerminalStatus(current.status)) return current;
    return this.update(id, { status, lastActivityAt: Date.now() });
  }

  /** Marks a session whose process vanished. No-op for sessions that already ended. */
  markDead(id: string): void {
    this.finish(id, 'dead', false);
  }

  /** At boot nothing is running: any session still marked active belongs to a previous server process. */
  reconcileOrphans(): number {
    const orphans = this.deps.repo.listByStatus(['starting', 'idle', 'busy', 'waiting', 'shell']);
    for (const s of orphans) this.finish(s.id, 'dead', false);
    return orphans.length;
  }

  shutdown(): void {
    for (const id of [...this.warm.keys()]) this.discardWarmShell(id);
    for (const live of this.live.values()) live.kill();
  }

  /** Sessions the user opened themselves end in a shell, not in a dead tab (see `continueInShell`). */
  private staysInShell(session: Session): boolean {
    return session.kind === 'orchestrator' && !session.parentSessionId && session.status !== 'shell' && isActiveSessionStatus(session.status);
  }

  /**
   * SessionEnd hook of a session that will fall back to a shell. It arrives *before* Claude's process is gone
   * (which can take a while), so it must not mark the session closed: the tab would show "closed" until the shell
   * appears. Instead the shell starts now, in the background, and takes the terminal over once Claude has exited.
   * Returns true when the hook was handled here. `/clear` also ends a "session" but keeps the process, so no shell then.
   */
  handleSessionEnd(id: string, reason?: string): boolean {
    const session = this.get(id);
    if (!session || !this.staysInShell(session)) return false;
    if (reason !== 'clear') this.warmUpShell(id, session);
    return true;
  }

  private warmUpShell(id: string, session: Session): void {
    const live = this.live.get(id);
    if (this.warm.has(id) || !live || live.exited) return;
    let pty: PtyProcess;
    try {
      pty = this.spawnShell(session.cwd, live.size);
    } catch {
      return; // `continueInShell` tries again once Claude has exited
    }
    const entry: WarmShell = {
      pty,
      output: [],
      adopted: false,
      // If Claude does not exit after all, the unused shell must not linger.
      timer: setTimeout(() => this.discardWarmShell(id), WARM_SHELL_TTL_MS),
    };
    entry.timer.unref();
    pty.onData((data) => {
      if (!entry.adopted) entry.output.push(data);
    });
    pty.onExit(() => {
      if (this.warm.get(id) !== entry) return;
      clearTimeout(entry.timer);
      this.warm.delete(id);
    });
    this.warm.set(id, entry);
  }

  private discardWarmShell(id: string): void {
    const entry = this.warm.get(id);
    if (!entry) return;
    this.warm.delete(id);
    clearTimeout(entry.timer);
    try {
      entry.pty.kill();
    } catch {
      // already gone
    }
  }

  private handleExit(id: string, code: number | null): void {
    const live = this.live.get(id);
    const killed = live?.killedByUs ?? false;
    const session = this.get(id);
    if (!killed && live && session && this.continueInShell(id, live, session)) return;
    // A shell's exit code is whatever its last command returned, so it says nothing about a crash.
    this.finish(id, killed || code === 0 || session?.status === 'shell' ? 'closed' : 'dead', killed);
    // Keep the LiveSession (and its ring buffer) around briefly so viewers can read the last screen.
    // A resume may have installed a new LiveSession under the same id in the meantime; leave that one alone.
    setTimeout(() => {
      if (this.live.get(id) === live) this.live.delete(id);
    }, 60_000).unref();
  }

  /**
   * Claude exited on its own (Ctrl+C twice, /exit, a crash): like in any terminal, the user is left at a
   * shell prompt in the same tab instead of a dead session. Only for sessions the user opened; workers and
   * nested orchestrators end for good, and so does a session we terminated ourselves.
   */
  private continueInShell(id: string, live: LiveSession, session: Session): boolean {
    if (!this.staysInShell(session)) return false;
    let pty: PtyProcess;
    let startup = '';
    const warm = this.warm.get(id);
    if (warm) {
      // Started when SessionEnd arrived: whatever it printed since (the prompt) comes right after the notice.
      this.warm.delete(id);
      clearTimeout(warm.timer);
      warm.adopted = true;
      pty = warm.pty;
      startup = warm.output.join('');
    } else {
      try {
        pty = this.spawnShell(session.cwd, live.size);
      } catch (err) {
        this.deps.log.warn({ err, id }, 'could not start a shell after claude exited');
        return false;
      }
    }
    live.continueWith(pty, SHELL_NOTICE + startup);
    this.ended.delete(id);
    this.update(id, { status: 'shell', pid: pty.pid, activeSubagents: 0, lastActivityAt: Date.now(), endedAt: null });
    this.deps.log.info({ id, pid: pty.pid }, 'claude exited, shell started in the same terminal');
    return true;
  }

  private finish(id: string, final: 'closed' | 'dead', killed: boolean): void {
    this.discardWarmShell(id);
    const current = this.get(id);
    if (!current || this.ended.has(id)) return;
    // The SessionEnd hook may already have closed the session; keep that status.
    const updated = this.update(id, {
      status: isTerminalStatus(current.status) ? current.status : final,
      endedAt: current.endedAt ?? Date.now(),
    });
    if (!updated) return;
    this.ended.add(id);
    this.deps.log.info({ id, status: updated.status }, 'session ended');
    for (const listener of this.endListeners) {
      try {
        listener(updated, { killed });
      } catch (err) {
        this.deps.log.error({ err }, 'end listener failed');
      }
    }
  }

  private update(id: string, patch: SessionPatch): Session | undefined {
    const before = this.deps.repo.get(id);
    const after = this.deps.repo.update(id, patch);
    if (!after) return undefined;
    this.deps.bus.publish({ type: 'session', session: after });
    if (before && before.status !== after.status) {
      this.statusChangedAt.set(id, Date.now());
      for (const listener of this.statusListeners) {
        try {
          listener(after, before.status);
        } catch (err) {
          this.deps.log.error({ err }, 'status listener failed');
        }
      }
    }
    return after;
  }

  /** Re-broadcasts a session (used by the watchdog when the derived `suspicious` flag flips). */
  republish(id: string): void {
    const s = this.get(id);
    if (s) this.deps.bus.publish({ type: 'session', session: s });
  }
}
