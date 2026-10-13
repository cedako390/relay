import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyOrchestratorSection,
  ensureOrchestratorClaudeMd,
  ORCHESTRATOR_SECTION,
  SECTION_BEGIN,
  SECTION_END,
} from './claude-md.js';

describe('applyOrchestratorSection', () => {
  it('builds a section for an empty file', () => {
    expect(applyOrchestratorSection('')).toBe(`${ORCHESTRATOR_SECTION}\n`);
  });

  it('appends after existing content and keeps it intact', () => {
    const out = applyOrchestratorSection('# My project\n\nRules.\n');
    expect(out.startsWith('# My project\n\nRules.\n\n')).toBe(true);
    expect(out.endsWith(`${SECTION_END}\n`)).toBe(true);
  });

  it('replaces only the managed block', () => {
    const old = `# Head\n\n${SECTION_BEGIN}\nold rules\n${SECTION_END}\n\n## Tail\n`;
    const out = applyOrchestratorSection(old);
    expect(out).not.toContain('old rules');
    expect(out.startsWith('# Head\n\n')).toBe(true);
    expect(out.endsWith('\n\n## Tail\n')).toBe(true);
    expect(out.split(SECTION_BEGIN)).toHaveLength(2);
  });

  it('is idempotent', () => {
    const once = applyOrchestratorSection('# Head\n');
    expect(applyOrchestratorSection(once)).toBe(once);
  });

  it('keeps CRLF line endings', () => {
    const out = applyOrchestratorSection('# Head\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(applyOrchestratorSection(out)).toBe(out);
  });

  it('mentions every MCP tool and the ban on native sub-agents', () => {
    for (const name of ['create_task', 'get_task', 'list_children', 'report_result', 'send_message', 'create_orchestrator', 'close_session']) {
      expect(ORCHESTRATOR_SECTION).toContain(`mcp__orchestrator__${name}`);
    }
    expect(ORCHESTRATOR_SECTION).toContain('Agent');
  });
});

describe('ensureOrchestratorClaudeMd', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'orch-claude-md-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates CLAUDE.md when missing, then reports unchanged', () => {
    expect(ensureOrchestratorClaudeMd(dir)).toBe('created');
    expect(readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toContain(SECTION_BEGIN);
    expect(ensureOrchestratorClaudeMd(dir)).toBe('unchanged');
  });

  it('adds the section to an existing file without losing its text', () => {
    writeFileSync(path.join(dir, 'CLAUDE.md'), '# Mine\n\nKeep me.\n');
    expect(ensureOrchestratorClaudeMd(dir)).toBe('updated');
    const text = readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(text.startsWith('# Mine\n\nKeep me.\n')).toBe(true);
    expect(text).toContain(SECTION_END);
  });
});
