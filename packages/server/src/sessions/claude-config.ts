import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOOK_EVENT_NAMES } from '@orch/shared';

export const MCP_SERVER_NAME = 'orchestrator';

export interface SessionConfigFiles {
  settingsPath: string;
  mcpConfigPath: string;
}

export interface ClaudeConfigOptions {
  sessionsDir: string;
  sessionId: string;
  hookScript: string;
  orchUrl: string;
}

/**
 * Writes the per-session Claude Code configuration into `<data>/sessions/<id>/`:
 *  - settings.json: hooks that run scripts/hook.mjs (passed with `--settings`, so neither the user's
 *    global settings nor the project's own .claude/ are modified);
 *  - mcp.json: the orchestrator MCP server (passed with `--mcp-config`). The X-Orch-Session header
 *    references ORCH_SESSION_ID from the child's environment.
 */
export function writeClaudeConfig(opts: ClaudeConfigOptions): SessionConfigFiles {
  const dir = path.join(opts.sessionsDir, opts.sessionId);
  mkdirSync(dir, { recursive: true });

  // Exec form (command + args, no shell): avoids quoting problems with Windows paths.
  const handler = { type: 'command', command: process.execPath, args: [opts.hookScript], timeout: 10 };
  const hooks = Object.fromEntries(HOOK_EVENT_NAMES.map((name) => [name, [{ hooks: [handler] }]]));
  const settingsPath = path.join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));

  const mcpConfigPath = path.join(dir, 'mcp.json');
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: `${opts.orchUrl}/mcp`,
            headers: {
              'X-Orch-Session': '${ORCH_SESSION_ID}',
            },
          },
        },
      },
      null,
      2,
    ),
  );
  return { settingsPath, mcpConfigPath };
}
