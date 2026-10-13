import type { TerminalServerFrame } from '@orch/shared';
import { TextWatcher } from './ansi.js';
import { classifyTitle, conversationTitle, extractTitles, type TitleState } from './title.js';
import type { PtyProcess } from './pty.js';
import { RingBuffer } from './ring-buffer.js';

/** Welcome header Claude Code prints once the TUI is up. */
const BANNER_PATTERN = /Claude Code v\d/;
const BANNER_FALLBACK_MS = 15_000;
/** The workspace-trust dialog Claude Code shows for a folder it has not seen before. */
const TRUST_PATTERN = /Yes, I trust this folder/;
const KEY_DOWN = '\x1b[B';
const KEY_ENTER = '\r';

type FrameListener = (frame: TerminalServerFrame) => void;

export interface LiveSessionOptions {
  /**
   * Answer the workspace-trust dialog with "Yes". Only meant for folders the server created itself
   * (git worktrees under data/worktrees), where the dialog would otherwise block an unattended worker.
   */
  autoAcceptTrust?: boolean;
  /** Called when Claude renames the conversation (its window title changes to a new name). */
  onTitle?: (title: string) => void;
}

/** A running PTY plus its output history and the terminal viewers attached to it. */
export class LiveSession {
  readonly ring = new RingBuffer();
  private readonly viewers = new Set<FrameListener>();
  private exitCode: number | null | undefined;
  /** Set when the server itself terminated the process (DELETE), so the exit counts as a clean close. */
  killedByUs = false;

  /** When the terminal app last switched bracketed paste ON (null while it is off). */
  private pasteEnabledSince: number | null = null;
  /** Tail of the previous chunk, so a mode-switch sequence split across chunks is still seen. */
  private modeTail = '';
  /** Set once the welcome banner has been drawn, i.e. the TUI finished booting. */
  private bannerSeen = false;
  private readonly bannerWatcher = new TextWatcher(BANNER_PATTERN, 16);
  private readonly trustWatcher = new TextWatcher(TRUST_PATTERN, 32);
  private trustAnswered = false;
  private readonly createdAt = Date.now();
  private oscRest = '';
  private titleState: TitleState | null = null;
  private titleStateSince: number | null = null;
  private lastWorkingAt: number | null = null;
  private lastName: string | null = null;

  /** Last size a viewer reported; a process started later (the shell after Claude) begins with it. */
  private cols: number | undefined;
  private rows: number | undefined;

  /**
   * `onExit` may call `continueWith` to keep the terminal alive with another process; the viewers
   * then never see the exit.
   */
  constructor(
    readonly id: string,
    private pty: PtyProcess,
    private readonly onExit: (exitCode: number | null) => void,
    private readonly options: LiveSessionOptions = {},
  ) {
    this.wire(pty);
  }

  private wire(pty: PtyProcess): void {
    pty.onData((data) => {
      if (this.pty !== pty) return;
      this.trackPasteMode(data);
      this.trackTitle(data);
      if (!this.bannerSeen && this.bannerWatcher.feed(data)) this.bannerSeen = true;
      if (this.options.autoAcceptTrust && !this.trustAnswered && this.trustWatcher.feed(data)) this.acceptTrust();
      this.ring.push(data);
      this.emit({ type: 'output', data });
    });
    pty.onExit((code) => {
      if (this.pty !== pty) return;
      this.exitCode = code;
      this.onExit(code);
      if (this.exitCode !== undefined) this.emit({ type: 'exit', code });
    });
  }

  /**
   * Replaces the exited process with another one in the same terminal: the screen history stays and
   * viewers stay attached. `initialOutput` is shown first: a notice, and whatever the new process
   * already printed while it was starting in the background.
   */
  continueWith(next: PtyProcess, initialOutput?: string): void {
    this.pty = next;
    this.exitCode = undefined;
    this.killedByUs = false;
    this.pasteEnabledSince = null;
    this.modeTail = '';
    if (initialOutput) {
      this.ring.push(initialOutput);
      this.emit({ type: 'output', data: initialOutput });
    }
    this.wire(next);
  }

  /** Size of the terminal as the viewers last set it. */
  get size(): { cols: number; rows: number } | undefined {
    return this.cols && this.rows ? { cols: this.cols, rows: this.rows } : undefined;
  }

  get pid(): number {
    return this.pty.pid;
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  /** Attaches a viewer; returns the current screen history to replay before live frames. */
  attach(listener: FrameListener): { snapshot: string; exitCode: number | null | undefined; detach: () => void } {
    this.viewers.add(listener);
    return {
      snapshot: this.ring.snapshot(),
      exitCode: this.exitCode,
      detach: () => {
        this.viewers.delete(listener);
      },
    };
  }

  /**
   * True when text can be pasted into the prompt. Claude Code fires SessionStart and toggles bracketed
   * paste *before* the TUI is interactive (it re-initialises the terminal while plugins/MCP load), and
   * text pasted in that window is echoed as plain output and lost. So we require both a stable
   * "bracketed paste on" and the welcome banner having been drawn; if the banner never shows up
   * (e.g. its text changed in a newer version) we fall back to a time limit.
   */
  isReadyForPaste(stableMs = 500, now: number = Date.now()): boolean {
    if (this.exited || this.pasteEnabledSince === null) return false;
    if (now - this.pasteEnabledSince < stableMs) return false;
    return this.bannerSeen || now - this.createdAt > BANNER_FALLBACK_MS;
  }

  write(data: string): boolean {
    if (this.exited) return false;
    this.pty.write(data);
    return true;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exited) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // resize of a dying PTY can throw; harmless
    }
  }

  kill(): void {
    if (this.exited) return;
    this.killedByUs = true;
    this.pty.kill();
  }

  private trackPasteMode(chunk: string): void {
    const text = this.modeTail + chunk;
    const on = text.lastIndexOf('\x1b[?2004h');
    const off = text.lastIndexOf('\x1b[?2004l');
    if (on > off) this.pasteEnabledSince ??= Date.now();
    else if (off > on) this.pasteEnabledSince = null;
    this.modeTail = text.slice(-8);
  }

  /** Window title state ("working" spinner vs "ready" glyph), see title.ts. */
  get title(): { state: TitleState | null; since: number | null; lastWorkingAt: number | null } {
    return { state: this.titleState, since: this.titleStateSince, lastWorkingAt: this.lastWorkingAt };
  }

  private trackTitle(chunk: string, now: number = Date.now()): void {
    const { titles, rest } = extractTitles(this.oscRest + chunk);
    this.oscRest = rest;
    for (const title of titles) {
      const name = conversationTitle(title);
      if (name && name !== this.lastName) {
        this.lastName = name;
        this.options.onTitle?.(name);
      }
      const state = classifyTitle(title);
      if (state === null) continue;
      if (state !== this.titleState) {
        this.titleState = state;
        this.titleStateSince = now;
      }
      if (state === 'working') this.lastWorkingAt = now;
    }
  }

  /** The dialog defaults to "No, exit": move to "Yes" first, then confirm. */
  private acceptTrust(): void {
    this.trustAnswered = true;
    setTimeout(() => {
      this.write(KEY_DOWN);
      setTimeout(() => this.write(KEY_ENTER), 300);
    }, 300);
  }

  private emit(frame: TerminalServerFrame): void {
    for (const viewer of this.viewers) {
      try {
        viewer(frame);
      } catch {
        // dead socket; its own close handler will detach it
      }
    }
  }
}
