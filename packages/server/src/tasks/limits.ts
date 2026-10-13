/**
 * Limit checks, kept pure so they are trivially testable.
 * Depth counts levels of the task tree: a root task has depth 1.
 */

export type DepthCheck = { ok: true; depth: number } | { ok: false; depth: number; reason: string };

export function checkDepth(parentDepth: number | null, maxDepth: number): DepthCheck {
  const depth = (parentDepth ?? 0) + 1;
  if (depth > maxDepth) {
    return { ok: false, depth, reason: `Task tree depth limit reached (max ${maxDepth}); cannot create a task at depth ${depth}` };
  }
  return { ok: true, depth };
}

/** Limits for orchestrators that other orchestrators create. `depth` of a session the user opened is 1. */
export type OrchestratorCheck = { ok: true; depth: number } | { ok: false; reason: string };

export function checkOrchestratorLimits(
  callerDepth: number,
  activeSubOrchestrators: number,
  limits: { maxDepth: number; maxActive: number },
): OrchestratorCheck {
  if (limits.maxActive < 1) return { ok: false, reason: "Creating orchestrators from agents is disabled (MAX_SUB_ORCHESTRATORS=0)" };
  const depth = callerDepth + 1;
  if (depth > limits.maxDepth) {
    return { ok: false, reason: `Orchestrator depth limit reached (max ${limits.maxDepth}); you cannot create another orchestrator. Do the work yourself or with create_task workers` };
  }
  if (activeSubOrchestrators >= limits.maxActive) {
    return { ok: false, reason: `Limit of ${limits.maxActive} active sub-orchestrators reached; wait for one to finish or close one with close_session` };
  }
  return { ok: true, depth };
}

/** Whether one more worker may be started right now. */
export function hasWorkerCapacity(activeWorkers: number, maxWorkers: number): boolean {
  return activeWorkers < maxWorkers;
}

/** How many queued tasks can be started given current usage. */
export function freeWorkerSlots(activeWorkers: number, maxWorkers: number): number {
  return Math.max(0, maxWorkers - activeWorkers);
}
