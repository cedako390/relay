import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import type { FastifyBaseLogger as Logger } from 'fastify';

export interface WorktreeResult {
  /** Directory the worker should run in. */
  cwd: string;
  /** True when a dedicated git worktree was created. */
  worktree: boolean;
  branch?: string;
}

/**
 * Creates `<worktreesDir>/<taskId>` as a git worktree on a new branch `orch/<taskId>` when `cwd`
 * is inside a git repository. Falls back to the original folder when it is not a repository or the
 * worktree cannot be created (e.g. the repository has no commits yet).
 */
export async function prepareWorkerCwd(
  cwd: string,
  taskId: string,
  worktreesDir: string,
  log: Logger,
): Promise<WorktreeResult> {
  try {
    const git = simpleGit({ baseDir: cwd });
    if (!(await git.checkIsRepo())) return { cwd, worktree: false };
    const top = path.resolve((await git.revparse(['--show-toplevel'])).trim());
    const relative = path.relative(top, path.resolve(cwd));
    const target = path.join(worktreesDir, taskId);
    const branch = `orch/${taskId}`;
    mkdirSync(worktreesDir, { recursive: true });
    await simpleGit({ baseDir: top }).raw(['worktree', 'add', '-b', branch, target]);
    return { cwd: path.join(target, relative), worktree: true, branch };
  } catch (err) {
    log.warn({ err, cwd, taskId }, 'could not create git worktree; using the original folder');
    return { cwd, worktree: false };
  }
}
