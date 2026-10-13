import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  terminalClientFrameSchema,
  type ServerEvent,
  type TerminalServerFrame,
} from '@orch/shared';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const params = z.object({ sessionId: z.string().min(1) });
const HEARTBEAT_MS = 30_000;

const send = (socket: WebSocket, frame: TerminalServerFrame | ServerEvent): void => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
};

function heartbeat(socket: WebSocket): () => void {
  const timer = setInterval(() => {
    if (socket.readyState === socket.OPEN) socket.ping();
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

export function registerWsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { sessions, bus } = ctx;

  /** Live state changes (sessions, tasks, messages, hook events) for the UI. */
  app.get('/ws/events', { websocket: true }, (socket) => {
    const unsubscribe = bus.subscribe((event) => send(socket, event));
    const stopHeartbeat = heartbeat(socket);
    send(socket, { type: 'hello' });
    socket.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });
    socket.on('error', () => socket.close());
  });

  /** Raw terminal of one session: replays the ring buffer, then streams output; accepts input and resize. */
  app.get('/ws/terminal/:sessionId', { websocket: true }, (socket, req) => {
    const parsed = params.safeParse(req.params);
    const live = parsed.success ? sessions.liveSession(parsed.data.sessionId) : undefined;
    if (!live) {
      socket.close(4404, 'session has no live terminal');
      return;
    }

    const { snapshot, exitCode, detach } = live.attach((frame) => send(socket, frame));
    send(socket, { type: 'snapshot', data: snapshot });
    if (exitCode !== undefined) send(socket, { type: 'exit', code: exitCode });
    const stopHeartbeat = heartbeat(socket);

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = terminalClientFrameSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return;
      }
      if (!frame.success) return;
      if (frame.data.type === 'input') live.write(frame.data.data);
      else live.resize(frame.data.cols, frame.data.rows);
    });
    // Closing the tab only detaches the viewer; the PTY keeps running.
    socket.on('close', () => {
      detach();
      stopHeartbeat();
    });
    socket.on('error', () => socket.close());
  });
}
