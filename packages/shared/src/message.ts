import { z } from 'zod';

export const messageStatusSchema = z.enum(['queued', 'delivered']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  body: z.string(),
  status: messageStatusSchema,
  createdAt: z.number(),
  deliveredAt: z.number().nullable(),
});
export type Message = z.infer<typeof messageSchema>;

export const postMessageBodySchema = z.object({
  body: z.string().min(1).max(200_000),
});
export type PostMessageBody = z.infer<typeof postMessageBodySchema>;
