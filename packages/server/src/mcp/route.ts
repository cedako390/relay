import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMcpServer, type McpContext } from './tools.js';

export const CALLER_SESSION_HEADER = 'x-orch-session';

export type McpDeps = Omit<McpContext, 'callerSessionId'>;

/**
 * Streamable HTTP MCP endpoint (stateless: a fresh server + transport per request).
 * The calling session is identified by the X-Orch-Session header that the per-session
 * `--mcp-config` injects; tool arguments are never trusted for identity.
 */
export function registerMcpRoute(app: FastifyInstance, deps: McpDeps): void {
  app.post('/mcp', async (request, reply) => {
    const header = request.headers[CALLER_SESSION_HEADER];
    const callerSessionId = typeof header === 'string' && header ? header : null;
    if (callerSessionId && !deps.sessions.get(callerSessionId)) {
      return reply.code(403).send({ error: 'unknown caller session' });
    }

    const server = createMcpServer({ ...deps, callerSessionId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      request.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  });

  // Stateless server: no standalone SSE stream and no session to terminate.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
