import type { FastifyInstance } from 'fastify';

export interface GuardOptions {
  port: number;
  allowedOrigins: readonly string[];
}

const PROTECTED_PREFIXES = ['/api/', '/mcp', '/ws/'];

const isProtected = (url: string): boolean => {
  const pathname = url.split('?')[0] ?? '';
  return PROTECTED_PREFIXES.some((p) => pathname === p.replace(/\/$/, '') || pathname.startsWith(p));
};

/**
 * Global request gate (there is no login: the server is for local use only):
 *  - Host must be a loopback name on our port (blocks DNS-rebinding);
 *  - requests to /api, /mcp and /ws from a browser must come from an allowed Origin
 *    (WebSocket upgrades are not covered by CORS, so this is what keeps other sites out).
 */
export function registerAuth(app: FastifyInstance, opts: GuardOptions): void {
  const hosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const origins = new Set(opts.allowedOrigins);

  app.addHook('onRequest', async (req, reply) => {
    if (!hosts.has((req.headers.host ?? '').toLowerCase())) {
      return reply.code(403).send({ error: 'forbidden host' });
    }
    if (!isProtected(req.url)) return;

    const origin = req.headers.origin;
    // Non-browser clients (hooks, MCP, curl) send no Origin; browsers always do on WebSocket and cross-site requests.
    if (origin !== undefined && !origins.has(origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
  });
}
