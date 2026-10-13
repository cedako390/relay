import path from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { canReceiveMessages, isActiveSessionStatus, type Session } from '@orch/shared';
import type { Config } from '../config/index.js';
import { ensureOrchestratorClaudeMd } from '../projects/claude-md.js';
import { checkOrchestratorLimits } from '../tasks/limits.js';
import { SessionError } from './manager.js';

/** What the sub-orchestrator layer needs from the session layer. */
export interface OrchestratorPort {
  get(id: string): Session | undefined;
  list(): Session[];
  create(input: { cwd: string; model?: string | null; parentSessionId: string }): Session;
  kill(id: string): Session;
}

export interface OrchestratorMessagePort {
  enqueue(sessionId: string, body: string): unknown;
}

export interface CreateOrchestratorInput {
  title: string;
  instructions: string;
  /** Defaults to the caller's folder. */
  cwd?: string;
  model?: string;
}

export function buildSubOrchestratorPrompt(input: { sessionId: string; parentId: string; title: string; instructions: string }): string {
  return [
    `You are a sub-orchestrator started by another orchestrator session (id ${input.parentId}).`,
    `Your session id: ${input.sessionId}`,
    `Assignment: ${input.title}`,
    '',
    input.instructions.trim() || '(no further description)',
    '',
    'How to work:',
    '- Split your assignment into tasks and run them with the MCP tool `create_task` of the `orchestrator` server;',
    '  you receive each result automatically, so do not poll.',
    '- Stay within your assignment: another orchestrator may be handling the rest of the project in the same folder.',
    '- You cannot ask the parent questions and no answer will come. Make reasonable assumptions and list them in your report.',
    `- When the whole assignment is finished, call \`send_message\` once with session_id "${input.parentId}" and a short report:`,
    '  what was done, where it lives (files, branches), what failed or is left. Then stop; the parent will close this session.',
  ].join('\n');
}

export function buildSubOrchestratorEndedMessage(session: Pick<Session, 'id' | 'title' | 'status'>): string {
  return `[Orchestrator] Sub-orchestrator ${session.title ? `"${session.title}" ` : ''}(session ${session.id}) ended with status: ${session.status}.`;
}

/** Orchestrators created by other orchestrators (`create_orchestrator`), with their limits and lifecycle. */
export class SubOrchestratorService {
  constructor(
    private readonly config: Config,
    private readonly sessions: OrchestratorPort,
    private readonly messages: OrchestratorMessagePort,
    private readonly log: Logger,
  ) {}

  /** Levels of the orchestrator tree above and including the session; a session the user opened has depth 1. */
  depth(session: Session): number {
    let depth = 1;
    const seen = new Set([session.id]);
    for (let parent = session; parent.parentSessionId && !seen.has(parent.parentSessionId); ) {
      const next = this.sessions.get(parent.parentSessionId);
      if (!next) break;
      seen.add(next.id);
      parent = next;
      depth += 1;
    }
    return depth;
  }

  create(callerSessionId: string | null, input: CreateOrchestratorInput): Session {
    const caller = callerSessionId ? this.sessions.get(callerSessionId) : undefined;
    if (!caller) throw new SessionError('create_orchestrator requires a session started by the Orchestrator', 403);
    if (caller.kind !== 'orchestrator') {
      throw new SessionError('only orchestrator sessions can create orchestrators; a worker should split its work with create_task', 403);
    }

    const active = this.sessions.list().filter((s) => s.parentSessionId !== null && isActiveSessionStatus(s.status)).length;
    const check = checkOrchestratorLimits(this.depth(caller), active, {
      maxDepth: this.config.maxOrchestratorDepth,
      maxActive: this.config.maxSubOrchestrators,
    });
    if (!check.ok) throw new SessionError(check.reason, 409);

    const cwd = path.resolve(input.cwd ?? caller.cwd);
    // Before the process starts, so `claude` reads the rules on launch. Not fatal: a read-only folder still gets a session.
    try {
      ensureOrchestratorClaudeMd(cwd);
    } catch (err) {
      this.log.warn({ err, cwd }, 'could not write CLAUDE.md');
    }
    const session = this.sessions.create({ cwd, model: input.model, parentSessionId: caller.id });
    this.messages.enqueue(
      session.id,
      buildSubOrchestratorPrompt({ sessionId: session.id, parentId: caller.id, title: input.title, instructions: input.instructions }),
    );
    this.log.info({ id: session.id, parent: caller.id, depth: check.depth }, 'sub-orchestrator started');
    return session;
  }

  /** Ends an orchestrator the caller created. Its workers keep running until they finish on their own. */
  close(callerSessionId: string | null, sessionId: string): Session {
    const target = this.sessions.get(sessionId);
    if (!target) throw new SessionError(`session not found: ${sessionId}`, 404);
    if (!callerSessionId || target.parentSessionId !== callerSessionId) {
      throw new SessionError('you can only close orchestrators that you created', 403);
    }
    if (!isActiveSessionStatus(target.status)) throw new SessionError(`session is already ${target.status}`, 409);
    return this.sessions.kill(sessionId);
  }

  /** A sub-orchestrator ended on its own (or died): tell the orchestrator that created it. */
  handleSessionEnded(session: Session, info: { killed: boolean }): void {
    if (!session.parentSessionId || info.killed) return;
    const parent = this.sessions.get(session.parentSessionId);
    if (!parent || !canReceiveMessages(parent.status)) return;
    this.messages.enqueue(parent.id, buildSubOrchestratorEndedMessage(session));
  }
}
