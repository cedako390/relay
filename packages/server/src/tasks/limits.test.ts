import { describe, expect, it } from 'vitest';
import { checkDepth, checkOrchestratorLimits, freeWorkerSlots, hasWorkerCapacity } from './limits.js';

describe('checkDepth', () => {
  it('a root task has depth 1', () => {
    expect(checkDepth(null, 3)).toEqual({ ok: true, depth: 1 });
  });

  it('allows a child up to the configured maximum depth', () => {
    expect(checkDepth(2, 3)).toEqual({ ok: true, depth: 3 });
  });

  it('rejects a task deeper than the maximum', () => {
    const result = checkDepth(3, 3);
    expect(result.ok).toBe(false);
    expect(result.depth).toBe(4);
  });

  it('maxDepth 1 allows only root tasks', () => {
    expect(checkDepth(null, 1).ok).toBe(true);
    expect(checkDepth(1, 1).ok).toBe(false);
  });
});

describe('worker capacity', () => {
  it('has capacity below the limit and none at or above it', () => {
    expect(hasWorkerCapacity(3, 4)).toBe(true);
    expect(hasWorkerCapacity(4, 4)).toBe(false);
    expect(hasWorkerCapacity(5, 4)).toBe(false);
  });

  it('computes free slots without going negative', () => {
    expect(freeWorkerSlots(1, 4)).toBe(3);
    expect(freeWorkerSlots(6, 4)).toBe(0);
  });
});

describe('checkOrchestratorLimits', () => {
  const limits = { maxDepth: 2, maxActive: 2 };

  it('lets a session the user opened (depth 1) create a child', () => {
    expect(checkOrchestratorLimits(1, 0, limits)).toEqual({ ok: true, depth: 2 });
  });

  it('rejects a child of a child once the depth limit is reached', () => {
    const r = checkOrchestratorLimits(2, 0, limits);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('depth limit');
  });

  it('rejects when too many sub-orchestrators are active', () => {
    expect(checkOrchestratorLimits(1, 1, limits).ok).toBe(true);
    const r = checkOrchestratorLimits(1, 2, limits);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('active sub-orchestrators');
  });

  it('maxActive 0 turns the feature off', () => {
    const r = checkOrchestratorLimits(1, 0, { maxDepth: 2, maxActive: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('disabled');
  });
});
