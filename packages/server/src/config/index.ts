import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Repository root: the closest ancestor containing pnpm-workspace.yaml. */
export function findRepoRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4180),
  DATA_DIR: z.string().default('./data'),
  CLAUDE_BIN: z.string().default('claude'),
  /** Shell for terminal sessions and for the prompt left after Claude exits. Empty = PowerShell on Windows, $SHELL elsewhere. */
  SHELL_BIN: z.string().default(''),
  /** Folder for tasks started without a known working directory. Default: <data>/workspace. */
  DEFAULT_CWD: z.string().default(''),
  /** Optional value for `claude --permission-mode`. Empty = claude default. */
  CLAUDE_PERMISSION_MODE: z.string().default(''),
  /** Auto-answer "trust this folder" for worktrees created by the server (see README). */
  AUTO_TRUST_WORKTREES: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  /** Disable Claude Code's built-in Agent (sub-agent) tool so delegation goes through create_task. */
  BLOCK_NATIVE_SUBAGENTS: z
    .enum(['true', 'false', '1', '0'])
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  MAX_WORKERS: z.coerce.number().int().min(1).default(4),
  MAX_DEPTH: z.coerce.number().int().min(1).default(3),
  /** How many orchestrators spawned by other orchestrators (`create_orchestrator`) may be active at once. 0 turns the tool off. */
  MAX_SUB_ORCHESTRATORS: z.coerce.number().int().min(0).default(4),
  /** Depth of the orchestrator tree: a session the user opened has depth 1. */
  MAX_ORCHESTRATOR_DEPTH: z.coerce.number().int().min(1).default(2),
  ALLOWED_MODELS: z.string().default('haiku,sonnet,opus').transform(csv),
  DEFAULT_MODEL: z.string().default(''),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4180,http://localhost:4180',
    )
    .transform(csv),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface Config {
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly repoRoot: string;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly worktreesDir: string;
  readonly defaultCwd: string;
  readonly sessionsDir: string;
  readonly hookScript: string;
  readonly webDist: string;
  readonly claudeBin: string;
  readonly shellBin: string;
  readonly permissionMode: string | null;
  readonly autoTrustWorktrees: boolean;
  readonly blockNativeSubagents: boolean;
  readonly maxWorkers: number;
  readonly maxDepth: number;
  readonly maxSubOrchestrators: number;
  readonly maxOrchestratorDepth: number;
  readonly allowedModels: readonly string[];
  readonly defaultModel: string | null;
  readonly allowedOrigins: readonly string[];
  readonly logLevel: string;
  readonly orchUrl: string;
}

function defaultShell(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return 'powershell.exe';
  return env.SHELL || '/bin/bash';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repoRoot = findRepoRoot();
  const envFile = path.join(repoRoot, '.env');
  if (env === process.env && existsSync(envFile)) process.loadEnvFile(envFile);

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(repoRoot, e.DATA_DIR);
  const defaultModel = e.DEFAULT_MODEL && e.ALLOWED_MODELS.includes(e.DEFAULT_MODEL) ? e.DEFAULT_MODEL : null;
  if (e.DEFAULT_MODEL && !defaultModel) {
    throw new Error(`Invalid configuration: DEFAULT_MODEL "${e.DEFAULT_MODEL}" is not in ALLOWED_MODELS`);
  }

  return {
    host: '127.0.0.1',
    port: e.PORT,
    repoRoot,
    dataDir,
    dbPath: path.join(dataDir, 'orchestrator.db'),
    worktreesDir: path.join(dataDir, 'worktrees'),
    defaultCwd: e.DEFAULT_CWD ? path.resolve(repoRoot, e.DEFAULT_CWD) : path.join(dataDir, 'workspace'),
    sessionsDir: path.join(dataDir, 'sessions'),
    hookScript: path.join(repoRoot, 'packages', 'server', 'scripts', 'hook.mjs'),
    webDist: path.join(repoRoot, 'packages', 'web', 'dist'),
    claudeBin: e.CLAUDE_BIN,
    shellBin: e.SHELL_BIN || defaultShell(env),
    permissionMode: e.CLAUDE_PERMISSION_MODE || null,
    autoTrustWorktrees: e.AUTO_TRUST_WORKTREES,
    blockNativeSubagents: e.BLOCK_NATIVE_SUBAGENTS,
    maxWorkers: e.MAX_WORKERS,
    maxDepth: e.MAX_DEPTH,
    maxSubOrchestrators: e.MAX_SUB_ORCHESTRATORS,
    maxOrchestratorDepth: e.MAX_ORCHESTRATOR_DEPTH,
    allowedModels: e.ALLOWED_MODELS,
    defaultModel,
    allowedOrigins: e.ALLOWED_ORIGINS,
    logLevel: e.LOG_LEVEL,
    orchUrl: `http://127.0.0.1:${e.PORT}`,
  };
}

/** Maps a requested model to a whitelisted alias; unknown values fall back to the default (or null). */
export function resolveModel(config: Pick<Config, 'allowedModels' | 'defaultModel'>, requested?: string | null): string | null {
  const wanted = requested?.trim().toLowerCase();
  if (wanted && config.allowedModels.includes(wanted)) return wanted;
  return config.defaultModel;
}
