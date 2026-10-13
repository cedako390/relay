import { z } from 'zod';

export const HOOK_EVENT_NAMES = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
] as const;
export const hookEventNameSchema = z.enum(HOOK_EVENT_NAMES);
export type HookEventName = z.infer<typeof hookEventNameSchema>;

/** Raw hook event as stored in the `events` table. */
export const sessionEventSchema = z.object({
  id: z.number(),
  sessionId: z.string(),
  type: z.string(),
  payload: z.unknown(),
  ts: z.number(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/**
 * Body POSTed by scripts/hook.mjs to /api/hooks.
 * `payload` is the JSON that Claude Code passes to the hook on stdin.
 */
export const hookRequestSchema = z.object({
  sessionId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});
export type HookRequest = z.infer<typeof hookRequestSchema>;
