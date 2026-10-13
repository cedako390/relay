/** CSI sequences (colours, cursor moves) and OSC sequences (window title). */
const ANSI_PATTERN = new RegExp(
  [String.raw`\x1b\[[0-9;?]*[ -/]*[@-~]`, String.raw`\x1b\][^\x07\x1b]*(?:\x07|\x1b[\\])`].join('|'),
  'g',
);

export const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, '');

/**
 * Remembers the end of a stream so a pattern split across two chunks is still found.
 * Escape sequences are removed before matching.
 */
export class TextWatcher {
  private tail = '';

  constructor(
    private readonly pattern: RegExp,
    private readonly tailLength = 64,
  ) {}

  /** True if the pattern shows up in the new chunk (taking the previous tail into account). */
  feed(chunk: string): boolean {
    const text = this.tail + stripAnsi(chunk);
    this.tail = text.slice(-this.tailLength);
    return this.pattern.test(text);
  }
}
