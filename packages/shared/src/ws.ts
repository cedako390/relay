import { z } from 'zod';
import { messageSchema } from './message.js';
import { sessionEventSchema } from './event.js';
import { sessionSchema } from './session.js';
import { taskSchema } from './task.js';

/** Server -> client frames on /ws/events. */
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello') }),
  z.object({ type: z.literal('session'), session: sessionSchema }),
  z.object({ type: z.literal('task'), task: taskSchema }),
  z.object({ type: z.literal('task_deleted'), id: z.string() }),
  z.object({ type: z.literal('message'), message: messageSchema }),
  z.object({ type: z.literal('event'), event: sessionEventSchema }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

/** Server -> client frames on /ws/terminal/:sessionId. */
export const terminalServerFrameSchema = z.discriminatedUnion('type', [
  /** Replay of the ring buffer, sent once right after connecting. */
  z.object({ type: z.literal('snapshot'), data: z.string() }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().nullable() }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

/** Client -> server frames on /ws/terminal/:sessionId. */
export const terminalClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;
