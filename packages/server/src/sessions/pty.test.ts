import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './pty.js';
import { RingBuffer } from './ring-buffer.js';

describe('buildChildEnv', () => {
  it('removes ANTHROPIC_API_KEY (any casing) so the subscription is used', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'sk-x', anthropic_api_key: 'sk-y', PATH: '/bin' }, {});
    expect(Object.keys(env).map((k) => k.toLowerCase())).not.toContain('anthropic_api_key');
    expect(env.PATH).toBe('/bin');
  });

  it('removes markers of a parent Claude Code session', () => {
    const env = buildChildEnv({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_USE_BEDROCK: '1' }, {});
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
  });

  it('adds the orchestrator variables on top', () => {
    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'k' }, { ORCH_SESSION_ID: 'abc', ORCH_URL: 'http://127.0.0.1:1' });
    expect(env.ORCH_SESSION_ID).toBe('abc');
    expect(env.ORCH_URL).toBe('http://127.0.0.1:1');
  });

  it('drops undefined values', () => {
    expect(buildChildEnv({ A: undefined, B: 'b' }, {})).toMatchObject({ B: 'b' });
    expect('A' in buildChildEnv({ A: undefined }, {})).toBe(false);
  });
});

describe('RingBuffer', () => {
  it('returns everything while under the limit', () => {
    const rb = new RingBuffer(100);
    rb.push('abc');
    rb.push('def');
    expect(rb.snapshot()).toBe('abcdef');
  });

  it('drops the oldest chunks once the limit is exceeded', () => {
    const rb = new RingBuffer(10);
    for (const chunk of ['aaaa', 'bbbb', 'cccc']) rb.push(chunk);
    expect(rb.snapshot()).toBe('bbbbcccc');
    expect(rb.length).toBe(8);
  });

  it('keeps only the tail of a single oversized chunk', () => {
    const rb = new RingBuffer(5);
    rb.push('0123456789');
    expect(rb.snapshot()).toBe('56789');
  });
});
