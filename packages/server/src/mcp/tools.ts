import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { canReceiveMessages, reportableStatusSchema, type Task } from '@orch/shared';
import { z } from 'zod';
import type { MessageQueue } from '../queue/service.js';
import { SessionError, type SessionManager } from '../sessions/manager.js';
import type { SubOrchestratorService } from '../sessions/sub-orchestrators.js';
import { TaskError, type TaskService } from '../tasks/service.js';

export interface McpContext {
  /** Orchestrator session that made the call (taken from the X-Orch-Session header, never from tool arguments). */
  callerSessionId: string | null;
  tasks: TaskService;
  sessions: SessionManager;
  subOrchestrators: SubOrchestratorService;
  queue: MessageQueue;
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/** Compact task view for agents (no timestamps/cwd noise). */
const view = (t: Task) => ({
  id: t.id,
  parent_id: t.parentId,
  title: t.title,
  status: t.status,
  model: t.model,
  session_id: t.sessionId,
  result: t.result,
});

async function guarded(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TaskError || err instanceof SessionError) return fail(err.message);
    return fail(`Internal error: ${(err as Error).message}`);
  }
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'orchestrator', version: '0.1.0' });

  server.registerTool(
    'create_task',
    {
      description:
        'Create a sub-task and start a separate worker agent for it. The worker runs in its own session; ' +
        'if the worker limit is reached the task stays "queued" and starts later. ' +
        'Returns the task right away. When the task finishes you automatically receive a message with its status and result, ' +
        'so do not poll. parent_id defaults to your own task.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short task title'),
        description: z.string().describe('Complete instructions for the worker; it sees nothing else'),
        model: z.string().optional().describe('Model alias: haiku, sonnet or opus. Omit for the default'),
        parent_id: z.string().optional().describe('Parent task id. Omit to use your own task'),
      },
    },
    ({ title, description, model, parent_id }) =>
      guarded(async () => {
        const task = await ctx.tasks.create(
          { title, description, model, parentId: parent_id, start: true },
          { callerSessionId: ctx.callerSessionId },
        );
        return json(view(task));
      }),
  );

  server.registerTool(
    'get_task',
    {
      description: 'Get one task by id: its status (pending, queued, running, done, failed, cancelled) and result.',
      inputSchema: { id: z.string().describe('Task id') },
    },
    ({ id }) =>
      guarded(() => {
        const task = ctx.tasks.get(id);
        return task ? json(view(task)) : fail(`task not found: ${id}`);
      }),
  );

  server.registerTool(
    'list_children',
    {
      description: 'List the direct sub-tasks of a task with their statuses and results.',
      inputSchema: { parent_id: z.string().describe('Id of the parent task') },
    },
    ({ parent_id }) =>
      guarded(() => {
        if (!ctx.tasks.get(parent_id)) return fail(`task not found: ${parent_id}`);
        return json(ctx.tasks.children(parent_id).map(view));
      }),
  );

  server.registerTool(
    'report_result',
    {
      description:
        'Report the final outcome of your own task. Call it exactly once, when you are finished. ' +
        'status is "done" on success or "failed" otherwise; result is a short summary of what was done or why it failed.',
      inputSchema: {
        task_id: z.string().describe('Id of your task'),
        status: reportableStatusSchema.describe('"done" or "failed"'),
        result: z.string().describe('Short summary of the outcome'),
      },
    },
    ({ task_id, status, result }) =>
      guarded(() => json(view(ctx.tasks.report(task_id, status, result, ctx.callerSessionId)))),
  );

  server.registerTool(
    'send_message',
    {
      description:
        'Queue a text message for another session. It is typed into that session once the session is idle. ' +
        'Does not wait for or return a reply.',
      inputSchema: {
        session_id: z.string().describe('Target session id'),
        body: z.string().min(1).describe('Message text'),
      },
    },
    ({ session_id, body }) =>
      guarded(() => {
        const target = ctx.sessions.get(session_id);
        if (!target) return fail(`session not found: ${session_id}`);
        if (!canReceiveMessages(target.status)) return fail(`session is ${target.status}; it cannot receive messages`);
        const message = ctx.queue.enqueue(session_id, body);
        return json({ message_id: message.id, status: message.status });
      }),
  );

  server.registerTool(
    'create_orchestrator',
    {
      description:
        'Start another orchestrator session that handles one part of a big job on its own (for example the frontend while you take the backend). ' +
        'It is a full orchestrator: it splits its part into tasks with create_task and runs its own workers. ' +
        'Returns its session id right away. The new session gets your instructions as its first message and, when it finishes, ' +
        'sends you a short report with send_message; you receive it automatically, so do not poll. ' +
        'Only orchestrators can call this (workers cannot). Workers of all orchestrators share the same worker limit. ' +
        'Count and nesting depth are limited; close_session ends one you no longer need.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('Short name of the assignment'),
        instructions: z.string().min(1).describe('Complete instructions: it sees nothing of your conversation. Say which part is yours and which is its, with paths, constraints and what to report'),
        cwd: z.string().optional().describe('Project folder. Omit to use your own'),
        model: z.string().optional().describe('Model alias: haiku, sonnet or opus. Omit for the default'),
      },
    },
    ({ title, instructions, cwd, model }) =>
      guarded(() => {
        const session = ctx.subOrchestrators.create(ctx.callerSessionId, { title, instructions, cwd, model });
        return json({ session_id: session.id, status: session.status, cwd: session.cwd, model: session.model });
      }),
  );

  server.registerTool(
    'close_session',
    {
      description:
        'End an orchestrator session that you created with create_orchestrator. Workers it already started keep running ' +
        'until they finish. You can only close your own sub-orchestrators.',
      inputSchema: { session_id: z.string().describe('Id returned by create_orchestrator') },
    },
    ({ session_id }) =>
      guarded(() => {
        const session = ctx.subOrchestrators.close(ctx.callerSessionId, session_id);
        return json({ session_id: session.id, status: session.status });
      }),
  );

  return server;
}
