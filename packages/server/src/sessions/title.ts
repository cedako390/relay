import type { SessionStatus } from '@orch/shared';

/**
 * Claude Code puts a state glyph in front of the terminal window title (OSC 0):
 *   "✳ <title>"          waiting for input (idle prompt or a permission dialog)
 *   "◐/◑ <title>"        working (animated spinner; braille spinners on other terminals)
 * Hooks cannot see everything (no Stop after Esc, nothing after a permission was granted), so the title
 * is used as an independent signal to correct stale `busy`/`waiting` statuses.
 */
export type TitleState = 'ready' | 'working';

const READY_GLYPH = '✳';
const SPINNER_GLYPHS = new Set(['◐', '◑', '◒', '◓']);

/** The conversation name Claude put in the window title, without the state glyph; null for the placeholders. */
export function conversationTitle(title: string): string | null {
  if (classifyTitle(title) === null) return null;
  const name = [...title.trimStart()].slice(1).join('').trim();
  return name && name !== 'Claude Code' ? name : null;
}

export function classifyTitle(title: string): TitleState | null {
  const first = [...title.trimStart()][0];
  if (!first) return null;
  if (first === READY_GLYPH) return 'ready';
  const code = first.codePointAt(0) ?? 0;
  if (SPINNER_GLYPHS.has(first) || (code >= 0x2800 && code <= 0x28ff)) return 'working';
  return null; // e.g. the plain "claude" title during startup
}

/** Latest window title set by the given output chunk (and the unterminated rest to prepend to the next one). */
export function extractTitles(buffer: string): { titles: string[]; rest: string } {
  const titles: string[] = [];
  const re = /\x1b\]0;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let consumed = 0;
  for (let m = re.exec(buffer); m; m = re.exec(buffer)) {
    titles.push(m[1] ?? '');
    consumed = re.lastIndex;
  }
  const tail = buffer.slice(consumed);
  const open = tail.lastIndexOf('\x1b]');
  return { titles, rest: open === -1 ? '' : tail.slice(open, open + 512) };
}

export interface TitleObservation {
  status: SessionStatus;
  /** When the status last changed (server time). */
  statusSince: number;
  activeSubagents: number;
  lastActivityAt: number;
  state: TitleState | null;
  /** When the current title state started. */
  stateSince: number | null;
  /** Last time a "working" title was seen. */
  lastWorkingAt: number | null;
}

/** How long "working" must persist to lift a stale `waiting`. */
export const WORKING_CONFIRM_MS = 800;
/** How long the idle glyph and the absence of hooks must persist before a stale `busy` becomes `idle`. */
export const READY_CONFIRM_MS = 5_000;

/**
 * Pure decision: should the title override the hook-derived status?
 *  - `waiting` -> `busy`: a permission was granted (the title went back to a spinner after the status was set);
 *  - `busy` -> `idle`: the work was interrupted (Esc fires no Stop). Only trusted if the title showed activity
 *    after the session became busy, and stayed ready with no hook activity for READY_CONFIRM_MS.
 * Returns the corrected status or null for "leave it alone".
 */
export function reconcileWithTitle(o: TitleObservation, now: number): SessionStatus | null {
  if (o.state === null || o.stateSince === null) return null;

  if (o.status === 'waiting') {
    const workedSinceWaiting = o.state === 'working' && o.stateSince > o.statusSince;
    return workedSinceWaiting && now - o.stateSince >= WORKING_CONFIRM_MS ? 'busy' : null;
  }

  if (o.status === 'busy' && o.activeSubagents === 0) {
    const sawWork = o.lastWorkingAt !== null && o.lastWorkingAt > o.statusSince;
    const quiet = now - o.lastActivityAt >= READY_CONFIRM_MS;
    return o.state === 'ready' && sawWork && quiet && now - o.stateSince >= READY_CONFIRM_MS ? 'idle' : null;
  }
  return null;
}
