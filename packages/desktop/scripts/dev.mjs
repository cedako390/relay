// Dev supervisor for the desktop app (`pnpm app:dev`): edit code, and the window shows the result.
//  - web: Vite dev server with HMR, the window loads it directly;
//  - server (+ @orch/shared): esbuild in watch mode into packages/server/dist, after every successful
//    rebuild the server is stopped gracefully (IPC `shutdown`) and started again from dist;
//  - Electron main/preload: esbuild in watch mode, the Electron process is restarted after a rebuild.
// A failed build keeps the previous version running. Closing the window or Ctrl+C stops everything.
//
// By default this is a separate instance (own port and DATA_DIR), so restarts do not kill the sessions of
// the app you are working in. Override with ORCH_DEV_PORT / ORCH_DEV_DATA_DIR / ORCH_DEV_VITE_PORT.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import { buildOptions as desktopBuild } from './build.mjs';
import { buildOptions as serverBuild } from '../../server/scripts/build.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const webRoot = path.join(repoRoot, 'packages', 'web');
const serverEntry = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');

const port = Number(process.env.ORCH_DEV_PORT) || 4185;
const vitePort = Number(process.env.ORCH_DEV_VITE_PORT) || 5183;
const dataDir = process.env.ORCH_DEV_DATA_DIR ?? './data/dev';
const backendUrl = `http://127.0.0.1:${port}`;
const devUrl = `http://127.0.0.1:${vitePort}`;

const log = (msg) => console.log(`\x1b[35m[app:dev]\x1b[0m ${msg}`);

let stopping = false;

// ---------- server ----------

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;

function startServer() {
  const child = spawn(process.execPath, ['--enable-source-maps', serverEntry], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ALLOWED_ORIGINS: `${devUrl},http://localhost:${vitePort}`,
    },
  });
  child.once('exit', (code) => {
    if (server === child) server = null;
    if (!stopping && child.exitCode !== null && !child.restarting) log(`server exited (code ${code}), waiting for the next change`);
  });
  server = child;
}

/** Same as the desktop app on quit: ask for a clean shutdown (closes PTYs and the DB), kill if it hangs. */
async function stopServer() {
  const child = server;
  if (!child || child.exitCode !== null) return;
  child.restarting = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (child.connected) child.send('shutdown');
  else child.kill();
  const timer = setTimeout(() => child.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

async function waitFor(url, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  log(`${what} did not come up at ${url}`);
  return false;
}

// ---------- electron ----------

const electronBin = createRequire(import.meta.url)('electron');
/** @type {import('node:child_process').ChildProcess | null} */
let electron = null;

function startElectron() {
  const env = { ...process.env, ORCH_DEV_URL: devUrl, PORT: String(port) };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, ['.'], { cwd: desktopRoot, stdio: 'inherit', env });
  child.once('exit', () => {
    if (electron === child) electron = null;
    // The user closed the window: end the whole dev session.
    if (!stopping && !child.restarting) void shutdown('window closed');
  });
  electron = child;
}

async function stopElectron() {
  const child = electron;
  if (!child || child.exitCode !== null) return;
  child.restarting = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

// ---------- vite ----------

/** @type {import('node:child_process').ChildProcess | null} */
let vite = null;

function startVite() {
  vite = spawn(process.execPath, [path.join(webRoot, 'node_modules', 'vite', 'bin', 'vite.js')], {
    cwd: webRoot,
    stdio: 'inherit',
    env: { ...process.env, ORCH_BACKEND: backendUrl, VITE_PORT: String(vitePort) },
  });
  vite.once('exit', (code) => {
    if (!stopping) log(`vite exited (code ${code})`);
  });
}

// ---------- watchers ----------

/** Restarts are serialized: a change that lands mid-restart triggers one more restart after it. */
function serial(fn) {
  let running = null;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        if (!stopping) await fn();
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  };
  return run;
}

const restartServer = serial(async () => {
  log('server rebuilt, restarting…');
  await stopServer();
  if (stopping) return;
  startServer();
  if (await waitFor(`${backendUrl}/api/health`, 'server', 20_000)) log('server is up');
});

const restartElectron = serial(async () => {
  log('electron main rebuilt, restarting the window…');
  await stopElectron();
  if (!stopping) startElectron();
});

/** esbuild watch context; `onRebuild` runs after every successful rebuild except the first build. */
async function watch(name, options, onRebuild) {
  let first = true;
  let resolveFirst;
  const firstBuild = new Promise((resolve) => (resolveFirst = resolve));
  const ctx = await context({
    ...options,
    logLevel: 'warning',
    plugins: [
      {
        name: 'orch-dev-restart',
        setup(build) {
          build.onEnd((result) => {
            const ok = result.errors.length === 0;
            if (first) {
              first = false;
              resolveFirst(ok);
              return;
            }
            if (ok) void onRebuild();
            else log(`${name}: build failed, keeping the previous version running`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  return { ctx, ok: await firstBuild };
}

// ---------- lifecycle ----------

/** @type {import('esbuild').BuildContext[]} */
const contexts = [];

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`stopping (${reason})…`);
  await Promise.all(contexts.map((c) => c.dispose()));
  electron?.kill();
  vite?.kill();
  await stopServer();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log(`instance: server ${backendUrl}, web ${devUrl}, DATA_DIR=${dataDir}`);

const [srv, desk] = await Promise.all([
  watch('server', serverBuild, restartServer),
  watch('desktop', desktopBuild, restartElectron),
]);
contexts.push(srv.ctx, desk.ctx);
if (!srv.ok || !desk.ok) {
  log('initial build failed, fix the errors above (the watcher keeps running)');
}

startVite();
if (srv.ok) startServer();
await Promise.all([
  srv.ok ? waitFor(`${backendUrl}/api/health`, 'server') : Promise.resolve(false),
  waitFor(devUrl, 'vite'),
]);
if (!stopping) startElectron();
log('ready: web edits hot-reload, server/main edits rebuild and restart automatically');
