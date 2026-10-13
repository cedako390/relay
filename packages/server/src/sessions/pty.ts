import { spawn as spawnChild } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import * as nodePty from 'node-pty';

/** Minimal surface of a pseudo-terminal process; lets the rest of the code (and tests) avoid node-pty. */
export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
}

export interface SpawnPtyOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

/**
 * Variables removed from the child's environment:
 *  - API credentials, which would make Claude Code bill an API key instead of using the subscription;
 *  - identity markers of a *parent* Claude Code session (present when the server itself is started from
 *    inside one), which would make the child behave as a nested session (e.g. no transcript saving).
 */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
];

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV.some((name) => name.toLowerCase() === key.toLowerCase())) continue;
    env[key] = value;
  }
  env.TERM ??= 'xterm-256color';
  env.COLORTERM ??= 'truecolor';
  // Classic renderer: claude's fullscreen ("no-flicker") mode keeps history in the app and nothing reaches
  // xterm's scrollback, so the wheel does nothing. Set CLAUDE_CODE_NO_FLICKER=1 to opt back in.
  env.CLAUDE_CODE_NO_FLICKER ??= '0';
  return { ...env, ...extra };
}

/** Arguments for an interactive shell: PowerShell gets no startup banner, anything else runs as is. */
export function shellArgs(shell: string): string[] {
  return /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shell) ? ['-NoLogo'] : [];
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Resolves a command name through PATH (+ PATHEXT on Windows). Returns the input unchanged if not found. */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const hasDir = command.includes('/') || command.includes('\\');
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  const dirs = hasDir ? [''] : (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, command + ext) : command + ext;
      if (!isFile(candidate)) continue;
      if (process.platform !== 'win32') {
        try {
          accessSync(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      return candidate;
    }
  }
  return command;
}

export function spawnPty(opts: SpawnPtyOptions): PtyProcess {
  let command = resolveExecutable(opts.command);
  let args = opts.args;
  // ConPTY cannot start .cmd/.bat shims directly.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    args = ['/d', '/s', '/c', command, ...args];
    command = process.env.ComSpec ?? 'cmd.exe';
  }
  const term = nodePty.spawn(command, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    cwd: opts.cwd,
    env: opts.env,
  });
  return {
    pid: term.pid,
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => {
      term.kill();
      killProcessTree(term.pid);
    },
    onData: (listener) => void term.onData(listener),
    onExit: (listener) => void term.onExit((e) => listener(e.exitCode)),
  };
}

/** On Windows `kill()` may leave the child's descendants running; make sure the whole tree goes away. */
function killProcessTree(pid: number): void {
  if (process.platform !== 'win32') return;
  try {
    const child = spawnChild('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
  } catch {
    // process already gone
  }
}

/** True if a process with this pid exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
