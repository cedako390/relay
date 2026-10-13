import { pino } from 'pino';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config/index.js';
import { openDb, type Db } from './db/index.js';
import { runMigrations } from './db/migrate.js';

/** Fresh in-memory database with the real migrations applied. */
export function createTestDb(): Db {
  const { db } = openDb(':memory:');
  runMigrations(db);
  return db;
}

export const silentLog: FastifyBaseLogger = pino({ level: 'silent' });

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: '127.0.0.1',
    port: 4180,
    repoRoot: '/repo',
    dataDir: '/repo/data',
    dbPath: ':memory:',
    worktreesDir: '/repo/data/worktrees',
    defaultCwd: '/repo/data/workspace',
    sessionsDir: '/repo/data/sessions',
    hookScript: '/repo/packages/server/scripts/hook.mjs',
    webDist: '/repo/packages/web/dist',
    claudeBin: 'claude',
    shellBin: 'powershell.exe',
    permissionMode: null,
    autoTrustWorktrees: false,
    blockNativeSubagents: true,
    maxWorkers: 4,
    maxDepth: 3,
    maxSubOrchestrators: 4,
    maxOrchestratorDepth: 2,
    allowedModels: ['haiku', 'sonnet', 'opus'],
    defaultModel: null,
    allowedOrigins: [],
    logLevel: 'silent',
    orchUrl: 'http://127.0.0.1:4180',
    ...overrides,
  };
}
