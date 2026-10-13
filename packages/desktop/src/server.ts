import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const repoRoot = path.resolve(__dirname, '..', '..', '..');
const serverEntry = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const webIndex = path.join(repoRoot, 'packages', 'web', 'dist', 'index.html');

/** Same precedence as the server's config: real environment first, then `.env`. */
function readPort(): number {
  let raw = process.env.PORT;
  if (!raw) {
    const envFile = path.join(repoRoot, '.env');
    if (existsSync(envFile)) raw = /^\s*PORT\s*=\s*(\d+)/m.exec(readFileSync(envFile, 'utf8'))?.[1];
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : 4180;
}

export const port = readPort();
export const appUrl = `http://127.0.0.1:${port}`;

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ServerHandle {
  /** Whether this app started the server (and therefore must stop it on exit). */
  readonly owned: boolean;
  stop(): Promise<void>;
}

/** Attaches to a server that is already running, otherwise starts the built one with the system `node`. */
export async function ensureServer(): Promise<ServerHandle> {
  if (await isUp()) return { owned: false, stop: async () => {} };

  if (!existsSync(serverEntry) || !existsSync(webIndex)) {
    throw new Error('Сервер или фронт не собраны. Выполните `pnpm build` в корне проекта.');
  }

  // The native modules (node-pty, better-sqlite3) are built for plain Node, not for Electron's ABI,
  // so the server runs under the system `node` rather than inside Electron.
  const child = spawn('node', [serverEntry], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.once('error', (err) => {
    stderr += `\n${err.message}`;
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isUp()) return { owned: true, stop: () => stopChild(child, exited) };
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`Сервер не запустился.\n${stderr.trim()}`);
}

/** Asks the server to shut down cleanly (it closes the PTYs and the database), killing it if it hangs. */
async function stopChild(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.connected) child.send('shutdown');
  const timer = setTimeout(() => child.kill(), 5000);
  await exited;
  clearTimeout(timer);
}
