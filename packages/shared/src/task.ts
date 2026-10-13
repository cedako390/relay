import { z } from 'zod';

export const TASK_STATUSES = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Statuses a worker may report through `report_result`. */
export const reportableStatusSchema = z.enum(['done', 'failed']);

export const taskSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  sessionId: z.string().nullable(),
  creatorSessionId: z.string().nullable(),
  result: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof taskSchema>;

export const createTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(100_000).default(''),
  model: z.string().optional(),
  parentId: z.string().nullable().optional(),
  cwd: z.string().optional(),
  /** Start a worker immediately (subject to limits). */
  start: z.boolean().default(false),
});
export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const updateTaskBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(100_000).optional(),
  status: taskStatusSchema.optional(),
  model: z.string().nullable().optional(),
  result: z.string().nullable().optional(),
});
export type UpdateTaskBody = z.infer<typeof updateTaskBodySchema>;
