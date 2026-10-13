import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerAuth } from './auth/guard.js';
import type { AppContext } from './context.js';
import { registerMcpRoute } from './mcp/route.js';
import { registerApiRoutes } from './routes/api.js';
import { registerWsRoutes } from './routes/ws.js';
import { SessionError } from './sessions/manager.js';
import { TaskError } from './tasks/service.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const { config } = ctx;
  const app = Fastify({ loggerInstance: ctx.log, disableRequestLogging: true, bodyLimit: 2 * 1024 * 1024 });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid request', issues: err.issues });
    }
    if (err instanceof SessionError || err instanceof TaskError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    return reply.code(status).send({ error: status >= 500 ? 'internal error' : (err as Error).message });
  });

  // Accept an empty body with a JSON content type (e.g. DELETE from generic HTTP clients).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '') return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      Object.assign(err as Error, { statusCode: 400 });
      done(err as Error, undefined);
    }
  });

  registerAuth(app, { port: config.port, allowedOrigins: config.allowedOrigins });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1024 * 1024 } });

  registerApiRoutes(app, ctx);
  registerWsRoutes(app, ctx);
  registerMcpRoute(app, { tasks: ctx.tasks, sessions: ctx.sessions, subOrchestrators: ctx.subOrchestrators, queue: ctx.queue });

  // Production: serve the built web UI from the same origin.
  if (existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0] ?? '';
      if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/ws/') && pathname !== '/mcp') {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }
  return app;
}
