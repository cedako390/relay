import type { Config } from '../config/index.js';
import { MCP_SERVER_NAME, type SessionConfigFiles } from './claude-config.js';

/** Built-in sub-agent tools of Claude Code ("Task" is the older name of "Agent"). */
export const NATIVE_SUBAGENT_TOOLS = ['Agent', 'Task'] as const;

/** Appended to the system prompt of panel sessions so delegation goes through the orchestrator. */
export const ORCHESTRATOR_INSTRUCTIONS =
  'You run inside the Orchestrator. To delegate work to another agent, always use the MCP tool ' +
  `mcp__${MCP_SERVER_NAME}__create_task (load its schema with ToolSearch first if it is not available yet); ` +
  'the built-in Agent/subagent tool is disabled here. ' +
  `For a big job with independent parts you may start another orchestrator with mcp__${MCP_SERVER_NAME}__create_orchestrator. ` +
  'When a delegated task finishes you automatically receive a message with its status and result, so do not poll for it.';

/** Command-line arguments for the interactive `claude` process of one session. */
export function buildClaudeArgs(
  config: Pick<Config, 'permissionMode' | 'blockNativeSubagents'>,
  files: SessionConfigFiles,
  model: string | null,
  /** Claude's own session id: continue that conversation instead of starting a new one. */
  resumeId?: string | null,
): string[] {
  const args = ['--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath];
  if (resumeId) args.push('--resume', resumeId);
  if (model) args.push('--model', model);
  if (config.permissionMode) args.push('--permission-mode', config.permissionMode);
  if (config.blockNativeSubagents) {
    args.push('--append-system-prompt', ORCHESTRATOR_INSTRUCTIONS);
    // Variadic option: keep it last so it cannot swallow other arguments.
    args.push('--disallowedTools', ...NATIVE_SUBAGENT_TOOLS);
  }
  return args;
}
