import { mkdirSync } from 'node:fs';
import type { FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createContext } from './context.js';
import { openDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const log: FastifyBaseLogger = pino({
    level: config.logLevel,
    ...(process.stdout.isTTY ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } } : {}),
  });

  const { db, sqlite } = openDb(config.dbPath);
  runMigrations(db);

  const ctx = createContext(config, db, log);
  const orphans = ctx.sessions.reconcileOrphans();
  if (orphans > 0) log.warn({ orphans }, 'marked sessions from a previous run as dead');

  const app = await buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });
  ctx.watchdog.start();
  ctx.reconciler.start();
  void ctx.tasks.drain();

  log.info(`Orchestrator listening on ${config.orchUrl}`);
  log.info(`Open the UI (dev): http://127.0.0.1:5173/`);
  log.info(`Open the UI (built): ${config.orchUrl}/`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    ctx.watchdog.stop();
    ctx.reconciler.stop();
    ctx.sessions.shutdown();
    await app.close();
    sqlite.close();
    process.exit(0);
  };
  // A stray rejection must not kill the server: that would also kill every running claude session.
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // The desktop app starts the server with an IPC channel; on Windows signals cannot be delivered gracefully.
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('IPC');
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
