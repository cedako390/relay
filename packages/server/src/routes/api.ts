import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  canReceiveMessages,
  createSessionBodySchema,
  createTaskBodySchema,
  hookRequestSchema,
  postMessageBodySchema,
  updateTaskBodySchema,
} from '@orch/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ensureOrchestratorClaudeMd } from '../projects/claude-md.js';
import { SessionError } from '../sessions/manager.js';
import { attachSessionToTask } from '../tasks/attach.js';
import { TaskError } from '../tasks/service.js';

const idParams = z.object({ id: z.string().min(1) });
const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

export function registerApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { sessions, tasks, queue, hooks, events, config } = ctx;

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async () => ({
    allowedModels: config.allowedModels,
    defaultModel: config.defaultModel,
    maxWorkers: config.maxWorkers,
    maxDepth: config.maxDepth,
    defaultCwd: config.defaultCwd,
    platform: process.platform,
  }));

  // --- sessions -----------------------------------------------------------------------------
  app.get('/api/sessions', async () => sessions.list());

  app.post('/api/sessions', async (req, reply) => {
    const body = createSessionBodySchema.parse(req.body);
    if (body.taskId && !tasks.get(body.taskId)) throw new TaskError(`task not found: ${body.taskId}`, 404);
    // A plain terminal has no Claude to read the rules, and must not leave files in the folder.
    if (body.kind !== 'terminal') {
      // Before the process starts, so `claude` reads the rules on launch. Not fatal: a read-only folder still gets a session.
      try {
        const action = ensureOrchestratorClaudeMd(path.resolve(body.cwd));
        if (action !== 'unchanged') req.log.info({ cwd: body.cwd, action }, 'CLAUDE.md with orchestrator rules');
      } catch (err) {
        req.log.warn({ err, cwd: body.cwd }, 'could not write CLAUDE.md');
      }
    }
    const session = sessions.create({ cwd: body.cwd, model: body.model, taskId: body.taskId, kind: body.kind });
    if (body.taskId) attachSessionToTask(tasks, body.taskId, session.id);
    return reply.code(201).send(session);
  });

  app.get('/api/sessions/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const session = sessions.get(id);
    if (!session) throw new SessionError('session not found', 404);
    return session;
  });

  app.delete('/api/sessions/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return sessions.kill(id);
  });

  app.post('/api/sessions/:id/resume', async (req) => {
    const { id } = idParams.parse(req.params);
    return sessions.resume(id, events.latestSessionStart(id));
  });

  app.get('/api/sessions/:id/events', async (req) => {
    const { id } = idParams.parse(req.params);
    const { limit } = eventsQuery.parse(req.query);
    if (!sessions.get(id)) throw new SessionError('session not found', 404);
    return events.listBySession(id, limit);
  });

  // --- message queue ------------------------------------------------------------------------
  app.get('/api/sessions/:id/messages', async (req) => {
    const { id } = idParams.parse(req.params);
    if (!sessions.get(id)) throw new SessionError('session not found', 404);
    return queue.list(id);
  });

  app.post('/api/sessions/:id/messages', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { body } = postMessageBodySchema.parse(req.body);
    const target = sessions.get(id);
    if (!target) throw new SessionError('session not found', 404);
    if (!canReceiveMessages(target.status)) {
      throw new SessionError(`session is ${target.status}; it cannot receive messages`, 409);
    }
    return reply.code(201).send(queue.enqueue(id, body));
  });

  // --- tasks --------------------------------------------------------------------------------
  app.get('/api/tasks', async () => tasks.list());

  app.post('/api/tasks', async (req, reply) => {
    const body = createTaskBodySchema.parse(req.body);
    return reply.code(201).send(await tasks.create(body));
  });

  app.get('/api/tasks/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const task = tasks.get(id);
    if (!task) throw new TaskError(`task not found: ${id}`, 404);
    return task;
  });

  app.get('/api/tasks/:id/children', async (req) => {
    const { id } = idParams.parse(req.params);
    if (!tasks.get(id)) throw new TaskError(`task not found: ${id}`, 404);
    return tasks.children(id);
  });

  app.patch('/api/tasks/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return tasks.update(id, updateTaskBodySchema.parse(req.body));
  });

  app.post('/api/tasks/:id/start', async (req) => {
    const { id } = idParams.parse(req.params);
    return tasks.start(id);
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    tasks.remove(id);
    return reply.code(204).send();
  });

  // --- hooks (called by scripts/hook.mjs) ---------------------------------------------------
  app.post('/api/hooks', async (req, reply) => {
    const { sessionId, payload } = hookRequestSchema.parse(req.body);
    hooks.handle(sessionId, payload);
    return reply.code(204).send();
  });
}
