import { describe, expect, it } from 'vitest';
import { buildClaudeArgs, NATIVE_SUBAGENT_TOOLS, ORCHESTRATOR_INSTRUCTIONS } from './claude-args.js';

const files = { settingsPath: '/s/settings.json', mcpConfigPath: '/s/mcp.json' };

describe('buildClaudeArgs', () => {
  it('always passes the per-session hooks and MCP config', () => {
    const args = buildClaudeArgs({ permissionMode: null, blockNativeSubagents: false }, files, null);
    expect(args).toEqual(['--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json']);
  });

  it('resumes the given Claude conversation', () => {
    const args = buildClaudeArgs({ permissionMode: null, blockNativeSubagents: false }, files, null, 'abc-123');
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123');
    expect(buildClaudeArgs({ permissionMode: null, blockNativeSubagents: false }, files, null)).not.toContain('--resume');
  });

  it('adds model and permission mode when set', () => {
    const args = buildClaudeArgs({ permissionMode: 'acceptEdits', blockNativeSubagents: false }, files, 'haiku');
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('blocks native sub-agents and points the model at create_task', () => {
    const args = buildClaudeArgs({ permissionMode: null, blockNativeSubagents: true }, files, 'haiku');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(ORCHESTRATOR_INSTRUCTIONS);
    expect(ORCHESTRATOR_INSTRUCTIONS).toContain('mcp__orchestrator__create_task');
    const i = args.indexOf('--disallowedTools');
    expect(args.slice(i + 1)).toEqual([...NATIVE_SUBAGENT_TOOLS]);
  });

  it('keeps the variadic --disallowedTools last so it cannot swallow other flags', () => {
    const args = buildClaudeArgs({ permissionMode: 'plan', blockNativeSubagents: true }, files, 'opus');
    const i = args.indexOf('--disallowedTools');
    expect(args.slice(i + 1).some((a) => a.startsWith('--'))).toBe(false);
  });
});
